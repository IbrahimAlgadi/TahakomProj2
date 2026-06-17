const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const encryptionService = require('./utils/encryptionService');
const { sleep } = require('./utils.js');
const { CONFIG_STATE_KEY, CONNECTED_DRIVE_LIST } = require('./redisKeyStore.js');

class UnifiedVideoTransferService extends EventEmitter {
    constructor(config) {
        super();
        
        // Configuration
        this.config = config || require('./utils/envConfig');
        this.currentSiteId = '';
        
        // Database and Redis connections
        this.pool = null;
        this.redis = null;
        this.redisSub = null;
        
        // Service state
        this.isProcessing = false;
        this.isTransferring = false;
        this.shouldStop = false;
        this.serviceConfig = {};
        
        // Drive and space monitoring
        this.driveInfo = null;
        this.isDriveConnected = false;
        this.shouldStopProcessing = true;
        this.minRequiredSpaceMB = 500;
        this.isEncryptionRequired = false;
        this.waitFileAccessTimeout = 5000;
        
        // Processing constants
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = this.config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
        this.ISS_MEDIA_CAMERAS = this.config.ISS_MEDIA_CAMERAS || ['1', '2'];
        this.VIDEO_TEMP_DIR = path.join(__dirname, 'temp_video_processing');
        this.ISS_MEDIA_FILE_SIZE = this.config.ISS_MEDIA_FILE_SIZE || 8192; // KB
        
        // Statistics
        this.videoStats = {
            totalVideosCreated: 0,
            totalFilesProcessed: 0,
            lastProcessedTime: null,
            errorsCount: 0
        };

        // Bind event handlers
        this._bindEventHandlers();
    }

    /**
     * Bind all event handlers
     */
    _bindEventHandlers() {
        this.on('start', this._handleStart);
        this.on('filesReady', this._handleFilesReady);
        this.on('videoCreated', this._handleVideoCreated);
        this.on('transferComplete', this._handleTransferComplete);
        this.on('configChanged', this._handleConfigChanged);
        this.on('driveChanged', this._handleDriveChanged);
        this.on('error', this._handleError);
        this.on('cleanup', this._handleCleanup);
    }

    /**
     * Initialize and start the service
     */
    async start() {
        console.log('[SERVICE] Starting Unified Video Transfer Service...');
        this.shouldStop = false;

        try {
            // Initialize database connection
            this.pool = new Pool({
                user: this.config.database.user,
                host: this.config.database.host,
                database: this.config.database.database,
                port: 5432,
                password: this.config.database.password
            });

            this.pool.on('error', (err) => {
                console.error('[DB_ERROR] Unexpected error on idle client', err);
                this.emit('error', err);
            });

            // Initialize Redis connections
            const redisOptions = {
                host: this.config.redis.host,
                port: this.config.redis.port,
                retryStrategy: (times) => Math.min(times * 50, 2000)
            };

            this.redis = new Redis(redisOptions);
            this.redisSub = new Redis(redisOptions);

            // Ensure temp directory exists
            await fs.ensureDir(this.VIDEO_TEMP_DIR);

            // Subscribe to Redis events
            this._subscribeToRedisEvents();

            // Load initial configuration
            await this._updateServiceConfig();
            await this._updateDriveInfo();

            this.emit('start');

        } catch (error) {
            console.error('[SERVICE] Failed to initialize:', error);
            this.emit('error', error);
        }
    }

    /**
     * Stop the service gracefully
     */
    async stop() {
        console.log('[SERVICE] Stopping Unified Video Transfer Service...');
        this.shouldStop = true;
        this.removeAllListeners();

        if (this.redisSub) await this.redisSub.quit();
        if (this.redis) await this.redis.quit();
        if (this.pool) await this.pool.end();

        console.log('[SERVICE] Service stopped gracefully');
    }

    // ===== EVENT HANDLERS =====

    /**
     * Handle service start event
     */
    _handleStart = async () => {
        console.log('[EVENT] Service started - beginning processing loops');
        
        try {
            // Start main processing loop
            this._runProcessingLoop();
            
            // Start transfer loop
            this._runTransferLoop();
            
            // Start cleanup loop
            this._runCleanupLoop();
            
            // Start buffer monitoring loop
            this._runBufferMonitoringLoop();
            
            console.log('[EVENT] All processing loops started successfully');
            
        } catch (error) {
            this.emit('error', error);
        }
    };

    /**
     * Handle files ready for processing
     */
    _handleFilesReady = async (files, job) => {
        console.log(`[EVENT] Processing ${files.length} files ready for video creation`);
        
        try {
            // Mark files as being processed
            await this._markFilesAsProcessing(files);
            
            // Group files by camera
            const groups = this._groupFilesByCamera(files);
            
            console.log(`[EVENT] Created ${groups.length} groups from ${files.length} files`);
            
            for (const group of groups) {
                console.log(`[EVENT] Processing group for camera ${group.camera_id}, date ${group.date}, interval ${group.interval_start}-${group.interval_end}`);
                
                // Check for duplicate video
                const isDuplicate = await this._checkDuplicateVideo(group);
                if (isDuplicate) {
                    console.log(`[EVENT] Skipping duplicate video for camera ${group.camera_id}, interval ${group.interval_start}-${group.interval_end}`);
                    continue;
                }
                
                // Check space before processing
                const estimatedSpaceMB = this._getEstimatedProcessingSize(group.files);
                if (!this._hasSpaceForProcessing(estimatedSpaceMB)) {
                    console.log(`[EVENT] Insufficient space for group processing (${estimatedSpaceMB}MB needed)`);
                    continue;
                }
                
                // Add files to buffer and convert them
                await this._processFilesToBuffer(group);
            }
            
        } catch (error) {
            // Remove processing markers on error
            await this._removeProcessingMarkers(files);
            this.emit('error', error);
        }
    };

    /**
     * Handle video creation completion
     */
    _handleVideoCreated = async (videoData, job) => {
        console.log(`[EVENT] Video created: ${videoData.videoName}`);
        
        try {
            // Add video to transfer queue
            await this._addVideoToTransferQueue(videoData, job);
            
            // Mark camera as processed
            await this._addCameraToProcessed(job.id, videoData.camera_id);
            
            // Update job stats
            await this._updateJobStats(job.id);
            
            // Remove processing markers for source files (they're now in transfer queue)
            const sourceFiles = videoData.sourceFileIds.map(id => ({ id }));
            await this._removeProcessingMarkers(sourceFiles);
            
            console.log(`[EVENT] Video queued for transfer: ${videoData.videoName}`);
            
        } catch (error) {
            this.emit('error', error);
        }
    };

    /**
     * Handle transfer completion
     */
    _handleTransferComplete = async (file) => {
        console.log(`[EVENT] Transfer completed: ${file.video_file_name}`);
        
        try {
            // Mark source files as transferred
            await this._markSourceFilesAsTransferred(file);
            
            // Clean up temporary video file
            if (file.video_file_path.includes(path.basename(this.VIDEO_TEMP_DIR))) {
                await this._cleanupTempVideo(file.video_file_path);
            }
            
            // Check if all files in the job have been transferred
            await this._checkAndCompleteJob(file.job_id);
            
            console.log(`[EVENT] Post-transfer cleanup completed for: ${file.video_file_name}`);
            
        } catch (error) {
            this.emit('error', error);
        }
    };

    /**
     * Handle configuration changes
     */
    _handleConfigChanged = async () => {
        // console.log('[EVENT] Configuration changed - updating service config');
        await this._updateServiceConfig();
    };

    /**
     * Handle drive changes
     */
    _handleDriveChanged = async () => {
        // console.log('[EVENT] Drive status changed - updating drive info');
        await this._updateDriveInfo();
    };

    /**
     * Handle errors
     */
    _handleError = (error) => {
        console.error('[EVENT] Service error:', error);
        this.videoStats.errorsCount++;
        
        // Could implement recovery logic here
        // For now, just log and continue
    };

    /**
     * Handle cleanup requests
     */
    _handleCleanup = async () => {
        console.log('[EVENT] Running cleanup tasks');
        
        try {
            await this._cleanupOldFailedJobs();
            await this._cleanupCorruptedBufferEntries();
            await this._cleanupStaleBufferEntries();
            await this._cleanupStaleProcessingMarkers();
            
        } catch (error) {
            this.emit('error', error);
        }
    };

    // ===== MAIN PROCESSING LOOPS =====

    /**
     * Main video processing loop
     */
    async _runProcessingLoop() {
        if (this.shouldStop) return;
        
        try {
            if (this.isProcessing) {
                setTimeout(() => this._runProcessingLoop(), 5000);
                return;
            }
            
            this.isProcessing = true;
            
            // Check if video transfer is enabled
            const isEnabled = this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.isActive &&
                              ['video', 'both'].includes(this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.dataType);
                              
            if (!isEnabled) {
                console.log('[PROCESSING] Video transfer is disabled in config');
                return;
            }
            
            // Check drive status
            if (this.shouldStopProcessing || !this.isDriveConnected) {
                console.log(`[PROCESSING] Paused: Drive not ready (Connected: ${this.isDriveConnected}, Space OK: ${!this.shouldStopProcessing})`);
                return;
            }
            
            // Check for active job or create new one
            const job = await this._getOrCreateActiveJob();
            if (!job) {
                return; // No files available for processing
            }
            
            // Get unprocessed files
            const unprocessedFiles = await this._getUnprocessedFiles();
            
            if (unprocessedFiles.length === 0) {
                console.log('[PROCESSING] No unprocessed files available');
                return;
            }
            
            console.log(`[PROCESSING] Found ${unprocessedFiles.length} unprocessed files across cameras`);
            
            // Group files by camera and check which cameras have enough files
            const cameraGroups = {};
            for (const file of unprocessedFiles) {
                if (!cameraGroups[file.camera_id]) {
                    cameraGroups[file.camera_id] = [];
                }
                cameraGroups[file.camera_id].push(file);
            }
            
            // Log camera file counts
            for (const [cameraId, files] of Object.entries(cameraGroups)) {
                console.log(`[PROCESSING] Camera ${cameraId}: ${files.length} files available`);
            }
            
            // Find cameras with enough files for processing
            const readyCameras = [];
            for (const [cameraId, files] of Object.entries(cameraGroups)) {
                if (files.length >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
                    readyCameras.push({ cameraId: parseInt(cameraId), fileCount: files.length });
                }
            }
            
            if (readyCameras.length === 0) {
                console.log('[PROCESSING] No cameras have enough files for processing yet');
                return;
            }
            
            console.log(`[PROCESSING] Ready cameras: ${readyCameras.map(c => `${c.cameraId} (${c.fileCount} files)`).join(', ')}`);
            
            // Process files for ready cameras (take exactly the needed amount per camera)
            const filesToProcess = [];
            for (const camera of readyCameras) {
                const cameraFiles = cameraGroups[camera.cameraId]
                    .slice(0, this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT);
                filesToProcess.push(...cameraFiles);
                
                console.log(`[PROCESSING] Selected ${cameraFiles.length} files from camera ${camera.cameraId} for processing`);
            }
            
            if (filesToProcess.length > 0) {
                console.log(`[PROCESSING] Processing ${filesToProcess.length} files from ${readyCameras.length} cameras`);
                this.emit('filesReady', filesToProcess, job);
            }
            
        } catch (error) {
            this.emit('error', error);
        } finally {
            this.isProcessing = false;
            setTimeout(() => this._runProcessingLoop(), 5000);
        }
    }

    /**
     * Main transfer processing loop
     */
    async _runTransferLoop() {
        if (this.shouldStop) return;
        
        try {
            if (this.isTransferring) {
                setTimeout(() => this._runTransferLoop(), 2000);
                return;
            }
            
            this.isTransferring = true;
            
            // Check if transfer should be paused
            if (!this.isDriveConnected || this.shouldStopProcessing) {
                console.log(`[TRANSFER] Paused: Drive not ready (Connected: ${this.isDriveConnected}, Space OK: ${!this.shouldStopProcessing})`);
                return;
            }
            
            // Get pending transfer files
            const filesToTransfer = await this._getPendingTransferFiles();
            
            if (filesToTransfer.length === 0) {
                return;
            }
            
            console.log(`[TRANSFER] Processing ${filesToTransfer.length} files for transfer`);
            
            for (const file of filesToTransfer) {
                if (!this.isDriveConnected || this.shouldStopProcessing) break;
                
                try {
                    await this._transferFile(file);
                    this.emit('transferComplete', file);
                    
                } catch (error) {
                    console.error(`[TRANSFER] Failed to transfer file ${file.id}:`, error);
                    await this._handleTransferError(file, error);
                }
            }
            
        } catch (error) {
            this.emit('error', error);
        } finally {
            this.isTransferring = false;
            setTimeout(() => this._runTransferLoop(), 2000);
        }
    }

    /**
     * Cleanup loop
     */
    async _runCleanupLoop() {
        if (this.shouldStop) return;
        
        try {
            this.emit('cleanup');
        } catch (error) {
            this.emit('error', error);
        } finally {
            // Run cleanup every 5 minutes
            setTimeout(() => this._runCleanupLoop(), 300000);
        }
    }

    /**
     * Buffer monitoring loop - checks for ready groups and creates videos
     */
    async _runBufferMonitoringLoop() {
        if (this.shouldStop) return;
        
        try {
            await this._checkReadyGroupsInBuffer();
        } catch (error) {
            this.emit('error', error);
        } finally {
            // Run buffer monitoring every 30 seconds
            setTimeout(() => this._runBufferMonitoringLoop(), 30000);
        }
    }

    /**
     * Check for ready groups in buffer and create videos
     */
    async _checkReadyGroupsInBuffer() {
        try {
            // Get distinct groups that have enough converted files
            const readyGroups = await this.pool.query(`
                SELECT 
                    camera_id, 
                    recording_date, 
                    group_key, 
                    group_interval_start, 
                    group_interval_end,
                    COUNT(*) as converted_count
                FROM video_converted_buffer 
                WHERE status = 'converted'
                GROUP BY camera_id, recording_date, group_key, group_interval_start, group_interval_end
                HAVING COUNT(*) >= $1
                ORDER BY recording_date, group_interval_start
            `, [this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
            
            if (readyGroups.rows.length === 0) {
                return;
            }
            
            console.log(`[BUFFER_MONITOR] Found ${readyGroups.rows.length} ready groups for video creation`);
            
            for (const group of readyGroups.rows) {
                try {
                    console.log(`[BUFFER_MONITOR] Processing ready group: camera ${group.camera_id}, interval ${group.group_interval_start}-${group.group_interval_end}`);
                    
                    // Check if this camera has already contributed to the current job
                    const hasAlreadyContributed = await this._checkCameraAlreadyProcessedInCurrentJob(group.camera_id);
                    if (hasAlreadyContributed) {
                        console.log(`[BUFFER_MONITOR] ⚠️ Skipping ready group for camera ${group.camera_id} - already contributed to current job (maintaining 1 video per camera per job)`);
                        continue;
                    }
                    
                    await this._createVideoFromBuffer(
                        group.camera_id, 
                        group.recording_date, 
                        group.group_key, 
                        group.group_interval_start, 
                        group.group_interval_end
                    );
                    
                } catch (error) {
                    console.error(`[BUFFER_MONITOR] Error processing ready group:`, error);
                }
            }
            
        } catch (error) {
            console.error('[BUFFER_MONITOR] Error checking ready groups:', error);
        }
    }

    // ===== REDIS EVENT HANDLING =====

    /**
     * Subscribe to Redis events
     */
    _subscribeToRedisEvents() {
        this.redisSub.subscribe(CONFIG_STATE_KEY + '_update');
        this.redisSub.subscribe(CONNECTED_DRIVE_LIST + '_update');

        this.redisSub.on('message', (channel, message) => {
            // console.log(`[REDIS] Message received on channel ${channel}: ${message}`);
            if (channel.startsWith(CONFIG_STATE_KEY)) {
                this.emit('configChanged');
            } else if (channel.startsWith(CONNECTED_DRIVE_LIST)) {
                this.emit('driveChanged');
            }
        });
    }

    // ===== CONFIGURATION AND STATE MANAGEMENT =====

    /**
     * Update service configuration from Redis
     */
    async _updateServiceConfig() {
        try {
            const configStr = await this.redis.get(CONFIG_STATE_KEY);
            if (configStr) {
                this.serviceConfig = JSON.parse(configStr);
                // console.log(`[CONFIG] Service configuration updated from Redis: ${JSON.stringify(this.serviceConfig, null, 2)}`);
                this.currentSiteId = (this.serviceConfig.storage && this.serviceConfig.storage.siteId) || '';
                this.isEncryptionRequired = (this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.encryption && this.serviceConfig.autoTransfer.encryption.enabled) || false;
                // console.log('[CONFIG] Service configuration updated from Redis');
            }
        } catch (error) {
            console.error('[CONFIG_ERROR] Failed to update service config:', error);
        }
    }

    /**
     * Update drive information from Redis
     */
    async _updateDriveInfo() {
        try {
            const driveListStr = await this.redis.get(CONNECTED_DRIVE_LIST);
            // console.log(`[DRIVE] Drive list updated from Redis: ${driveListStr}`);
            if (!driveListStr) {
                this.isDriveConnected = false;
                this.shouldStopProcessing = true;
                return;
            }

            const driveList = JSON.parse(driveListStr);
            const configuredDrive = this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.drive;
            // console.log(`[DRIVE] Configured drive: ${configuredDrive}`);
            // console.log(`[DRIVE] driveList: ${JSON.stringify(driveList, null, 2)}`);
            const targetDrive = driveList.find(d => d.drive.startsWith(configuredDrive));
            // console.log(`[DRIVE] targetDrive: ${JSON.stringify(targetDrive, null, 2)}`);

            if (targetDrive) {
                this.driveInfo = targetDrive;
                this.isDriveConnected = true;
                const freeSpaceMB = parseFloat(targetDrive.remainingSpace || 0) * 1024;
                this.shouldStopProcessing = freeSpaceMB <= this.minRequiredSpaceMB;
            } else {
                this.isDriveConnected = false;
                this.shouldStopProcessing = true;
            }
            
            // console.log(`[DRIVE] Drive info updated. Connected: ${this.isDriveConnected}, Space OK: ${!this.shouldStopProcessing}`);
        } catch (error) {
            console.error('[DRIVE_ERROR] Failed to update drive info:', error);
            this.isDriveConnected = false;
            this.shouldStopProcessing = true;
        }
    }

    // ===== VIDEO PROCESSING METHODS =====

    /**
     * Get unprocessed files from database
     */
    async _getUnprocessedFiles() {
        try {
            const query = `
                SELECT 
                    id, file_path, file_name, file_size, camera_id, site_id,
                    recording_date, recording_time, timezone_offset, precise_time
                FROM iss_media_files 
                WHERE 
                    deleted = false 
                    AND is_auto_transferred = false
                    AND recording_date >= CURRENT_DATE - INTERVAL '7 days'
                    AND id NOT IN (
                        SELECT DISTINCT unnest(source_file_ids) 
                        FROM video_transfer_queue 
                        WHERE status IN ('pending', 'transferred')
                    )
                    AND id NOT IN (
                        SELECT DISTINCT source_file_id 
                        FROM video_converted_buffer 
                        WHERE status IN ('pending', 'converted', 'grouped')
                    )
                ORDER BY camera_id, recording_date, precise_time
            `;
            
            const result = await this.pool.query(query);
            
            // Filter out files in retry delay or already being processed
            const filteredFiles = [];
            for (const file of result.rows) {
                const retryKey = `video_processing_failed:${file.id}`;
                const processingKey = `video_processing_in_progress:${file.id}`;
                
                const isInRetryDelay = await this.redis.exists(retryKey);
                const isBeingProcessed = await this.redis.exists(processingKey);
                
                if (!isInRetryDelay && !isBeingProcessed) {
                    filteredFiles.push(file);
                }
            }
            
            return filteredFiles;
        } catch (error) {
            console.error('[ERROR] Error fetching unprocessed files:', error);
            return [];
        }
    }

    /**
     * Group files by camera for video creation
     */
    _groupFilesByCamera(files) {
        const groups = {};
        const REQUIRED_FILES_PER_GROUP = this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
        
        for (const file of files) {
            const cameraId = file.camera_id;
            const date = file.recording_date.toISOString().split('T')[0];
            
            if (!groups[cameraId]) {
                groups[cameraId] = {};
            }
            
            if (!groups[cameraId][date]) {
                groups[cameraId][date] = { files: [] };
            }
            
            groups[cameraId][date].files.push(file);
        }
        
        // Create valid groups with exactly the required number of files
        const validGroups = [];
        
        for (const cameraId in groups) {
            for (const date in groups[cameraId]) {
                const cameraDateFiles = groups[cameraId][date].files;
                cameraDateFiles.sort((a, b) => a.precise_time.localeCompare(b.precise_time));
                
                for (let i = 0; i < cameraDateFiles.length; i += REQUIRED_FILES_PER_GROUP) {
                    const groupFiles = cameraDateFiles.slice(i, i + REQUIRED_FILES_PER_GROUP);
                    
                    if (groupFiles.length === REQUIRED_FILES_PER_GROUP) {
                        const firstFile = groupFiles[0];
                        const lastFile = groupFiles[groupFiles.length - 1];
                        
                        const [firstHours, firstMinutes] = firstFile.precise_time.split(':').map(Number);
                        const [lastHours, lastMinutes] = lastFile.precise_time.split(':').map(Number);
                        
                        const intervalStart = firstHours * 60 + firstMinutes;
                        const intervalEnd = lastHours * 60 + lastMinutes;
                        
                        const groupKey = `cam_${cameraId}_${date}_${intervalStart}-${intervalEnd}`;
                        
                        validGroups.push({
                            camera_id: parseInt(cameraId),
                            date: date,
                            interval_start: intervalStart,
                            interval_end: intervalEnd,
                            group_key: groupKey,
                            files: groupFiles
                        });
                    }
                }
            }
        }
        
        return validGroups;
    }



    /**
     * Convert .issvd file to .mp4 using ffmpeg
     */
    _convertToMp4(inputFile, outputFile) {
        return new Promise((resolve, reject) => {
            const args = [
                '-f', 'h264',
                '-i', inputFile,
                '-c:v', 'copy',
                '-f', 'mp4',
                outputFile,
                '-y'
            ];

            const ffmpeg = spawn('ffmpeg', args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ffmpeg.on('close', async (code) => {
                if (code === 0) {
                    try {
                        await sleep(200);
                        await this._waitForFileAccess(outputFile, this.waitFileAccessTimeout);
                        resolve(true);
                    } catch (error) {
                        console.error(`[VIDEO_CONVERT_ERROR] File access check failed for ${outputFile}: ${error.message}`);
                        reject(error);
                    }
                } else {
                    console.error(`[VIDEO_CONVERT_ERROR] Error converting ${inputFile}: ${stderr}`);
                    reject(new Error(`FFmpeg process exited with code ${code}`));
                }
            });

            ffmpeg.on('error', (error) => {
                console.error(`Exception while converting ${inputFile}: ${error.message}`);
                reject(error);
            });
        });
    }

    /**
     * Concatenate multiple mp4 files
     */
    async _concatenateMp4Files(mp4Files, outputFile) {
        try {
            const outputDir = path.dirname(outputFile);
            const concatListPath = path.join(outputDir, `concat_list_${Date.now()}.txt`);
            
            await fs.ensureDir(outputDir);
            
            // Verify all input files are accessible
            for (const file of mp4Files) {
                try {
                    await this._waitForFileAccess(file, 3000);
                } catch (error) {
                    console.error(`[VIDEO] Input file not accessible: ${file} - ${error.message}`);
                    return false;
                }
            }
            
            // Create concat list file
            const concatContent = mp4Files.map(file => {
                const absPath = path.resolve(file).replace(/\\/g, '/');
                return `file '${absPath}'`;
            }).join('\n');
            
            await fs.writeFile(concatListPath, concatContent);
            
            // Remove existing output file if it exists
            try {
                await fs.access(outputFile);
                await fs.unlink(outputFile);
                await sleep(500);
            } catch (error) {
                // File doesn't exist, which is fine
            }
            
            // Run ffmpeg to concatenate
            const success = await new Promise((resolve) => {
                const args = [
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', concatListPath,
                    '-c', 'copy',
                    '-avoid_negative_ts', 'make_zero',
                    outputFile,
                    '-y'
                ];

                const ffmpeg = spawn('ffmpeg', args, {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                let stderr = '';

                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                ffmpeg.on('close', async (code) => {
                    if (code === 0) {
                        try {
                            await sleep(500);
                            await this._waitForFileAccess(outputFile, 3000);
                            resolve(true);
                        } catch (error) {
                            console.error(`[VIDEO] Output file verification failed: ${error.message}`);
                            resolve(false);
                        }
                    } else {
                        console.error(`Error concatenating files: ${stderr}`);
                        resolve(false);
                    }
                });

                ffmpeg.on('error', (error) => {
                    console.error(`Exception while concatenating files: ${error.message}`);
                    resolve(false);
                });
            });
            
            // Clean up temporary concat list file
            try {
                await fs.unlink(concatListPath);
            } catch (error) {
                // Ignore cleanup errors
            }
            
            return success;
        } catch (error) {
            console.error(`Exception while concatenating files: ${error.message}`);
            return false;
        }
    }

    /**
     * Wait for file to be accessible
     */
    async _waitForFileAccess(filePath, maxWaitMs = 5000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitMs) {
            try {
                await fs.access(filePath, fs.constants.F_OK | fs.constants.R_OK);
                const stats = await fs.stat(filePath);
                if (stats.size > 0) {
                    // Additional verification: try to open and close the file
                    const fd = await fs.open(filePath, 'r');
                    await fs.close(fd);
                    return true;
                }
                await sleep(100);
            } catch (error) {
                if (error.code === 'EBUSY' || error.code === 'EACCES' || 
                    error.code === 'ENOENT' || error.code === 'EPERM') {
                    await sleep(200);
                    continue;
                }
                throw error;
            }
        }
        
        throw new Error(`File ${filePath} is still not accessible after ${maxWaitMs}ms`);
    }

    // ===== FILE TRANSFER METHODS =====

    /**
     * Get pending transfer files
     */
    async _getPendingTransferFiles() {
        // First update job status from 'pending' to 'transferring' if needed
        await this.pool.query(`
            UPDATE video_transfer_queue_job 
            SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'pending' 
            AND batch_origin = 'auto_video'
            AND EXISTS (
                SELECT 1 FROM video_transfer_queue 
                WHERE job_id = video_transfer_queue_job.id 
                AND status = 'pending'
            )
        `);
        
        const { rows } = await this.pool.query(`
            SELECT vtq.*, vtqj.batch_id, vtqj.batch_origin
            FROM video_transfer_queue vtq
            JOIN video_transfer_queue_job vtqj ON vtq.job_id = vtqj.id
            WHERE vtq.status = 'pending' 
            AND vtqj.status IN ('transferring', 'pending')
            ORDER BY vtq.created_at ASC
            LIMIT 10
        `);
        return rows;
    }

    /**
     * Transfer a video file to USB
     */
    async _transferFile(file) {
        console.log(`[TRANSFER] Processing video file: ${file.video_file_path}`);
        
        const shouldEncrypt = this.isEncryptionRequired;
        
        try {
            const usb_path = `${this.serviceConfig.autoTransfer.drive}:\\`;
            const videoFileName = path.basename(file.video_file_path);
            const relativePath = path.join('videos', videoFileName);
            const destinationPath = path.join(usb_path, relativePath);
            
            // Update transfer queue with paths
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET destination_path = $1, usb_path = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [destinationPath, usb_path, file.id]);

            if (shouldEncrypt) {
                await this._processEncryptedVideoFile(file, usb_path);
            } else {
                await fs.ensureDir(path.dirname(destinationPath));
                
                const sourceExists = await fs.pathExists(file.video_file_path);
                if (!sourceExists) {
                    throw new Error(`Source video file not found: ${file.video_file_path}`);
                }
                
                // Check if file already exists with same size
                let shouldCopy = true;
                const destExists = await fs.pathExists(destinationPath);
                
                if (destExists) {
                    try {
                        const sourceStat = await fs.stat(file.video_file_path);
                        const destStat = await fs.stat(destinationPath);
                        
                        if (sourceStat.size === destStat.size) {
                            console.log(`[TRANSFER] File already exists with same size, skipping: ${destinationPath}`);
                            shouldCopy = false;
                        }
                    } catch (statError) {
                        console.warn(`[TRANSFER] Could not compare file stats: ${statError.message}`);
                    }
                }
                
                if (shouldCopy) {
                    await this._copyWithRetry(file.video_file_path, destinationPath, 3, 1000);
                    console.log(`[TRANSFER] Copied: ${file.video_file_path} to ${destinationPath}`);
                }
            }
            
            // Mark as transferred
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [file.id]);
            
            console.log(`[TRANSFER] Successfully transferred video file ID: ${file.id}`);
            
        } catch (error) {
            console.error(`[TRANSFER] Failed to process video file ${file.id}:`, error);
            throw error;
        }
    }

    /**
     * Copy file with retry mechanism
     */
    async _copyWithRetry(sourcePath, destPath, maxRetries = 3, delay = 1000) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await fs.copy(sourcePath, destPath, { overwrite: true, errorOnExist: false });
                return;
            } catch (error) {
                lastError = error;
                
                if (error.code === 'EBUSY' && attempt < maxRetries) {
                    console.warn(`[TRANSFER] Copy attempt ${attempt} failed with EBUSY error, retrying in ${delay}ms...`);
                    await sleep(delay);
                    continue;
                }
                
                throw error;
            }
        }
        
        throw lastError;
    }

    /**
     * Handle transfer errors
     */
    async _handleTransferError(file, error) {
        const isFileNotFound = error.code === 'ENOENT';
        const isNoSpaceError = error.code === 'ENOSPC';
        
        if (isFileNotFound) {
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [`File not found: ${error.message}`, file.id]);
        } else if (isNoSpaceError) {
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET status = 'paused', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [`No space left on device: ${error.message}`, file.id]);
            
            this.shouldStopProcessing = true;
        } else {
            const newRetryCount = (file.retry_count || 0) + 1;
            const newStatus = newRetryCount >= (file.max_retries || 3) ? 'failed' : 'pending';
            
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET retry_count = $1, status = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $4
            `, [newRetryCount, newStatus, error.message, file.id]);
        }
    }

    // ===== UTILITY METHODS =====

    /**
     * Check if there's enough space for processing
     */
    _hasSpaceForProcessing(estimatedSizeMB = 100) {
        if (!this.driveInfo) {
            return !this.shouldStopProcessing;
        }
        
        const freeSpaceGB = parseFloat(this.driveInfo.remainingSpace || 0);
        console.log(`[ESTIMATE] Free space: ${freeSpaceGB}GB`);
        const freeSpaceMB = freeSpaceGB * 1024;
        console.log(`[ESTIMATE] Free space: ${freeSpaceMB}MB`);
        const bufferMB = 120;
        const totalRequired = estimatedSizeMB + bufferMB;
        console.log(`[ESTIMATE] Total required: ${totalRequired}MB`);
        
        return freeSpaceMB >= totalRequired;
    }

    /**
     * Get estimated processing size
     */
    _getEstimatedProcessingSize(files) {
        if (!files || files.length === 0) return 0;
        
        // console.log(`[ESTIMATE] Files: ${JSON.stringify(files, null, 2)}`);
        const avgFileSizeMB = this.ISS_MEDIA_FILE_SIZE / 1024;
        console.log(`[ESTIMATE] Avg file size: ${avgFileSizeMB}`);
        const tempMp4SizeMB = avgFileSizeMB * files.length;
        console.log(`[ESTIMATE] Temp MP4 size: ${tempMp4SizeMB}`);
        const bufferSpaceForFinalVideo = tempMp4SizeMB * 0.25;
        const finalVideoSizeMB = tempMp4SizeMB + bufferSpaceForFinalVideo;
        console.log(`[ESTIMATE] Final video size: ${finalVideoSizeMB}`);
        return finalVideoSizeMB;
    }

    /**
     * Get or create active job with proper state management
     */
    async _getOrCreateActiveJob() {
        // Check for active job (exclude completed jobs)
        const result = await this.pool.query(`
            SELECT * FROM video_transfer_queue_job 
            WHERE batch_origin = 'auto_video' AND status IN ('created', 'pending', 'processing', 'transferring', 'paused')
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        
        if (result.rows.length > 0) {
            const activeJob = result.rows[0];
            console.log(`[JOB] Found active job: ${activeJob.batch_id} (status: ${activeJob.status})`);
            
            // If job is pending, transferring, or processing - wait for it to complete
            if (activeJob.status === 'pending' || activeJob.status === 'transferring' || activeJob.status === 'processing') {
                const isComplete = await this._checkJobCompletion(activeJob.id);
                console.log(`[JOB] Job is ${activeJob.status}. Waiting for completion... isComplete: ${isComplete}`);
                if (isComplete) {
                    console.log('[JOB] All cameras processed. Moving job to tranferred status...');
                    await this._updateJobStatus(activeJob.id, 'transferred');
                    console.log('[JOB] ✓ Job status changed to transferred for transfer');
                    return null; // Job is now ready for transfer, don't create new content
                }
                return null; // Don't process more files until current job completes
            }
            
            // If job is created, check if all cameras are complete
            if (activeJob.status === 'created') {
                const isComplete = await this._checkJobCompletion(activeJob.id);
                if (isComplete) {
                    console.log('[JOB] All cameras processed. Moving job to pending status...');
                    // await this._updateJobStats(activeJob.id);
                    await this._updateJobStatus(activeJob.id, 'pending');
                    console.log('[JOB] ✓ Job status changed to pending for transfer');
                    return null; // Job is now ready for transfer, don't create new content
                }
                
                // Job exists but is incomplete - continue with this job
                console.log('[JOB] Job incomplete. Continuing with current job...');
                return activeJob;
            }
            
            return activeJob;
        }
        
        // Check if there are unprocessed files before creating job
        const unprocessedFiles = await this._getUnprocessedFiles();
        if (unprocessedFiles.length === 0) {
            return null;
        }
        
        // Create new job
        const expectedCameras = this.ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
        const batchId = uuidv4();
        
        console.log(`[JOB] Creating new job for cameras: ${expectedCameras.join(', ')}`);
        const createResult = await this.pool.query(`
            INSERT INTO video_transfer_queue_job (
                batch_id, batch_origin, status, 
                expected_cameras, processed_cameras, 
                interval_duration_minutes, site_id
            ) 
            VALUES ($1, $2, 'created', $3, '{}', 5, $4) 
            RETURNING *
        `, [batchId, 'auto_video', expectedCameras, this.currentSiteId]);
        
        console.log(`[JOB] ✓ Created new job: ${createResult.rows[0].batch_id}`);
        return createResult.rows[0];
    }

    /**
     * Add video to transfer queue
     */
    async _addVideoToTransferQueue(videoData, job) {
        const insertQuery = `
            INSERT INTO video_transfer_queue 
            (video_file_path, video_file_name, video_file_size, camera_id, site_id, 
             recording_date, interval_start_minutes, interval_end_minutes, 
             source_files_count, source_files_size, source_file_ids, status, job_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id;
        `;
        
        const result = await this.pool.query(insertQuery, [
            videoData.videoPath,
            videoData.videoName,
            videoData.fileSize,
            videoData.camera_id,
            videoData.site_id,
            videoData.recording_date,
            videoData.interval_start,
            videoData.interval_end,
            videoData.sourceFileIds.length,
            0,
            videoData.sourceFileIds,
            'pending',
            job.id
        ]);
        
        console.log(`[QUEUE] Added video ${videoData.videoName} to transfer queue (ID: ${result.rows[0].id})`);
        return result.rows[0].id;
    }

    /**
     * Check if all cameras have been processed for a job
     */
    async _checkJobCompletion(jobId) {
        const result = await this.pool.query(`
            SELECT 
                expected_cameras,
                processed_cameras,
                array_length(expected_cameras, 1) as expected_count,
                array_length(processed_cameras, 1) as processed_count
            FROM video_transfer_queue_job 
            WHERE id = $1
        `, [jobId]);
        
        if (result.rows.length === 0) return false;
        
        const row = result.rows[0];
        const expectedCount = row.expected_count || 0;
        const processedCount = row.processed_count || 0;
        
        console.log(`[JOB] Completion check - Expected: ${expectedCount}, Processed: ${processedCount}`);
        
        return expectedCount > 0 && processedCount >= expectedCount;
    }

    /**
     * Update job status
     */
    async _updateJobStatus(jobId, status, errorMessage = null) {
        const updateQuery = errorMessage 
            ? `UPDATE video_transfer_queue_job SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`
            : `UPDATE video_transfer_queue_job SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`;
            
        const params = errorMessage ? [status, errorMessage, jobId] : [status, jobId];
        
        await this.pool.query(updateQuery, params);
        console.log(`[JOB] Updated job ${jobId} status to: ${status}`);
    }

    /**
     * Add camera to processed list
     */
    async _addCameraToProcessed(jobId, cameraId) {
        await this.pool.query(`
            UPDATE video_transfer_queue_job 
            SET processed_cameras = array_append(processed_cameras, $1::text),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 
            AND NOT ($1::text = ANY(processed_cameras))
        `, [cameraId.toString(), jobId]);
        
        console.log(`[JOB] Added camera ${cameraId} to processed list for job ${jobId}`);
    }

    /**
     * Update job statistics
     */
    async _updateJobStats(jobId) {
        await this.pool.query(`
            UPDATE video_transfer_queue_job 
            SET 
                total_videos = (SELECT COUNT(*) FROM video_transfer_queue WHERE job_id = $1),
                total_size = (SELECT COALESCE(SUM(video_file_size), 0) FROM video_transfer_queue WHERE job_id = $1),
                transferred_videos = (SELECT COUNT(*) FROM video_transfer_queue WHERE job_id = $1 AND status = 'transferred'),
                transferred_size = (SELECT COALESCE(SUM(video_file_size), 0) FROM video_transfer_queue WHERE job_id = $1 AND status = 'transferred'),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [jobId]);
    }

    /**
     * Check if job is complete and update status accordingly
     */
    async _checkAndCompleteJob(jobId) {
        try {
            const result = await this.pool.query(`
                SELECT 
                    vtqj.id,
                    vtqj.batch_id,
                    vtqj.status,
                    COUNT(vtq.id) as total_videos,
                    COUNT(CASE WHEN vtq.status = 'transferred' THEN 1 END) as transferred_videos
                FROM video_transfer_queue_job vtqj
                LEFT JOIN video_transfer_queue vtq ON vtqj.id = vtq.job_id
                WHERE vtqj.id = $1
                GROUP BY vtqj.id, vtqj.batch_id, vtqj.status
            `, [jobId]);
            
            if (result.rows.length === 0) {
                return;
            }
            
            const job = result.rows[0];
            const totalVideos = parseInt(job.total_videos);
            const transferredVideos = parseInt(job.transferred_videos);
            
            console.log(`[JOB] Transfer progress for job ${job.batch_id}: ${transferredVideos}/${totalVideos} videos transferred`);
            
            // If all videos have been transferred, mark job as completed
            if (totalVideos > 0 && transferredVideos >= totalVideos) {
                await this._updateJobStatus(jobId, 'completed');
                console.log(`[JOB] ✓ Job ${job.batch_id} completed - all ${totalVideos} videos transferred`);
            }
            
        } catch (error) {
            console.error(`[JOB] Error checking job completion for job ${jobId}:`, error);
        }
    }

    /**
     * Mark source files as transferred
     */
    async _markSourceFilesAsTransferred(file) {
        try {
            const sourceFileIdsResult = await this.pool.query(`
                SELECT source_file_ids 
                FROM video_transfer_queue 
                WHERE id = $1
            `, [file.id]);
            
            if (sourceFileIdsResult.rows.length === 0) {
                console.warn(`[MARK] No video transfer queue record found for file ID: ${file.id}`);
                return;
            }
            
            const sourceFileIds = sourceFileIdsResult.rows[0].source_file_ids;
            
            if (!sourceFileIds || sourceFileIds.length === 0) {
                console.warn(`[MARK] No source file IDs found for video: ${path.basename(file.video_file_path)}`);
                return;
            }
            
            await this.pool.query(`
                UPDATE iss_media_files 
                SET is_auto_transferred = true, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ANY($1)
            `, [sourceFileIds]);
            
            console.log(`[MARK] ✓ Marked ${sourceFileIds.length} source files as transferred for video: ${path.basename(file.video_file_path)}`);
            
        } catch (error) {
            console.error(`[MARK] Failed to mark source files as transferred for ${file.video_file_path}:`, error);
        }
    }

    /**
     * Clean up temporary video files
     */
    async _cleanupTempVideo(videoPath) {
        try {
            await fs.unlink(videoPath);
            console.log(`[CLEANUP] Deleted temporary video: ${videoPath}`);
            
            const parentDir = path.dirname(videoPath);
            const files = await fs.readdir(parentDir);
            if (files.length === 0) {
                await fs.rmdir(parentDir);
                console.log(`[CLEANUP] Removed empty temporary directory: ${parentDir}`);
            }
        } catch (error) {
            console.warn(`[CLEANUP] Could not clean up temporary file/directory: ${videoPath}`, error.message);
        }
    }

    /**
     * Process encrypted video file
     */
    async _processEncryptedVideoFile(file, usb_path) {
        const relativeDirPath = 'videos';
        const destinationGroupDir = path.join(usb_path, relativeDirPath);
        
        await fs.ensureDir(destinationGroupDir);
        
        const { key: aesKey, iv: aesIv } = encryptionService.generateAESKey();
        
        const newFilename = `${file.id}`;
        const encryptedFilePath = path.join(destinationGroupDir, newFilename);
        
        console.log(`[ENCRYPTION] Encrypting: ${file.video_file_path} to ${encryptedFilePath}`);
        await encryptionService.encryptFileAES(file.video_file_path, encryptedFilePath, aesKey, aesIv);
        
        await this.pool.query(`
            UPDATE video_transfer_queue 
            SET error_message = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [JSON.stringify({aesKey: aesKey.toString('hex'), iv: aesIv.toString('hex')}), file.id]);
    }

    // ===== CLEANUP METHODS =====

    /**
     * Clean up old failed jobs
     */
    async _cleanupOldFailedJobs() {
        try {
            const result = await this.pool.query(`
                DELETE FROM video_transfer_queue_job 
                WHERE status = 'failed' 
                AND created_at < NOW() - INTERVAL '1 hour'
                RETURNING id
            `);
            
            if (result.rows.length > 0) {
                console.log(`[CLEANUP] Removed ${result.rows.length} old failed jobs`);
            }
        } catch (error) {
            console.error('[CLEANUP] Error during cleanup of old failed jobs:', error);
        }
    }

    /**
     * Clean up corrupted buffer entries
     */
    async _cleanupCorruptedBufferEntries() {
        try {
            const result = await this.pool.query(`
                SELECT id, converted_file_path, source_file_id
                FROM video_converted_buffer 
                WHERE status = 'converted'
                AND created_at < NOW() - INTERVAL '1 hour'
            `);
            
            let cleanedCount = 0;
            
            for (const entry of result.rows) {
                if (!await fs.pathExists(entry.converted_file_path)) {
                    await this.pool.query(`
                        UPDATE video_converted_buffer 
                        SET status = 'failed', updated_at = CURRENT_TIMESTAMP 
                        WHERE id = $1
                    `, [entry.id]);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`[CLEANUP] Marked ${cleanedCount} corrupted buffer entries as failed`);
            }
        } catch (error) {
            console.error('[CLEANUP] Failed to cleanup corrupted buffer entries:', error);
        }
    }

    /**
     * Clean up stale buffer entries
     */
    async _cleanupStaleBufferEntries() {
        try {
            // Clean up old converted files from disk first
            const oldConvertedFiles = await this.pool.query(`
                SELECT id, converted_file_path, status
                FROM video_converted_buffer 
                WHERE status IN ('converted', 'grouped', 'failed')
                AND created_at < NOW() - INTERVAL '2 hours'
                AND converted_file_path != ''
            `);
            
            for (const file of oldConvertedFiles.rows) {
                try {
                    if (await fs.pathExists(file.converted_file_path)) {
                        await fs.unlink(file.converted_file_path);
                        console.log(`[CLEANUP] Removed old converted file: ${file.converted_file_path}`);
                    }
                } catch (fileError) {
                    console.warn(`[CLEANUP] Failed to remove file ${file.converted_file_path}:`, fileError.message);
                }
            }
            
            // Now clean up database entries
            const result = await this.pool.query(`
                DELETE FROM video_converted_buffer 
                WHERE status IN ('converted', 'grouped', 'failed')
                AND created_at < NOW() - INTERVAL '2 hours'
                RETURNING id, status, source_file_id
            `);
            
            if (result.rows.length > 0) {
                console.log(`[CLEANUP] Removed ${result.rows.length} stale buffer entries`);
            }
        } catch (error) {
            console.error('[CLEANUP] Failed to cleanup stale buffer entries:', error);
        }
    }

    // ===== VIDEO CONVERSION BUFFER MANAGEMENT =====

    /**
     * Store file entry in buffer table with pending status (before conversion)
     */
    async _storeFileInBufferAsPending(sourceFile, groupKey, intervalStart, intervalEnd, consistentDate = null) {
        try {
            // Use consistent date format if provided, otherwise format the file's date
            const recordingDate = consistentDate || (
                sourceFile.recording_date instanceof Date 
                    ? sourceFile.recording_date.toISOString().split('T')[0]
                    : sourceFile.recording_date
            );
            
            const insertQuery = `
                INSERT INTO video_converted_buffer 
                (source_file_id, converted_file_path, converted_file_name, converted_file_size,
                 camera_id, site_id, recording_date, recording_time, precise_time, timezone_offset,
                 group_key, group_interval_start, group_interval_end, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                RETURNING id;
            `;
            
            const result = await this.pool.query(insertQuery, [
                sourceFile.id,
                '', // Will be updated after conversion
                '', // Will be updated after conversion
                0,  // Will be updated after conversion
                sourceFile.camera_id,
                sourceFile.site_id,
                recordingDate,
                sourceFile.recording_time,
                sourceFile.precise_time,
                sourceFile.timezone_offset,
                groupKey,
                intervalStart,
                intervalEnd,
                'pending'
            ]);
            
            const bufferId = result.rows[0].id;
            console.log(`[BUFFER] Added file to buffer: ${sourceFile.file_name} (Buffer ID: ${bufferId})`);
            
            return bufferId;
            
        } catch (error) {
            console.error(`[BUFFER] Failed to store file in buffer: ${sourceFile.file_name}`, error);
            throw error;
        }
    }

    /**
     * Update buffer entry after successful conversion
     */
    async _updateBufferAfterConversion(bufferId, convertedFilePath) {
        try {
            console.log(`[BUFFER] Updating buffer entry ${bufferId} with converted file: ${convertedFilePath}`);
            
            const stats = await fs.stat(convertedFilePath);
            const convertedFileName = path.basename(convertedFilePath);
            
            const result = await this.pool.query(`
                UPDATE video_converted_buffer 
                SET 
                    converted_file_path = $2,
                    converted_file_name = $3,
                    converted_file_size = $4,
                    status = 'converted',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING id, status, group_key
            `, [bufferId, convertedFilePath, convertedFileName, stats.size]);
            
            if (result.rows.length > 0) {
                console.log(`[BUFFER] ✓ Updated buffer entry ${bufferId}: ${convertedFileName} (${(stats.size/1024/1024).toFixed(2)} MB)`);
                return result.rows[0];
            } else {
                throw new Error(`Buffer entry ${bufferId} not found for update`);
            }
            
        } catch (error) {
            console.error(`[BUFFER] Failed to update buffer entry ${bufferId}:`, error);
            throw error;
        }
    }

    /**
     * Mark buffer entry as failed
     */
    async _markBufferEntryAsFailed(bufferId, errorMessage) {
        try {
            await this.pool.query(`
                UPDATE video_converted_buffer 
                SET 
                    status = 'failed',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [bufferId]);
            
            console.log(`[BUFFER] Marked buffer entry as failed (ID: ${bufferId})`);
            
        } catch (error) {
            console.error(`[BUFFER] Failed to mark buffer entry as failed: ${error.message}`);
        }
    }

    /**
     * Check if camera group has enough converted files ready
     */
    async _checkCameraGroupReady(cameraId, date, groupKey) {
        try {
            const query = `
                SELECT COUNT(*) as file_count
                FROM video_converted_buffer 
                WHERE camera_id = $1 
                AND recording_date = $2 
                AND group_key = $3 
                AND status = 'converted'
            `;
            
            const result = await this.pool.query(query, [cameraId, date, groupKey]);
            const fileCount = parseInt(result.rows[0].file_count);
            
            console.log(`[BUFFER] Camera ${cameraId} group ${groupKey}: ${fileCount}/${this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files converted`);
            
            return fileCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
            
        } catch (error) {
            console.error(`[BUFFER] Failed to check camera group readiness:`, error);
            return false;
        }
    }

    /**
     * Get converted files for a specific group
     */
    async _getConvertedFilesForGroup(cameraId, date, groupKey) {
        try {
            console.log(`[BUFFER] Querying for: camera=${cameraId}, date=${date}, groupKey=${groupKey}, status=converted`);
            
            const query = `
                SELECT * FROM video_converted_buffer 
                WHERE camera_id = $1 
                AND recording_date = $2 
                AND group_key = $3 
                AND status = 'converted'
                ORDER BY precise_time
                LIMIT $4
            `;
            
            const result = await this.pool.query(query, [cameraId, date, groupKey, this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
            console.log(`[BUFFER] Retrieved ${result.rows.length} converted files for concatenation`);
            
            return result.rows;
            
        } catch (error) {
            console.error(`[BUFFER] Failed to get converted files for group:`, error);
            return [];
        }
    }

    /**
     * Mark converted files as grouped after successful concatenation
     */
    async _markFilesAsGrouped(bufferIds) {
        try {
            await this.pool.query(`
                UPDATE video_converted_buffer 
                SET status = 'grouped', updated_at = CURRENT_TIMESTAMP 
                WHERE id = ANY($1)
            `, [bufferIds]);
            
            console.log(`[BUFFER] Marked ${bufferIds.length} converted files as grouped`);
        } catch (error) {
            console.error(`[BUFFER] Failed to mark files as grouped: ${error.message}`);
        }
    }

    /**
     * Process files to buffer (add to buffer, convert individually)
     */
    async _processFilesToBuffer(group) {
        try {
            const { camera_id, date, interval_start, interval_end, files, group_key } = group;
            
            console.log(`[BUFFER] Adding ${files.length} files to buffer for camera ${camera_id}, interval ${interval_start}-${interval_end}`);
            
            for (const file of files) {
                try {
                    // Check if file already exists in buffer
                    const existingCheck = await this.pool.query(`
                        SELECT id, status FROM video_converted_buffer 
                        WHERE source_file_id = $1
                    `, [file.id]);
                    
                    if (existingCheck.rows.length > 0) {
                        const existing = existingCheck.rows[0];
                        if (existing.status === 'pending') {
                            console.log(`[BUFFER] File ${file.file_name} already in buffer as pending, skipping`);
                            continue;
                        } else if (existing.status === 'converted') {
                            console.log(`[BUFFER] File ${file.file_name} already converted in buffer, skipping`);
                            continue;
                        } else {
                            // Clean up old entries and allow re-adding
                            console.log(`[BUFFER] Cleaning up old buffer entry for ${file.file_name} (status: ${existing.status})`);
                            await this.pool.query(`DELETE FROM video_converted_buffer WHERE id = $1`, [existing.id]);
                        }
                    }
                    
                    // Check if source file exists
                    if (!await fs.pathExists(file.file_path)) {
                        console.error(`[BUFFER] ✗ Source file not found: ${file.file_path}`);
                        continue;
                    }
                    
                    // Add file to buffer as pending
                    const bufferId = await this._storeFileInBufferAsPending(file, group_key, interval_start, interval_end, date);
                    
                    // Convert the file immediately
                    await this._convertSingleFile(file, bufferId, group);
                    
                } catch (error) {
                    console.error(`[BUFFER] ✗ Failed to process file: ${file.file_name}`, error.message);
                    this.videoStats.errorsCount++;
                }
            }
            
            // After all files are processed, check if group is ready for concatenation
            const isReady = await this._checkCameraGroupReady(camera_id, date, group_key);
            if (isReady) {
                console.log(`[BUFFER] Group ready for concatenation: camera ${camera_id}, interval ${interval_start}-${interval_end}`);
                await this._createVideoFromBuffer(camera_id, date, group_key, interval_start, interval_end);
            }
            
        } catch (error) {
            console.error(`[BUFFER] Error processing files to buffer:`, error);
            throw error;
        }
    }

    /**
     * Convert a single file and update buffer
     */
    async _convertSingleFile(file, bufferId, group) {
        const { camera_id, date, interval_start, interval_end } = group;
        
        const tempGroupDir = path.join(this.VIDEO_TEMP_DIR, `cam_${camera_id}_${date}_${interval_start}-${interval_end}`);
        await fs.ensureDir(tempGroupDir);
        
        const filename = path.basename(file.file_name, '.issvd');
        const mp4Path = path.join(tempGroupDir, `${filename}.mp4`);
        
        try {
            console.log(`[VIDEO_CONVERT] Converting: ${file.file_name} to ${mp4Path}`);
            await this._convertToMp4(file.file_path, mp4Path);
            console.log(`[VIDEO_CONVERT] Converted: ${file.file_name} to ${mp4Path}`);
            
            // Update buffer entry with converted file info
            await this._updateBufferAfterConversion(bufferId, mp4Path);
            
            await sleep(100);
            
        } catch (error) {
            console.error(`[VIDEO_CONVERT] Failed to convert: ${file.file_name}`, error.message);
            await this._markBufferEntryAsFailed(bufferId, error.message);
            this.videoStats.errorsCount++;
            throw error;
        }
    }

    /**
     * Create final video from buffer when group is ready
     */
    async _createVideoFromBuffer(cameraId, date, groupKey, intervalStart, intervalEnd) {
        try {
            console.log(`[BUFFER] Creating video from buffer for camera ${cameraId}, interval ${intervalStart}-${intervalEnd}`);
            
            // Check if this camera has already contributed a video to the current active job
            const hasAlreadyContributed = await this._checkCameraAlreadyProcessedInCurrentJob(cameraId);
            if (hasAlreadyContributed) {
                console.log(`[BUFFER] ⚠️ Camera ${cameraId} has already contributed a video to the current job. Skipping group ${groupKey} to maintain 1 video per camera per job constraint.`);
                
                // Mark the converted files as grouped to clean them up, but don't create a video
                const convertedFiles = await this._getConvertedFilesForGroup(cameraId, date, groupKey);
                if (convertedFiles.length > 0) {
                    const bufferIds = convertedFiles.map(f => f.id);
                    const convertedFilePaths = convertedFiles.map(f => f.converted_file_path);
                    
                    await this._markFilesAsGrouped(bufferIds);
                    
                    // Clean up the converted files since we won't use them
                    for (const filePath of convertedFilePaths) {
                        try {
                            await fs.unlink(filePath);
                            console.log(`[CLEANUP] Removed unused converted file: ${path.basename(filePath)}`);
                        } catch (error) {
                            // Ignore cleanup errors
                        }
                    }
                    
                    console.log(`[BUFFER] ✓ Cleaned up ${convertedFiles.length} converted files from camera ${cameraId} (already processed in current job)`);
                }
                
                return null;
            }
            
            // Get converted files for this group
            const convertedFiles = await this._getConvertedFilesForGroup(cameraId, date, groupKey);
            
            if (convertedFiles.length === 0) {
                console.error(`[BUFFER] No converted files found for group ${cameraId}_${date}_${intervalStart}-${intervalEnd}`);
                return null;
            }
            
            // Extract file paths for concatenation
            const convertedFilePaths = convertedFiles.map(f => f.converted_file_path);
            const bufferIds = convertedFiles.map(f => f.id);
            const sourceFileIds = convertedFiles.map(f => f.source_file_id);
            
            // Create final concatenated video
            const startTime = Math.floor(intervalStart / 60).toString().padStart(2, '0') + 
                             (intervalStart % 60).toString().padStart(2, '0');
            const endTime = Math.floor(intervalEnd / 60).toString().padStart(2, '0') + 
                           (intervalEnd % 60).toString().padStart(2, '0');
            
            const formattedDate = date instanceof Date ? date.toISOString().split('T')[0] : date;
            const finalVideoName = `CAM_${cameraId}_${formattedDate}_${startTime}_to_${endTime}.mp4`;
            const tempGroupDir = path.dirname(convertedFilePaths[0]);
            const finalVideoPath = path.join(tempGroupDir, finalVideoName);
            
            console.log(`[VIDEO] Starting concatenation to: ${finalVideoName}`);
            const success = await this._concatenateMp4Files(convertedFilePaths, finalVideoPath);
            
            if (success) {
                const stats = await fs.stat(finalVideoPath);
                const fileSize = stats.size;
                
                console.log(`[VIDEO] ✓ Created: ${finalVideoName} (${(fileSize/1024/1024).toFixed(2)} MB)`);
                
                // Mark buffer files as grouped
                await this._markFilesAsGrouped(bufferIds);
                
                // Clean up individual MP4 files
                for (const filePath of convertedFilePaths) {
                    try {
                        await fs.unlink(filePath);
                    } catch (error) {
                        // Ignore cleanup errors
                    }
                }
                
                this.videoStats.totalVideosCreated++;
                this.videoStats.totalFilesProcessed += convertedFiles.length;
                
                const videoData = {
                    videoPath: finalVideoPath,
                    videoName: finalVideoName,
                    fileSize: fileSize,
                    camera_id: cameraId,
                    site_id: this.currentSiteId,
                    sourceFileIds: sourceFileIds,
                    recording_date: date,
                    interval_start: intervalStart,
                    interval_end: intervalEnd
                };
                
                // Emit video created event
                const job = await this._getOrCreateActiveJob();
                if (job) {
                    this.emit('videoCreated', videoData, job);
                }
                
                return videoData;
            } else {
                console.error(`[VIDEO] ✗ Failed to concatenate files for group ${cameraId}_${date}_${intervalStart}-${intervalEnd}`);
                return null;
            }
            
        } catch (error) {
            console.error(`[BUFFER] Error creating video from buffer:`, error);
            return null;
        }
    }

    // ===== FILE PROCESSING STATE MANAGEMENT =====

    /**
     * Mark files as being processed to prevent duplicates
     */
    async _markFilesAsProcessing(files) {
        try {
            for (const file of files) {
                const processingKey = `video_processing_in_progress:${file.id}`;
                await this.redis.setex(processingKey, 3600, JSON.stringify({
                    fileId: file.id,
                    camera_id: file.camera_id,
                    startedAt: new Date().toISOString()
                }));
            }
            console.log(`[PROCESSING] Marked ${files.length} files as being processed`);
        } catch (error) {
            console.error('[PROCESSING] Failed to mark files as processing:', error);
        }
    }

    /**
     * Remove processing markers for files
     */
    async _removeProcessingMarkers(files) {
        try {
            for (const file of files) {
                const processingKey = `video_processing_in_progress:${file.id}`;
                await this.redis.del(processingKey);
            }
            console.log(`[PROCESSING] Removed processing markers for ${files.length} files`);
        } catch (error) {
            console.error('[PROCESSING] Failed to remove processing markers:', error);
        }
    }

    /**
     * Check if a video already exists for the same camera/interval combination
     */
    async _checkDuplicateVideo(group) {
        try {
            const result = await this.pool.query(`
                SELECT id, video_file_name, status 
                FROM video_transfer_queue 
                WHERE camera_id = $1 
                AND recording_date = $2 
                AND interval_start_minutes = $3 
                AND interval_end_minutes = $4
                AND status IN ('pending', 'transferred')
                LIMIT 1
            `, [group.camera_id, group.date, group.interval_start, group.interval_end]);
            
            if (result.rows.length > 0) {
                console.log(`[DUPLICATE] Found existing video for camera ${group.camera_id}, interval ${group.interval_start}-${group.interval_end}: ${result.rows[0].video_file_name}`);
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('[DUPLICATE] Error checking for duplicate video:', error);
            return false;
        }
    }

    /**
     * Check if a camera has already contributed a video to the current active job
     */
    async _checkCameraAlreadyProcessedInCurrentJob(cameraId) {
        try {
            // Get current active job
            const jobResult = await this.pool.query(`
                SELECT id, processed_cameras, expected_cameras, status 
                FROM video_transfer_queue_job 
                WHERE batch_origin = 'auto_video' 
                AND status IN ('created', 'pending', 'processing', 'transferring', 'paused')
                ORDER BY created_at DESC 
                LIMIT 1
            `);
            
            if (jobResult.rows.length === 0) {
                console.log(`[CAMERA_CHECK] No active job found`);
                return false;
            }
            
            const currentJob = jobResult.rows[0];
            
            // Check if camera is already in processed_cameras array
            const processedCameras = currentJob.processed_cameras || [];
            const isAlreadyProcessed = processedCameras.includes(cameraId.toString());
            
            if (isAlreadyProcessed) {
                console.log(`[CAMERA_CHECK] Camera ${cameraId} already processed in job ${currentJob.id} (processed_cameras: [${processedCameras.join(', ')}])`);
                return true;
            }
            
            // Double-check by looking at actual videos in transfer queue for this job
            const videoResult = await this.pool.query(`
                SELECT id, video_file_name, camera_id 
                FROM video_transfer_queue 
                WHERE job_id = $1 
                AND camera_id = $2
                AND status IN ('pending', 'transferred')
                LIMIT 1
            `, [currentJob.id, cameraId]);
            
            if (videoResult.rows.length > 0) {
                console.log(`[CAMERA_CHECK] Camera ${cameraId} already has video in transfer queue for job ${currentJob.id}: ${videoResult.rows[0].video_file_name}`);
                return true;
            }
            
            console.log(`[CAMERA_CHECK] Camera ${cameraId} has not yet contributed to job ${currentJob.id}`);
            return false;
            
        } catch (error) {
            console.error(`[CAMERA_CHECK] Error checking if camera ${cameraId} already processed in current job:`, error);
            return false; // Default to allowing processing if check fails
        }
    }

    /**
     * Clean up stale processing markers
     */
    async _cleanupStaleProcessingMarkers() {
        try {
            const pattern = 'video_processing_in_progress:*';
            const keys = await this.redis.keys(pattern);
            
            let cleanedCount = 0;
            for (const key of keys) {
                try {
                    const value = await this.redis.get(key);
                    if (value) {
                        const data = JSON.parse(value);
                        const startedAt = new Date(data.startedAt);
                        const hoursSinceStart = (Date.now() - startedAt.getTime()) / (1000 * 60 * 60);
                        
                        // Remove markers older than 2 hours
                        if (hoursSinceStart > 2) {
                            await this.redis.del(key);
                            cleanedCount++;
                        }
                    }
                } catch (parseError) {
                    // Remove invalid markers
                    await this.redis.del(key);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                console.log(`[CLEANUP] Removed ${cleanedCount} stale processing markers`);
            }
        } catch (error) {
            console.error('[CLEANUP] Failed to cleanup stale processing markers:', error);
        }
    }
}

// ===== MAIN APPLICATION ENTRY POINT =====

async function main() {
    const config = require('./utils/envConfig');
    const videoService = new UnifiedVideoTransferService(config);

    await videoService.start();

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('[MAIN] Shutting down service...');
        await videoService.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('[MAIN] Shutting down service...');
        await videoService.stop();
        process.exit(0);
    });
}

// Export the class for testing
module.exports = { UnifiedVideoTransferService };

// Run if this file is executed directly
if (require.main === module) {
    main().catch(error => {
        console.error("Fatal error during service initialization:", error);
        process.exit(1);
    });
}
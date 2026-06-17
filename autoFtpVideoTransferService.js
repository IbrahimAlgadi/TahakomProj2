const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const { sleep } = require('./utils.js');
const { CONFIG_FTP_STATE_KEY, FTP_VIDEO_METRICS_KEY } = require('./redisKeyStore.js');
const ftp = require('basic-ftp');

// Import shared classes (reused from USB service)
const VideoProcessor = require('./services/video-transfer/processors/VideoProcessor.js');
const ProcessingStateManager = require('./services/video-transfer/state/ProcessingStateManager.js');
const CleanupService = require('./services/shared/CleanupService.js');

// Import FTP-specific classes
const FtpTransferManager = require('./services/video-transfer/transfer/FtpTransferManager.js');
const FtpJobManager = require('./services/video-transfer/state/FtpJobManager.js');
const FtpCompleteBufferManager = require('./services/video-transfer/processors/FtpCompleteBufferManager.js');

class AutoFtpVideoTransferService extends EventEmitter {
    constructor(config) {
        super();
        
        // Configuration
        this.config = config || require('./utils/envConfig.js');
        this.ftpConfig = null;
        this.systemConfig = {};
        this.currentSiteId = '';
        
        // Database and Redis connections
        this.pool = null;
        this.redis = null;
        this.redisSub = null;
        
        // Service state
        this.pauseVideoTransferFromConfig = false;
        this.isTransferringToStorageRunning = false;
        this.isProcessing = false;
        this.isTransferring = false;
        this.shouldStop = false;
        this.serviceConfig = {};
        
        // FTP connection status
        this.isFtpConnected = false;
        this.lastFtpTestTime = 0;
        this.ftpTestInterval = 30000; // Test FTP connection every 30 seconds
        
        // Processing constants
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = this.config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
        this.ISS_MEDIA_CAMERAS = this.config.ISS_MEDIA_CAMERAS || ['1', '2'];
        this.VIDEO_TEMP_DIR = path.join(__dirname, 'temp_video_processing_ftp');
        
        // External service instances (initialized after DB/Redis connections)
        this.videoProcessor = null;
        this.ftpTransferManager = null;
        this.ftpJobManager = null;
        this.processingStateManager = null;
        this.cleanupService = null;
        this.ftpBufferManager = null;

        // Bind event handlers
        this._bindEventHandlers();
    }

    /**
     * Bind all event handlers
     */
    _bindEventHandlers() {
        this.on('start', this._handleStart);
        this.on('startTransferToStorage', this._startTransferToStorageAsync);
        this.on('configChanged', this._handleConfigChanged);
        this.on('error', this._handleError);
        this.on('cleanup', this._handleCleanup);
    }

    /**
     * Initialize and start the service
     */
    async start() {
        console.log('-------------------------------------------------------');
        console.log('-------------------------------------------------------');
        console.log('[AUTO_FTP_SERVICE] start: Starting FTP Video Transfer Service...');
        console.log('-------------------------------------------------------');
        console.log('-------------------------------------------------------');
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
                console.error('[AUTO_FTP_DB_ERROR] start: Unexpected error on idle client', err);
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

            // Load FTP configuration
            await this._loadFtpConfig();

            // Wait a moment for connections to establish
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Initialize external services
            this._initializeExternalServices();

            // Subscribe to Redis events
            this._subscribeToRedisEvents();

            // Load initial configuration
            await this._updateServiceConfig();

            this.emit('start');

        } catch (error) {
            console.error('[AUTO_FTP_SERVICE] start: Failed to initialize:', error);
            this.emit('error', error);
        }
    }

    /**
     * Load FTP configuration from file
     */
    async _loadFtpConfig() {
        try {
            const configPath = path.join(__dirname, 'config', 'ftp-transfer.json');
            this.ftpConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
            // console.log(this.ftpConfig);
            // console.log('[AUTO_FTP_SERVICE] _loadFtpConfig: ✓ FTP configuration loaded successfully');
        } catch (error) {
            console.error('[AUTO_FTP_SERVICE] _loadFtpConfig: Failed to load FTP configuration:', error);
            this.ftpConfig = null;
        }
    }

    /**
     * Initialize external service instances
     */
    _initializeExternalServices() {
        // Shared services (reused from USB service)
        this.videoProcessor = new VideoProcessor(this, this.config);
        this.processingStateManager = new ProcessingStateManager(this, this.pool, this.redis, this.config);
        this.cleanupService = new CleanupService(this, this.pool, this.redis, this.config);
        
        // FTP-specific services
        this.ftpJobManager = new FtpJobManager(this, this.pool, this.redis, this.config, this.processingStateManager);
        this.ftpTransferManager = new FtpTransferManager(this, this.pool, this.redis, this.config);
        this.ftpBufferManager = new FtpCompleteBufferManager(this, this.pool, this.config, this.videoProcessor, this.ftpJobManager);
        
        // Set FTP configuration
        if (this.ftpConfig) {
            this.ftpTransferManager.setFtpConfig(this.ftpConfig);
        }
        
        console.log('[AUTO_FTP_SERVICE] _initializeExternalServices: FTP external services initialized successfully');
    }

    /**
     * Stop the service gracefully
     */
    async stop() {
        console.log('[AUTO_FTP_SERVICE] stop: Stopping FTP Video Transfer Service...');
        this.shouldStop = true;
        this.removeAllListeners();

        if (this.redisSub) await this.redisSub.quit();
        if (this.redis) await this.redis.quit();
        if (this.pool) await this.pool.end();

        console.log('[AUTO_FTP_SERVICE] stop: FTP service stopped gracefully');
    }

    // ===== EVENT HANDLERS =====

    /**
     * Handle service start event
     */
    _handleStart = async () => {
        console.log('[AUTO_FTP_EVENT] _handleStart: FTP service started - beginning processing loops');
        
        try {
            // Start main processing loop
            this._runProcessingLoop();
            
            // Start cleanup loop
            // this._runCleanupLoop();
            
            // Start buffer monitoring loop
            this._runBufferMonitoringLoop();
            
            // Start FTP connection monitoring
            this._runFtpConnectionMonitoring();
            
            console.log('[AUTO_FTP_EVENT] All FTP processing loops started successfully');
            
        } catch (error) {
            this.emit('error', error);
        }
    };

    /**
     * Handle configuration changes
     */
    _handleConfigChanged = async () => {
        console.log('[AUTO_FTP_EVENT] _handleConfigChanged: Config changed');
        await this._updateServiceConfig();
        await this._loadFtpConfig();
        if (this.ftpTransferManager && this.ftpConfig) {
            this.ftpTransferManager.setFtpConfig(this.ftpConfig);
        }
    };

    /**
     * Handle errors
     */
    _handleError = (error) => {
        console.error('[AUTO_FTP_EVENT] _handleError: FTP service error:', error);
        
        // Get video stats from FTP BufferManager if available
        if (this.ftpBufferManager) {
            const stats = this.ftpBufferManager.getVideoStats();
            stats.errorsCount++;
        }
    };

    /**
     * Handle cleanup requests
     */
    _handleCleanup = async () => {
        console.log('[AUTO_FTP_EVENT] _handleCleanup: Running FTP cleanup tasks');
        
        try {
            // Clean up FTP buffer entries
            if (this.ftpBufferManager) {
                await this.ftpBufferManager.cleanupOldBufferEntries();
            }
            
            // Run general cleanup tasks
            await this.cleanupService.runAllCleanupTasks();
        } catch (error) {
            this.emit('error', error);
        }
    };

    // ===== MAIN PROCESSING LOOPS =====

    /**
     * Main FTP video processing loop
     */
    async _runProcessingLoop() {
        console.log('-------------------------------------------------------');
        console.log('-------------------------------------------------------');
        console.log('[FTP_PROCESSING] _runProcessingLoop: Starting FTP processing loop...');
        console.log('-------------------------------------------------------');
        console.log('-------------------------------------------------------');
        if (this.shouldStop) return;
        // console.log({
        //     pauseVideoTransferFromConfig: this.pauseVideoTransferFromConfig
        // });

        if (!this.pauseVideoTransferFromConfig) {
            console.log('[FTP_TRANSFER] _startTransferToStorageAsync: FTP video transfer is disabled in config');
            setTimeout(() => this._runProcessingLoop(), 2000);
            return;
        }

        try {
            if (this.isProcessing) {
                setTimeout(() => this._runProcessingLoop(), 2000);
                return;
            }

            this.isProcessing = true;
            console.log('[FTP_PROCESSING] _runProcessingLoop: Running FTP processing loop');

            // Check if FTP video transfer is enabled
            const isEnabled = this.serviceConfig.transfer && this.serviceConfig.transfer.startTransfer &&
                              ['video', 'both'].includes(this.serviceConfig.transferSchedule.dataType);

            if (!isEnabled) {
                console.log('[FTP_PROCESSING] _runProcessingLoop: FTP video transfer is disabled in config');
                return;
            }

            // Check FTP configuration
            if (!this.ftpConfig || !this.ftpConfig.server) {
                console.log('[FTP_PROCESSING] _runProcessingLoop: FTP configuration not available');
                return;
            }

            // Check if transfer should start based on schedule
            if (!this._shouldStartTransfer()) {
                console.log('[FTP_PROCESSING] _runProcessingLoop: Not in scheduled transfer time');
                return;
            }

            // Check FTP connection
            if (!this.isFtpConnected) {
                console.log('[FTP_PROCESSING] _runProcessingLoop: FTP not connected');
                return;
            }

            // ===== STEP 1: Look for existing jobs that aren't completed =====
            const existingJobs = await this.ftpJobManager.getExistingUncompletedJobs();
            console.log(`[FTP_PROCESSING] _runProcessingLoop: Found ${existingJobs.length} existing uncompleted FTP jobs`);
            
            if (existingJobs.length > 0) {
                const activeJob = existingJobs[0]; // Get the newest job
                console.log(`[FTP_PROCESSING] _runProcessingLoop: Found active FTP job: ${activeJob.batch_id} (status: ${activeJob.status})`);
                await this._handleJobProcessing(activeJob);
                return;
            }

            // ===== STEP 2: Create new job if files are available =====
            const newJob = await this._createNewJobIfFilesAvailable();
            if (!newJob) {
                console.log('[FTP_PROCESSING] _runProcessingLoop: No files available to create new FTP job');
                return;
            }

            console.log(`[FTP_PROCESSING] _runProcessingLoop: Created new FTP job: ${newJob.batch_id}`);
            await this._handleJobProcessing(newJob);
            
        } catch (error) {
            this.emit('error', error);
        } finally {
            this.isProcessing = false;
            setTimeout(() => this._runProcessingLoop(), 5000);
        }
    }

    /**
     * Handle FTP job processing
     */
    async _handleJobProcessing(job) {
        console.log(`[FTP_PROCESSING] _handleJobProcessing: Handling FTP job: ${job.batch_id} (ID: ${job.id})`);
        
        // Process each camera for this job
        const cameraJobPromises = [];
        
        for (const camera of this.ISS_MEDIA_CAMERAS) {
            const cameraId = camera.replace('CAM_', '');
            let singleCameraJobPromise = this._processSingleCameraJob(job, cameraId);
            cameraJobPromises.push(singleCameraJobPromise);
        }

        console.log(`[FTP_PROCESSING] _handleJobProcessing: FTP Job ${job.id} - Waiting for all cameras to be processed`);
        await Promise.all(cameraJobPromises);
        console.log(`[FTP_PROCESSING] _handleJobProcessing: FTP Job ${job.id} - All cameras processed`);
        
        // Update and publish video metrics
        await this._updateAndPublishVideoMetrics(job);
    }

    /**
     * Process single camera for FTP job
     */
    async _processSingleCameraJob(job, cameraId) {
        console.log(`[FTP_PROCESSING] _processSingleCameraJob: Processing FTP camera ${cameraId} for job ${job.id}`);
        
        // Check if video is already in transfer queue
        let videoInTransferQueue = await this.ftpJobManager.getVideoInTransferQueue(job.id, cameraId);
        if (videoInTransferQueue) {
            console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP video already in transfer queue for camera ${cameraId}`);
            if (videoInTransferQueue.status === 'pending') {
                this.emit('startTransferToStorage', job.id, cameraId);
            }
            return;
        }

        // Get camera file status counts from FTP buffer
        const cameraFileStatusCounts = await this.ftpJobManager.getCameraFileCountsStatusBufferCheck(job.id, cameraId);
        const cameraPendingCount = cameraFileStatusCounts.pending || 0;
        const cameraConvertedCount = cameraFileStatusCounts.converted || 0;
        const cameraGroupedCount = cameraFileStatusCounts.grouped || 0;

        console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - Camera ${cameraId}: ${cameraPendingCount} pending, ${cameraConvertedCount} converted, ${cameraGroupedCount} grouped`);
        
        const convertedGroupedCount = cameraGroupedCount + cameraConvertedCount;
        
        // If we need more files, add them to the buffer
        if (convertedGroupedCount < this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - Requesting additional files for camera ${cameraId}`);
            
            if (cameraPendingCount > 0) {
                // Process pending records
                const bufferedRecords = await this.ftpJobManager.requestPendingRecordsForCamera(cameraId, job.id);
                console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - Camera ${cameraId} has ${bufferedRecords.length} pending records`);
                
                for (const record of bufferedRecords) {
                    const file = await this.ftpJobManager.getMediaFileById(record.source_file_id);
                    if (!file) {
                        console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - File not found for record ${record.id}`);
                        await this.ftpBufferManager.markBufferEntryAsFailed(record.id, 'File not found');
                        continue;
                    }
                    await this.ftpBufferManager.convertSingleFile(file, record, null);
                }
                return;
            } else {
                // Request additional files
                const additionalFiles = await this.ftpJobManager.requestAdditionalFilesForCamera(
                    cameraId, convertedGroupedCount, this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT, job.id
                );

                if (additionalFiles.length > 0) {
                    console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - Adding ${additionalFiles.length} files for camera ${cameraId} to FTP processing queue`);
                    
                    for (const file of additionalFiles) {
                        const bufferRecord = await this.ftpBufferManager.storeFileInBufferAsPending(
                            file, null, null, null, job.id, null
                        );
                        await this.ftpBufferManager.convertSingleFile(file, bufferRecord, null);
                    }
                } else {
                    console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - No additional files available for camera ${cameraId}`);
                }
            }
        }

        // Update job status if needed
        if (cameraPendingCount > 0) {
            if (job.status !== 'pending') {
                await this.ftpJobManager.updateJobStatus(job.id, 'pending');
            }
            console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - is processing pending files`);
        }
        
        // Group files if we have enough converted files
        if (cameraConvertedCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            const groupName = await this.processingStateManager.groupFilesByCamera(cameraId, job.id, 'ftp_video_converted_buffer');
            if (groupName) {
                console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - Grouped files for camera ${cameraId} - ${groupName}`);
            }
        }

        // Create video if we have enough grouped files
        if (cameraGroupedCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP Job ${job.id} - Creating video for camera ${cameraId}`);
            
            try {
                // Create video from buffer
                /**
                 * const videoData = {
                        videoPath: videoResult.videoPath,
                        videoName: videoResult.videoName,
                        fileSize: videoResult.fileSize,
                        camera_id: cameraId,
                        site_id: this.currentSiteId,
                        sourceFileIds: sourceFileIds,
                        group_key: groupKey
                    };
                 */
                const videoData = await this.ftpBufferManager.createVideoFromBuffer(job.id, cameraId);
            
                console.log({videoData});

                // Add video to FTP transfer queue
                await this.ftpJobManager.addVideoToTransferQueue(videoData, job.id);
                
                // Mark camera as processed
                await this.ftpJobManager.addCameraToProcessed(job.id, cameraId);
                
                // Update job stats
                await this.ftpJobManager.updateJobStatsToTransfered(job.id);
                
                console.log(`[FTP_PROCESSING] _processSingleCameraJob: FTP video queued for transfer: ${videoData.videoName}`);
                
                // Start transfer
                this.emit('startTransferToStorage', job.id, cameraId);
                
            } catch (error) {
                this.emit('error', error);
            }
        }
    }

    /**
     * Create new FTP job if files are available
     */
    async _createNewJobIfFilesAvailable() {

        console.log('[FTP_PROCESSING] _createNewJobIfFilesAvailable: Checking file availability for FTP transfer...');

        // Check file availability before creating job
        let totalAvailableFiles = 0;
        const expectedCameras = this.ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
        
        for (const cameraId of expectedCameras) {
            const files = await this.ftpJobManager.requestAdditionalFilesForCamera(cameraId, 0, 38, null);
            
            if (files.length === 0) {
                console.log(`[FTP_PROCESSING] _createNewJobIfFilesAvailable: No files available for FTP camera ${cameraId}`);
                continue;
            }
            
            console.log(`[FTP_PROCESSING] _createNewJobIfFilesAvailable: Found ${files.length} available files for FTP camera ${cameraId}`);
            totalAvailableFiles += files.length;
        }
        
        // If no files available, don't create job
        if (totalAvailableFiles === 0) {
            console.log(`[FTP_PROCESSING] _createNewJobIfFilesAvailable: No files available for FTP transfer`);
            return null;
        }
        
        // Create new FTP job
        console.log(`[FTP_PROCESSING] _createNewJobIfFilesAvailable: Found ${totalAvailableFiles} total files available. Creating new FTP job...`);
        
        const newJob = await this.ftpJobManager.createNewJobWithUUID();
        console.log(`[FTP_PROCESSING] _createNewJobIfFilesAvailable: ✓ Created new FTP job: ${newJob.batch_id} (ID: ${newJob.id})`);
        
        return newJob;
    }

    /**
     * Start FTP transfer to storage
     */
    async _startTransferToStorageAsync(jobId, cameraId) {
        if (this.shouldStop) return;
        
        if (!this.pauseVideoTransferFromConfig) {
            console.log('[FTP_TRANSFER] _startTransferToStorageAsync: FTP video transfer is disabled in config');
            return;
        }

        if (this.isTransferringToStorageRunning) {
            console.log('[FTP_TRANSFER] _startTransferToStorageAsync: FTP transfer is already running');
            return;
        }

        this.isTransferringToStorageRunning = true;

        // Check FTP connection
        if (!this.isFtpConnected) {
            console.log('[FTP_TRANSFER] _startTransferToStorageAsync: FTP not connected');
            this.isTransferringToStorageRunning = false;
            return;
        }
        
        // Get pending transfer file
        const fileToTransfer = await this.ftpTransferManager.getPendingTransferFileForJob(jobId, cameraId);
        
        if (!fileToTransfer) {
            this.isTransferringToStorageRunning = false;
            return;
        }
        
        console.log(`[FTP_TRANSFER] _startTransferToStorageAsync: Processing ${fileToTransfer.video_file_name} for FTP transfer`);
        
        try {
            // Transfer file via FTP
            await this.ftpTransferManager.transferFile(fileToTransfer);
            
            // Mark source files as FTP transferred
            await this.ftpTransferManager.markSourceFilesAsTransferred(fileToTransfer);
            
            // Clean up temporary video file
            if (fileToTransfer.video_file_path.includes(path.basename(this.VIDEO_TEMP_DIR))) {
                await this.ftpTransferManager.cleanupTempVideo(fileToTransfer.video_file_path);
            }
            
            // Check if all files in the job have been transferred
            await this.ftpJobManager.checkAndCompleteJob(fileToTransfer.job_id);
            
            console.log(`[FTP_TRANSFER] _startTransferToStorageAsync: Post-transfer cleanup completed for: ${fileToTransfer.video_file_name}`);
            
            // Update and publish video transfer metrics
            await this._updateAndPublishVideoMetrics();

        } catch (error) {
            console.error(`[FTP_TRANSFER] _startTransferToStorageAsync: Failed to transfer file ${fileToTransfer.id}:`, error);
            await this.ftpTransferManager.handleTransferError(fileToTransfer, error);
        }

        this.isTransferringToStorageRunning = false;
    }

    /**
     * Cleanup loop for FTP service
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
     * Buffer monitoring loop for FTP service
     */
    async _runBufferMonitoringLoop() {
        if (this.shouldStop) return;
        
        try {
            // Check for ready groups in FTP buffer
            await this.ftpBufferManager.checkReadyGroupsInBuffer();
        } catch (error) {
            this.emit('error', error);
        } finally {
            // Run buffer monitoring every 30 seconds
            setTimeout(() => this._runBufferMonitoringLoop(), 30000);
        }
    }

    /**
     * FTP connection monitoring loop
     */
    async _runFtpConnectionMonitoring() {
        if (this.shouldStop) return;
        
        const now = Date.now();
        if (now - this.lastFtpTestTime > this.ftpTestInterval) {
            this.lastFtpTestTime = now;
            
            try {
                if (this.ftpTransferManager && this.ftpConfig) {
                    const testResult = await this.ftpTransferManager.testFtpConnection();
                    this.isFtpConnected = testResult.success;
                    
                    if (!testResult.success) {
                        console.error(`[FTP_CONNECTION] FTP connection test failed: ${testResult.message}`);
                    } else {
                        console.log('[FTP_CONNECTION] FTP connection test successful');
                    }
                }
            } catch (error) {
                this.isFtpConnected = false;
                console.error('[FTP_CONNECTION] FTP connection test error:', error);
            }
        }
        
        // Run connection monitoring every 10 seconds
        setTimeout(() => this._runFtpConnectionMonitoring(), 10000);
    }

    // ===== CONFIGURATION AND STATE MANAGEMENT =====

    /**
     * Subscribe to Redis events
     */
    _subscribeToRedisEvents() {
        console.log('[AUTO_FTP_SERVICE] _subscribeToRedisEvents: Subscribing to Redis events...');
        this.redisSub.subscribe(CONFIG_FTP_STATE_KEY + '_update');

        this.redisSub.on('message', (channel, message) => {
            if (channel.startsWith(CONFIG_FTP_STATE_KEY)) {
                this.systemConfig = JSON.parse(message);
                // console.log('[AUTO_FTP_SERVICE] _subscribeToRedisEvents: Redis event received...');
                // console.log(JSON.stringify(this.systemConfig, null, 2));
                this.emit('configChanged');
            }
        });
    }

    /**
     * Update service configuration from Redis
     */
    async _updateServiceConfig() {
        try {
            const configStr = await this.redis.get(CONFIG_FTP_STATE_KEY);
            console.log('[AUTO_FTP_SERVICE] _updateServiceConfig: ');
            if (configStr) {
                this.serviceConfig = JSON.parse(configStr);
                this.currentSiteId = 'TEST_SITE_ID' || '';
                // console.log({
                //     transfer: this.serviceConfig.transfer,
                //     startTransfer: this.serviceConfig.transfer.startTransfer
                // });
                
                // Update external services with new config
                if (this.ftpJobManager) {
                    this.ftpJobManager.setCurrentSiteId(this.currentSiteId);
                }
                if (this.ftpBufferManager) {
                    this.ftpBufferManager.setCurrentSiteId(this.currentSiteId);
                }
                
                this.pauseVideoTransferFromConfig = this.serviceConfig.transfer ? this.serviceConfig.transfer.startTransfer : false;
                // console.log({
                //     pauseVideoTransferFromConfig: this.pauseVideoTransferFromConfig
                // });
            }
        } catch (error) {
            console.error('[FTP_CONFIG_ERROR] _updateServiceConfig: Failed to update service config:', error);
        }
    }

    /**
     * Check if transfer should start based on schedule
     */
    _shouldStartTransfer() {
        if (!this.ftpConfig || !this.ftpConfig.transferSchedule) {
            return true; // If no schedule config, always allow
        }

        const schedule = this.ftpConfig.transferSchedule;
        const now = new Date();

        // Check if transfer is enabled
        if (!schedule.scheduleType || schedule.scheduleType === 'disabled') {
            return false;
        }

        if (schedule.scheduleType === 'immediate') {
            return true;
        }

        if (schedule.scheduleType === 'scheduled') {
            // Check day of week
            if (schedule.dayOfWeek) {
                const currentDay = now.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase(); // mon, tue, etc.
                if (currentDay !== schedule.dayOfWeek.toLowerCase().substring(0, 3)) {
                    return false;
                }
            }

            // Check time
            if (schedule.transferTime) {
                const [scheduleHour, scheduleMinute] = schedule.transferTime.split(':').map(Number);
                const currentHour = now.getHours();
                const currentMinute = now.getMinutes();
                
                // Allow transfer within 1 hour window
                const scheduleMinutes = scheduleHour * 60 + scheduleMinute;
                const currentMinutes = currentHour * 60 + currentMinute;
                
                return Math.abs(currentMinutes - scheduleMinutes) <= 60; // 1 hour window
            }
        }

        return true;
    }

    /**
     * Publish FTP video transfer metrics to Redis
     */
    async _publishVideoTransferMetrics(metrics) {
        try {
            const metricsData = {
                type: 'video',
                timestamp: new Date().toISOString(),
                ...metrics
            };
            
            await this.redis.publish(FTP_VIDEO_METRICS_KEY + '_update', JSON.stringify(metricsData));
            await this.redis.set(FTP_VIDEO_METRICS_KEY, JSON.stringify(metricsData), 'EX', 300);
            
        } catch (error) {
            console.error('[AUTO_FTP_SERVICE] Error publishing video metrics:', error);
        }
    }

    /**
     * Update and publish current video transfer metrics
     */
    async _updateAndPublishVideoMetrics(jobData = null) {
        try {
            // Get basic stats from job manager if available
            let jobStats = {};
            let transferStats = {};
            
            if (this.ftpJobManager) {
                jobStats = await this.ftpJobManager.getTransferStatistics() || {};
            }
            
            if (this.ftpTransferManager) {
                transferStats = await this.ftpTransferManager.getCurrentTransferStats() || {};
            }
            
            const metrics = {
                jobsActive: jobStats.activeJobs || 0,
                jobsCompleted: jobStats.completedJobs || 0,
                videosInQueue: jobStats.videosInQueue || 0,
                videosTransferred: jobStats.videosTransferred || 0,
                currentTransferFile: transferStats.currentFile || null,
                transferSpeed: transferStats.speed || 0,
                connectionStatus: this.isFtpConnected ? 'connected' : 'disconnected',
                serverHost: (this.ftpConfig && this.ftpConfig.server && this.ftpConfig.server.host) ? this.ftpConfig.server.host : 'N/A',
                progress: transferStats.progress || 0,
                eta: transferStats.eta || null,
                lastUpdated: new Date().toISOString()
            };
            
            if (jobData) {
                metrics.currentJob = {
                    id: jobData.id,
                    batchId: jobData.batch_id,
                    status: jobData.status
                };
            }
            
            await this._publishVideoTransferMetrics(metrics);
            
        } catch (error) {
            console.error('[AUTO_FTP_SERVICE] Error updating video metrics:', error);
        }
    }
}

// ===== MAIN APPLICATION ENTRY POINT =====

async function main() {
    const config = require('./utils/envConfig.js');
    const ftpVideoService = new AutoFtpVideoTransferService(config);

    await ftpVideoService.start();

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('[FTP_MAIN] Shutting down FTP service...');
        await ftpVideoService.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('[FTP_MAIN] Shutting down FTP service...');
        await ftpVideoService.stop();
        process.exit(0);
    });
}

// Export the class for testing
module.exports = { AutoFtpVideoTransferService };

// Run if this file is executed directly
if (require.main === module) {
    main().catch(error => {
        console.error("Fatal error during FTP service initialization:", error);
        process.exit(1);
    });
}

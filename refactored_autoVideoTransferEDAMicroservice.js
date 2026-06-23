const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const encryptionService = require('./utils/encryptionService');
const { sleep } = require('./utils.js');
const { CONFIG_STATE_KEY, CONNECTED_DRIVE_LIST } = require('./redisKeyStore.js');
const { createLogger, runWithTrace, newTraceId, addTraceField } = require('./utils/logger');

// Import external classes
const VideoProcessor = require('./services/video-transfer/processors/VideoProcessor');
const FileTransferManager = require('./services/video-transfer/transfer/FileTransferManager');
const JobManager = require('./services/video-transfer/state/JobManager');
const ProcessingStateManager = require('./services/video-transfer/state/ProcessingStateManager');
const SpaceValidator = require('./services/video-transfer/validators/SpaceValidator');
const CleanupService = require('./services/shared/CleanupService');
const CompleteBufferManager = require('./services/video-transfer/processors/CompleteBufferManager');

const logger = createLogger({ service: 'autoVideoTransferEDAMicroservice', logFile: 'video-usb-pipeline' });

class UnifiedVideoTransferService extends EventEmitter {
    constructor(config) {
        super();
        
        // Configuration
        this.config = config || require('./utils/envConfig');
        this.mainConfig = {}
        this.currentSiteId = '';
        
        // Database and Redis connections
        this.pool = null;
        this.redis = null;
        this.redisSub = null;
        this.redisMetrics = null;
        
        // Service state
        this.pauseVideoTransferFromConfig = false;
        this.isTransferringToStorageRunning = false;
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
        
        // Processing constants
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = this.config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
        this.ISS_MEDIA_CAMERAS = this.config.ISS_MEDIA_CAMERAS || ['1', '2'];
        this.VIDEO_TEMP_DIR = path.join(__dirname, 'temp_video_processing');
        
        // Schedule-related state
        this.scheduleConfig = {};
        this.isScheduledTransfer = false;
        this.isInScheduledWindow = false;
        this.nextScheduledRun = null;
        this.currentScheduleStatus = 'immediate_active';
        this.scheduleWindowStart = null;
        this.scheduleWindowEnd = null;
        
        // External service instances (initialized after DB/Redis connections)
        this.videoProcessor = null;
        this.fileTransferManager = null;
        this.jobManager = null;
        this.processingStateManager = null;
        this.spaceValidator = null;
        this.cleanupService = null;
        this.bufferManager = null;

        // Bind event handlers
        this._bindEventHandlers();
    }

    /**
     * Calculate next scheduled run time
     */
    _calculateNextScheduledRun(scheduleConfig) {
        if (!scheduleConfig || scheduleConfig.type !== 'scheduled') {
            return null;
        }

        const now = new Date();
        const next = new Date();

        switch (scheduleConfig.mode) {
            case 'daily':
                next.setHours(scheduleConfig.hour, 0, 0, 0);
                if (next <= now) {
                    next.setDate(next.getDate() + 1);
                }
                break;
                
            case 'weekly':
                const dayOfWeek = scheduleConfig.dayOfWeek || 1; // Default to Monday
                const daysUntilNext = (7 + dayOfWeek - now.getDay()) % 7;
                next.setDate(now.getDate() + (daysUntilNext === 0 ? 7 : daysUntilNext));
                next.setHours(scheduleConfig.hour, 0, 0, 0);
                break;
                
            default:
                return null;
        }

        return next;
    }

    /**
     * Check if currently in scheduled window
     */
    _isInScheduledWindow(scheduleConfig) {
        if (!scheduleConfig || scheduleConfig.type !== 'scheduled') {
            return false;
        }

        const now = new Date();
        const scheduleTime = new Date();
        
        switch (scheduleConfig.mode) {
            case 'daily':
                scheduleTime.setHours(scheduleConfig.hour, 0, 0, 0);
                // Allow 2-hour window for daily transfers
                const endTime = new Date(scheduleTime);
                endTime.setHours(endTime.getHours() + 2);
                return now >= scheduleTime && now <= endTime;
                
            case 'weekly':
                const dayOfWeek = scheduleConfig.dayOfWeek || 1;
                if (now.getDay() !== dayOfWeek) {
                    return false;
                }
                scheduleTime.setHours(scheduleConfig.hour, 0, 0, 0);
                const weeklyEndTime = new Date(scheduleTime);
                weeklyEndTime.setHours(weeklyEndTime.getHours() + 4); // 4-hour window for weekly
                return now >= scheduleTime && now <= weeklyEndTime;
                
            default:
                return false;
        }
    }

    /**
     * Update schedule status
     */
    _updateScheduleStatus() {
        if (!this.isScheduledTransfer) {
            this.currentScheduleStatus = 'immediate_active';
            return;
        }

        const inWindow = this._isInScheduledWindow(this.scheduleConfig);
        
        if (inWindow) {
            this.currentScheduleStatus = 'scheduled_running';
            this.isInScheduledWindow = true;
            this.scheduleWindowStart = new Date();
        } else {
            this.currentScheduleStatus = 'scheduled_pending';
            this.isInScheduledWindow = false;
            this.nextScheduledRun = this._calculateNextScheduledRun(this.scheduleConfig);
        }

        logger.info('[VIDEO_SERVICE_SCHEDULE] _updateScheduleStatus: Status: ' + this.currentScheduleStatus + ', Next run: ' + this.nextScheduledRun + ', In window: ' + this.isInScheduledWindow);
    }

    /**
     * Bind all event handlers
     */
    _bindEventHandlers() {
        this.on('start', this._handleStart);
        this.on('filesReady', this._handleFilesReady);
        this.on('videoCreated', this._handleVideoCreated);
        this.on('startTransferToStorage', this._startTransferToStorageAsync);
        this.on('configChanged', this._handleConfigChanged);
        this.on('driveChanged', this._handleDriveChanged);
        this.on('error', this._handleError);
        this.on('cleanup', this._handleCleanup);
    }

    /**
     * Initialize and start the service
     */
    async start() {
        logger.info('-------------------------------------------------------');
        logger.info('[SERVICE] start: Starting Unified Video Transfer Service...');
        logger.info('-------------------------------------------------------');
        this.shouldStop = false;

        try {
            this.pool = new Pool({
                user: this.config.database.user,
                host: this.config.database.host,
                database: this.config.database.database,
                port: 5432,
                password: this.config.database.password
            });

            this.pool.on('error', (err) => {
                logger.error('[DB_ERROR] start: Unexpected error on idle client', { error: err.message, stack: err.stack });
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
            this.redisMetrics = new Redis(redisOptions);

            // Ensure temp directory exists
            await fs.ensureDir(this.VIDEO_TEMP_DIR);

            // Wait a moment for connections to establish
            await new Promise(resolve => setTimeout(resolve, 1000));

            // Initialize external services
            this._initializeExternalServices();

            // Subscribe to Redis events
            this._subscribeToRedisEvents();

            // Load initial configuration
            await this._updateServiceConfig();
            await this._updateDriveInfo();

            this.emit('start');

        } catch (error) {
            logger.error('[SERVICE] start: Failed to initialize:', { error: error.message, stack: error.stack });
            this.emit('error', error);
        }
    }

    /**
     * Initialize external service instances
     */
    _initializeExternalServices() {
        this.videoProcessor = new VideoProcessor(this, this.config);
        this.fileTransferManager = new FileTransferManager(this, this.pool, this.redis, encryptionService, this.config);
        this.processingStateManager = new ProcessingStateManager(this, this.pool, this.redis, this.config);
        this.jobManager = new JobManager(this, this.pool, this.redis, this.config, this.processingStateManager);
        this.spaceValidator = new SpaceValidator(this, this.config);
        this.cleanupService = new CleanupService(this, this.pool, this.redis, this.config);
        this.bufferManager = new CompleteBufferManager(this, this.pool, this.config, this.videoProcessor, this.jobManager);
        
        logger.info('[SERVICE] _initializeExternalServices: External services initialized successfully');
    }

    /**
     * Publish video transfer metrics to Redis
     */
    publishVideoTransferMetrics(type, data) {
        try {
            if (!this.redisMetrics) return;
            
            const metricsPayload = {
                serviceType: 'video',
                type: type, // 'job_start', 'camera_progress', 'video_created', 'transfer_start', 'transfer_complete'
                data: Object.assign({}, data, {
                    scheduleStatus: this.currentScheduleStatus,
                    isScheduled: this.isScheduledTransfer,
                    nextScheduledRun: this.nextScheduledRun,
                    timestamp: new Date().toISOString(),
                    serviceName: 'UnifiedVideoTransferService'
                })
            };
            
            this.redisMetrics.publish('usb_video_transfer_metrics', JSON.stringify(metricsPayload));
            logger.info('[VIDEO_SERVICE] Published metrics', { metricsType: type, jobId: data.jobId || 'unknown' });
        } catch (error) {
            logger.error('[VIDEO_SERVICE] Error publishing metrics:', { error: error.message });
        }
    }

    /**
     * Stop the service gracefully
     */
    async stop() {
        logger.info('[SERVICE] UnifiedVideoTransferService.stop: Stopping Unified Video Transfer Service...');
        this.shouldStop = true;
        this.removeAllListeners();

        if (this.redisSub) await this.redisSub.quit();
        if (this.redis) await this.redis.quit();
        if (this.redisMetrics) await this.redisMetrics.quit();
        if (this.pool) await this.pool.end();

        logger.info('[SERVICE] UnifiedVideoTransferService.stop: Service stopped gracefully');
    }

    // ===== EVENT HANDLERS =====

    /**
     * Handle service start event
     */
    _handleStart = async () => {
        logger.info('[EVENT] UnifiedVideoTransferService._handleStart: Service started - beginning processing loops');
        
        try {
            this._runProcessingLoop();
            this._runCleanupLoop();
            this._runBufferMonitoringLoop();
            
            logger.info('[EVENT] All processing loops started successfully');
            
        } catch (error) {
            this.emit('error', error);
        }
    };

    /**
     * Handle files ready for processing
     */
    _handleFilesReady = async (files, job) => {
        logger.info(`[EVENT] UnifiedVideoTransferService._handleFilesReady: Processing ${files.length} files ready for video creation for job ${job.id}`);
        
        try {
            // Mark files as being processed
            await this.processingStateManager.markFilesAsProcessing(files);
            
            // Group files by camera
            const groups = this.processingStateManager.groupFilesByCamera(files, job.id);
            
            logger.info(`[EVENT] UnifiedVideoTransferService._handleFilesReady: Job ${job.id} - Created ${groups.length} groups from ${files.length} files`);
            
            for (const group of groups) {
                logger.info(`[EVENT] UnifiedVideoTransferService._handleFilesReady: Job ${job.id} - Processing group for camera ${group.camera_id}, date ${group.date}, interval ${group.interval_start}-${group.interval_end}`);
                
                // Check for duplicate video
                const isDuplicate = await this.processingStateManager.checkDuplicateVideo(group, job.id);
                if (isDuplicate) {
                    logger.info(`[EVENT] UnifiedVideoTransferService._handleFilesReady: Job ${job.id} - Skipping duplicate video for camera ${group.camera_id}, interval ${group.interval_start}-${group.interval_end}`);
                    continue;
                }
                
                // Check space before processing using SpaceValidator
                const spaceValidation = this.spaceValidator.validateProcessingSpace(group.files);
                if (!spaceValidation.canProceed) {
                    logger.info(`[EVENT] UnifiedVideoTransferService._handleFilesReady: Job ${job.id} - ${spaceValidation.reason}: ${spaceValidation.estimatedSpaceMB}MB needed`);
                    continue;
                }
                
                // Add files to buffer and convert them using BufferManager with job_id
                await this.bufferManager.processFilesToBuffer(group, job.id);
            }
            
        } catch (error) {
            // Remove processing markers on error
            await this.processingStateManager.removeProcessingMarkers(files);
            this.emit('error', error);
        }
    };

    /**
     * Handle video creation completion
     */
    _handleVideoCreated = async (videoData, jobId) => {
        logger.info(`[EVENT] UnifiedVideoTransferService._handleVideoCreated: Video created: ${videoData.videoName} for job ${jobId}`);
        
        try {
            // // Add video to transfer queue using JobManager
            await this.jobManager.addVideoToTransferQueue(videoData, jobId);
            
            // // Mark camera as processed
            await this.jobManager.addCameraToProcessed(jobId, videoData.camera_id);
            
            // // Update job stats
            await this.jobManager.updateJobStats(jobId);
            
            // Remove processing markers for source files
            const sourceFiles = videoData.sourceFileIds.map(id => ({ id }));
            await this.processingStateManager.removeProcessingMarkers(sourceFiles);
            
            logger.info(`[EVENT] UnifiedVideoTransferService._handleVideoCreated: Video queued for transfer: ${videoData.videoName}`);
            
        } catch (error) {
            this.emit('error', error);
        }
    };


    /**
     * Handle configuration changes
     */
    _handleConfigChanged = async () => {
        await this._updateServiceConfig();
    };

    /**
     * Handle drive changes
     */
    _handleDriveChanged = async () => {
        await this._updateDriveInfo();
    };

    /**
     * Handle errors
     */
    _handleError = (error) => {
        logger.error('[EVENT] Service error:', { error: error.message, stack: error.stack });
        
        if (this.bufferManager) {
            const stats = this.bufferManager.getVideoStats();
            stats.errorsCount++;
        }
    };

    _handleCleanup = async () => {
        logger.info('[EVENT] Running cleanup tasks');
        
        try {
            await this.cleanupService.runAllCleanupTasks();
        } catch (error) {
            this.emit('error', error);
        }
    };

    // ===== MAIN PROCESSING LOOPS =====

    /**
     * Main video processing loop - Refactored with advanced job management
     */
    async _runProcessingLoop() {

        if (this.shouldStop) return;
        if (this.pauseVideoTransferFromConfig) {
            logger.info('[PROCESSING] UnifiedVideoTransferService._runProcessingLoop: Video transfer is disabled in config');
            setTimeout(() => this._runProcessingLoop(), 2000);
            return;
        }
        
        try {
            if (this.isProcessing) {
                setTimeout(() => this._runProcessingLoop(), 2000);
                return;
            }

            this.isProcessing = true;
            logger.info('[PROCESSING] UnifiedVideoTransferService._runProcessingLoop: running processing loop start point');

            const isEnabled = this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.isActive &&
                              ['videos', 'both'].includes(this.serviceConfig.autoTransfer.dataType);
            logger.debug('[PROCESSING] Transfer enabled check', {
                isEnabled,
                dataType: this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.dataType,
                isActive: this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.isActive
            });

            if (!isEnabled) {
                logger.info('[PROCESSING] UnifiedVideoTransferService._runProcessingLoop: Video transfer is disabled in config');
                return;
            }
            
            if (this.isScheduledTransfer && !this.isInScheduledWindow) {
                logger.info('[PROCESSING_SCHEDULE] Scheduled video transfer — waiting for window', { nextScheduledRun: this.nextScheduledRun, scheduleStatus: this.currentScheduleStatus });
                this._updateScheduleStatus();
                return;
            }

            if (this.isScheduledTransfer && this.isInScheduledWindow) {
                logger.info('[PROCESSING_SCHEDULE] In scheduled transfer window — processing videos');
            }
            
            if (!this.spaceValidator.isDriveReady()) {
                const driveStatus = this.spaceValidator.getDriveStatus();
                logger.warn(`[PROCESSING_CHECK_DRIVE] Processing paused: ${driveStatus.reason}`);
                return;
            }

            // ===== STEP 1: Look for existing jobs that aren't completed (newest first) =====
            const existingJobs = await this.jobManager.getExistingUncompletedJobs();
            logger.info(`[PROCESSING] Found ${existingJobs.length} existing uncompleted jobs`);
            
            if (existingJobs.length > 0) {
                const activeJob = existingJobs[0];
                await runWithTrace({ traceId: activeJob.batch_id, jobId: activeJob.batch_id, jobDbId: activeJob.id, jobStatus: activeJob.status }, async () => {
                    logger.info('[PROCESSING] Found active job', { jobId: activeJob.batch_id, jobDbId: activeJob.id, status: activeJob.status, phase: 'session-resume' });
                    await this._handleJobProcessing(activeJob);
                });
                return;
            }

            // ===== STEP 2: Create new job (no active job found) =====
            const newJob = await this._createNewJobIfFilesAvailable();
            if (!newJob) {
                logger.info('[PROCESSING] No files available to create new job');
                return;
            }

            await runWithTrace({ traceId: newJob.batch_id, jobId: newJob.batch_id, jobDbId: newJob.id, jobStatus: 'created' }, async () => {
                logger.info(`[PROCESSING] Created new job: ${newJob.batch_id}`, { jobId: newJob.batch_id, jobDbId: newJob.id, phase: 'session-start', cameras: this.ISS_MEDIA_CAMERAS });
                await this._handleJobProcessing(newJob);
            });
            
        } catch (error) {
            this.emit('error', error);
        } finally {
            this.isProcessing = false;
            setTimeout(() => this._runProcessingLoop(), 5000);
        }
    }

    /**
     * Handle job with 'created' status - collecting media files phase
     */
    async _handleJobProcessing(job) {
        logger.info(`[PROCESSING] Handling job: ${job.batch_id}`, { jobId: job.batch_id, jobDbId: job.id });
        
        this.publishVideoTransferMetrics('job_start', {
            jobId: job.batch_id,
            totalCameras: this.ISS_MEDIA_CAMERAS.length,
            conversionTarget: this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT
        });
        
        // Check camera file counts in video_converted_buffer for this specific job
        const cameraJobPromises = [];
        
        // For each camera in ISS_MEDIA_CAMERAS, ensure it has 38 files in buffer for this job
        for (const camera of this.ISS_MEDIA_CAMERAS) {
            const cameraId = camera.replace('CAM_', '');
            let singleCameraJobPromise = this._processSingleCameraJob(job, cameraId);
            cameraJobPromises.push(singleCameraJobPromise);
        }

        logger.info(`[PROCESSING] Job ${job.id} - Waiting for all cameras to be processed`);
        await Promise.all(cameraJobPromises);
        logger.info(`[PROCESSING] Job ${job.id} - All cameras processed`);
        
        return null;
    }

    async _processSingleCameraJob(job, cameraId) {
        addTraceField('camera', cameraId);
        logger.info(`[PROCESSING] Processing camera ${cameraId} for job ${job.id}`, { phase: 'camera-start' });

        logger.info(`[PROCESSING] Checking transfer queue for camera ${cameraId}`, { phase: 'camera-start' });

        let videoInTransferQueue = await this.jobManager.getVideoInTransferQueue(job.id, cameraId);
        if (videoInTransferQueue) {
            logger.info(`[PROCESSING] Video already in transfer queue for camera ${cameraId}`, { queueStatus: videoInTransferQueue.status });
            if (videoInTransferQueue.status === 'pending') {
                this.emit('startTransferToStorage', job.id, cameraId, job.batch_id);
            }
            return;
        }

        const cameraFileStatusCounts = await this.jobManager.getCameraFileCountsStatusBufferCheck(job.id, cameraId);
        const cameraPendingCount = cameraFileStatusCounts.pending || 0;
        const cameraConvertedCount = cameraFileStatusCounts.converted || 0;
        const cameraGroupedCount = cameraFileStatusCounts.grouped || 0;

        logger.info(`[PROCESSING] Camera ${cameraId}: ${cameraPendingCount} pending, ${cameraConvertedCount} converted, ${cameraGroupedCount} grouped`, { phase: 'buffer-status', cameraPendingCount, cameraConvertedCount, cameraGroupedCount });
        const currentCount = cameraPendingCount + cameraConvertedCount + cameraGroupedCount;
        const convertedGroupeCount = cameraGroupedCount + cameraConvertedCount;
        
        logger.info(`[PROCESSING] Camera ${cameraId}: ${convertedGroupeCount}/${this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files in buffer`, { phase: 'buffer-status', progress: convertedGroupeCount, target: this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT });

        // Publish camera progress metrics
        this.publishVideoTransferMetrics('camera_progress', {
            jobId: job.batch_id,
            cameraId: cameraId,
            pendingCount: cameraPendingCount,
            convertedCount: cameraConvertedCount,
            groupedCount: cameraGroupedCount,
            totalCount: currentCount,
            convertedGroupedCount: convertedGroupeCount,
            targetCount: this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT,
            progressPercentage: Math.round((convertedGroupeCount / this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) * 100)
        });

        if (convertedGroupeCount < this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            addTraceField('phase', 'buffer-fill');
            logger.info(`[PROCESSING] Camera ${cameraId}: requesting additional files`, { phase: 'buffer-fill' });
            
            if (cameraPendingCount > 0) {
                logger.info(`[PROCESSING] Camera ${cameraId} has ${cameraPendingCount} pending files to convert`, { phase: 'buffer-fill' });
                const buffereRecords = await this.jobManager.requestPendingRecordsForCamera(cameraId, job.id);
                logger.info(`[PROCESSING] Camera ${cameraId}: ${buffereRecords.length} pending records`, { phase: 'buffer-fill', recordCount: buffereRecords.length });
                for (const record of buffereRecords) {
                    const file = await this.jobManager.getMediaFileById(record.source_file_id);
                    if (!file) {
                        logger.warn(`[PROCESSING] File not found for buffer record ${record.id}`, { phase: 'buffer-fill', bufferId: record.id });
                        await this.bufferManager.markBufferEntryAsFailed(record.id, 'File not found');
                        continue;
                    }
                    await this.bufferManager.convertSingleFile(file, record, null);
                }

                return;
            } else {

                const additionalFiles = await this.jobManager.requestAdditionalFilesForCamera(
                    cameraId, currentCount, this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT, job.id
                );

                if (additionalFiles.length > 0) {
                    logger.info(`[PROCESSING] Camera ${cameraId}: adding ${additionalFiles.length} files to processing queue`, { phase: 'buffer-fill', fileCount: additionalFiles.length });
                    
                    await this.processingStateManager.markFilesAsProcessing(additionalFiles);

                    for (const file of additionalFiles) {
                        const bufferRecord = await this.bufferManager.storeFileInBufferAsPending(
                            file, null, null, null, job.id, null
                        );
                        await this.bufferManager.convertSingleFile(file, bufferRecord, null);
                    }

                } else {
                    logger.info(`[PROCESSING] Camera ${cameraId}: no additional files available`, { phase: 'buffer-fill' });
                }

            }
            
            
        }

        if (cameraPendingCount > 0) {
            if (job.status !== 'pending') {
                await this.jobManager.updateJobStatus(job.id, 'pending');
            }
            logger.info(`[PROCESSING] Camera ${cameraId}: processing pending conversions`, { phase: 'buffer-fill' });
        }
        
        if (cameraConvertedCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            addTraceField('phase', 'group');
            const groupName = await this.processingStateManager.groupFilesByCamera(cameraId, job.id);
            if (groupName) {
                logger.info(`[PROCESSING] Camera ${cameraId}: grouped files`, { phase: 'group', groupName });
            }
        }

        if (cameraGroupedCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            let videoInTransferQueue = false;

            videoInTransferQueue = await this.jobManager.getVideoInTransferQueue(job.id, cameraId);
            logger.info(`[PROCESSING] Camera ${cameraId}: checking transfer queue after grouping`, { phase: 'pre-concat', hasQueue: !!videoInTransferQueue });

            if (videoInTransferQueue) {
                if (videoInTransferQueue.status === 'pending') {
                    logger.info(`[PROCESSING] Camera ${cameraId}: video pending in transfer queue, triggering transfer`, { phase: 'pre-concat' });
                    this.emit('startTransferToStorage', job.id, cameraId, job.batch_id);
                }
                return;
            }

            const spaceValidation = this.spaceValidator.validateProcessingSpace();
            if (!spaceValidation.canProceed) {
                logger.warn(`[PROCESSING] Camera ${cameraId}: insufficient space for video build`, { phase: 'pre-concat', reason: spaceValidation.reason, estimatedSpaceMB: spaceValidation.estimatedSpaceMB });
                return;
            }

            addTraceField('phase', 'concat');
            const t0 = Date.now();
            const videoData = await this.bufferManager.createVideoFromBuffer(job.id, cameraId);
            const buildDurationMs = Date.now() - t0;

            if (!videoData) {
                logger.error(`[PROCESSING] Camera ${cameraId}: video build returned null`, { phase: 'concat', durationMs: buildDurationMs });
                return;
            }

            logger.info(`[EVENT] Video created for camera ${cameraId}`, { phase: 'concat', videoName: videoData.videoName, durationMs: buildDurationMs, groupKey: videoData.group_key });

            this.publishVideoTransferMetrics('video_created', {
                jobId: job.batch_id,
                cameraId: cameraId,
                videoName: videoData.videoName,
                sourceFileIds: videoData.sourceFileIds,
                sourceFileCount: videoData.sourceFileIds ? videoData.sourceFileIds.length : 0
            });

            try {
                await this.jobManager.addVideoToTransferQueue(videoData, job.id);
                await this.jobManager.addCameraToProcessed(job.id, videoData.camera_id);
                await this.jobManager.updateJobStatsToTransfered(job.id);
                const sourceFiles = videoData.sourceFileIds.map(id => ({ id }));
                await this.processingStateManager.removeProcessingMarkers(sourceFiles);
                
                logger.info(`[EVENT] Video queued for transfer: ${videoData.videoName}`, { phase: 'concat' });

                this.emit('startTransferToStorage', job.id, videoData.camera_id, job.batch_id);
                
            } catch (error) {
                this.emit('error', error);
            }
            
        }
        
    }

    /**
     * Handle job with 'pending' or 'processing' status - conversion phase
     */
    async _handlePendingProcessingJobStatus(job) {
        logger.info(`[PROCESSING] UnifiedVideoTransferService._handlePendingProcessingJobStatus: Handling ${job.status} job: ${job.batch_id}`);
        
        // Check if job is actually complete
        const isComplete = await this.jobManager.checkJobCompletion(job.id) && await this.jobManager.checkJobVideoTransferCompletion(job.id);
        
        if (isComplete) {
            logger.info(`[PROCESSING] UnifiedVideoTransferService._handlePendingProcessingJobStatus: Job ${job.batch_id} is complete - updating to transferred status`);
            await this.jobManager.updateJobStatus(job.id, 'transferred');
            return null;
        }
        
        logger.info(`[PROCESSING] UnifiedVideoTransferService._handlePendingProcessingJobStatus: Job ${job.batch_id} is not complete - waiting for processing to finish`);
        return null; // Wait for completion
    }

    /**
     * Handle job with 'transferring' status
     */
    async _handleTransferringJobStatus(job) {
        logger.info(`[PROCESSING] UnifiedVideoTransferService._handleTransferringJobStatus: Job ${job.batch_id} is transferring - checking completion`);
        
        const isComplete = await this.jobManager.checkJobCompletion(job.id);
        if (isComplete) {
            await this.jobManager.updateJobStatus(job.id, 'transferred');
            logger.info(`[PROCESSING] UnifiedVideoTransferService._handleTransferringJobStatus: Job ${job.batch_id} transfer completed`);
        }
        
        return null; // Don't process new files during transfer
    }

    /**
     * Create new job if files are available for processing
     */
    async _createNewJobIfFilesAvailable() {
        logger.info('[PROCESSING] UnifiedVideoTransferService._createNewJobIfFilesAvailable: Checking file availability before creating job...');

        // ===== STEP 1: Check file availability BEFORE creating job =====
        let totalAvailableFiles = 0;
        const expectedCameras = this.ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
        
        logger.info(`[PROCESSING] UnifiedVideoTransferService._createNewJobIfFilesAvailable: Checking availability for cameras: ${expectedCameras.join(', ')}`);
        
        for (const cameraId of expectedCameras) {
            // Check how many files are available for this camera without creating a job
            const files = await this.jobManager.requestAdditionalFilesForCamera(cameraId, 0, 38, null);
            
            if (files.length === 0) {
                logger.info(`[PROCESSING] UnifiedVideoTransferService._createNewJobIfFilesAvailable: No files available for camera ${cameraId}`);
                continue;
            }
            
            logger.info(`[PROCESSING] UnifiedVideoTransferService._createNewJobIfFilesAvailable: Found ${files.length} available files for camera ${cameraId}`);
            totalAvailableFiles += files.length;
        }
        
        // ===== STEP 2: If no files available, don't create job - just return null =====
        if (totalAvailableFiles === 0) {
            logger.info(`[PROCESSING] UnifiedVideoTransferService._createNewJobIfFilesAvailable: No files available across all cameras. Will retry in next cycle.`);
            return null;
        }
        
        // ===== STEP 3: Files are available, now create the job =====
        logger.info(`[PROCESSING] UnifiedVideoTransferService._createNewJobIfFilesAvailable: Found ${totalAvailableFiles} total files available. Creating new job...`);
        
        const newJob = await this.jobManager.createNewJobWithUUID();
        logger.info(`[PROCESSING] UnifiedVideoTransferService._createNewJobIfFilesAvailable: ✓ Created new job: ${newJob.batch_id} (ID: ${newJob.id})`);
        
        return newJob;
    }

    /**
     * Start transfer to storage
     */
    async _startTransferToStorageAsync(jobId, cameraId, jobBatchId) {

        if (this.shouldStop) return;
        
        if (this.pauseVideoTransferFromConfig) {
            logger.info('[TRANSFER TO STORAGE] Video transfer is disabled in config');
            return;
        }
        
        if (this.isScheduledTransfer && !this.isInScheduledWindow) {
            logger.info('[TRANSFER TO STORAGE] Scheduled transfer — outside window', { nextScheduledRun: this.nextScheduledRun });
            return;
        }

        if (this.isTransferringToStorageRunning) {
            logger.info('[TRANSFER TO STORAGE] Transfer is already running');
            return;
        }

        this.isTransferringToStorageRunning = true;

        if (!this.spaceValidator.isDriveReady()) {
            const driveStatus = this.spaceValidator.getDriveStatus();
            logger.warn(`[TRANSFER TO STORAGE] Paused: ${driveStatus.reason}`);
            return;
        }
        
        const fileToTransfer = await this.fileTransferManager.getPendingTransferFileForJob(jobId, cameraId);
        
        if (!fileToTransfer) {
            return;
        }

        const sessionTraceId = jobBatchId || newTraceId();
        const t0Transfer = Date.now();
        await runWithTrace({ traceId: sessionTraceId, jobId: sessionTraceId, jobDbId: jobId, camera: cameraId, fileName: fileToTransfer.video_file_name, phase: 'transfer', queueId: fileToTransfer.id }, async () => {
            logger.info('[TRANSFER TO STORAGE] Starting file transfer', { fileName: fileToTransfer.video_file_name, fileSize: fileToTransfer.file_size });
            
            this.publishVideoTransferMetrics('transfer_start', {
                jobId: jobId,
                cameraId: cameraId,
                fileName: fileToTransfer.video_file_name,
                fileSize: fileToTransfer.file_size,
                filePath: fileToTransfer.video_file_path
            });
            
            try {
                
                await this.fileTransferManager.transferFile(fileToTransfer);
                await this.fileTransferManager.markSourceFilesAsTransferred(fileToTransfer);
                
                if (fileToTransfer.video_file_path.includes(path.basename(this.VIDEO_TEMP_DIR))) {
                    await this.fileTransferManager.cleanupTempVideo(fileToTransfer.video_file_path);
                }
                
                await this.jobManager.checkAndCompleteJob(fileToTransfer.job_id);
                
                const transferDurationMs = Date.now() - t0Transfer;
                this.publishVideoTransferMetrics('transfer_complete', {
                    jobId: jobId,
                    cameraId: cameraId,
                    fileName: fileToTransfer.video_file_name,
                    fileSize: fileToTransfer.file_size,
                    success: true
                });
                
                logger.info('[TRANSFER TO STORAGE] Transfer session complete', { fileName: fileToTransfer.video_file_name, durationMs: transferDurationMs, phase: 'transfer-done' });

            } catch (error) {

                logger.error('[TRANSFER TO STORAGE] Failed to transfer file', { fileId: fileToTransfer.id, error: error.message, stack: error.stack });
                
                this.publishVideoTransferMetrics('transfer_complete', {
                    jobId: jobId,
                    cameraId: cameraId,
                    fileName: fileToTransfer.video_file_name,
                    fileSize: fileToTransfer.file_size,
                    success: false,
                    error: error.message
                });
                
                const errorResult = await this.fileTransferManager.handleTransferError(fileToTransfer, error);

                this.isTransferringToStorageRunning = false;
                
                if (errorResult.shouldStopProcessing) {
                    this.shouldStopProcessing = true;
                    this.spaceValidator.updateDriveInfo(this.driveInfo, true);
                }
            }
        });
        this.isTransferringToStorageRunning = false;

    }

    /**
     * Cleanup loop
     */
    async _runCleanupLoop() {
        if (this.shouldStop) return;
        
        if (this.pauseVideoTransferFromConfig) {
            logger.info('[CLEANUP] _runCleanupLoop: Video transfer is disabled in config');
            setTimeout(() => this._runCleanupLoop(), 300000);
            return;
        }
        
        // Add schedule check for cleanup
        if (this.isScheduledTransfer && !this.isInScheduledWindow) {
            logger.info('[CLEANUP] _runCleanupLoop: Scheduled transfer - skipping cleanup outside window');
            setTimeout(() => this._runCleanupLoop(), 300000);
            return;
        }

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
        if (this.pauseVideoTransferFromConfig) {
            logger.info('[BUFFER_MONITOR] _runBufferMonitoringLoop: Video transfer is disabled in config');
            setTimeout(() => this._runBufferMonitoringLoop(), 30000);
            return;
        }
        
        // Add schedule check for buffer monitoring
        if (this.isScheduledTransfer && !this.isInScheduledWindow) {
            logger.info('[BUFFER_MONITOR] _runBufferMonitoringLoop: Scheduled transfer - skipping buffer monitoring outside window');
            setTimeout(() => this._runBufferMonitoringLoop(), 30000);
            return;
        }
        
        try {
            // Use BufferManager to check for ready groups
            await this.bufferManager.checkReadyGroupsInBuffer();
        } catch (error) {
            this.emit('error', error);
        } finally {
            // Run buffer monitoring every 30 seconds
            setTimeout(() => this._runBufferMonitoringLoop(), 30000);
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
                this.currentSiteId = (this.serviceConfig.storage && this.serviceConfig.storage.siteId) || '';
                this.isEncryptionRequired = (this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.encryption && this.serviceConfig.autoTransfer.encryption.enabled) || false;
                
                // Update external services with new config
                if (this.fileTransferManager) {
                    this.fileTransferManager.setEncryptionRequired(this.isEncryptionRequired);
                    this.fileTransferManager.setMainConfig(this.serviceConfig);
                    // Update drive info if available
                    if (this.driveInfo) {
                        this.fileTransferManager.setDriveInfo(this.driveInfo);
                    }
                }
                if (this.jobManager) {
                    this.jobManager.setCurrentSiteId(this.currentSiteId);
                }
                if (this.bufferManager) {
                    this.bufferManager.setCurrentSiteId(this.currentSiteId);
                }
                this.pauseVideoTransferFromConfig = !this.serviceConfig.autoTransfer.isActive;
                
                // Update schedule configuration
                this.scheduleConfig = (this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.schedule) || {};
                this.isScheduledTransfer = this.scheduleConfig.type === 'scheduled';

                // Update schedule status
                this._updateScheduleStatus();

                logger.info('[VIDEO_SERVICE_CONFIG] _updateServiceConfig: Schedule config updated:', {
                    type: this.scheduleConfig.type,
                    mode: this.scheduleConfig.mode,
                    isScheduled: this.isScheduledTransfer,
                    status: this.currentScheduleStatus,
                    nextRun: this.nextScheduledRun
                });
            }
        } catch (error) {
            logger.error('[CONFIG_ERROR] _updateServiceConfig: Failed to update service config:', error);
        }
    }

    /**
     * Update drive information from Redis
     */
    async _updateDriveInfo() {
        try {
            const driveListStr = await this.redis.get(CONNECTED_DRIVE_LIST);
            if (!driveListStr) {
                this.isDriveConnected = false;
                this.shouldStopProcessing = true;
                this.spaceValidator.updateDriveInfo(null, true);
                return;
            }

            const driveList = JSON.parse(driveListStr);
            const configuredDrive = this.serviceConfig.autoTransfer && this.serviceConfig.autoTransfer.drive;
            const targetDrive = driveList.find(d => d.drive.startsWith(configuredDrive));

            if (targetDrive) {
                this.driveInfo = targetDrive;
                this.isDriveConnected = true;
                const freeSpaceMB = parseFloat(targetDrive.remainingSpace || 0) * 1024;
                this.shouldStopProcessing = freeSpaceMB <= this.minRequiredSpaceMB;
                
                // Update SpaceValidator with new drive info
                this.spaceValidator.updateDriveInfo(this.driveInfo, this.shouldStopProcessing);
                
                // Update FileTransferManager with new drive info
                if (this.fileTransferManager) {
                    this.fileTransferManager.setDriveInfo(this.driveInfo);
                }
            } else {
                this.isDriveConnected = false;
                this.shouldStopProcessing = true;
                this.spaceValidator.updateDriveInfo(null, true);
                
                // Update FileTransferManager with null drive info
                if (this.fileTransferManager) {
                    this.fileTransferManager.setDriveInfo(null);
                }
            }
            
        } catch (error) {
            logger.error('[DRIVE_ERROR] UnifiedVideoTransferService._updateDriveInfo: Failed to update drive info:', error);
            this.isDriveConnected = false;
            this.shouldStopProcessing = true;
            this.spaceValidator.updateDriveInfo(null, true);
            
            // Update FileTransferManager with null drive info
            if (this.fileTransferManager) {
                this.fileTransferManager.setDriveInfo(null);
            }
        }
    }
}

// ===== MAIN APPLICATION ENTRY POINT =====

async function main() {
    const config = require('./utils/envConfig');
    const videoService = new UnifiedVideoTransferService(config);

    await videoService.start();

    process.on('SIGINT', async () => {
        logger.info('[MAIN] Shutting down service...');
        await videoService.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('[MAIN] Shutting down service...');
        await videoService.stop();
        process.exit(0);
    });
}

module.exports = { UnifiedVideoTransferService };

if (require.main === module) {
    main().catch(error => {
        logger.error('Fatal error during service initialization:', { error: error.message, stack: error.stack });
        process.exit(1);
    });
}

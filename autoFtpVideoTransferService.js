const { EventEmitter } = require('events');
const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const { sleep } = require('./utils.js');
const { CONFIG_FTP_STATE_KEY, FTP_VIDEO_METRICS_KEY } = require('./redisKeyStore.js');
const ftp = require('basic-ftp');
const { createLogger, runWithTrace, newTraceId } = require('./utils/logger');

// Import shared classes (reused from USB service)
const VideoProcessor = require('./services/video-transfer/processors/VideoProcessor.js');
const ProcessingStateManager = require('./services/video-transfer/state/ProcessingStateManager.js');
const CleanupService = require('./services/shared/CleanupService.js');

// Import FTP-specific classes
const FtpTransferManager = require('./services/video-transfer/transfer/FtpTransferManager.js');
const FtpJobManager = require('./services/video-transfer/state/FtpJobManager.js');
const FtpCompleteBufferManager = require('./services/video-transfer/processors/FtpCompleteBufferManager.js');

const logger = createLogger({ service: 'autoFtpVideoTransferService' });

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
        logger.info('[AUTO_FTP_SERVICE] start: Starting FTP Video Transfer Service...');
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
                logger.error('[AUTO_FTP_DB_ERROR] start: Unexpected error on idle client', { error: err.message });
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
            logger.error('[AUTO_FTP_SERVICE] start: Failed to initialize:', { error: error.message, stack: error.stack });
            this.emit('error', error);
        }
    }

    async _loadFtpConfig() {
        try {
            const configPath = path.join(__dirname, 'config', 'ftp-transfer.json');
            this.ftpConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
        } catch (error) {
            logger.error('[AUTO_FTP_SERVICE] _loadFtpConfig: Failed to load FTP configuration:', { error: error.message });
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
        
        logger.info('[AUTO_FTP_SERVICE] _initializeExternalServices: FTP external services initialized successfully');
    }

    /**
     * Stop the service gracefully
     */
    async stop() {
        logger.info('[AUTO_FTP_SERVICE] stop: Stopping FTP Video Transfer Service...');
        this.shouldStop = true;
        this.removeAllListeners();

        if (this.redisSub) await this.redisSub.quit();
        if (this.redis) await this.redis.quit();
        if (this.pool) await this.pool.end();

        logger.info('[AUTO_FTP_SERVICE] stop: FTP service stopped gracefully');
    }

    // ===== EVENT HANDLERS =====

    /**
     * Handle service start event
     */
    _handleStart = async () => {
        logger.info('[AUTO_FTP_EVENT] _handleStart: FTP service started - beginning processing loops');
        
        try {
            this._runProcessingLoop();
            this._runBufferMonitoringLoop();
            this._runFtpConnectionMonitoring();
            logger.info('[AUTO_FTP_EVENT] All FTP processing loops started successfully');
        } catch (error) {
            this.emit('error', error);
        }
    };

    _handleConfigChanged = async () => {
        logger.info('[AUTO_FTP_EVENT] _handleConfigChanged: Config changed');
        await this._updateServiceConfig();
        await this._loadFtpConfig();
        if (this.ftpTransferManager && this.ftpConfig) {
            this.ftpTransferManager.setFtpConfig(this.ftpConfig);
        }
    };

    _handleError = (error) => {
        logger.error('[AUTO_FTP_EVENT] _handleError: FTP service error:', { error: error.message, stack: error.stack });
        if (this.ftpBufferManager) {
            const stats = this.ftpBufferManager.getVideoStats();
            stats.errorsCount++;
        }
    };

    _handleCleanup = async () => {
        logger.info('[AUTO_FTP_EVENT] _handleCleanup: Running FTP cleanup tasks');
        try {
            if (this.ftpBufferManager) await this.ftpBufferManager.cleanupOldBufferEntries();
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
        logger.info('[FTP_PROCESSING] _runProcessingLoop: Starting FTP processing loop...');
        if (this.shouldStop) return;

        if (!this.pauseVideoTransferFromConfig) {
            logger.info('[FTP_TRANSFER] Video transfer disabled in config');
            setTimeout(() => this._runProcessingLoop(), 2000);
            return;
        }

        try {
            if (this.isProcessing) {
                setTimeout(() => this._runProcessingLoop(), 2000);
                return;
            }

            this.isProcessing = true;
            logger.info('[FTP_PROCESSING] Running FTP processing loop');

            const isEnabled = this.serviceConfig.transfer && this.serviceConfig.transfer.startTransfer &&
                              ['video', 'both'].includes(this.serviceConfig.transferSchedule.dataType);

            if (!isEnabled) {
                logger.info('[FTP_PROCESSING] FTP video transfer is disabled in config');
                return;
            }

            if (!this.ftpConfig || !this.ftpConfig.server) {
                logger.info('[FTP_PROCESSING] FTP configuration not available');
                return;
            }

            if (!this._shouldStartTransfer()) {
                logger.info('[FTP_PROCESSING] Not in scheduled transfer time');
                return;
            }

            if (!this.isFtpConnected) {
                logger.info('[FTP_PROCESSING] FTP not connected');
                return;
            }

            const existingJobs = await this.ftpJobManager.getExistingUncompletedJobs();
            logger.info(`[FTP_PROCESSING] Found ${existingJobs.length} existing uncompleted FTP jobs`);
            
            if (existingJobs.length > 0) {
                const activeJob = existingJobs[0];
                await runWithTrace({ traceId: newTraceId(), jobId: activeJob.batch_id, jobStatus: activeJob.status }, async () => {
                    logger.info('[FTP_PROCESSING] Found active FTP job', { jobId: activeJob.batch_id, status: activeJob.status });
                    await this._handleJobProcessing(activeJob);
                });
                return;
            }

            const newJob = await this._createNewJobIfFilesAvailable();
            if (!newJob) {
                logger.info('[FTP_PROCESSING] No files available to create new FTP job');
                return;
            }

            await runWithTrace({ traceId: newTraceId(), jobId: newJob.batch_id, jobStatus: 'created' }, async () => {
                logger.info(`[FTP_PROCESSING] Created new FTP job: ${newJob.batch_id}`);
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
     * Handle FTP job processing
     */
    async _handleJobProcessing(job) {
        logger.info(`[FTP_PROCESSING] Handling FTP job: ${job.batch_id}`, { jobId: job.batch_id, id: job.id });
        
        const cameraJobPromises = [];
        for (const camera of this.ISS_MEDIA_CAMERAS) {
            const cameraId = camera.replace('CAM_', '');
            cameraJobPromises.push(this._processSingleCameraJob(job, cameraId));
        }

        logger.info(`[FTP_PROCESSING] FTP Job ${job.id} - Waiting for all cameras to be processed`);
        await Promise.all(cameraJobPromises);
        logger.info(`[FTP_PROCESSING] FTP Job ${job.id} - All cameras processed`);
        
        await this._updateAndPublishVideoMetrics(job);
    }

    /**
     * Process single camera for FTP job
     */
    async _processSingleCameraJob(job, cameraId) {
        logger.info(`[FTP_PROCESSING] Processing FTP camera ${cameraId} for job ${job.id}`, { camera: cameraId, jobId: job.batch_id });
        
        let videoInTransferQueue = await this.ftpJobManager.getVideoInTransferQueue(job.id, cameraId);
        if (videoInTransferQueue) {
            logger.info(`[FTP_PROCESSING] FTP video already in transfer queue for camera ${cameraId}`, { camera: cameraId });
            if (videoInTransferQueue.status === 'pending') {
                this.emit('startTransferToStorage', job.id, cameraId);
            }
            return;
        }

        const cameraFileStatusCounts = await this.ftpJobManager.getCameraFileCountsStatusBufferCheck(job.id, cameraId);
        const cameraPendingCount = cameraFileStatusCounts.pending || 0;
        const cameraConvertedCount = cameraFileStatusCounts.converted || 0;
        const cameraGroupedCount = cameraFileStatusCounts.grouped || 0;

        logger.info(`[FTP_PROCESSING] FTP Job ${job.id} - Camera ${cameraId} counts`, { camera: cameraId, pending: cameraPendingCount, converted: cameraConvertedCount, grouped: cameraGroupedCount });
        
        const convertedGroupedCount = cameraGroupedCount + cameraConvertedCount;
        
        if (convertedGroupedCount < this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            logger.info(`[FTP_PROCESSING] FTP Job ${job.id} - Requesting additional files for camera ${cameraId}`, { camera: cameraId });
            
            if (cameraPendingCount > 0) {
                const bufferedRecords = await this.ftpJobManager.requestPendingRecordsForCamera(cameraId, job.id);
                logger.info(`[FTP_PROCESSING] Camera ${cameraId} has ${bufferedRecords.length} pending records`, { camera: cameraId, count: bufferedRecords.length });
                
                for (const record of bufferedRecords) {
                    const file = await this.ftpJobManager.getMediaFileById(record.source_file_id);
                    if (!file) {
                        logger.warn(`[FTP_PROCESSING] File not found for record ${record.id}`, { recordId: record.id, camera: cameraId });
                        await this.ftpBufferManager.markBufferEntryAsFailed(record.id, 'File not found');
                        continue;
                    }
                    await this.ftpBufferManager.convertSingleFile(file, record, null);
                }
                return;
            } else {
                const additionalFiles = await this.ftpJobManager.requestAdditionalFilesForCamera(
                    cameraId, convertedGroupedCount, this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT, job.id
                );

                if (additionalFiles.length > 0) {
                    logger.info(`[FTP_PROCESSING] Adding ${additionalFiles.length} files for camera ${cameraId} to FTP processing queue`, { camera: cameraId, count: additionalFiles.length });
                    for (const file of additionalFiles) {
                        const bufferRecord = await this.ftpBufferManager.storeFileInBufferAsPending(file, null, null, null, job.id, null);
                        await this.ftpBufferManager.convertSingleFile(file, bufferRecord, null);
                    }
                } else {
                    logger.info(`[FTP_PROCESSING] No additional files available for camera ${cameraId}`, { camera: cameraId });
                }
            }
        }

        if (cameraPendingCount > 0) {
            if (job.status !== 'pending') {
                await this.ftpJobManager.updateJobStatus(job.id, 'pending');
            }
            logger.info(`[FTP_PROCESSING] FTP Job ${job.id} - processing pending files`, { camera: cameraId });
        }
        
        if (cameraConvertedCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            const groupName = await this.processingStateManager.groupFilesByCamera(cameraId, job.id, 'ftp_video_converted_buffer');
            if (groupName) {
                logger.info(`[FTP_PROCESSING] Grouped files for camera ${cameraId}`, { camera: cameraId, groupName });
            }
        }

        if (cameraGroupedCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            logger.info(`[FTP_PROCESSING] Creating video for camera ${cameraId}`, { camera: cameraId });
            
            try {
                const videoData = await this.ftpBufferManager.createVideoFromBuffer(job.id, cameraId);
                logger.info('[FTP_PROCESSING] Video created from buffer', { videoName: videoData && videoData.videoName });

                await this.ftpJobManager.addVideoToTransferQueue(videoData, job.id);
                await this.ftpJobManager.addCameraToProcessed(job.id, cameraId);
                await this.ftpJobManager.updateJobStatsToTransfered(job.id);
                
                logger.info(`[FTP_PROCESSING] FTP video queued for transfer: ${videoData.videoName}`, { videoName: videoData.videoName, camera: cameraId });
                
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
        logger.info('[FTP_PROCESSING] Checking file availability for FTP transfer...');

        let totalAvailableFiles = 0;
        const expectedCameras = this.ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
        
        for (const cameraId of expectedCameras) {
            const files = await this.ftpJobManager.requestAdditionalFilesForCamera(cameraId, 0, 38, null);
            if (files.length === 0) {
                logger.info(`[FTP_PROCESSING] No files available for FTP camera ${cameraId}`, { camera: cameraId });
                continue;
            }
            logger.info(`[FTP_PROCESSING] Found ${files.length} available files for FTP camera ${cameraId}`, { camera: cameraId, count: files.length });
            totalAvailableFiles += files.length;
        }
        
        if (totalAvailableFiles === 0) {
            logger.info('[FTP_PROCESSING] No files available for FTP transfer');
            return null;
        }
        
        logger.info(`[FTP_PROCESSING] Found ${totalAvailableFiles} total files available. Creating new FTP job...`, { totalFiles: totalAvailableFiles });
        
        const newJob = await this.ftpJobManager.createNewJobWithUUID();
        logger.info(`[FTP_PROCESSING] Created new FTP job: ${newJob.batch_id}`, { jobId: newJob.batch_id, id: newJob.id });
        
        return newJob;
    }

    /**
     * Start FTP transfer to storage
     */
    async _startTransferToStorageAsync(jobId, cameraId) {
        if (this.shouldStop) return;
        
        if (!this.pauseVideoTransferFromConfig) {
            logger.info('[FTP_TRANSFER] FTP video transfer is disabled in config');
            return;
        }

        if (this.isTransferringToStorageRunning) {
            logger.info('[FTP_TRANSFER] FTP transfer is already running');
            return;
        }

        this.isTransferringToStorageRunning = true;

        if (!this.isFtpConnected) {
            logger.info('[FTP_TRANSFER] FTP not connected');
            this.isTransferringToStorageRunning = false;
            return;
        }
        
        const fileToTransfer = await this.ftpTransferManager.getPendingTransferFileForJob(jobId, cameraId);
        
        if (!fileToTransfer) {
            this.isTransferringToStorageRunning = false;
            return;
        }
        
        logger.info(`[FTP_TRANSFER] Processing ${fileToTransfer.video_file_name} for FTP transfer`, { file: fileToTransfer.video_file_name, jobId, camera: cameraId });
        
        try {
            await this.ftpTransferManager.transferFile(fileToTransfer);
            await this.ftpTransferManager.markSourceFilesAsTransferred(fileToTransfer);
            
            if (fileToTransfer.video_file_path.includes(path.basename(this.VIDEO_TEMP_DIR))) {
                await this.ftpTransferManager.cleanupTempVideo(fileToTransfer.video_file_path);
            }
            
            await this.ftpJobManager.checkAndCompleteJob(fileToTransfer.job_id);
            
            logger.info(`[FTP_TRANSFER] Post-transfer cleanup completed for: ${fileToTransfer.video_file_name}`, { file: fileToTransfer.video_file_name });
            
            await this._updateAndPublishVideoMetrics();

        } catch (error) {
            logger.error(`[FTP_TRANSFER] Failed to transfer file ${fileToTransfer.id}:`, { error: error.message, fileId: fileToTransfer.id });
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
                        logger.error(`[FTP_CONNECTION] FTP connection test failed: ${testResult.message}`, { message: testResult.message });
                    } else {
                        logger.info('[FTP_CONNECTION] FTP connection test successful');
                    }
                }
            } catch (error) {
                this.isFtpConnected = false;
                logger.error('[FTP_CONNECTION] FTP connection test error:', { error: error.message });
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
        logger.info('[AUTO_FTP_SERVICE] Subscribing to Redis events...');
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
            logger.info('[AUTO_FTP_SERVICE] Updating service config from Redis');
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
            logger.error('[FTP_CONFIG_ERROR] Failed to update service config:', { error: error.message });
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
            logger.error('[AUTO_FTP_SERVICE] Error publishing video metrics:', { error: error.message });
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
            logger.error('[AUTO_FTP_SERVICE] Error updating video metrics:', { error: error.message });
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
        logger.info('[FTP_MAIN] Shutting down FTP service...');
        await ftpVideoService.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        logger.info('[FTP_MAIN] Shutting down FTP service...');
        await ftpVideoService.stop();
        process.exit(0);
    });
}

// Export the class for testing
module.exports = { AutoFtpVideoTransferService };

// Run if this file is executed directly
if (require.main === module) {
    main().catch(error => {
        logger.error('Fatal error during FTP service initialization:', { error: error.message, stack: error.stack });
        process.exit(1);
    });
}

const Redis = require('ioredis');
const { Pool } = require("pg");
const { CONFIG_STATE_KEY, CONNECTED_DRIVE_STATE, CONNECTED_DRIVE_LIST } = require('./redisKeyStore');
const ImageJobManager = require('./services/image-transfer/state/ImageJobManager');
const ImageTransferManager = require('./services/image-transfer/transfer/ImageTransferManager');
const ImageSpaceValidator = require('./services/image-transfer/validators/ImageSpaceValidator');
const ImageProcessor = require('./services/image-transfer/processors/ImageProcessor');
const TransferUtils = require('./services/shared/TransferUtils');
const encryptionService = require('./utils/encryptionService');
const config = require('./utils/envConfig');
const { createLogger, runWithTrace, newTraceId } = require('./utils/logger');

const logger = createLogger({ service: 'autoUSBImageTransferService', logFile: 'image-usb-pipeline' });

// Database Configuration
let DB_USER = "postgres";
let DB_PASSWORD = "postgres";
let DB_HOST = "localhost";
let DB_APP = "tahakom_transfer";

// Initialize Redis clients
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

const redisPubSub = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

// Redis publisher for metrics
const redisMetrics = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

// Initialize Database Pool
const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD
});

// Initialize Image Transfer Services
const imageJobManager = new ImageJobManager(pool, redis, config);
const imageTransferManager = new ImageTransferManager(pool, redis, config, encryptionService);
const imageSpaceValidator = new ImageSpaceValidator(config);
const imageProcessor = new ImageProcessor(encryptionService, config);

// State Management
let CONFIG_STATE = {};
let DRIVE_INFO = {};
let IS_AUTO_TRANSFER_ACTIVE = true;
let IS_DRIVE_CONNECTED = false;
let SHOULD_STOP_TRANSFER = false;
let SHOULD_STOP_TRANSFER_SIZE = 10; // MB
let IS_ENCRYPTION_REQUIRED = false;
let IS_IMAGE_TRANSFER_ACTIVE = false;

// Schedule-related state
let SCHEDULE_CONFIG = {};
let IS_SCHEDULED_TRANSFER = false;
let IS_IN_SCHEDULED_WINDOW = false;
let NEXT_SCHEDULED_RUN = null;
let CURRENT_SCHEDULE_STATUS = 'immediate_active';
let SCHEDULE_WINDOW_START = null;
let SCHEDULE_WINDOW_END = null;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Schedule management functions
function calculateNextScheduledRun(scheduleConfig) {
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

function isInScheduledWindow(scheduleConfig) {
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

function updateScheduleStatus() {
    if (!IS_SCHEDULED_TRANSFER) {
        CURRENT_SCHEDULE_STATUS = 'immediate_active';
        return;
    }

    const inWindow = isInScheduledWindow(SCHEDULE_CONFIG);
    
    if (inWindow) {
        CURRENT_SCHEDULE_STATUS = 'scheduled_running';
        IS_IN_SCHEDULED_WINDOW = true;
        SCHEDULE_WINDOW_START = new Date();
    } else {
        CURRENT_SCHEDULE_STATUS = 'scheduled_pending';
        IS_IN_SCHEDULED_WINDOW = false;
        NEXT_SCHEDULED_RUN = calculateNextScheduledRun(SCHEDULE_CONFIG);
    }

    logger.info(`[USB_IMAGE_SCHEDULE] updateScheduleStatus: Status: ${CURRENT_SCHEDULE_STATUS}, Next run: ${NEXT_SCHEDULED_RUN}, In window: ${IS_IN_SCHEDULED_WINDOW}`);
}

// Function to publish transfer metrics to Redis
function publishImageTransferMetrics(type, data) {
    try {
        const metricsPayload = {
            serviceType: 'image',
            type: type, // 'batch_start', 'batch_progress', 'batch_complete', 'file_processed'
            data: Object.assign({}, data, {
                scheduleStatus: CURRENT_SCHEDULE_STATUS,
                isScheduled: IS_SCHEDULED_TRANSFER,
                nextScheduledRun: NEXT_SCHEDULED_RUN,
                timestamp: new Date().toISOString(),
                serviceName: 'autoUSBImageTransferService'
            })
        };
        
        redisMetrics.publish('usb_image_transfer_metrics', JSON.stringify(metricsPayload));
        logger.info(`[USB_IMAGE_REDIS_METRICS] Published metrics: ${type} - ${data.processedCount || 0}/${data.totalFiles || 0}`);
    } catch (error) {
        logger.error('[USB_IMAGE_REDIS_METRICS] Error publishing metrics:', { error: error.message });
    }
}

// Function to read config from file
function readConfig() {
    try {
        const fs = require('fs-extra');
        if (fs.existsSync(config.CONFIG_FILE_PATH)) {
            const configData = JSON.parse(fs.readFileSync(config.CONFIG_FILE_PATH, 'utf8'));
            return configData;
        }
        logger.warn('[USB_IMAGE] readConfig: Config file not found:', { path: config.CONFIG_FILE_PATH });
        return null;
    } catch (error) {
        logger.error('[USB_IMAGE] readConfig: Error reading config file:', { error: error.message });
        return null;
    }
}

// Update drive information from Redis
async function updateDriveInfo() {
    try {
        const driveListStr = await redis.get(CONNECTED_DRIVE_LIST);
        if (driveListStr) {
            const driveList = JSON.parse(driveListStr);

            if (driveList && driveList.length > 0) {
                let targetDrive = null;
                const configuredDrive = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive;
                const transferMode = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.transferMode;

                if (transferMode === 'any' || configuredDrive === 'ANY') {
                    logger.info(`[USB_IMAGE] updateDriveInfo: Transfer mode is 'any' - checking connected drives`);

                    if (configuredDrive && configuredDrive !== 'ANY') {
                        targetDrive = driveList.find(drive =>
                            drive.drive === configuredDrive ||
                            drive.drive === `${configuredDrive}:` ||
                            drive.drive === `${configuredDrive}:`
                        );
                    }

                    if (!targetDrive) {
                        targetDrive = driveList[0];
                        logger.info(`[USB_IMAGE] updateDriveInfo: Using first available drive: ${targetDrive.drive}`);

                        const actualDrive = targetDrive.drive.replace(':', '');
                        if (configuredDrive !== actualDrive) {
                            try {
                                const fs = require('fs-extra');
                                const currentConfig = readConfig();
                                if (currentConfig) {
                                    currentConfig.autoTransfer.drive = actualDrive;
                                    fs.writeFileSync(config.CONFIG_FILE_PATH, JSON.stringify(currentConfig, null, 2));
                                    CONFIG_STATE = currentConfig;
                                    logger.info(`[USB_IMAGE] updateDriveInfo: Updated config with drive ${actualDrive}`);
                                }
                            } catch (error) {
                                logger.error('[USB_IMAGE] updateDriveInfo: Error updating config file:', { error: error.message });
                            }
                        }
                    }
                } else {
                    if (configuredDrive) {
                        targetDrive = driveList.find(drive =>
                            drive.drive === configuredDrive ||
                            drive.drive === `${configuredDrive}:` ||
                            drive.drive === `${configuredDrive}:`
                        );
                    }

                    if (!targetDrive) {
                        logger.warn(`[USB_IMAGE] updateDriveInfo: Target drive '${configuredDrive}' not found`);
                        DRIVE_INFO = null;
                        IS_DRIVE_CONNECTED = false;
                        SHOULD_STOP_TRANSFER = true;
                        return;
                    }
                }

                DRIVE_INFO = targetDrive;
                IS_DRIVE_CONNECTED = true;

                // Update space validator
                SHOULD_STOP_TRANSFER = imageSpaceValidator.isDriveNearFull(99);
                imageSpaceValidator.updateDriveInfo(DRIVE_INFO, SHOULD_STOP_TRANSFER);
                imageTransferManager.setDriveInfo(DRIVE_INFO);

                // console.log(`[USB_IMAGE] updateDriveInfo: Drive update: selectedDrive=${DRIVE_INFO.drive}, connected=${IS_DRIVE_CONNECTED}`);
            } else {
                DRIVE_INFO = null;
                IS_DRIVE_CONNECTED = false;
                SHOULD_STOP_TRANSFER = true;
                logger.info('[USB_IMAGE] updateDriveInfo: No drives connected');
            }
        } else {
            DRIVE_INFO = null;
            IS_DRIVE_CONNECTED = false;
            SHOULD_STOP_TRANSFER = true;
            logger.info('[USB_IMAGE] updateDriveInfo: No drive list found in Redis');
        }
    } catch (error) {
        logger.error('[USB_IMAGE] updateDriveInfo: Error updating drive info:', { error: error.message });
        DRIVE_INFO = null;
        IS_DRIVE_CONNECTED = false;
        SHOULD_STOP_TRANSFER = true;
    }
}

// Redis PubSub Listeners
redisPubSub.subscribe(CONNECTED_DRIVE_LIST + '_update', CONFIG_STATE_KEY + '_update', (err, count) => {
    if (err) {
        logger.error('[USB_IMAGE] redisPubSub.subscribe: Failed to subscribe:', { error: err.message });
    } else {
        logger.info(`[USB_IMAGE] redisPubSub.subscribe: Subscribed successfully! Listening on ${count} channel(s).`);
    }
});

redisPubSub.on('message', async (channel, message) => {
    try {
        const parsedMessage = JSON.parse(message);
        
        if (channel === CONNECTED_DRIVE_LIST + '_update') {
            await updateDriveInfo();
        }
        
        if (channel === CONFIG_STATE_KEY + '_update') {
            CONFIG_STATE = parsedMessage;
            
            // Update managers with new CONFIG_STATE
            imageTransferManager.config = CONFIG_STATE;
            
            // console.log('[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Config updated - storage.directory:', CONFIG_STATE.storage && CONFIG_STATE.storage.directory);
            // console.log('[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Config updated - autoTransfer.drive:', CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive);
            
            // console.log({
            //     CONFIG_STATE
            // });

            // Update encryption setting
            IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
            imageTransferManager.setEncryptionRequired(IS_ENCRYPTION_REQUIRED);

            IS_IMAGE_TRANSFER_ACTIVE = CONFIG_STATE && CONFIG_STATE.autoTransfer && ['images', 'both'].includes(CONFIG_STATE.autoTransfer.dataType) || false;
            // console.log('[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Config updated - autoTransfer.dataType:', CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.dataType);
            
            // Update schedule configuration
            SCHEDULE_CONFIG = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.schedule || {};
            IS_SCHEDULED_TRANSFER = SCHEDULE_CONFIG.type === 'scheduled';

            // Update schedule status
            updateScheduleStatus();

            // console.log('[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Schedule config updated:', {
            //     type: SCHEDULE_CONFIG.type,
            //     mode: SCHEDULE_CONFIG.mode,
            //     isScheduled: IS_SCHEDULED_TRANSFER,
            //     status: CURRENT_SCHEDULE_STATUS,
            //     nextRun: NEXT_SCHEDULED_RUN
            // });
            
            const wasActive = IS_AUTO_TRANSFER_ACTIVE;
            // console.log({
            //     config: CONFIG_STATE
            // });
            IS_AUTO_TRANSFER_ACTIVE = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.isActive || false;
            // console.log({
            //     IS_IMAGE_TRANSFER_ACTIVE: IS_IMAGE_TRANSFER_ACTIVE,
            //     IS_AUTO_TRANSFER_ACTIVE: IS_AUTO_TRANSFER_ACTIVE,
            //     wasActive: wasActive
            // })
            
            if (IS_AUTO_TRANSFER_ACTIVE && !wasActive) {
                logger.info("[USB_IMAGE_REDIS_UPDATE] Auto transfer reactivated - resuming paused jobs");
                await imageJobManager.resumeActiveJobs();
            } else if (!IS_AUTO_TRANSFER_ACTIVE && wasActive) {
                logger.info("[USB_IMAGE_REDIS_UPDATE] Auto transfer stopped - pausing active jobs");
                await imageJobManager.pauseActiveJobs('Auto transfer disabled');
            }
        }
    } catch (error) {
        logger.error('[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Error processing Redis message:', { error: error.message });
    }
});

// Main Image Transfer Consumer
async function consumer() {
    logger.info('[USB_IMAGE_CONSUMER] USB Image Transfer Service started...');   
    
    while (true) {
        try {
            if (!IS_AUTO_TRANSFER_ACTIVE) {
                logger.info("[USB_IMAGE_CONSUMER] Auto transfer disabled - pausing active jobs");
                await imageJobManager.pauseActiveJobs('Auto transfer disabled');
                await sleep(1000);
                continue;
            }

            if (!IS_IMAGE_TRANSFER_ACTIVE) {
                logger.info("[USB_IMAGE_CONSUMER] Image transfer disabled - pausing active jobs");
                await imageJobManager.pauseActiveJobs('Image transfer disabled');
                await sleep(1000);
                continue;
            }

            if (IS_SCHEDULED_TRANSFER && !IS_IN_SCHEDULED_WINDOW) {
                logger.info("[USB_IMAGE_CONSUMER] Scheduled transfer - waiting for window", { nextRun: NEXT_SCHEDULED_RUN, status: CURRENT_SCHEDULE_STATUS });
                await imageJobManager.pauseActiveJobs('Outside scheduled window');
                await sleep(1000);
                updateScheduleStatus();
                continue;
            }

            if (IS_SCHEDULED_TRANSFER && IS_IN_SCHEDULED_WINDOW) {
                logger.info("[USB_IMAGE_CONSUMER] In scheduled transfer window - processing images");
            }

            if (!IS_DRIVE_CONNECTED) {
                logger.info("[USB_IMAGE_CONSUMER] Drive not connected - service paused");
                await sleep(1000);
                continue;
            }

            if (SHOULD_STOP_TRANSFER) {
                logger.info("[USB_IMAGE_CONSUMER] USB storage full - service paused");
                await sleep(1000);
                continue;
            }

            await updateDriveInfo();

            const spaceStatus = imageSpaceValidator.getSpaceStatus();
            logger.info(`[USB_IMAGE_CONSUMER] Status: Active=${IS_AUTO_TRANSFER_ACTIVE}, Connected=${IS_DRIVE_CONNECTED}, Space=${spaceStatus.message}`);

            const activeJob = await imageJobManager.getOrCreateActiveJob('auto', 1000);
            if (!activeJob) {
                logger.info("[USB_IMAGE_CONSUMER] No active job and no files to process");
                await sleep(1000);
                continue;
            }

            await runWithTrace({ traceId: newTraceId(), jobId: activeJob.batch_id, jobStatus: activeJob.status }, async () => {
                logger.info(`[USB_IMAGE_CONSUMER] Processing job: ${activeJob.batch_id}`, { jobId: activeJob.batch_id, status: activeJob.status });

                const filesToProcess = await imageTransferManager.getPendingFiles(1000);
                logger.info(`[USB_IMAGE_CONSUMER] Found ${filesToProcess.length} pending image files`, { count: filesToProcess.length, jobId: activeJob.batch_id });

                if (filesToProcess.length === 0) {
                    logger.info(`[USB_IMAGE_CONSUMER] No pending files for job ${activeJob.batch_id} - checking for completion`);
                    await sleep(1000);
                    return;
                }

                logger.info(`[USB_IMAGE_CONSUMER] Processing batch of ${filesToProcess.length} image files`, { count: filesToProcess.length });

                const startTime = process.hrtime();
                let processedCount = 0;
                let failedCount = 0;

                const exportDir = CONFIG_STATE.storage && CONFIG_STATE.storage.directory;
                const usbPath = `${CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive}:\\`;
                const publicKeyPath = 'certs/'+CONFIG_STATE.certificates.publicKeyFilename;

                logger.info('[USB_IMAGE_CONSUMER] Processing config', { exportDir, usbPath, publicKeyPath });

                if (IS_ENCRYPTION_REQUIRED) {
                    const filesByDir = imageTransferManager.groupFilesByDirectory(filesToProcess, exportDir);
                    for (const [relativeDirPath, dirFiles] of Object.entries(filesByDir)) {
                        if (dirFiles.length === 0) {
                            logger.info(`[USB_IMAGE_CONSUMER] No files to process for directory ${relativeDirPath}`);
                            continue;
                        }

                        if (dirFiles.length < 3) {
                            logger.warn(`[USB_IMAGE_CONSUMER] Not enough files for directory ${relativeDirPath}`, { count: dirFiles.length });
                            processedCount += dirFiles.length;
                            for (const file of dirFiles) {
                                await TransferUtils.handleImageTransferError(pool, file, new Error('Not enough files to process for directory'), 'transfer_queue');
                            }
                            continue;
                        }

                        logger.info(`[USB_IMAGE_CONSUMER] Encryption enabled - processing ${filesToProcess.length} files in batches of 3`);

                        try {
                            await imageTransferManager.processEncryptedImageBatch(dirFiles, relativeDirPath, exportDir, usbPath, publicKeyPath);
                            processedCount += dirFiles.length;

                            logger.info(`[USB_IMAGE_CONSUMER] Successfully processed ${processedCount} files in encrypted batches`);

                            if (processedCount % 5 === 0 || processedCount === filesToProcess.length) {
                                publishImageTransferMetrics('batch_progress', {
                                    jobId: activeJob.batch_id,
                                    processedCount: processedCount,
                                    totalFiles: filesToProcess.length,
                                    failedCount: failedCount,
                                    currentFile: dirFiles[0].file_name,
                                    progressPercentage: Math.round((processedCount / filesToProcess.length) * 100),
                                    throughput: processedCount / ((process.hrtime(startTime)[0] + process.hrtime(startTime)[1] / 1e9))
                                });
                            }
                        } catch (error) {
                            logger.error(`[USB_IMAGE_CONSUMER] Batch encryption failed:`, { error: error.message });
                            failedCount = dirFiles.length;
                            
                            for (const file of dirFiles) {
                                logger.error(`[USB_IMAGE_CONSUMER] Error processing image file ${file.id}:`, { error: error.message, fileId: file.id });
                                await TransferUtils.handleImageTransferError(pool, file, error, 'transfer_queue');
                            }
                            publishImageTransferMetrics('batch_progress', {
                                jobId: activeJob.batch_id,
                                processedCount: processedCount,
                                totalFiles: filesToProcess.length,
                                failedCount: failedCount,
                                progressPercentage: Math.round(((processedCount + failedCount) / filesToProcess.length) * 100),
                                lastError: error.message,
                                hasError: true
                            });
                            if (TransferUtils.isFileNotFoundError(error)) {
                                await imageTransferManager.updateTransferStatus(dirFiles[0].id, 'failed', 'File not found');
                                continue;
                            }
                            if (TransferUtils.isDriveRelatedError(error)) {
                                logger.warn(`[USB_IMAGE_CONSUMER] Drive error detected - stopping batch`);
                                IS_DRIVE_CONNECTED = false;
                                break;
                            } else {
                                await TransferUtils.handleImageTransferError(pool, dirFiles[0], error, 'transfer_queue');
                            }
                        }

                        if (processedCount % 10 === 0) {
                            logger.info(`[USB_IMAGE_CONSUMER] Batch progress: ${processedCount}/${filesToProcess.length} images processed`);
                        }
                    }
                } else {
                    for (const file of filesToProcess) {
                        try {
                            if (!IS_AUTO_TRANSFER_ACTIVE || !IS_DRIVE_CONNECTED || SHOULD_STOP_TRANSFER) {
                                const reason = !IS_AUTO_TRANSFER_ACTIVE ? 'auto transfer disabled' : 
                                            !IS_DRIVE_CONNECTED ? 'drive disconnected' : 'USB storage full';
                                logger.info(`[USB_IMAGE_CONSUMER] Transfer stopped (${reason}) - pausing remaining files`);
                                break;
                            }

                            if (!imageSpaceValidator.hasSpaceForFile(file.file_size || 0)) {
                                logger.warn(`[USB_IMAGE_CONSUMER] Insufficient space for file ${file.id} - stopping batch`);
                                await TransferUtils.handleImageTransferError(pool, file, new Error('Insufficient USB space'), 'transfer_queue');
                                break;
                            }

                            await imageTransferManager.processImageFile(file);
                            processedCount++;

                            if (processedCount % 5 === 0 || processedCount === filesToProcess.length) {
                                publishImageTransferMetrics('batch_progress', {
                                    jobId: activeJob.batch_id,
                                    processedCount: processedCount,
                                    totalFiles: filesToProcess.length,
                                    failedCount: failedCount,
                                    currentFile: file.file_name,
                                    progressPercentage: Math.round((processedCount / filesToProcess.length) * 100),
                                    throughput: processedCount / ((process.hrtime(startTime)[0] + process.hrtime(startTime)[1] / 1e9))
                                });
                            }
                        } catch (error) {
                            logger.error(`[USB_IMAGE_CONSUMER] Error processing image file ${file.id}:`, { error: error.message, fileId: file.id });
                            failedCount++;
                            
                            publishImageTransferMetrics('batch_progress', {
                                jobId: activeJob.batch_id,
                                processedCount: processedCount,
                                totalFiles: filesToProcess.length,
                                failedCount: failedCount,
                                currentFile: file.file_name,
                                progressPercentage: Math.round(((processedCount + failedCount) / filesToProcess.length) * 100),
                                lastError: error.message,
                                hasError: true
                            });
                                
                            if (TransferUtils.isFileNotFoundError(error)) {
                                logger.info(`[USB_IMAGE_CONSUMER] File ${file.id} not found - marking as failed`);
                                await imageTransferManager.updateTransferStatus(file.id, 'failed', 'File not found');
                                continue;
                            }
                            
                            if (TransferUtils.isDriveRelatedError(error)) {
                                logger.warn(`[USB_IMAGE_CONSUMER] Drive error detected - stopping batch`);
                                IS_DRIVE_CONNECTED = false;
                                break;
                            } else {
                                await TransferUtils.handleImageTransferError(pool, file, error, 'transfer_queue');
                            }
                        }
                    }

                    TransferUtils.markUSBSourceFilesAsTransferred(pool, filesToProcess.map(f => f.id), "auto");
                }

                const endTime = process.hrtime(startTime);
                const duration = endTime[0] * 1000 + endTime[1] / 1000000;
                const throughput = processedCount > 0 ? (processedCount / (duration / 1000)).toFixed(2) : 0;
                
                publishImageTransferMetrics('batch_complete', {
                    jobId: activeJob.batch_id,
                    processedCount: processedCount,
                    failedCount: failedCount,
                    totalFiles: filesToProcess.length,
                    duration: duration.toFixed(2),
                    throughput: parseFloat(throughput),
                    successRate: Math.round((processedCount / filesToProcess.length) * 100),
                    batchSize: filesToProcess.length
                });
                
                logger.info(`[USB_IMAGE_CONSUMER] Batch completed: ${processedCount} transferred, ${failedCount} failed in ${duration.toFixed(2)}ms (${throughput} files/sec)`, { processedCount, failedCount, duration: duration.toFixed(2), throughput });

                await imageTransferManager.checkAndUpdateCompletedJobs();

                if (processedCount > 0) {
                    await sleep(500);
                }
            });

        } catch (error) {
            logger.error('[USB_IMAGE_CONSUMER] Error in transfer consumer:', { error: error.message, stack: error.stack });
            await sleep(1000);
        }
    }
}

// Initialize and start service
async function runService() {
    try {
        logger.info('[USB_IMAGE_RUN_SERVICE] Initializing USB Image Transfer Service...');
        
        let configLoaded = false;
        
        const fileConfig = readConfig();
        if (fileConfig) {
            CONFIG_STATE = fileConfig;
            IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
            
            imageTransferManager.config = CONFIG_STATE;
            imageTransferManager.setEncryptionRequired(IS_ENCRYPTION_REQUIRED);
            
            SCHEDULE_CONFIG = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.schedule || {};
            IS_SCHEDULED_TRANSFER = SCHEDULE_CONFIG.type === 'scheduled';
            updateScheduleStatus();
            
            logger.info('[USB_IMAGE_RUN_SERVICE] Loaded config from file', { encryptionEnabled: IS_ENCRYPTION_REQUIRED, storageDir: CONFIG_STATE.storage && CONFIG_STATE.storage.directory, drive: CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive, scheduleType: SCHEDULE_CONFIG.type, isScheduled: IS_SCHEDULED_TRANSFER });
            configLoaded = true;
        }
        
        if (!configLoaded) {
            const redisConfig = await redis.get(CONFIG_STATE_KEY);
            if (redisConfig) {
                CONFIG_STATE = JSON.parse(redisConfig);
                IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
                
                imageTransferManager.config = CONFIG_STATE;
                imageTransferManager.setEncryptionRequired(IS_ENCRYPTION_REQUIRED);
                
                SCHEDULE_CONFIG = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.schedule || {};
                IS_SCHEDULED_TRANSFER = SCHEDULE_CONFIG.type === 'scheduled';
                updateScheduleStatus();
                
                logger.info('[USB_IMAGE_RUN_SERVICE] Loaded config from Redis', { encryptionEnabled: IS_ENCRYPTION_REQUIRED, storageDir: CONFIG_STATE.storage && CONFIG_STATE.storage.directory, drive: CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive });
                configLoaded = true;
            }
        }
        
        if (!configLoaded) {
            logger.warn('[USB_IMAGE_RUN_SERVICE] No config found - using defaults');
        }
        
        await updateDriveInfo();
        
        logger.info('[USB_IMAGE_RUN_SERVICE] Starting consumer...');
        consumer();
        
    } catch (error) {
        logger.error('[USB_IMAGE_RUN_SERVICE] Service initialization error:', { error: error.message, stack: error.stack });
        process.exit(1);
    }
}

process.on('SIGINT', async () => {
    logger.info('[USB_IMAGE_SHUTDOWN] Shutting down USB Image Transfer Service...');
    await imageProcessor.cleanup();
    process.exit(0);
});

// Start the service
runService();

module.exports = {
    imageJobManager,
    imageTransferManager,
    imageSpaceValidator,
    imageProcessor
};

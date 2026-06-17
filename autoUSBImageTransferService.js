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

    console.log(`[USB_IMAGE_SCHEDULE] updateScheduleStatus: Status: ${CURRENT_SCHEDULE_STATUS}, Next run: ${NEXT_SCHEDULED_RUN}, In window: ${IS_IN_SCHEDULED_WINDOW}`);
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
        console.log(`[USB_IMAGE_REDIS_METRICS] publishImageTransferMetrics: Published metrics: ${type} - ${data.processedCount || 0}/${data.totalFiles || 0}`);
    } catch (error) {
        console.error('[USB_IMAGE_REDIS_METRICS] publishImageTransferMetrics: Error publishing metrics:', error);
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
        console.log('[USB_IMAGE] readConfig: Config file not found:', config.CONFIG_FILE_PATH);
        return null;
    } catch (error) {
        console.error('[USB_IMAGE] readConfig: Error reading config file:', error);
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

                // Handle "ANY" mode OR when transferMode is 'any'
                if (transferMode === 'any' || configuredDrive === 'ANY') {
                    console.log(`[USB_IMAGE] updateDriveInfo: Transfer mode is 'any' - checking connected drives`);

                    // Check if configured drive (if set and not "ANY") is connected
                    if (configuredDrive && configuredDrive !== 'ANY') {
                        targetDrive = driveList.find(drive =>
                            drive.drive === configuredDrive ||
                            drive.drive === `${configuredDrive}:` ||
                            drive.drive === `${configuredDrive}:`
                        );
                    }

                    // If configured drive not connected, use first available
                    if (!targetDrive) {
                        targetDrive = driveList[0];
                        console.log(`[USB_IMAGE] updateDriveInfo: Using first available drive: ${targetDrive.drive}`);

                        // Update config file with the actual drive being used (so it persists)
                        const actualDrive = targetDrive.drive.replace(':', ''); // Remove colon
                        if (configuredDrive !== actualDrive) {
                            try {
                                const fs = require('fs-extra');
                                const currentConfig = readConfig();
                                if (currentConfig) {
                                    currentConfig.autoTransfer.drive = actualDrive;
                                    fs.writeFileSync(config.CONFIG_FILE_PATH, JSON.stringify(currentConfig, null, 2));
                                    CONFIG_STATE = currentConfig; // Update in-memory state
                                    console.log(`[USB_IMAGE] updateDriveInfo: Updated config with drive ${actualDrive}`);
                                }
                            } catch (error) {
                                console.error('[USB_IMAGE] updateDriveInfo: Error updating config file:', error);
                            }
                        }
                    }
                } else {
                    // Specific drive mode - find the exact drive
                    if (configuredDrive) {
                        targetDrive = driveList.find(drive =>
                            drive.drive === configuredDrive ||
                            drive.drive === `${configuredDrive}:` ||
                            drive.drive === `${configuredDrive}:`
                        );
                    }

                    if (!targetDrive) {
                        console.warn(`[USB_IMAGE] updateDriveInfo: Target drive '${configuredDrive}' not found`);
                        // Don't use fallback in specific mode - wait for correct drive
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
                console.log('[USB_IMAGE] updateDriveInfo: No drives connected');
            }
        } else {
            DRIVE_INFO = null;
            IS_DRIVE_CONNECTED = false;
            SHOULD_STOP_TRANSFER = true;
            console.log('[USB_IMAGE] updateDriveInfo: No drive list found in Redis');
        }
    } catch (error) {
        console.error('[USB_IMAGE] updateDriveInfo: Error updating drive info:', error);
        DRIVE_INFO = null;
        IS_DRIVE_CONNECTED = false;
        SHOULD_STOP_TRANSFER = true;
    }
}

// Redis PubSub Listeners
redisPubSub.subscribe(CONNECTED_DRIVE_LIST + '_update', CONFIG_STATE_KEY + '_update', (err, count) => {
    if (err) {
        console.error('[USB_IMAGE] redisPubSub.subscribe: Failed to subscribe: %s', err.message);
    } else {
        console.log(`[USB_IMAGE] redisPubSub.subscribe: Subscribed successfully! Listening on ${count} channel(s).`);
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
                console.log("[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Auto transfer reactivated - resuming paused jobs");
                await imageJobManager.resumeActiveJobs();
            } else if (!IS_AUTO_TRANSFER_ACTIVE && wasActive) {
                console.log("[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Auto transfer stopped - pausing active jobs");
                await imageJobManager.pauseActiveJobs('Auto transfer disabled');
            }
        }
    } catch (error) {
        console.error('[USB_IMAGE_REDIS_UPDATE] redisPubSub.on: Error processing Redis message:', error);
    }
});

// Main Image Transfer Consumer
async function consumer() {
    console.log('--------------------------------');
    console.log('--------------------------------');
    console.log('--------------------------------');
    console.log('--------------------------------');
    console.log('[USB_IMAGE_CONSUMER] consumer: USB Image Transfer Service started...');   
    
    while (true) {
        try {
            if (!IS_AUTO_TRANSFER_ACTIVE) {
                console.log("[USB_IMAGE_CONSUMER] consumer: Auto transfer disabled - pausing active jobs");
                await imageJobManager.pauseActiveJobs('Auto transfer disabled');
                await sleep(1000);
                continue;
            }

            if (!IS_IMAGE_TRANSFER_ACTIVE) {
                console.log("[USB_IMAGE_CONSUMER] consumer: Image transfer disabled - pausing active jobs");
                await imageJobManager.pauseActiveJobs('Image transfer disabled');
                await sleep(1000);
                continue;
            }

            // Add schedule check
            if (IS_SCHEDULED_TRANSFER && !IS_IN_SCHEDULED_WINDOW) {
                console.log("[USB_IMAGE_CONSUMER] consumer: Scheduled transfer - waiting for window. Next run: " + NEXT_SCHEDULED_RUN + ", Status: " + CURRENT_SCHEDULE_STATUS);
                await imageJobManager.pauseActiveJobs('Outside scheduled window');
                await sleep(1000); // Check every 30 seconds during scheduled mode
                updateScheduleStatus(); // Re-check schedule status
                continue;
            }

            if (IS_SCHEDULED_TRANSFER && IS_IN_SCHEDULED_WINDOW) {
                console.log("[USB_IMAGE_CONSUMER] consumer: In scheduled transfer window - processing images");
            }

            if (!IS_DRIVE_CONNECTED) {
                console.log("[USB_IMAGE_CONSUMER] consumer: Drive not connected - service paused");
                await sleep(1000);
                continue;
            }

            if (SHOULD_STOP_TRANSFER) {
                console.log("[USB_IMAGE_CONSUMER] consumer: USB storage full - service paused");
                await sleep(1000);
                continue;
            }

            // Update drive info periodically
            await updateDriveInfo();

            // Log status
            const spaceStatus = imageSpaceValidator.getSpaceStatus();
            console.log(`[USB_IMAGE_CONSUMER] consumer: Status: Active=${IS_AUTO_TRANSFER_ACTIVE}, Connected=${IS_DRIVE_CONNECTED}, Space=${spaceStatus.message}`);

            // Get or create active job
            const activeJob = await imageJobManager.getOrCreateActiveJob('auto', 1000);
            if (!activeJob) {
                console.log("[USB_IMAGE_CONSUMER] consumer: No active job and no files to process");
                await sleep(1000);
                continue;
            }

            console.log(`[USB_IMAGE_CONSUMER] consumer: Processing job: ${activeJob.batch_id} (status: ${activeJob.status})`);

            // Get pending files for this job
            const filesToProcess = await imageTransferManager.getPendingFiles(1000);
            console.log(`[USB_IMAGE_CONSUMER] consumer: Found ${filesToProcess.length} pending image files for job ${activeJob.batch_id}`);

            if (filesToProcess.length === 0) {
                console.log(`[USB_IMAGE_CONSUMER] consumer: No pending files for job ${activeJob.batch_id} - checking for completion`);
                await sleep(1000);
                continue;
            }

            console.log(`[USB_IMAGE_CONSUMER] consumer: Processing batch of ${filesToProcess.length} image files for job ${activeJob.batch_id}`);

            // Publish batch start metrics
            console.log({
                'batch_start': {
                    jobId: activeJob.batch_id,
                    totalFiles: filesToProcess.length,
                    batchSize: filesToProcess.length
                }
            });

            publishImageTransferMetrics('batch_start', {
                jobId: activeJob.batch_id,
                totalFiles: filesToProcess.length,
                batchSize: filesToProcess.length
            });

            // Process files batch
            const startTime = process.hrtime();
            let processedCount = 0;
            let failedCount = 0;

            // Process files individually (existing logic for non-encrypted)
            console.log(`[USB_IMAGE_CONSUMER] consumer: Processing ${filesToProcess.length} files individually`);

            // Get necessary paths for batch processing
            const exportDir = CONFIG_STATE.storage && CONFIG_STATE.storage.directory;
            const usbPath = `${CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive}:\\`;
            const publicKeyPath = 'certs/'+CONFIG_STATE.certificates.publicKeyFilename;

            console.log('[USB_IMAGE_CONSUMER] DEBUG Config:', {
                exportDir,
                usbPath,
                publicKeyPath,
                sampleFilePath: filesToProcess[0]?.file_path
            });


            if (IS_ENCRYPTION_REQUIRED) {
                // Group files by directory, then into batches of 3
                const filesByDir = imageTransferManager.groupFilesByDirectory(filesToProcess, exportDir);
                console.log('--------------------------------');
                console.log('--------------------------------');
                console.log('--------------------------------');
                console.log('--------------------------------');
                console.log({
                    filesByDir
                });
                console.log('--------------------------------');
                console.log('--------------------------------');
                console.log('--------------------------------');
                console.log('--------------------------------');
                for (const [relativeDirPath, dirFiles] of Object.entries(filesByDir)) {
                    if (dirFiles.length === 0) {
                        console.log(`[USB_IMAGE_CONSUMER] consumer: No files to process for directory ${relativeDirPath}`);
                        continue;
                    }

                    if (dirFiles.length < 3) {
                        console.log(`[USB_IMAGE_CONSUMER] consumer: Not enough files to process for directory ${relativeDirPath}`);
                        // TODO: Handle this case by delete files from the transfer queue database so other files can be added to the queue
                        // Or we can handle this case before files are added to the queue and check if the number of files is less than the number of cameras
                        // so we don't add files to the queue that are not completed the required batch size
                        processedCount+=dirFiles.length;
                        // Mark all files as failed
                        for (const file of dirFiles) {
                            await TransferUtils.handleImageTransferError(pool, file, new Error('Not enough files to process for directory'), 'transfer_queue');
                        }
                        continue;
                    }

                    console.log(`[USB_IMAGE_CONSUMER] consumer: Encryption enabled - processing ${filesToProcess.length} files in batches of 3`);

                    try {
                        // Process all files as encrypted batches
                        await imageTransferManager.processEncryptedImageBatch(dirFiles, relativeDirPath, exportDir, usbPath, publicKeyPath);
                        
                        processedCount += dirFiles.length;

                        console.log({
                            'batch_complete': {
                                jobId: activeJob.batch_id,
                                processedCount: processedCount,
                                totalFiles: dirFiles.length,
                            }
                        });
                        console.log(`[USB_IMAGE_CONSUMER] consumer: Successfully processed ${processedCount} files in encrypted batches`);

                        // Publish progress metrics every 5 files or on completion
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
                        console.error(`[USB_IMAGE_CONSUMER] consumer: Batch encryption failed:`, error);
                        failedCount = dirFiles.length;
                        
                        // Mark all files as failed
                        for (const file of dirFiles) {
                            console.error(`[USB_IMAGE_CONSUMER] consumer: Error processing image file ${file.id}:`, error);
                            await TransferUtils.handleImageTransferError(pool, file, error, 'transfer_queue');
                        }
                        // Publish error progress metrics
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
                        // Handle different types of errors
                        if (TransferUtils.isFileNotFoundError(error)) {
                            console.log(`[USB_IMAGE_CONSUMER] consumer: File ${file.id} not found - marking as failed`);
                            await imageTransferManager.updateTransferStatus(file.id, 'failed', 'File not found');
                            continue;
                        }
                        if (TransferUtils.isDriveRelatedError(error)) {
                            console.log(`[USB_IMAGE_CONSUMER] consumer: Drive error detected - stopping batch`);
                            IS_DRIVE_CONNECTED = false;
                            break;
                        } else {
                            // Handle with retry logic
                            await TransferUtils.handleImageTransferError(pool, file, error, 'transfer_queue');
                        }

                    }

                    // Log progress every 10 files
                    if (processedCount % 10 === 0) {
                        console.log(`[USB_IMAGE_CONSUMER] consumer: Batch progress: ${processedCount}/${filesToProcess.length} images processed`);
                    }

                }
            } else {
                for (const file of filesToProcess) {
                    try{
                        // Check conditions before processing each file
                        if (!IS_AUTO_TRANSFER_ACTIVE || !IS_DRIVE_CONNECTED || SHOULD_STOP_TRANSFER) {
                            const reason = !IS_AUTO_TRANSFER_ACTIVE ? 'auto transfer disabled' : 
                                        !IS_DRIVE_CONNECTED ? 'drive disconnected' : 'USB storage full';
                            console.log(`[USB_IMAGE_CONSUMER] consumer: Transfer stopped (${reason}) - pausing remaining files`);
                            break;
                        }

                        // Check space for this specific file
                        if (!imageSpaceValidator.hasSpaceForFile(file.file_size || 0)) {
                            console.log(`[USB_IMAGE_CONSUMER] consumer: Insufficient space for file ${file.id} - stopping batch`);
                            
                            await TransferUtils.handleImageTransferError(
                                pool, 
                                file, 
                                new Error('Insufficient USB space'), 
                                'transfer_queue'
                            );
                            break;
                        }

                        // Process the image file
                        console.log("[USB_IMAGE_CONSUMER] consumer: await imageTransferManager.processImageFile(file)")
                        await imageTransferManager.processImageFile(file);

                        processedCount++;

                        // Publish progress metrics every 5 files or on completion
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
                        console.error(`[USB_IMAGE_CONSUMER] consumer: Error processing image file ${file.id}:`, error);
                        failedCount++;
                        
                        // Publish error progress metrics
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
                            
                        // Handle different types of errors
                        if (TransferUtils.isFileNotFoundError(error)) {
                            console.log(`[USB_IMAGE_CONSUMER] consumer: File ${file.id} not found - marking as failed`);
                            await imageTransferManager.updateTransferStatus(file.id, 'failed', 'File not found');
                            continue;
                        }
                        
                        if (TransferUtils.isDriveRelatedError(error)) {
                            console.log(`[USB_IMAGE_CONSUMER] consumer: Drive error detected - stopping batch`);
                            IS_DRIVE_CONNECTED = false;
                            break;
                        } else {
                            // Handle with retry logic
                            await TransferUtils.handleImageTransferError(pool, file, error, 'transfer_queue');
                        }
                    }
                }

                TransferUtils.markUSBSourceFilesAsTransferred(pool, filesToProcess.map(f => f.id), "auto");
            }

            const endTime = process.hrtime(startTime);
            const duration = endTime[0] * 1000 + endTime[1] / 1000000;
            const throughput = processedCount > 0 ? (processedCount / (duration / 1000)).toFixed(2) : 0;
            
            // Publish batch completion metrics
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
            
            console.log(`[USB_IMAGE_CONSUMER] consumer: Batch completed: ${processedCount} transferred, ${failedCount} failed in ${duration.toFixed(2)}ms (${throughput} files/sec)`);

            // Check for completed jobs
            await imageTransferManager.checkAndUpdateCompletedJobs();

            // Small delay before next batch
            if (processedCount > 0) {
                await sleep(500);
            }

        } catch (error) {
            console.error('[USB_IMAGE_CONSUMER] consumer: Error in transfer consumer:', error);
            await sleep(1000);
        }
    }
}

// Initialize and start service
async function runService() {
    try {
        console.log('[USB_IMAGE_RUN_SERVICE] runService: Initializing USB Image Transfer Service...');
        
        // Load initial config
        let configLoaded = false;
        
        const fileConfig = readConfig();
        if (fileConfig) {
            CONFIG_STATE = fileConfig;
            IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
            
            console.log({
                CONFIG_STATE
            });

            // Update managers with CONFIG_STATE
            imageTransferManager.config = CONFIG_STATE;
            imageTransferManager.setEncryptionRequired(IS_ENCRYPTION_REQUIRED);
            
            // Initialize schedule configuration
            SCHEDULE_CONFIG = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.schedule || {};
            IS_SCHEDULED_TRANSFER = SCHEDULE_CONFIG.type === 'scheduled';
            updateScheduleStatus();
            
            console.log('[USB_IMAGE_RUN_SERVICE] runService: Loaded config from file - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
            console.log('[USB_IMAGE_RUN_SERVICE] runService: Config storage.directory:', CONFIG_STATE.storage && CONFIG_STATE.storage.directory);
            console.log('[USB_IMAGE_RUN_SERVICE] runService: Config autoTransfer.drive:', CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive);
            console.log('[USB_IMAGE_RUN_SERVICE] runService: Schedule config loaded:', {
                type: SCHEDULE_CONFIG.type,
                mode: SCHEDULE_CONFIG.mode,
                isScheduled: IS_SCHEDULED_TRANSFER,
                status: CURRENT_SCHEDULE_STATUS,
                nextRun: NEXT_SCHEDULED_RUN
            });
            configLoaded = true;
        }
        
        if (!configLoaded) {
            const redisConfig = await redis.get(CONFIG_STATE_KEY);
            if (redisConfig) {
                CONFIG_STATE = JSON.parse(redisConfig);
                IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
                
                // Update managers with CONFIG_STATE
                imageTransferManager.config = CONFIG_STATE;
                imageTransferManager.setEncryptionRequired(IS_ENCRYPTION_REQUIRED);
                
                // Initialize schedule configuration
                SCHEDULE_CONFIG = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.schedule || {};
                IS_SCHEDULED_TRANSFER = SCHEDULE_CONFIG.type === 'scheduled';
                updateScheduleStatus();
                
                console.log('[USB_IMAGE_RUN_SERVICE] runService: Loaded config from Redis - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
                console.log('[USB_IMAGE_RUN_SERVICE] runService: Config storage.directory:', CONFIG_STATE.storage && CONFIG_STATE.storage.directory);
                console.log('[USB_IMAGE_RUN_SERVICE] runService: Config autoTransfer.drive:', CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive);
                console.log('[USB_IMAGE_RUN_SERVICE] runService: Schedule config loaded:', {
                    type: SCHEDULE_CONFIG.type,
                    mode: SCHEDULE_CONFIG.mode,
                    isScheduled: IS_SCHEDULED_TRANSFER,
                    status: CURRENT_SCHEDULE_STATUS,
                    nextRun: NEXT_SCHEDULED_RUN
                });
                configLoaded = true;
            }
        }
        
        if (!configLoaded) {
            console.log('[USB_IMAGE_RUN_SERVICE] runService: No config found - using defaults');
        }
        
        // Initial drive info update
        await updateDriveInfo();
        
        // Start consumer
        console.log('[USB_IMAGE_RUN_SERVICE] runService: Starting consumer...');
        consumer();
        
    } catch (error) {
        console.error('[USB_IMAGE_RUN_SERVICE] runService: Service initialization error:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('[USB_IMAGE_SHUTDOWN] process.on: Shutting down USB Image Transfer Service...');
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

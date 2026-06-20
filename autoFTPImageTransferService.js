const Redis = require('ioredis');
const { Pool } = require("pg");
const fs = require('fs-extra');
const { CONFIG_FTP_STATE_KEY, FTP_IMAGE_METRICS_KEY } = require('./redisKeyStore');
const FtpImageJobManager = require('./services/image-transfer/state/FtpImageJobManager');
const FtpImageTransferManager = require('./services/image-transfer/transfer/FtpImageTransferManager');
const ImageSpaceValidator = require('./services/image-transfer/validators/ImageSpaceValidator');
const ImageProcessor = require('./services/image-transfer/processors/ImageProcessor');
const TransferUtils = require('./services/shared/TransferUtils');
const config = require('./utils/envConfig');
const { createLogger, runWithTrace, newTraceId } = require('./utils/logger');

const logger = createLogger({ service: 'autoFTPImageTransferService', logFile: 'image-ftp-pipeline' });

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

// Initialize Database Pool
const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD
});

// Initialize FTP Image Transfer Services
const ftpImageJobManager = new FtpImageJobManager(pool, redis, config);
const ftpImageTransferManager = new FtpImageTransferManager(pool, redis, config);
const imageSpaceValidator = new ImageSpaceValidator(config); // Used for local space if needed
const imageProcessor = new ImageProcessor(null, config); // No encryption for FTP

// State Management
let CONFIG_STATE = {};
let FTP_CONFIG = {};
let IS_AUTO_TRANSFER_ACTIVE = true;
let IS_FTP_CONNECTED = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Publish FTP image transfer metrics to Redis
 */
async function publishImageTransferMetrics(metrics) {
    try {
        const metricsData = {
            type: 'image',
            timestamp: new Date().toISOString(),
            ...metrics
        };
        
        await redis.publish(FTP_IMAGE_METRICS_KEY + '_update', JSON.stringify(metricsData));
        await redis.set(FTP_IMAGE_METRICS_KEY, JSON.stringify(metricsData), 'EX', 300); // 5 min expiry
        
    } catch (error) {
        logger.error('[FTP_IMAGE] Error publishing metrics:', { error: error.message });
    }
}

/**
 * Calculate and publish current transfer metrics
 */
async function updateAndPublishMetrics(processedCount, failedCount, totalFiles, duration, throughput) {
    try {
        // Get pending files count from job manager
        const pendingFiles = await ftpImageJobManager.getPendingFilesCount();
        const completedFiles = await ftpImageJobManager.getCompletedFilesCount();
        
        const metrics = {
            filesPending: pendingFiles || 0,
            filesTransferred: completedFiles || 0,
            filesInProgress: processedCount,
            filesFailed: failedCount,
            totalFiles: (pendingFiles || 0) + (completedFiles || 0),
            transferSpeed: parseFloat(throughput) || 0,
            averageProcessingTime: duration / Math.max(processedCount, 1),
            connectionStatus: IS_FTP_CONNECTED ? 'connected' : 'disconnected',
            serverHost: (FTP_CONFIG.server && FTP_CONFIG.server.host) ? FTP_CONFIG.server.host : 'N/A',
            lastUpdated: new Date().toISOString()
        };
        
        await publishImageTransferMetrics(metrics);
        
    } catch (error) {
        logger.error('[FTP_IMAGE] Error updating metrics:', { error: error.message });
    }
}

// Function to read config from file
function readConfig() {
    try {
        if (fs.existsSync(config.CONFIG_FILE_PATH)) {
            const configData = JSON.parse(fs.readFileSync(config.CONFIG_FILE_PATH, 'utf8'));
            return configData;
        }
        logger.warn('[FTP_IMAGE] Config file not found:', { path: config.CONFIG_FILE_PATH });
        return null;
    } catch (error) {
        logger.error('[FTP_IMAGE] Error reading config file:', { error: error.message });
        return null;
    }
}

function readFtpConfig() {
    try {
        const FTP_CONFIG_FILE_PATH = './config/ftp-transfer.json';
        if (fs.existsSync(FTP_CONFIG_FILE_PATH)) {
            const ftpConfigData = JSON.parse(fs.readFileSync(FTP_CONFIG_FILE_PATH, 'utf8'));
            return ftpConfigData;
        }
        logger.warn('[FTP_IMAGE] FTP config file not found:', { path: FTP_CONFIG_FILE_PATH });
        return null;
    } catch (error) {
        logger.error('[FTP_IMAGE] Error reading FTP config file:', { error: error.message });
        return null;
    }
}

function updateFtpConfig() {
    try {
        const ftpConfig = readFtpConfig();
        if (ftpConfig) {
            FTP_CONFIG = ftpConfig;
            IS_FTP_CONNECTED = ftpConfig.connection && ftpConfig.connection.status === 'connected';
            ftpImageTransferManager.setFtpConfig(ftpConfig);
            logger.info(`[FTP_IMAGE] FTP config updated`, { connected: IS_FTP_CONNECTED });
        } else {
            FTP_CONFIG = {};
            IS_FTP_CONNECTED = false;
            logger.warn('[FTP_IMAGE] No FTP config available');
        }
    } catch (error) {
        logger.error('[FTP_IMAGE] Error updating FTP config:', { error: error.message });
        FTP_CONFIG = {};
        IS_FTP_CONNECTED = false;
    }
}

// Redis PubSub Listeners
redisPubSub.subscribe(CONFIG_FTP_STATE_KEY + '_update', (err, count) => {
    if (err) {
        logger.error('[FTP_IMAGE] Failed to subscribe:', { error: err.message });
    } else {
        logger.info(`[FTP_IMAGE] Subscribed successfully! Listening on ${count} channel(s).`);
    }
});

redisPubSub.on('message', async (channel, message) => {
    try {
        const parsedMessage = JSON.parse(message);
        
        if (channel === CONFIG_FTP_STATE_KEY + '_update') {
            CONFIG_STATE = parsedMessage;
            
            // console.log(CONFIG_STATE);

            const wasActive = IS_AUTO_TRANSFER_ACTIVE;
            IS_AUTO_TRANSFER_ACTIVE = CONFIG_STATE && CONFIG_STATE.transfer && CONFIG_STATE.transfer.startTransfer || false;
            
            if (IS_AUTO_TRANSFER_ACTIVE && !wasActive) {
                logger.info("[FTP_IMAGE] Auto transfer reactivated - resuming paused FTP jobs");
                await ftpImageJobManager.resumeActiveJobs();
            } else if (!IS_AUTO_TRANSFER_ACTIVE && wasActive) {
                logger.info("[FTP_IMAGE] Auto transfer stopped - pausing active FTP jobs");
                await ftpImageJobManager.pauseActiveJobs('Auto transfer disabled');
            }
            
            // Check if FTP config might have changed
            updateFtpConfig();
        }
    } catch (error) {
        logger.error('[FTP_IMAGE] Error processing Redis message:', { error: error.message });
    }
});

// Main FTP Image Transfer Consumer
async function consumer() {
    logger.info('[FTP_IMAGE] FTP Image Transfer Service started...');   
    
    while (true) {
        try {
            if (!IS_AUTO_TRANSFER_ACTIVE) {
                logger.info("[FTP_IMAGE] Auto transfer disabled - pausing active FTP jobs");
                await ftpImageJobManager.pauseActiveJobs('Auto transfer disabled');
                await sleep(5000);
                continue;
            }

            if (!IS_FTP_CONNECTED || !ftpImageTransferManager.isFtpReady()) {
                logger.info("[FTP_IMAGE] FTP not ready - service paused");
                await sleep(5000);
                continue;
            }

            const activeJob = await ftpImageJobManager.getOrCreateActiveJob();
            if (!activeJob) {
                logger.info("[FTP_IMAGE] No active job and no files to process");
                await sleep(2000);
                continue;
            }

            await runWithTrace({ traceId: newTraceId(), jobId: activeJob.batch_id, jobStatus: activeJob.status }, async () => {
                logger.info(`[FTP_IMAGE] Processing job: ${activeJob.batch_id}`, { jobId: activeJob.batch_id, status: activeJob.status });

                updateFtpConfig();

                logger.info(`[FTP_IMAGE] Status: Active=${IS_AUTO_TRANSFER_ACTIVE}, FTP_Connected=${IS_FTP_CONNECTED}, Server=${FTP_CONFIG.server && FTP_CONFIG.server.host || 'N/A'}`);

                const filesToProcess = await ftpImageTransferManager.getPendingFiles(50);
                logger.info(`[FTP_IMAGE] Found ${filesToProcess.length} pending FTP image files`, { count: filesToProcess.length });

                if (filesToProcess.length === 0) {
                    await sleep(3000);
                    return;
                }

                logger.info(`[FTP_IMAGE] Processing FTP batch of ${filesToProcess.length} image files`, { count: filesToProcess.length });

                const startTime = process.hrtime();
                let processedCount = 0;
                let failedCount = 0;

                for (const file of filesToProcess) {
                    try {
                        if (!IS_AUTO_TRANSFER_ACTIVE || !IS_FTP_CONNECTED) {
                            const reason = !IS_AUTO_TRANSFER_ACTIVE ? 'auto transfer disabled' : 'FTP disconnected';
                            logger.info(`[FTP_IMAGE] Transfer stopped (${reason}) - pausing remaining files`);
                            break;
                        }

                        if (!imageProcessor.isImageExtensionSupported(file.file_path)) {
                            logger.warn(`[FTP_IMAGE] Unsupported image format for file ${file.id}, skipping`, { fileId: file.id });
                            await TransferUtils.handleImageTransferError(pool, file, new Error('Unsupported image format'), 'ftp_image_transfer_queue');
                            continue;
                        }

                        await ftpImageTransferManager.processImageFile(file);
                        processedCount++;
                        
                        if (processedCount % 5 === 0) {
                            logger.info(`[FTP_IMAGE] FTP batch progress: ${processedCount}/${filesToProcess.length} images uploaded`);
                        }
                        
                        await sleep(100);
                        
                    } catch (error) {
                        logger.error(`[FTP_IMAGE] Error processing FTP image file ${file.id}:`, { error: error.message, fileId: file.id });
                        failedCount++;
                        
                        if (TransferUtils.isFileNotFoundError(error)) {
                            logger.warn(`[FTP_IMAGE] File ${file.id} not found - marking as failed`, { fileId: file.id });
                            await ftpImageTransferManager.updateTransferStatus(file.id, 'failed', 'File not found');
                            continue;
                        }
                        
                        if (ftpImageTransferManager.isFtpConnectionError && ftpImageTransferManager.isFtpConnectionError(error)) {
                            logger.warn(`[FTP_IMAGE] FTP connection error - stopping batch`);
                            IS_FTP_CONNECTED = false;
                            await ftpImageTransferManager.handleTransferError(file, error);
                            break;
                        } else {
                            await TransferUtils.handleImageTransferError(pool, file, error, 'ftp_image_transfer_queue');
                        }
                    }
                }
                
                const endTime = process.hrtime(startTime);
                const duration = endTime[0] * 1000 + endTime[1] / 1000000;
                const throughput = processedCount > 0 ? (processedCount / (duration / 1000)).toFixed(2) : 0;
                
                logger.info(`[FTP_IMAGE] FTP batch completed: ${processedCount} uploaded, ${failedCount} failed in ${duration.toFixed(2)}ms (${throughput} files/sec)`, { processedCount, failedCount, duration: duration.toFixed(2), throughput });

                await updateAndPublishMetrics(processedCount, failedCount, filesToProcess.length, duration, throughput);
                await ftpImageTransferManager.checkAndUpdateCompletedJobs();

                if (processedCount > 0) {
                    await sleep(1000);
                }
            });

        } catch (error) {
            logger.error('[FTP_IMAGE] Error in FTP transfer consumer:', { error: error.message, stack: error.stack });
            
            if (ftpImageTransferManager.isFtpConnectionError && ftpImageTransferManager.isFtpConnectionError(error)) {
                IS_FTP_CONNECTED = false;
                await ftpImageTransferManager.disconnectFtp();
            }
            
            await sleep(10000);
        }
    }
}

// Initialize and start service
async function runService() {
    try {
        logger.info('[FTP_IMAGE] Initializing FTP Image Transfer Service...');
        
        let configLoaded = false;
        
        const fileConfig = readConfig();
        if (fileConfig) {
            CONFIG_STATE = fileConfig;
            logger.info('[FTP_IMAGE] Loaded main config from file');
            configLoaded = true;
        }
        
        if (!configLoaded) {
            const redisConfig = await redis.get(CONFIG_FTP_STATE_KEY);
            if (redisConfig) {
                CONFIG_STATE = JSON.parse(redisConfig);
                logger.info('[FTP_IMAGE] Loaded main config from Redis');
                configLoaded = true;
            }
        }
        
        if (!configLoaded) {
            logger.warn('[FTP_IMAGE] No main config found - using defaults');
        }
        
        updateFtpConfig();
        
        if (!IS_FTP_CONNECTED) {
            logger.warn('[FTP_IMAGE] FTP not connected - service will wait for connection');
        }
        
        logger.info('[FTP_IMAGE] Starting FTP consumer...');
        consumer();
        
    } catch (error) {
        logger.error('[FTP_IMAGE] Service initialization error:', { error: error.message, stack: error.stack });
        process.exit(1);
    }
}

process.on('SIGINT', async () => {
    logger.info('[FTP_IMAGE] Shutting down FTP Image Transfer Service...');
    await ftpImageTransferManager.cleanup();
    await imageProcessor.cleanup();
    process.exit(0);
});

// Start the service
runService();

module.exports = {
    ftpImageJobManager,
    ftpImageTransferManager,
    imageSpaceValidator,
    imageProcessor
};

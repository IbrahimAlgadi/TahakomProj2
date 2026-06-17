const Redis = require('ioredis');
const { Pool } = require("pg");
const fs = require('fs-extra');
const path = require('path');
const { CONFIG_STATE_KEY, CONNECTED_DRIVE_STATE, CONNECTED_DRIVE_LIST } = require('./redisKeyStore');
const encryptionService = require('./utils/encryptionService');
const config = require('./utils/envConfig');

const RSA_PUBLIC_KEY_PATH = path.join(__dirname, 'certs', 'public_key.pem');

let DB_USER = "postgres";
let DB_PASSWORD = "postgres";
let DB_HOST = "localhost";
let DB_APP = "tahakom_transfer";


// Initialize Redis client
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

// Initialize Redis client
const redisPubSub = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});


const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD
});


// Queue names - Image specific
const QUEUE_NAMES = {
    IMAGE_FILE_TRANSFER_QUEUE: 'image_file_transfer_queue',
    IMAGE_FILE_TRANSFER_RESULT_QUEUE: 'image_file_transfer_result_queue',
};

let CONFIG_STATE = {};
let DRIVE_INFO = {};
let IS_AUTO_TRANSFER_ACTIVE = true;
let IS_DRIVE_CONNECTED = false;
let SHOULD_STOP_TRANSFER = false;
let SHOULD_STOP_TRANSFER_SIZE = 10; // MB
let IS_ENCRYPTION_REQUIRED = false;


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Function to check if there's enough space for a specific image file
function hasSpaceForFile(fileSizeBytes) {
    if (!DRIVE_INFO) {
        console.warn('[IMAGE] Drive info not available for space check');
        return !SHOULD_STOP_TRANSFER; // Fallback to general threshold check
    }
    
    // Handle different possible property names for free space
    // Values are in GB as strings, convert to bytes
    let freeSpaceGB = 0;
    
    if (DRIVE_INFO.remainingSpace) {
        freeSpaceGB = parseFloat(DRIVE_INFO.remainingSpace);
    } else if (DRIVE_INFO.freeSize) {
        freeSpaceGB = parseFloat(DRIVE_INFO.freeSize);
    } else if (DRIVE_INFO.availableSpace) {
        freeSpaceGB = parseFloat(DRIVE_INFO.availableSpace);
    } else if (DRIVE_INFO.available) {
        freeSpaceGB = parseFloat(DRIVE_INFO.available);
    }
    
    if (freeSpaceGB === 0) {
        console.warn('[IMAGE] No free space information available in drive info');
        return !SHOULD_STOP_TRANSFER;
    }
    
    const fileSizeMB = fileSizeBytes / (1024 * 1024);
    const freeSpaceMB = freeSpaceGB * 1024; // Convert GB to MB
    const bufferMB = 10; // Keep 10MB buffer for images (smaller than videos)
    
    const hasSpace = freeSpaceMB > (fileSizeMB + bufferMB);
    
    if (!hasSpace) {
        console.log(`[IMAGE] Insufficient space: need ${fileSizeMB.toFixed(1)}MB + ${bufferMB}MB buffer, only ${freeSpaceMB.toFixed(1)}MB available`);
    }
    
    return hasSpace;
}

// Function to copy file with retry mechanism for EBUSY errors
async function copyWithRetry(sourcePath, destPath, maxRetries = 3, delay = 1000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await fs.copy(sourcePath, destPath, { overwrite: true, errorOnExist: false });
            return; // Success, exit the function
        } catch (error) {
            lastError = error;
            
            // If it's an EBUSY error and we have more attempts, wait and retry
            if (error.code === 'EBUSY' && attempt < maxRetries) {
                console.warn(`[IMAGE] Copy attempt ${attempt} failed with EBUSY error, retrying in ${delay}ms...`);
                await sleep(delay);
                continue;
            }
            
            // If it's not EBUSY or we're out of attempts, throw the error
            throw error;
        }
    }
    
    throw lastError; // This should never be reached, but just in case
}

// Function to read config from file
function readConfig() {
    try {
        if (fs.existsSync(config.CONFIG_FILE_PATH)) {
            const configData = JSON.parse(fs.readFileSync(config.CONFIG_FILE_PATH, 'utf8'));
            return configData;
        }
        console.log('[IMAGE] Config file not found:', config.CONFIG_FILE_PATH);
        return null;
    } catch (error) {
        console.error('[IMAGE] Error reading config file:', error);
        return null;
    }
}

// Function to detect if error is due to file not being found
/**
 * Update drive information from Redis (similar to autoVideoTransferMicroservice.js)
 */
async function updateDriveInfo() {
    try {
        const driveListStr = await redis.get(CONNECTED_DRIVE_LIST);
        if (driveListStr) {
            const driveList = JSON.parse(driveListStr);
            
            if (driveList && driveList.length > 0) {
                // Find the configured target drive instead of using first drive
                let targetDrive = null;
                const configuredDrive = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive;
                
                if (configuredDrive) {
                    // Look for the configured drive (e.g., "F" matches "F:" or "F")
                    targetDrive = driveList.find(drive => 
                        drive.drive === configuredDrive || 
                        drive.drive === `${configuredDrive}:` ||
                        drive.drive === `${configuredDrive}:`
                    );
                }
                
                // Fallback to first drive if target drive not found
                if (!targetDrive) {
                    console.warn(`[IMAGE] Target drive '${configuredDrive}' not found, using first available drive`);
                    targetDrive = driveList[0];
                }
                
                DRIVE_INFO = targetDrive;
                IS_DRIVE_CONNECTED = true;
                
                // Handle different possible property names for free space
                // Values are in GB as strings, convert to MB
                let freeSpaceGB = 0;
                
                if (DRIVE_INFO.remainingSpace) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.remainingSpace);
                } else if (DRIVE_INFO.freeSize) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.freeSize);
                } else if (DRIVE_INFO.availableSpace) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.availableSpace);
                } else if (DRIVE_INFO.available) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.available);
                }
                
                const freeSpaceMB = freeSpaceGB * 1024; // Convert GB to MB
                SHOULD_STOP_TRANSFER = freeSpaceMB <= SHOULD_STOP_TRANSFER_SIZE;
                
                console.log(`[IMAGE] Drive update: configuredDrive=${configuredDrive}, selectedDrive=${DRIVE_INFO.drive}, freeSpaceGB=${freeSpaceGB}, freeSpaceMB=${freeSpaceMB.toFixed(1)}, threshold=${SHOULD_STOP_TRANSFER_SIZE}MB, SHOULD_STOP_TRANSFER=${SHOULD_STOP_TRANSFER}`);
                
                if (SHOULD_STOP_TRANSFER) {
                    console.log(`[IMAGE] Insufficient space: ${freeSpaceMB.toFixed(1)}MB available, need more than ${SHOULD_STOP_TRANSFER_SIZE}MB`);
                }
            } else {
                DRIVE_INFO = null;
                IS_DRIVE_CONNECTED = false;
                SHOULD_STOP_TRANSFER = true;
                console.log('[IMAGE] No drives connected - driveList empty or null');
            }
        } else {
            DRIVE_INFO = null;
            IS_DRIVE_CONNECTED = false;
            SHOULD_STOP_TRANSFER = true;
            console.log(`[IMAGE] No drive list found in Redis - CONNECTED_DRIVE_LIST key: '${CONNECTED_DRIVE_LIST}'`);
        }
    } catch (error) {
        console.error('[IMAGE] Error updating drive info:', error);
        try {
            const driveListStr = await redis.get(CONNECTED_DRIVE_LIST);
            if (driveListStr) {
                console.error('[IMAGE] Raw drive list string:', driveListStr);
            }
        } catch (logError) {
            console.error('[IMAGE] Error logging drive info:', logError.message);
        }
        DRIVE_INFO = null;
        IS_DRIVE_CONNECTED = false;
        SHOULD_STOP_TRANSFER = true;
    }
}

function isFileNotFoundError(error) {
    return error.code === 'ENOENT' && ['lstat', 'stat', 'open', 'read'].includes(error.syscall);
}

// Function to detect drive disconnection errors
function isDriveDisconnectionError(error) {
    // Exclude simple file-not-found errors first
    if (isFileNotFoundError(error)) {
        return false;
    }
    // Check for common drive disconnection error patterns
    const driveErrorCodes = ['UNKNOWN', 'ENOENT', 'ENOTDIR', 'EACCES'];
    const driveErrorSyscalls = ['mkdir', 'write', 'close']; // Removed 'read', 'open' from drive operations
    const driveErrorPatterns = [
        /mkdir.*[F-Z]:\\/, // Drive access errors (F:, E:, etc.)
        /mkdir.*\\\\?\$/, // UNC path errors like '\\?'
        /no such file or directory.*:\\/, // Drive letter access errors
        /unknown error.*mkdir/, // Unknown mkdir errors on drives
        /ENOENT.*mkdir/, // File not found during mkdir on drives
        /unknown error.*write/, // Unknown write errors on drives
        /write.*[F-Z]:\\/, // Write errors on drives
    ];
    
    // Check error code AND syscall combination for drive operations
    if (driveErrorCodes.includes(error.code) && driveErrorSyscalls.includes(error.syscall)) {
        return true;
    }
    
    // Special case for UNKNOWN write errors (very common for drive disconnect)
    if (error.code === 'UNKNOWN' && error.syscall === 'write') {
        return true;
    }
    
    // Check error message and path patterns
    const errorText = (error.message || '') + ' ' + (error.path || '');
    for (const pattern of driveErrorPatterns) {
        if (pattern.test(errorText)) {
            return true;
        }
    }
    
    return false;
}

redisPubSub.subscribe(CONNECTED_DRIVE_LIST + '_update', (err, count) => {
    if (err) {
        console.error('[IMAGE] Failed to subscribe: %s', err.message);
    } else {
        console.log(`[IMAGE] Subscribed successfully! Listening on ${count} channel(s).`);
    }
});

redisPubSub.subscribe(CONFIG_STATE_KEY + '_update', (err, count) => {
    if (err) {
        console.error('[IMAGE] Failed to subscribe: %s', err.message);
    } else {
        console.log(`[IMAGE] Subscribed successfully! Listening on ${count} channel(s).`);
    }
});

redisPubSub.on('message', async (channel, message) => {
    const parsedMessage = JSON.parse(message);
    // console.log(`Received on ${channel}:`, parsedMessage);
    if (channel === CONNECTED_DRIVE_LIST + '_update') {
        // Update drive info when drive list changes
        await updateDriveInfo();
    }
    if (channel === CONFIG_STATE_KEY + '_update') {
        CONFIG_STATE = parsedMessage;
        
        // Sync encryption setting from config
        IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
        // console.log('[IMAGE] Config update received from Redis - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
        
        const wasActive = IS_AUTO_TRANSFER_ACTIVE;
        
        if (CONFIG_STATE.autoTransfer.isActive) {
            IS_AUTO_TRANSFER_ACTIVE = true;
            
            // Resume paused image jobs when reactivated
            if (!wasActive) {
                console.log("[IMAGE] Auto transfer reactivated - resuming paused image jobs");
                pool.query(`
                    UPDATE transfer_queue_job 
                    SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
                    WHERE status = 'paused' AND batch_origin = 'auto'
                `).catch(err => console.error('[IMAGE] Error resuming paused jobs:', err));
            }
        } else {
            IS_AUTO_TRANSFER_ACTIVE = false;
            
            // Pause active image jobs when deactivated
            if (wasActive) {
                console.log("[IMAGE] Auto transfer stopped - pausing active image jobs");
                pool.query(`
                    UPDATE transfer_queue_job 
                    SET status = 'paused', updated_at = CURRENT_TIMESTAMP 
                    WHERE status = 'transferring' AND batch_origin = 'auto'
                `).catch(err => console.error('[IMAGE] Error pausing active jobs:', err));
            }
        }
    }
});


// Old copyBatch function removed - now using database-based processBatch and processFile functions


// Database-based consumer (Image Transfer Service)
async function consumer() {
    console.log('[IMAGE] Consumer (Image File Transfer Service) started...');   
    
    while (true) {
        try {
            if (!IS_AUTO_TRANSFER_ACTIVE) {
                console.log("[IMAGE] Auto transfer stopped by configuration - pausing active image jobs");
                
                // Pause all transferring image jobs
                await pool.query(`
                    UPDATE transfer_queue_job 
                    SET status = 'paused', updated_at = CURRENT_TIMESTAMP 
                    WHERE status = 'transferring' AND batch_origin = 'auto'
                `);
                
                await sleep(5000);
                continue;
            }

            if (!IS_DRIVE_CONNECTED) {
                console.log("[IMAGE] Drive is not connected - consumer paused");
                await sleep(5000);
                continue;
            }

            if (SHOULD_STOP_TRANSFER) {
                console.log("[IMAGE] USB storage is full - consumer paused");
                await sleep(5000);
                continue;
            }

            // Resume paused jobs and start pending jobs if auto transfer is active and drive is connected
            const resumeResult = await pool.query(`
                UPDATE transfer_queue_job 
                SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
                WHERE status IN ('paused', 'pending') AND batch_origin = 'auto'
                RETURNING id, batch_id, status as old_status
            `);
            
            if (resumeResult.rows.length > 0) {
                console.log(`[IMAGE] Started/Resumed ${resumeResult.rows.length} image job(s): ${resumeResult.rows.map(j => `${j.id} (${j.batch_id}) [${j.old_status}→transferring]`).join(', ')}`);
            }

            // Update drive info periodically
            await updateDriveInfo();

            // Add debugging for image transfer
            console.log('\n=== IMAGE TRANSFER STATUS ===');
            console.log(`[IMAGE] IS_AUTO_TRANSFER_ACTIVE: ${IS_AUTO_TRANSFER_ACTIVE}`);
            console.log(`[IMAGE] IS_DRIVE_CONNECTED: ${IS_DRIVE_CONNECTED}`);
            
            // Calculate free space using the same logic as updateDriveInfo
            let freeSpaceMB = 'N/A';
            if (DRIVE_INFO) {
                let freeSpaceGB = 0;
                if (DRIVE_INFO.remainingSpace) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.remainingSpace);
                } else if (DRIVE_INFO.freeSize) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.freeSize);
                } else if (DRIVE_INFO.availableSpace) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.availableSpace);
                } else if (DRIVE_INFO.available) {
                    freeSpaceGB = parseFloat(DRIVE_INFO.available);
                }
                freeSpaceMB = (freeSpaceGB * 1024).toFixed(1);
            }
            
            console.log(`[IMAGE] USB_SPACE_AVAILABLE: ${!SHOULD_STOP_TRANSFER} (${freeSpaceMB}MB free, threshold: ${SHOULD_STOP_TRANSFER_SIZE}MB)`);
            console.log(`[IMAGE] SELECTED_DRIVE: ${DRIVE_INFO ? DRIVE_INFO.drive : 'N/A'}`);
            console.log(`[IMAGE] CONFIG_STATE loaded: ${!!CONFIG_STATE.autoTransfer}`);
            console.log('=== END IMAGE STATUS ===\n');

            // Get up to 100 image files from any active jobs
            const imageFiles = await pool.query(`
                SELECT tq.*, tqj.batch_id, tqj.batch_origin
                FROM transfer_queue tq
                JOIN transfer_queue_job tqj ON tq.job_id = tqj.id
                WHERE tq.status = 'pending' 
                AND tqj.status IN ('transferring', 'pending')
                AND tqj.batch_origin = 'auto'
                ORDER BY tq.created_at ASC
                LIMIT 100
            `);

            const filesToProcess = imageFiles.rows;
            console.log(`[IMAGE] Found ${imageFiles.rows.length} pending image files`);

            if (filesToProcess.length === 0) {
                await sleep(2000);
                continue;
            }

            console.log(`[IMAGE] Processing batch of ${filesToProcess.length} image files`);

            // Process the entire batch of up to 100 files
            const startTime = process.hrtime();
            let processedCount = 0;
            let failedCount = 0;

            for (const file of filesToProcess) {
                try {
                    if (!IS_AUTO_TRANSFER_ACTIVE || !IS_DRIVE_CONNECTED || SHOULD_STOP_TRANSFER) {
                        const reason = !IS_AUTO_TRANSFER_ACTIVE ? 'auto transfer disabled' : 
                                     !IS_DRIVE_CONNECTED ? 'drive disconnected' : 'USB storage full';
                        console.log(`[IMAGE] Transfer stopped (${reason}) - pausing remaining ${filesToProcess.length - processedCount} image files in batch`);
                        break;
                    }

                    // Check if there's enough space for this specific image file
                    if (!hasSpaceForFile(file.file_size || 0)) {
                        console.log(`[IMAGE] Insufficient space for image file ${file.id} (${((file.file_size || 0) / (1024 * 1024)).toFixed(1)}MB) - stopping batch`);
                        
                        // Mark this file as failed due to insufficient space
                        await pool.query(`
                            UPDATE transfer_queue 
                            SET status = 'failed', error_message = 'Insufficient USB space', updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $1
                        `, [file.id]);
                        
                        // Stop processing more files as there's no space
                        break;
                    }

                    await processImageFile(file);
                    await updateJobStats(file.job_id);
                    processedCount++;
                    
                    // Log progress every 10 files
                    if (processedCount % 10 === 0) {
                        console.log(`[IMAGE] Batch progress: ${processedCount}/${filesToProcess.length} image files processed`);
                    }
                    
                } catch (error) {
                    console.error(`[IMAGE] Error processing image file ${file.id}:`, error);
                    failedCount++;
                    
                    // Check if error is due to file not being found
                    const isFileNotFound = isFileNotFoundError(error);
                    
                    if (isFileNotFound) {
                        console.log(`[IMAGE] Image file ${file.id} not found - marking as failed (file deleted): ${file.file_path}`);
                        
                        // Mark file as failed in the database (file was deleted/not found)
                        await pool.query(`
                            UPDATE transfer_queue 
                            SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $2
                        `, [`File not found: ${error.message}`, file.id]);
                        
                        // Continue with next file instead of breaking
                        continue;
                    }
                    
                    // Check if error is due to drive disconnection
                    const isDriveError = isDriveDisconnectionError(error);
                    
                    if (isDriveError) {
                        console.log(`[IMAGE] Drive disconnection detected during image file ${file.id} - stopping batch`);
                        IS_DRIVE_CONNECTED = false;
                        break;
                    } else {
                        // Handle regular file errors
                        const newRetryCount = file.retry_count + 1;
                        const newStatus = newRetryCount >= file.max_retries ? 'failed' : 'pending';
                        
                        await pool.query(`
                            UPDATE transfer_queue 
                            SET retry_count = $1, status = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $4
                        `, [newRetryCount, newStatus, error.message, file.id]);
                    }
                }
            }
            
            const endTime = process.hrtime(startTime);
            const duration = endTime[0] * 1000 + endTime[1] / 1000000;
            const throughput = processedCount > 0 ? (processedCount / (duration / 1000)).toFixed(2) : 0;
            
            console.log(`[IMAGE] Batch completed: ${processedCount} transferred, ${failedCount} failed in ${duration.toFixed(2)} ms (${throughput} files/sec)`);

            // Check for completed jobs after batch processing
            await checkAndUpdateCompletedJobs();

            // Small delay before next batch to prevent overwhelming the system
            if (processedCount > 0) {
                await sleep(500); // Short pause between batches
            }

        } catch (error) {
            console.error('[IMAGE] Error processing image transfer queue:', error);
            await sleep(5000);
        }
    }
}

async function updateJobStats(jobId) {
    await pool.query(`
        UPDATE transfer_queue_job 
        SET 
            transferred_files = (SELECT COUNT(*) FROM transfer_queue WHERE job_id = $1 AND status = 'transferred'),
            transferred_size = (SELECT COALESCE(SUM(file_size), 0) FROM transfer_queue WHERE job_id = $1 AND status = 'transferred'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
    `, [jobId]);
}

async function checkAndUpdateCompletedJobs() {
    // Find jobs that might be completed
    const jobsToCheck = await pool.query(`
        SELECT DISTINCT tqj.id, tqj.batch_id
        FROM transfer_queue_job tqj
        WHERE tqj.status = 'transferring'
        AND NOT EXISTS (
            SELECT 1 FROM transfer_queue tq 
            WHERE tq.job_id = tqj.id AND tq.status = 'pending'
        )
    `);

    for (const job of jobsToCheck.rows) {
        const jobStatus = await pool.query(`
            SELECT 
                COUNT(*) as total_files,
                COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_files
            FROM transfer_queue 
            WHERE job_id = $1
        `, [job.id]);
        
        const stats = jobStatus.rows[0];
        const jobFinalStatus = stats.transferred_files > 0 ? 'transferred' : 'failed';
        
        await pool.query(`
            UPDATE transfer_queue_job 
            SET status = $1, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [jobFinalStatus, job.id]);
        
        console.log(`Job ${job.id} (${job.batch_id}) marked as ${jobFinalStatus} - transferred: ${stats.transferred_files}, failed: ${stats.failed_files}`);
    }
}

async function processImageFile(file) {
    console.log(`[IMAGE] Processing image file: ${file.file_path}`);
    
    // Capture encryption decision ONCE at the start to avoid race conditions
    const shouldEncrypt = IS_ENCRYPTION_REQUIRED;
    console.log(`[IMAGE] Image file ${file.id} - shouldEncrypt: ${shouldEncrypt} (captured at start)`);
    
    try {
        // Update file destinations based on current config
        const EXPORT_DIR = CONFIG_STATE.storage.directory;
        const usb_path = `${CONFIG_STATE.autoTransfer.drive}:\\`;
        
        // For image files, use the existing logic
        const relativePath = path.relative(EXPORT_DIR, file.file_path);
        const destinationPath = path.join(usb_path, relativePath);
        console.log(`[IMAGE] Image file: ${path.basename(file.file_path)} -> ${relativePath}`);
        
        // Update the transfer_queue record with paths
        await pool.query(`
            UPDATE transfer_queue 
            SET destination_path = $1, usb_path = $2, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $3
        `, [destinationPath, usb_path, file.id]);

        if (shouldEncrypt) {
            // Handle encrypted image transfer
            await processEncryptedImageFile(file, EXPORT_DIR, usb_path);
        } else {
            // Handle normal transfer
            await fs.ensureDir(path.dirname(destinationPath));
            
            // Check if destination file already exists and skip if same size
            const sourceExists = await fs.pathExists(file.file_path);
            const destExists = await fs.pathExists(destinationPath);
            
            if (!sourceExists) {
                throw new Error(`Source image file not found: ${file.file_path}`);
            }
            
            let shouldCopy = true;
            
            if (destExists) {
                try {
                    const sourceStat = await fs.stat(file.file_path);
                    const destStat = await fs.stat(destinationPath);
                    
                    // If destination file has same size, assume it's already transferred correctly
                    if (sourceStat.size === destStat.size) {
                        console.log(`[IMAGE] File already exists with same size, skipping copy: ${destinationPath}`);
                        shouldCopy = false;
                    }
                } catch (statError) {
                    console.warn(`[IMAGE] Could not compare file stats, proceeding with copy: ${statError.message}`);
                }
            }
            
            if (shouldCopy) {
                // Use overwrite option to handle existing files more gracefully with retry mechanism
                try {
                    await copyWithRetry(file.file_path, destinationPath, 3, 1000);
                    console.log(`[IMAGE] Copied: ${file.file_path} to ${destinationPath}`);
                } catch (retryError) {
                    // Fallback to direct copy if copyWithRetry is not available
                    console.warn(`[IMAGE] copyWithRetry failed, falling back to direct copy:`, retryError.message);
                    await fs.copy(file.file_path, destinationPath, { overwrite: true, errorOnExist: false });
                    console.log(`[IMAGE] Copied (fallback): ${file.file_path} to ${destinationPath}`);
                }
            } else {
                console.log(`[IMAGE] Skipped copy (file exists): ${file.file_path} to ${destinationPath}`);
            }
        }
        
        // Mark as transferred on success
        await pool.query(`
            UPDATE transfer_queue 
            SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [file.id]);
        
        // Update original files table
        await pool.query(`
            UPDATE public.files SET is_auto_transferred = true WHERE id = $1
        `, [file.file_id]);
        
        // Image files transferred successfully
        
        console.log(`[IMAGE] Successfully transferred image file ID: ${file.id}`);
        
    } catch (error) {
        console.error(`[IMAGE] Failed to process image file ${file.id}:`, error);
        throw error;
    }
}

async function processEncryptedImageFile(file, EXPORT_DIR, usb_path) {
    // For encrypted image files, we need to group by batch and handle encryption
    // This is a simplified version - you may need to adapt based on your encryption requirements
    
    // For image files, use the existing logic
    const relativeDirPath = path.dirname(path.relative(EXPORT_DIR, file.file_path));
    const destinationGroupDir = path.join(usb_path, relativeDirPath);
    
    await fs.ensureDir(destinationGroupDir);
    
    // Generate or reuse AES key for this batch
    const { key: aesKey, iv: aesIv } = encryptionService.generateAESKey();
    
    const originalFilename = path.basename(file.file_path);
    const newFilename = `${file.id}`; // Use file ID as encrypted filename
    const encryptedFilePath = path.join(destinationGroupDir, newFilename);
    
    console.log(`[IMAGE] Encrypting: ${file.file_path} to ${encryptedFilePath}`);
    await encryptionService.encryptFileAES(file.file_path, encryptedFilePath, aesKey, aesIv);
    
    // Store encryption metadata in the transfer_queue table
    await pool.query(`
        UPDATE transfer_queue 
        SET error_message = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
    `, [JSON.stringify({aesKey: aesKey.toString('hex'), iv: aesIv.toString('hex')}), file.id]);
}


// Run the simulation
async function runSimulation() {
    try {
        // Clear existing queues
        await redis.del(QUEUE_NAMES.IMAGE_FILE_TRANSFER_QUEUE);
        await redis.del(QUEUE_NAMES.IMAGE_FILE_TRANSFER_RESULT_QUEUE);
        
        // Load initial config from file first, then fallback to Redis
        let configLoaded = false;
        
        // Try to load from file first
        const fileConfig = readConfig();
        if (fileConfig) {
            CONFIG_STATE = fileConfig;
            IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
            console.log('[IMAGE] Loaded config from file - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
            configLoaded = true;
        }
        
        // Fallback to Redis if file load failed
        if (!configLoaded) {
            const redisConfig = await redis.get(CONFIG_STATE_KEY);
            if (redisConfig) {
                CONFIG_STATE = JSON.parse(redisConfig);
                IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
                console.log('[IMAGE] Loaded config from Redis - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
                configLoaded = true;
            }
        }
        
        if (!configLoaded) {
            console.log('[IMAGE] No config found in file or Redis - using defaults');
        }
        
        // Initial drive info update
        await updateDriveInfo();
        
        consumer();
        
    } catch (error) {
        console.error('[IMAGE] Simulation error:', error);
        process.exit(1);
    }
}
runSimulation();


// Keep the process running
process.on('SIGINT', async () => {
    console.log('[IMAGE] Cleaning up...');
    // await redis.quit();
    process.exit(0);
});

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

// Queue names - Video specific
const QUEUE_NAMES = {
    VIDEO_FILE_TRANSFER_QUEUE: 'video_file_transfer_queue',
    VIDEO_FILE_TRANSFER_RESULT_QUEUE: 'video_file_transfer_result_queue',
};

let CONFIG_STATE = {};
let DRIVE_INFO = {};
let IS_AUTO_TRANSFER_ACTIVE = true;
let IS_DRIVE_CONNECTED = false;
let SHOULD_STOP_TRANSFER = false;
let SHOULD_STOP_TRANSFER_SIZE = 500; // MB
let IS_ENCRYPTION_REQUIRED = false;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Safe directory removal that works with different Node.js versions
 */
async function safeRemoveDirectory(dirPath) {
    try {
        console.log(`[CLEANUP] Attempting to remove directory: ${dirPath}`);
        
        // Debug: Check what methods are available on fs object
        const fsMethodsAvailable = {
            remove: typeof fs.remove,
            rm: typeof fs.rm,
            rmdir: typeof fs.rmdir,
            readdir: typeof fs.readdir,
            stat: typeof fs.stat,
            unlink: typeof fs.unlink
        };
        // console.log(`[CLEANUP] Available fs methods:`, fsMethodsAvailable);
        // console.log(`[CLEANUP] Node.js version: ${process.version}`);
        
        // Force manual removal for compatibility (fs-extra might try to use fs.rm internally)
        console.log(`[CLEANUP] Using manual recursive removal for compatibility`);
        
        // Manual recursive removal (most compatible approach)
        const files = await fs.readdir(dirPath);
        console.log(`[CLEANUP] Found ${files.length} items in directory to remove`);
        
        for (const file of files) {
            const filePath = path.join(dirPath, file);
            const stat = await fs.stat(filePath);
            
            if (stat.isDirectory()) {
                console.log(`[CLEANUP] Recursively removing subdirectory: ${file}`);
                await safeRemoveDirectory(filePath); // Recursive call
            } else {
                console.log(`[CLEANUP] Removing file: ${file}`);
                await fs.unlink(filePath);
            }
        }
        
        console.log(`[CLEANUP] Removing empty directory: ${path.basename(dirPath)}`);
        await fs.rmdir(dirPath);
        console.log(`[CLEANUP] Successfully removed directory: ${path.basename(dirPath)}`);
        return true;
    } catch (error) {
        console.warn(`[CLEANUP] Error removing directory ${dirPath}: ${error.message}`);
        return false;
    }
}

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
                    console.warn(`[VIDEO] Target drive '${configuredDrive}' not found, using first available drive`);
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
                
                console.log(`[VIDEO] Drive update: configuredDrive=${configuredDrive}, selectedDrive=${DRIVE_INFO.drive}, freeSpaceGB=${freeSpaceGB}, freeSpaceMB=${freeSpaceMB.toFixed(1)}, threshold=${SHOULD_STOP_TRANSFER_SIZE}MB, SHOULD_STOP_TRANSFER=${SHOULD_STOP_TRANSFER}`);
                
                if (SHOULD_STOP_TRANSFER) {
                    console.log(`[VIDEO] Insufficient space: ${freeSpaceMB.toFixed(1)}MB available, need more than ${SHOULD_STOP_TRANSFER_SIZE}MB`);
                }
            } else {
                DRIVE_INFO = null;
                IS_DRIVE_CONNECTED = false;
                SHOULD_STOP_TRANSFER = true;
                console.log('[VIDEO] No drives connected - driveList empty or null');
            }
        } else {
            DRIVE_INFO = null;
            IS_DRIVE_CONNECTED = false;
            SHOULD_STOP_TRANSFER = true;
            console.log(`[VIDEO] No drive list found in Redis - CONNECTED_DRIVE_LIST key: '${CONNECTED_DRIVE_LIST}'`);
        }
    } catch (error) {
        console.error('[VIDEO] Error updating drive info:', error);
        try {
            const driveListStr = await redis.get(CONNECTED_DRIVE_LIST);
            if (driveListStr) {
                console.error('[VIDEO] Raw drive list string:', driveListStr);
            }
        } catch (logError) {
            console.error('[VIDEO] Error logging drive info:', logError.message);
        }
        DRIVE_INFO = null;
        IS_DRIVE_CONNECTED = false;
        SHOULD_STOP_TRANSFER = true;
    }
}

// Function to check if there's enough space for a specific video file
function hasSpaceForFile(fileSizeBytes) {
    if (!DRIVE_INFO) {
        console.warn('[VIDEO] Drive info not available for space check');
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
        console.warn('[VIDEO] No free space information available in drive info');
        return !SHOULD_STOP_TRANSFER;
    }
    
    const fileSizeMB = fileSizeBytes / (1024 * 1024);
    const freeSpaceMB = freeSpaceGB * 1024; // Convert GB to MB
    const bufferMB = 100; // Keep 100MB buffer for safety
    
    const hasSpace = freeSpaceMB > (fileSizeMB + bufferMB);
    
    if (!hasSpace) {
        console.log(`[VIDEO] Insufficient space: need ${fileSizeMB.toFixed(1)}MB + ${bufferMB}MB buffer, only ${freeSpaceMB.toFixed(1)}MB available`);
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
                console.warn(`[VIDEO] Copy attempt ${attempt} failed with EBUSY error, retrying in ${delay}ms...`);
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
        console.log('[VIDEO] Config file not found:', config.CONFIG_FILE_PATH);
        return null;
    } catch (error) {
        console.error('[VIDEO] Error reading config file:', error);
        return null;
    }
}

// Function to detect if error is due to file not being found
function isFileNotFoundError(error) {
    return error.code === 'ENOENT' && ['lstat', 'stat', 'open', 'read'].includes(error.syscall);
}

// Function to detect ENOSPC (no space left) errors
function isNoSpaceLeftError(error) {
    return error.code === 'ENOSPC' || 
           (error.message && error.message.toLowerCase().includes('no space left on device'));
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
        console.error('[VIDEO] Failed to subscribe: %s', err.message);
    } else {
        console.log(`[VIDEO] Subscribed successfully! Listening on ${count} channel(s).`);
    }
});

redisPubSub.subscribe(CONFIG_STATE_KEY + '_update', (err, count) => {
    if (err) {
        console.error('[VIDEO] Failed to subscribe: %s', err.message);
    } else {
        console.log(`[VIDEO] Subscribed successfully! Listening on ${count} channel(s).`);
    }
});

redisPubSub.on('message', async (channel, message) => {
    const parsedMessage = JSON.parse(message);
    // console.log(`[VIDEO] Received on ${channel}:`, parsedMessage);
    if (channel === CONNECTED_DRIVE_LIST + '_update') {
        // Update drive info when drive list changes
        await updateDriveInfo();
    }
    if (channel === CONFIG_STATE_KEY + '_update') {
        CONFIG_STATE = parsedMessage;
        
        // Sync encryption setting from config
        IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
        // console.log('[VIDEO] Config update received from Redis - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
        
        const wasActive = IS_AUTO_TRANSFER_ACTIVE;
        
        if (CONFIG_STATE.autoTransfer.isActive) {
            IS_AUTO_TRANSFER_ACTIVE = true;
            
            // Resume paused video jobs when reactivated
            if (!wasActive) {
                console.log("[VIDEO] Auto transfer reactivated - resuming paused video jobs");
                pool.query(`
                    UPDATE video_transfer_queue_job 
                    SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
                    WHERE status = 'paused' AND batch_origin = 'auto_video'
                `).catch(err => console.error('[VIDEO] Error resuming paused jobs:', err));
            }
        } else {
            IS_AUTO_TRANSFER_ACTIVE = false;
            
            // Pause active video jobs when deactivated
            if (wasActive) {
                console.log("[VIDEO] Auto transfer stopped - pausing active video jobs");
                pool.query(`
                    UPDATE video_transfer_queue_job 
                    SET status = 'paused', updated_at = CURRENT_TIMESTAMP 
                    WHERE status = 'transferring' AND batch_origin = 'auto_video'
                `).catch(err => console.error('[VIDEO] Error pausing active jobs:', err));
            }
        }
    }
});

// Database-based consumer (Video Transfer Service)
async function consumer() {
    console.log('[VIDEO] Consumer (Video File Transfer Service) started...');   
    
    while (true) {
        try {
            if (!IS_AUTO_TRANSFER_ACTIVE) {
                console.log("[VIDEO] Auto transfer stopped by configuration - pausing active video jobs");
                
                // Pause all transferring video jobs
                await pool.query(`
                    UPDATE video_transfer_queue_job 
                    SET status = 'paused', updated_at = CURRENT_TIMESTAMP 
                    WHERE status = 'transferring' AND batch_origin = 'auto_video'
                `);
                
                await sleep(5000);
                continue;
            }

            if (!IS_DRIVE_CONNECTED) {
                console.log("[VIDEO] Drive is not connected - consumer paused");
                await sleep(5000);
                continue;
            }

            if (SHOULD_STOP_TRANSFER) {
                console.log("[VIDEO] USB storage is full - consumer paused");
                await sleep(5000);
                continue;
            }

            // Resume paused files when space becomes available
            const resumeFileResult = await pool.query(`
                UPDATE video_transfer_queue 
                SET status = 'pending', error_message = NULL, updated_at = CURRENT_TIMESTAMP 
                WHERE status = 'paused' 
                AND error_message LIKE '%No space left%'
                RETURNING id, job_id
            `);
            
            if (resumeFileResult.rows.length > 0) {
                console.log(`[VIDEO] Resumed ${resumeFileResult.rows.length} paused video file(s) due to space availability`);
                
                // Resume associated jobs that were paused due to space issues
                const uniqueJobIds = [...new Set(resumeFileResult.rows.map(f => f.job_id))];
                for (const jobId of uniqueJobIds) {
                    await pool.query(`
                        UPDATE video_transfer_queue_job 
                        SET status = 'transferring', error_message = NULL, updated_at = CURRENT_TIMESTAMP 
                        WHERE id = $1 AND status = 'paused' AND error_message LIKE '%No space left%'
                    `, [jobId]);
                }
                console.log(`[VIDEO] Resumed ${uniqueJobIds.length} job(s) that were paused due to space issues`);
            }

            // Resume paused jobs and start pending jobs if auto transfer is active and drive is connected
            const resumeResult = await pool.query(`
                UPDATE video_transfer_queue_job 
                SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
                WHERE status IN ('paused', 'pending') AND batch_origin = 'auto_video'
                AND NOT (error_message LIKE '%No space left%')
                RETURNING id, batch_id, status as old_status
            `);
            
            if (resumeResult.rows.length > 0) {
                console.log(`[VIDEO] Started/Resumed ${resumeResult.rows.length} video job(s): ${resumeResult.rows.map(j => `${j.id} (${j.batch_id}) [${j.old_status}→transferring]`).join(', ')}`);
            }

            // Update drive info periodically
            await updateDriveInfo();

            // Add debugging for video transfer
            console.log('\n=== VIDEO TRANSFER STATUS ===');
            console.log(`[VIDEO] IS_AUTO_TRANSFER_ACTIVE: ${IS_AUTO_TRANSFER_ACTIVE}`);
            console.log(`[VIDEO] IS_DRIVE_CONNECTED: ${IS_DRIVE_CONNECTED}`);
            
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
            
            console.log(`[VIDEO] USB_SPACE_AVAILABLE: ${!SHOULD_STOP_TRANSFER} (${freeSpaceMB}MB free, threshold: ${SHOULD_STOP_TRANSFER_SIZE}MB)`);
            console.log(`[VIDEO] SELECTED_DRIVE: ${DRIVE_INFO ? DRIVE_INFO.drive : 'N/A'}`);
            console.log(`[VIDEO] CONFIG_STATE loaded: ${!!CONFIG_STATE.autoTransfer}`);
            console.log('=== END VIDEO STATUS ===\n');

            // Get up to 50 video files from any active jobs
            const videoFiles = await pool.query(`
                SELECT vtq.*, vtqj.batch_id, vtqj.batch_origin
                FROM video_transfer_queue vtq
                JOIN video_transfer_queue_job vtqj ON vtq.job_id = vtqj.id
                WHERE vtq.status = 'pending' 
                AND vtqj.status IN ('transferring', 'pending')
                ORDER BY vtq.created_at ASC
                LIMIT 50
            `);

            if (videoFiles.rows.length === 0) {
                await sleep(1000); // Reduced from 2000ms for faster response
                continue;
            }

            console.log(`[VIDEO] Processing batch of ${videoFiles.rows.length} video files`);

            // Process the video files
            const startTime = process.hrtime();
            let processedCount = 0;
            let failedCount = 0;

            for (const file of videoFiles.rows) {
                try {
                    if (!IS_AUTO_TRANSFER_ACTIVE || !IS_DRIVE_CONNECTED || SHOULD_STOP_TRANSFER) {
                        const reason = !IS_AUTO_TRANSFER_ACTIVE ? 'auto transfer disabled' : 
                                     !IS_DRIVE_CONNECTED ? 'drive disconnected' : 'USB storage full';
                        console.log(`[VIDEO] Transfer stopped (${reason}) - pausing remaining ${videoFiles.rows.length - processedCount} video files in batch`);
                        break;
                    }

                    // Check if there's enough space for this specific video file
                    if (!hasSpaceForFile(file.video_file_size || 0)) {
                        console.log(`[VIDEO] Insufficient space for video file ${file.id} (${((file.video_file_size || 0) / (1024 * 1024)).toFixed(1)}MB) - stopping batch`);
                        
                        // Mark this file as failed due to insufficient space
                        await pool.query(`
                            UPDATE video_transfer_queue 
                            SET status = 'failed', error_message = 'Insufficient USB space', updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $1
                        `, [file.id]);
                        
                        // Stop processing more files as there's no space
                        break;
                    }

                    await processVideoFile(file);
                    await updateJobStats(file.job_id);
                    processedCount++;
                    
                    // Log progress every 5 files for videos
                    if (processedCount % 5 === 0) {
                        console.log(`[VIDEO] Batch progress: ${processedCount}/${videoFiles.rows.length} video files processed`);
                    }
                    
                } catch (error) {
                    console.error(`[VIDEO] Error processing video file ${file.id}:`, error);
                    failedCount++;
                    
                    // Check if error is due to file not being found
                    const isFileNotFound = isFileNotFoundError(error);
                    
                    if (isFileNotFound) {
                        console.log(`[VIDEO] Video file ${file.id} not found - marking as failed (file deleted): ${file.video_file_path}`);
                        
                        // Mark file as failed in the database (file was deleted/not found)
                        await pool.query(`
                            UPDATE video_transfer_queue 
                            SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $2
                        `, [`File not found: ${error.message}`, file.id]);
                        
                        // Continue with next file instead of breaking
                        continue;
                    }
                    
                    // Check if error is due to no space left (ENOSPC)
                    const isNoSpaceError = isNoSpaceLeftError(error);
                    
                    if (isNoSpaceError) {
                        console.log(`[VIDEO] No space left on device for video file ${file.id} - pausing file and stopping batch`);
                        
                        // Mark file as paused due to space issues (not failed)
                        await pool.query(`
                            UPDATE video_transfer_queue 
                            SET status = 'paused', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $2
                        `, [`No space left on device: ${error.message}`, file.id]);
                        
                        // Also pause the job since there's no space
                        await pool.query(`
                            UPDATE video_transfer_queue_job 
                            SET status = 'paused', error_message = 'Transfer paused: No space left on USB device', updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $1
                        `, [file.job_id]);
                        
                        // Set global flag to stop transfer until space is available
                        SHOULD_STOP_TRANSFER = true;
                        
                        console.log(`[VIDEO] Job ${file.job_id} paused due to insufficient USB space`);
                        break; // Stop processing more files
                    }
                    
                    // Check if error is due to drive disconnection
                    const isDriveError = isDriveDisconnectionError(error);
                    
                    if (isDriveError) {
                        console.log(`[VIDEO] Drive disconnection detected during video file ${file.id} - stopping batch`);
                        IS_DRIVE_CONNECTED = false;
                        break;
                    } else {
                        // Handle regular file errors
                        const newRetryCount = file.retry_count + 1;
                        const newStatus = newRetryCount >= file.max_retries ? 'failed' : 'pending';
                        
                        await pool.query(`
                            UPDATE video_transfer_queue 
                            SET retry_count = $1, status = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $4
                        `, [newRetryCount, newStatus, error.message, file.id]);
                    }
                }
            }
            
            const endTime = process.hrtime(startTime);
            const duration = endTime[0] * 1000 + endTime[1] / 1000000;
            const throughput = processedCount > 0 ? (processedCount / (duration / 1000)).toFixed(2) : 0;
            
            console.log(`[VIDEO] Batch completed: ${processedCount} transferred, ${failedCount} failed in ${duration.toFixed(2)} ms (${throughput} files/sec)`);

            // Check for completed jobs after batch processing
            await checkAndUpdateCompletedJobs();
            
            // Diagnostic check for inconsistent job states
            await checkInconsistentJobStates();

            // Small delay before next batch to prevent overwhelming the system
            if (processedCount > 0) {
                await sleep(200); // Reduced from 500ms for faster batch processing
            }

        } catch (error) {
            console.error('[VIDEO] Error processing video transfer queue:', error);
            await sleep(5000);
        }
    }
}

async function updateJobStats(jobId) {
    await pool.query(`
        UPDATE video_transfer_queue_job 
        SET 
            transferred_videos = (SELECT COUNT(*) FROM video_transfer_queue WHERE job_id = $1 AND status = 'transferred'),
            transferred_size = (SELECT COALESCE(SUM(video_file_size), 0) FROM video_transfer_queue WHERE job_id = $1 AND status = 'transferred'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
    `, [jobId]);
}

async function checkAndUpdateCompletedJobs() {
    // Find video jobs that might be completed (no pending files)
    // Include both 'transferring' and 'pending' jobs to handle race conditions
    const jobsToCheck = await pool.query(`
        SELECT DISTINCT vtqj.id, vtqj.batch_id
        FROM video_transfer_queue_job vtqj
        WHERE vtqj.status IN ('transferring', 'pending')
        AND vtqj.batch_origin = 'auto_video'
        AND NOT EXISTS (
            SELECT 1 FROM video_transfer_queue vtq 
            WHERE vtq.job_id = vtqj.id AND vtq.status = 'pending'
        )
    `);

    for (const job of jobsToCheck.rows) {
        const jobStatus = await pool.query(`
            SELECT 
                COUNT(*) as total_videos,
                COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_videos,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_videos,
                COUNT(CASE WHEN status = 'paused' THEN 1 END) as paused_videos
            FROM video_transfer_queue 
            WHERE job_id = $1
        `, [job.id]);
        
        const stats = jobStatus.rows[0];
        let jobFinalStatus;
        let completedAt = null;
        
        // Determine job status based on file statuses
        if (stats.paused_videos > 0) {
            // If any files are paused (due to space issues), keep job as paused
            jobFinalStatus = 'paused';
            // Don't set completed_at for paused jobs
        } else if (stats.transferred_videos === parseInt(stats.total_videos)) {
            // All files transferred successfully
            jobFinalStatus = 'transferred';
            completedAt = 'CURRENT_TIMESTAMP';
        } else if (stats.transferred_videos > 0) {
            // Some files transferred, others failed
            jobFinalStatus = 'transferred';
            completedAt = 'CURRENT_TIMESTAMP';
        } else {
            // No files transferred (all failed)
            jobFinalStatus = 'failed';
            completedAt = 'CURRENT_TIMESTAMP';
        }
        
        // Update job status
        if (completedAt) {
            await pool.query(`
                UPDATE video_transfer_queue_job 
                SET status = $1, completed_at = ${completedAt}, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [jobFinalStatus, job.id]);
        } else {
            await pool.query(`
                UPDATE video_transfer_queue_job 
                SET status = $1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [jobFinalStatus, job.id]);
        }
        
        console.log(`[VIDEO] Job ${job.id} (${job.batch_id}) updated: pending→${jobFinalStatus} - transferred: ${stats.transferred_videos}, failed: ${stats.failed_videos}, paused: ${stats.paused_videos}, total: ${stats.total_videos}`);
    }
}

async function checkInconsistentJobStates() {
    try {
        // Find jobs with inconsistent states (pending/transferring but no pending files)
        const inconsistentJobs = await pool.query(`
            SELECT 
                vtqj.id, 
                vtqj.batch_id, 
                vtqj.status as job_status,
                vtqj.transferred_videos,
                vtqj.total_videos,
                COUNT(vtq.id) as total_files,
                COUNT(CASE WHEN vtq.status = 'pending' THEN 1 END) as pending_files,
                COUNT(CASE WHEN vtq.status = 'transferred' THEN 1 END) as transferred_files,
                COUNT(CASE WHEN vtq.status = 'failed' THEN 1 END) as failed_files,
                COUNT(CASE WHEN vtq.status = 'paused' THEN 1 END) as paused_files
            FROM video_transfer_queue_job vtqj
            LEFT JOIN video_transfer_queue vtq ON vtq.job_id = vtqj.id
            WHERE vtqj.batch_origin = 'auto_video'
            AND vtqj.status IN ('pending', 'transferring')
            GROUP BY vtqj.id, vtqj.batch_id, vtqj.status, vtqj.transferred_videos, vtqj.total_videos
            HAVING COUNT(CASE WHEN vtq.status = 'pending' THEN 1 END) = 0
            AND COUNT(vtq.id) > 0
        `);
        
        if (inconsistentJobs.rows.length > 0) {
            console.log(`[VIDEO] WARNING: Found ${inconsistentJobs.rows.length} job(s) with inconsistent states:`);
            for (const job of inconsistentJobs.rows) {
                console.log(`[VIDEO] - Job ${job.id} (${job.batch_id}): status=${job.job_status}, files=[pending:${job.pending_files}, transferred:${job.transferred_files}, failed:${job.failed_files}, paused:${job.paused_files}]`);
            }
        }
    } catch (error) {
        console.error('[VIDEO] Error checking inconsistent job states:', error);
    }
}

async function processVideoFile(file) {
    console.log(`[VIDEO] Processing video file: ${file.video_file_path}`);
    
    // Capture encryption decision ONCE at the start to avoid race conditions
    const shouldEncrypt = IS_ENCRYPTION_REQUIRED;
    console.log(`[VIDEO] Video file ${file.id} - shouldEncrypt: ${shouldEncrypt} (captured at start)`);
    
    try {
        // Update file destinations based on current config
        const usb_path = `${CONFIG_STATE.autoTransfer.drive}:\\`;
        
        // For video files, use the filename and place in a videos folder
        const videoFileName = path.basename(file.video_file_path);
        const relativePath = path.join('videos', videoFileName);
        const destinationPath = path.join(usb_path, relativePath);
        console.log(`[VIDEO] Video file detected: ${videoFileName} -> ${relativePath}`);
        
        // Update the video_transfer_queue record with paths
        await pool.query(`
            UPDATE video_transfer_queue 
            SET destination_path = $1, usb_path = $2, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $3
        `, [destinationPath, usb_path, file.id]);

        if (shouldEncrypt) {
            // Handle encrypted video transfer
            await processEncryptedVideoFile(file, usb_path);
        } else {
            // Handle normal video transfer
            await fs.ensureDir(path.dirname(destinationPath));
            
            // Check if destination file already exists and skip if same size
            const sourceExists = await fs.pathExists(file.video_file_path);
            const destExists = await fs.pathExists(destinationPath);
            
            if (!sourceExists) {
                throw new Error(`Source video file not found: ${file.video_file_path}`);
            }
            
            let shouldCopy = true;
            
            if (destExists) {
                try {
                    const sourceStat = await fs.stat(file.video_file_path);
                    const destStat = await fs.stat(destinationPath);
                    
                    // If destination file has same size, assume it's already transferred correctly
                    if (sourceStat.size === destStat.size) {
                        console.log(`[VIDEO] File already exists with same size, skipping copy: ${destinationPath}`);
                        shouldCopy = false;
                    }
                } catch (statError) {
                    console.warn(`[VIDEO] Could not compare file stats, proceeding with copy: ${statError.message}`);
                }
            }
            
            if (shouldCopy) {
                // Use overwrite option to handle existing files more gracefully with retry mechanism
                try {
                    await copyWithRetry(file.video_file_path, destinationPath, 3, 1000);
                    console.log(`[VIDEO] Copied: ${file.video_file_path} to ${destinationPath}`);
                } catch (retryError) {
                    // Fallback to direct copy if copyWithRetry is not available
                    console.warn(`[VIDEO] copyWithRetry failed, falling back to direct copy:`, retryError.message);
                    await fs.copy(file.video_file_path, destinationPath, { overwrite: true, errorOnExist: false });
                    console.log(`[VIDEO] Copied (fallback): ${file.video_file_path} to ${destinationPath}`);
                }
            } else {
                console.log(`[VIDEO] Skipped copy (file exists): ${file.video_file_path} to ${destinationPath}`);
            }
        }
        
        // Mark as transferred on success
        await pool.query(`
            UPDATE video_transfer_queue 
            SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $1
        `, [file.id]);
        
        // Clean up source video files from temp_video_processing after successful transfer
        if (file.video_file_path.includes('temp_video_processing')) {
            try {
                // First remove the individual file
                await fs.unlink(file.video_file_path);
                console.log(`[VIDEO] Cleaned up source video file from buffer: ${file.video_file_path}`);
                
                // Then clean up the parent directory if it's empty
                const parentDir = path.dirname(file.video_file_path);
                console.log(`[VIDEO] Checking if parent directory can be cleaned up: ${parentDir}`);
                
                // Check if directory is empty and remove it
                const remainingFiles = await fs.readdir(parentDir);
                if (remainingFiles.length === 0) {
                    await safeRemoveDirectory(parentDir);
                    console.log(`[VIDEO] Cleaned up empty parent directory: ${parentDir}`);
                } else {
                    console.log(`[VIDEO] Parent directory still has ${remainingFiles.length} files, keeping it: ${parentDir}`);
                }
                
            } catch (cleanupError) {
                // Try alternative method if unlink fails
                try {
                    await fs.remove(file.video_file_path);
                    console.log(`[VIDEO] Cleaned up source video file from buffer (fallback): ${file.video_file_path}`);
                } catch (fallbackError) {
                    // Log cleanup error but don't fail the transfer
                    console.warn(`[VIDEO] Failed to cleanup source video file ${file.video_file_path}:`, fallbackError.message);
                }
            }
        }
        
        console.log(`[VIDEO] Successfully transferred video file ID: ${file.id}`);
        
        // Mark source files as transferred only after successful transfer
        await markSourceFilesAsTransferred(file);
        
    } catch (error) {
        console.error(`[VIDEO] Failed to process video file ${file.id}:`, error);
        throw error;
    }
}

/**
 * Mark source files as transferred when video transfer is successful
 */
async function markSourceFilesAsTransferred(file) {
    try {
        // Get source file IDs from the video_transfer_queue record
        const sourceFileIdsResult = await pool.query(`
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
        
        // Mark source files as transferred
        await pool.query(`
            UPDATE iss_media_files 
            SET is_auto_transferred = true, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ANY($1)
        `, [sourceFileIds]);
        
        console.log(`[MARK] ✓ Marked ${sourceFileIds.length} source files as transferred for video: ${path.basename(file.video_file_path)}`);
        
    } catch (error) {
        console.error(`[MARK] Failed to mark source files as transferred for ${file.video_file_path}:`, error);
    }
}

async function processEncryptedVideoFile(file, usb_path) {
    // For encrypted video files, place in videos folder
    const relativeDirPath = 'videos';
    const destinationGroupDir = path.join(usb_path, relativeDirPath);
    
    await fs.ensureDir(destinationGroupDir);
    
    // Generate or reuse AES key for this batch
    const { key: aesKey, iv: aesIv } = encryptionService.generateAESKey();
    
    const originalFilename = path.basename(file.video_file_path);
    const newFilename = `${file.id}`; // Use file ID as encrypted filename
    const encryptedFilePath = path.join(destinationGroupDir, newFilename);
    
    console.log(`[VIDEO] Encrypting: ${file.video_file_path} to ${encryptedFilePath}`);
    await encryptionService.encryptFileAES(file.video_file_path, encryptedFilePath, aesKey, aesIv);
    
    // Store encryption metadata in the video_transfer_queue table
    await pool.query(`
        UPDATE video_transfer_queue 
        SET error_message = $1, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $2
    `, [JSON.stringify({aesKey: aesKey.toString('hex'), iv: aesIv.toString('hex')}), file.id]);
}

// Run the simulation
async function runSimulation() {
    try {
        // Clear existing video queues
        await redis.del(QUEUE_NAMES.VIDEO_FILE_TRANSFER_QUEUE);
        await redis.del(QUEUE_NAMES.VIDEO_FILE_TRANSFER_RESULT_QUEUE);
        
        // Load initial config from file first, then fallback to Redis
        let configLoaded = false;
        
        // Try to load from file first
        const fileConfig = readConfig();
        if (fileConfig) {
            CONFIG_STATE = fileConfig;
            IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
            console.log('[VIDEO] Loaded config from file - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
            configLoaded = true;
        }
        
        // Fallback to Redis if file load failed
        if (!configLoaded) {
            const redisConfig = await redis.get(CONFIG_STATE_KEY);
            if (redisConfig) {
                CONFIG_STATE = JSON.parse(redisConfig);
                IS_ENCRYPTION_REQUIRED = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.encryption && CONFIG_STATE.autoTransfer.encryption.enabled || false;
                console.log('[VIDEO] Loaded config from Redis - Encryption enabled:', IS_ENCRYPTION_REQUIRED);
                configLoaded = true;
            }
        }
        
        if (!configLoaded) {
            console.log('[VIDEO] No config found in file or Redis - using defaults');
        }
        
        // Initial drive info update
        await updateDriveInfo();
        
        consumer();
        
    } catch (error) {
        console.error('[VIDEO] Simulation error:', error);
        process.exit(1);
    }
}

runSimulation();

// Keep the process running
process.on('SIGINT', async () => {
    console.log('[VIDEO] Cleaning up...');
    // await redis.quit();
    process.exit(0);
});

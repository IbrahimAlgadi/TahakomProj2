const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { sleep } = require('./utils.js');
const { CONFIG_STATE_KEY, CONNECTED_DRIVE_LIST } = require('./redisKeyStore.js');

// Configuration
const config = require('./utils/envConfig');
const { ISS_MEDIA_DIR, ISS_VIDEO_TRANSFER_SIZE, ISS_MEDIA_CAMERAS, ISS_VIDEO_TRANSFER_CONVERSION_COUNT } = config;

// Initialize Redis client
const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

// Initialize PostgreSQL pool
const pool = new Pool({
    user: config.database.user,
    host: config.database.host,
    database: config.database.database,
    port: 5432,
    password: config.database.password
});

// State variables
let isProcessing = false;
let currentSiteId = '';
let videoStats = {
    totalVideosCreated: 0,
    totalFilesProcessed: 0,
    lastProcessedTime: null,
    errorsCount: 0
};

// Storage for temporary video files
const VIDEO_TEMP_DIR = path.join(__dirname, 'temp_video_processing');

// Drive monitoring state
let CONFIG_STATE = {};
let DRIVE_INFO = null;
let IS_DRIVE_CONNECTED = false;
let SHOULD_STOP_PROCESSING = false;
const MIN_REQUIRED_SPACE_MB = 500; // 500MB minimum space requirement

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

/**
 * Get current site_id from Redis configuration
 */
async function getCurrentSiteId() {
    try {
        const configStr = await redis.get(CONFIG_STATE_KEY);
        if (configStr) {
            const config = JSON.parse(configStr);
            return (config && config.storage && config.storage.siteId) || '';
        }
    } catch (error) {
        console.error('[ERROR] Error getting site ID from Redis:', error);
    }
    return '';
}

/**
 * Check if auto transfer and video transfer are enabled
 */
async function isVideoTransferEnabled() {
    try {
        const configStr = await redis.get(CONFIG_STATE_KEY);
        if (configStr) {
            const config = JSON.parse(configStr);
            console.log(`[CONFIG] Auto transfer config:`);
            // console.log(JSON.stringify(config, null, 2));
            const autoTransferEnabled = config.autoTransfer && config.autoTransfer.isActive || false;
            const videoTransferEnabled = config.autoTransfer && (config.autoTransfer.dataType === 'video' || config.autoTransfer.dataType === 'both') || false;
            
            console.log(`[CONFIG] Auto transfer: ${autoTransferEnabled}, Video transfer: ${videoTransferEnabled}`);
            return autoTransferEnabled && videoTransferEnabled;
        }
    } catch (error) {
        console.error('[ERROR] Error checking video transfer config:', error);
    }
    return false;
}

/**
 * Update drive information from Redis
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
                    console.warn(`[DRIVE] Target drive '${configuredDrive}' not found, using first available drive`);
                    targetDrive = driveList[0];
                }
                
                DRIVE_INFO = targetDrive;
                IS_DRIVE_CONNECTED = true;
                

                
                // Handle different possible property names for free space
                // Values are in GB as strings, convert to bytes
                let freeBytes = 0;
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
                
                // Convert GB to MB (simpler and consistent)
                const freeSpaceMB = freeSpaceGB * 1024;
                SHOULD_STOP_PROCESSING = freeSpaceMB <= MIN_REQUIRED_SPACE_MB;
                
                console.log(`[DEBUG] Space calculation: configuredDrive=${configuredDrive}, selectedDrive=${DRIVE_INFO.drive}, freeSpaceGB=${freeSpaceGB}, freeSpaceMB=${freeSpaceMB.toFixed(1)}, MIN_REQUIRED_SPACE_MB=${MIN_REQUIRED_SPACE_MB}, SHOULD_STOP_PROCESSING=${SHOULD_STOP_PROCESSING}`);
                
                if (SHOULD_STOP_PROCESSING) {
                    console.log(`[SPACE] Insufficient space: ${freeSpaceMB.toFixed(1)}MB available, need more than ${MIN_REQUIRED_SPACE_MB}MB minimum`);
                }
            } else {
                DRIVE_INFO = null;
                IS_DRIVE_CONNECTED = false;
                SHOULD_STOP_PROCESSING = true;
                console.log('[DRIVE] No drives connected - driveList empty or null');
            }
        } else {
            DRIVE_INFO = null;
            IS_DRIVE_CONNECTED = false;
            SHOULD_STOP_PROCESSING = true;
            console.log(`[DRIVE] No drive list found in Redis - CONNECTED_DRIVE_LIST key: '${CONNECTED_DRIVE_LIST}'`);
        }
    } catch (error) {
        console.error('[ERROR] Error updating drive info:', error);
        try {
            if (driveListStr) {
                console.error('[ERROR] Raw drive list string:', driveListStr);
            }
        } catch (logError) {
            console.error('[ERROR] Error logging drive info:', logError.message);
        }
        DRIVE_INFO = null;
        IS_DRIVE_CONNECTED = false;
        SHOULD_STOP_PROCESSING = true;
    }
}

/**
 * Check if there's enough space for video processing
 * @param {number} estimatedSizeMB - Estimated size needed in MB
 * @returns {boolean} True if there's enough space
 */
function hasSpaceForProcessing(estimatedSizeMB = 100) {
    if (!DRIVE_INFO) {
        console.warn('[SPACE] Drive info not available for space check');
        return !SHOULD_STOP_PROCESSING;
    }
    
    // Handle different possible property names for free space
    // Values are in GB as strings, convert to bytes
    let freeBytes = 0;
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
        console.warn('[SPACE] No free space information available in drive info');
        return !SHOULD_STOP_PROCESSING;
    }
    
    // Convert GB to MB (simpler and consistent)
    const freeSpaceMB = freeSpaceGB * 1024;
    const bufferMB = 200; // Keep 200MB buffer for safety during video processing
    const totalRequired = estimatedSizeMB + bufferMB + MIN_REQUIRED_SPACE_MB;
    
    const hasSpace = freeSpaceMB >= totalRequired;
    
    if (!hasSpace) {
        console.log(`[SPACE] Insufficient space: need ${estimatedSizeMB}MB + ${bufferMB}MB buffer + ${MIN_REQUIRED_SPACE_MB}MB minimum = ${totalRequired}MB total, only ${freeSpaceMB.toFixed(1)}MB available`);
    }
    
    return hasSpace;
}

/**
 * Get estimated size for video group processing
 * @param {Array} files - Array of files to process
 * @returns {number} Estimated size in MB
 */
function getEstimatedProcessingSize(files) {
    if (!files || files.length === 0) return 0;
    
    // Estimate: each .issvd file becomes ~same size .mp4, plus final concatenated video
    const avgFileSizeMB = files.reduce((sum, file) => sum + (file.file_size || 1024*1024), 0) / files.length / (1024 * 1024);
    const tempMp4SizeMB = avgFileSizeMB * files.length; // All individual MP4s
    const finalVideoSizeMB = tempMp4SizeMB * 0.9; // Final concatenated video (slightly smaller due to optimization)
    
    // Total = temp files + final file (temp files get cleaned up after)
    return tempMp4SizeMB + finalVideoSizeMB;
}

/**
 * Get unprocessed files from database grouped by camera and time intervals
 */
async function getUnprocessedFiles() {
    try {
        const query = `
            SELECT 
                id,
                file_path,
                file_name,
                file_size,
                camera_id,
                site_id,
                recording_date,
                recording_time,
                timezone_offset,
                precise_time
            FROM iss_media_files 
            WHERE 
                deleted = false 
                AND is_auto_transferred = false
                AND recording_date >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY camera_id, recording_date, precise_time
        `;
        
        const result = await pool.query(query);
        
        // Filter out files that are currently in retry delay
        const filteredFiles = [];
        for (const file of result.rows) {
            const retryKey = `video_processing_failed:${file.id}`;
            const isInRetryDelay = await redis.exists(retryKey);
            
            if (!isInRetryDelay) {
                filteredFiles.push(file);
            } else {
                console.log(`[RETRY] Skipping file ${file.file_name} (ID: ${file.id}) - in retry delay`);
            }
        }
        
        return filteredFiles;
    } catch (error) {
        console.error('[ERROR] Error fetching unprocessed files:', error);
        return [];
    }
}

/**
 * Get ISS_VIDEO_TRANSFER_CONVERSION_COUNT oldest unprocessed files for a specific camera
 */
async function getUnprocessedFilesForCamera(cameraId) {
    try {
        const query = `
            SELECT 
                id,
                file_path,
                file_name,
                file_size,
                camera_id,
                site_id,
                recording_date,
                recording_time,
                timezone_offset,
                precise_time
            FROM iss_media_files 
            WHERE 
                deleted = false 
                AND is_auto_transferred = false
                AND camera_id = $1
                AND recording_date >= CURRENT_DATE - INTERVAL '7 days'
            ORDER BY recording_date, precise_time
            LIMIT $2
        `;
        
        const result = await pool.query(query, [cameraId, ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
        
        // Filter out files that are currently in retry delay
        const filteredFiles = [];
        for (const file of result.rows) {
            const retryKey = `video_processing_failed:${file.id}`;
            const isInRetryDelay = await redis.exists(retryKey);
            
            if (!isInRetryDelay) {
                filteredFiles.push(file);
            } else {
                console.log(`[RETRY] Skipping file ${file.file_name} (ID: ${file.id}) - in retry delay`);
            }
        }
        
        return filteredFiles;
    } catch (error) {
        console.error(`[ERROR] Error fetching unprocessed files for camera ${cameraId}:`, error);
        return [];
    }
}

/**
 * Group files by camera ensuring exactly ISS_VIDEO_TRANSFER_CONVERSION_COUNT files per group for concatenation
 */
function groupFilesByCamera(files) {
    const groups = {};
    const REQUIRED_FILES_PER_GROUP = ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
    
    for (const file of files) {
        const cameraId = file.camera_id;
        const date = file.recording_date.toISOString().split('T')[0]; // Format as YYYY-MM-DD
        
        if (!groups[cameraId]) {
            groups[cameraId] = {};
        }
        
        if (!groups[cameraId][date]) {
            groups[cameraId][date] = {
                files: []
            };
        }
        
        groups[cameraId][date].files.push(file);
    }
    
    // Create valid groups with exactly ISS_VIDEO_TRANSFER_CONVERSION_COUNT files
    const validGroups = [];
    
    for (const cameraId in groups) {
        for (const date in groups[cameraId]) {
            const cameraDateFiles = groups[cameraId][date].files;
            
            // Sort files by precise time to ensure correct order
            cameraDateFiles.sort((a, b) => a.precise_time.localeCompare(b.precise_time));
            
            // Create groups of exactly ISS_VIDEO_TRANSFER_CONVERSION_COUNT files
            for (let i = 0; i < cameraDateFiles.length; i += REQUIRED_FILES_PER_GROUP) {
                const groupFiles = cameraDateFiles.slice(i, i + REQUIRED_FILES_PER_GROUP);
                
                // Only process groups with exactly ISS_VIDEO_TRANSFER_CONVERSION_COUNT files
                if (groupFiles.length === REQUIRED_FILES_PER_GROUP) {
                    const firstFile = groupFiles[0];
                    const lastFile = groupFiles[groupFiles.length - 1];
                    
                    // Calculate time interval from first to last file
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
                    
                    console.log(`[GROUPING] Created group for camera ${cameraId} on ${date}: ${groupFiles.length} files (${firstFile.precise_time} to ${lastFile.precise_time})`);
                }
            }
        }
    }
    
    console.log(`[GROUPING] Created ${validGroups.length} valid groups with exactly ${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files each`);
    return validGroups;
}

/**
 * Wait for file to be accessible and not locked
 */
async function waitForFileAccess(filePath, maxWaitMs = 5000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
        try {
            // Try to access the file to check if it exists and is accessible
            await fs.access(filePath, fs.constants.F_OK | fs.constants.R_OK);
            
            // Additional check: try to get file stats to ensure it's complete
            const stats = await fs.stat(filePath);
            if (stats.size > 0) {
                return true;
            }
            
            // If file exists but has 0 size, it might still be writing
            await sleep(100);
        } catch (error) {
            if (error.code === 'EBUSY' || error.code === 'EACCES' || error.code === 'ENOENT') {
                // File is busy, access denied, or doesn't exist yet - wait a bit
                await sleep(100);
                continue;
            }
            throw error; // Other errors should be thrown
        }
    }
    
    throw new Error(`File ${filePath} is still not accessible after ${maxWaitMs}ms`);
}

/**
 * Convert .issvd file to .mp4 using ffmpeg with proper completion checking
 */
function convertToMp4(inputFile, outputFile) {
    return new Promise((resolve, reject) => {
        const args = [
            '-f', 'h264',           // Force input format to h264
            '-i', inputFile,        // Input file
            '-c:v', 'copy',        // Copy video stream without re-encoding
            '-f', 'mp4',           // Force output format to mp4
            outputFile,            // Output file
            '-y'                   // Overwrite output file if exists
        ];

        const ffmpeg = spawn('ffmpeg', args, {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'] // Explicitly handle stdio
        });
        let stderr = '';

        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ffmpeg.on('close', async (code) => {
            if (code === 0) {
                try {
                    // Wait a bit for file system to release the file
                    await sleep(200);
                    // Verify file was created and is accessible
                    await waitForFileAccess(outputFile, 2000);
                    resolve(true);
                } catch (error) {
                    console.error(`File access check failed for ${outputFile}: ${error.message}`);
                    reject(error);
                }
            } else {
                console.error(`Error converting ${inputFile}: ${stderr}`);
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
 * Concatenate multiple mp4 files into a single file using ffmpeg with proper file checking
 */
async function concatenateMp4Files(mp4Files, outputFile) {
    try {
        const outputDir = path.dirname(outputFile);
        const concatListPath = path.join(outputDir, `concat_list_${Date.now()}.txt`);
        
        // Ensure output directory exists
        await fs.ensureDir(outputDir);
        
        // Verify all input files are accessible before proceeding
        console.log(`[VIDEO] Verifying ${mp4Files.length} input files are accessible...`);
        for (const file of mp4Files) {
            try {
                await waitForFileAccess(file, 3000);
            } catch (error) {
                console.error(`[VIDEO] Input file not accessible: ${file} - ${error.message}`);
                return false;
            }
        }
        
        // Create concat list file
        const concatContent = mp4Files.map(file => {
            // Use absolute paths with forward slashes for ffmpeg
            const absPath = path.resolve(file).replace(/\\/g, '/');
            return `file '${absPath}'`;
        }).join('\n');
        
        await fs.writeFile(concatListPath, concatContent);
        
        // Check if output file already exists and remove it
        try {
            await fs.access(outputFile);
            console.log(`[VIDEO] Removing existing output file: ${outputFile}`);
            await fs.unlink(outputFile);
            // Wait a bit after deletion
            await sleep(500);
        } catch (error) {
            // File doesn't exist, which is fine
        }
        
        // Run ffmpeg to concatenate the files
        const success = await new Promise((resolve) => {
            const args = [
                '-f', 'concat',       // Format is concat
                '-safe', '0',         // Don't restrict filenames
                '-i', concatListPath, // Input file is the concat list
                '-c', 'copy',         // Copy streams without re-encoding
                '-avoid_negative_ts', 'make_zero', // Handle negative timestamps
                outputFile,           // Output file
                '-y'                  // Overwrite if exists
            ];

            const ffmpeg = spawn('ffmpeg', args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'] // Explicitly handle stdio
            });
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ffmpeg.on('close', async (code) => {
                if (code === 0) {
                    try {
                        // Wait for file system to complete the write
                        await sleep(500);
                        // Verify the output file was created and is accessible
                        await waitForFileAccess(outputFile, 3000);
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
 * Store file entry in buffer table with pending status (before conversion)
 */
async function storeFileInBufferAsPending(sourceFile, groupKey, intervalStart, intervalEnd, consistentDate = null) {
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
        
        const result = await pool.query(insertQuery, [
            sourceFile.id,
            '', // Will be updated after conversion
            '', // Will be updated after conversion
            0,  // Will be updated after conversion
            sourceFile.camera_id,
            currentSiteId,
            recordingDate, // Use consistent date format
            sourceFile.recording_time,
            sourceFile.precise_time,
            sourceFile.timezone_offset,
            groupKey,
            intervalStart,
            intervalEnd,
            'pending'
        ]);
        
        console.log(`[BUFFER] Stored file as pending: ${sourceFile.file_name} (ID: ${result.rows[0].id}) with date: ${recordingDate}`);
        return result.rows[0].id;
        
    } catch (error) {
        console.error(`[ERROR] Failed to store file in buffer as pending: ${error.message}`);
        throw error;
    }
}

/**
 * Update buffer entry after successful conversion
 */
async function updateBufferAfterConversion(bufferId, convertedFilePath) {
    try {
        console.log(`[BUFFER] Updating buffer entry ${bufferId} with converted file: ${convertedFilePath}`);
        
        const stats = await fs.stat(convertedFilePath);
        const convertedFileName = path.basename(convertedFilePath);
        
        const result = await pool.query(`
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
            const updated = result.rows[0];
            console.log(`[BUFFER] ✓ Updated: ID ${updated.id} → status='${updated.status}', group='${updated.group_key}', file='${convertedFileName}'`);
        } else {
            console.error(`[BUFFER] ✗ No rows updated for buffer ID ${bufferId}`);
        }
        
    } catch (error) {
        console.error(`[ERROR] Failed to update buffer after conversion (ID ${bufferId}): ${error.message}`);
        throw error;
    }
}

/**
 * Mark buffer entry as failed
 */
async function markBufferEntryAsFailed(bufferId, errorMessage) {
    try {
        await pool.query(`
            UPDATE video_converted_buffer 
            SET 
                status = 'failed',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [bufferId]);
        
        console.log(`[BUFFER] Marked buffer entry as failed (ID: ${bufferId})`);
        
    } catch (error) {
        console.error(`[ERROR] Failed to mark buffer entry as failed: ${error.message}`);
    }
}

/**
 * Check if camera has ISS_VIDEO_TRANSFER_CONVERSION_COUNT converted files ready for concatenation
 */
async function checkCameraGroupReady(cameraId, date, groupKey) {
    try {
        const query = `
            SELECT COUNT(*) as file_count
            FROM video_converted_buffer 
            WHERE camera_id = $1 
            AND recording_date = $2 
            AND group_key = $3 
            AND status = 'converted'
        `;
        
        const result = await pool.query(query, [cameraId, date, groupKey]);
        const fileCount = parseInt(result.rows[0].file_count);
        
        console.log(`[BUFFER] Camera ${cameraId} group ${groupKey}: ${fileCount}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files converted`);
        
        return fileCount >= ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
    } catch (error) {
        console.error(`[ERROR] Failed to check camera group readiness: ${error.message}`);
        return false;
    }
}

/**
 * Get converted files for a camera group ready for concatenation
 */
async function getConvertedFilesForGroup(cameraId, date, groupKey) {
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
        
        const result = await pool.query(query, [cameraId, date, groupKey, ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
        console.log(`[BUFFER] Retrieved ${result.rows.length} converted files for concatenation`);
        
        // If no results, let's see what's in the buffer for debugging
        if (result.rows.length === 0) {
            const debugResult = await pool.query(`
                SELECT camera_id, recording_date, group_key, status, COUNT(*) as count
                FROM video_converted_buffer 
                WHERE camera_id = $1
                GROUP BY camera_id, recording_date, group_key, status
                ORDER BY recording_date DESC
                LIMIT 5
            `, [cameraId]);
            
            console.log(`[DEBUG] No converted files found. Recent buffer entries for camera ${cameraId}:`);
            for (const row of debugResult.rows) {
                console.log(`[DEBUG]   Date: ${row.recording_date}, Group: ${row.group_key}, Status: ${row.status}, Count: ${row.count}`);
            }
        }
        
        return result.rows;
    } catch (error) {
        console.error(`[ERROR] Failed to get converted files for group: ${error.message}`);
        return [];
    }
}

/**
 * Mark converted files as grouped after successful concatenation
 */
async function markFilesAsGrouped(bufferIds) {
    try {
        await pool.query(`
            UPDATE video_converted_buffer 
            SET status = 'grouped', updated_at = CURRENT_TIMESTAMP 
            WHERE id = ANY($1)
        `, [bufferIds]);
        
        console.log(`[BUFFER] Marked ${bufferIds.length} converted files as grouped`);
    } catch (error) {
        console.error(`[ERROR] Failed to mark files as grouped: ${error.message}`);
    }
}

/**
 * Clean up converted files from buffer and disk after successful concatenation
 */
async function cleanupConvertedFiles(bufferIds, convertedFilePaths) {
    try {
        // Delete physical files
        for (const filePath of convertedFilePaths) {
            try {
                if (await fs.pathExists(filePath)) {
                    await fs.unlink(filePath);
                }
            } catch (error) {
                console.warn(`[CLEANUP] Failed to delete file ${filePath}: ${error.message}`);
            }
        }
        
        // Delete from buffer table
        await pool.query(`
            DELETE FROM video_converted_buffer 
            WHERE id = ANY($1)
        `, [bufferIds]);
        
        console.log(`[CLEANUP] Cleaned up ${bufferIds.length} converted files from buffer and disk`);
    } catch (error) {
        console.error(`[ERROR] Failed to cleanup converted files: ${error.message}`);
    }
}

/**
 * Add available files to buffer as pending for a specific camera
 */
async function addFilesToBuffer(cameraId, job) {
    console.log(`[BUFFER] Adding available files to buffer for camera ${cameraId}`);
    
    try {
        // Update job to set current camera
        await updateJobCurrentCamera(pool, job.id, cameraId);
        
        // Get unprocessed files for this camera
        const files = await getUnprocessedFilesForCamera(cameraId);
        
        if (files.length === 0) {
            console.log(`[BUFFER] No unprocessed files found for camera ${cameraId}`);
            return 0;
        }
        
        console.log(`[BUFFER] Found ${files.length} unprocessed files for camera ${cameraId}`);
        
        // Create group key based on source files' date (not current time)
        const firstFile = files[0];
        const fileDate = firstFile.recording_date instanceof Date 
            ? firstFile.recording_date.toISOString().split('T')[0]
            : firstFile.recording_date;
            
        const now = new Date();
        const hours = now.getHours();
        const minutes = now.getMinutes();
        const intervalStart = hours * 60 + minutes;
        const intervalEnd = intervalStart + 60; // 1 hour window
        
        const groupKey = `cam_${cameraId}_${fileDate}_${intervalStart}-${intervalEnd}`;
        
        console.log(`[BUFFER] Using file date: ${fileDate} for group key: ${groupKey}`);
        
        let addedCount = 0;
        
        for (const file of files) {
            try {
                // Check if this file is already in buffer with pending status
                const existingCheck = await pool.query(`
                    SELECT id, status FROM video_converted_buffer 
                    WHERE source_file_id = $1
                `, [file.id]);
                
                if (existingCheck.rows.length > 0) {
                    const existing = existingCheck.rows[0];
                    if (existing.status === 'pending') {
                        console.log(`[BUFFER] File ${file.file_name} already in buffer as pending, skipping`);
                        continue;
                    } else {
                        // Clean up old completed/failed entries and allow re-adding
                        console.log(`[BUFFER] Cleaning up old buffer entry for ${file.file_name} (status: ${existing.status})`);
                        await pool.query(`DELETE FROM video_converted_buffer WHERE id = $1`, [existing.id]);
                    }
                }
                
                // Check if source file exists
                if (!await fs.pathExists(file.file_path)) {
                    console.error(`[BUFFER] ✗ Source file not found: ${file.file_path}`);
                    
                    // Mark file as deleted in database
                    try {
                        await pool.query(`
                            UPDATE iss_media_files 
                            SET deleted = true, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $1
                        `, [file.id]);
                        console.log(`[UPDATE] Marked file ${file.file_name} as deleted (ID: ${file.id})`);
                    } catch (dbError) {
                        console.error(`[ERROR] Failed to mark file as deleted: ${dbError.message}`);
                    }
                    
                    continue;
                }
                
                // Add file to buffer as pending (use consistent date format)
                await storeFileInBufferAsPending(file, groupKey, intervalStart, intervalEnd, fileDate);
                addedCount++;
                console.log(`[BUFFER] ✓ Added to buffer: ${file.file_name} (${addedCount}/${files.length})`);
                
            } catch (error) {
                console.error(`[BUFFER] ✗ Failed to add: ${file.file_name}`, error.message);
                videoStats.errorsCount++;
            }
        }
        
        console.log(`[BUFFER] Added ${addedCount} files to buffer for camera ${cameraId}`);
        return addedCount;
        
    } catch (error) {
        console.error(`[BUFFER] Error adding files to buffer for camera ${cameraId}:`, error);
        return 0;
    }
}

/**
 * Check how many pending files each camera has in buffer
 */
async function checkCameraBufferStatus(expectedCameras) {
    try {
        const status = {};
        
        for (const cameraIdStr of expectedCameras) {
            const cameraId = parseInt(cameraIdStr);
            
            const result = await pool.query(`
                SELECT COUNT(*) as pending_count
                FROM video_converted_buffer 
                WHERE camera_id = $1 AND status = 'pending'
            `, [cameraId]);
            
            status[cameraId] = parseInt(result.rows[0].pending_count);
        }
        
        return status;
    } catch (error) {
        console.error('[ERROR] Failed to check camera buffer status:', error);
        return {};
    }
}

/**
 * Check detailed buffer status for each camera (pending + converted counts)
 */
async function checkCameraBufferStatusDetailed(expectedCameras) {
    try {
        const status = {};
        
        for (const cameraIdStr of expectedCameras) {
            const cameraId = parseInt(cameraIdStr);
            
            const result = await pool.query(`
                SELECT 
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_count,
                    COUNT(CASE WHEN status = 'converted' THEN 1 END) as converted_count
                FROM video_converted_buffer 
                WHERE camera_id = $1
            `, [cameraId]);
            
            const row = result.rows[0];
            status[cameraId] = {
                pending: parseInt(row.pending_count) || 0,
                converted: parseInt(row.converted_count) || 0
            };
        }
        
        return status;
    } catch (error) {
        console.error('[ERROR] Failed to check detailed camera buffer status:', error);
        return {};
    }
}

/**
 * Check if all cameras are ready for conversion (each has ISS_VIDEO_TRANSFER_CONVERSION_COUNT+ pending files)
 */
async function checkAllCamerasReady(expectedCameras) {
    try {
        const status = await checkCameraBufferStatus(expectedCameras);
        
        console.log('[BUFFER] Camera buffer status:');
        for (const cameraId of expectedCameras) {
            const pending = status[parseInt(cameraId)] || 0;
            const ready = pending >= ISS_VIDEO_TRANSFER_CONVERSION_COUNT ? '✓ READY' : `✗ Need ${ISS_VIDEO_TRANSFER_CONVERSION_COUNT - pending} more`;
            console.log(`[BUFFER]   Camera ${cameraId}: ${pending}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files ${ready}`);
        }
        
        const allReady = expectedCameras.every(cameraId => {
            const pending = status[parseInt(cameraId)] || 0;
            return pending >= ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
        });
        
        return { allReady, status };
    } catch (error) {
        console.error('[ERROR] Failed to check if all cameras ready:', error);
        return { allReady: false, status: {} };
    }
}

/**
 * Convert and create videos for all ready cameras
 */
async function processAllReadyCameras(expectedCameras, job) {
    console.log('\n[CONVERSION] Starting optimized parallel conversion for all ready cameras...');
    
    // Initial space check for overall processing
    await updateDriveInfo();
    if (SHOULD_STOP_PROCESSING || !IS_DRIVE_CONNECTED) {
        console.log(`[CONVERSION] ⏸️  Cannot start processing: insufficient space or drive disconnected`);
        return { successfulCameras: 0, failedCameras: expectedCameras.length };
    }
    
    // Process cameras in parallel for better efficiency
    const cameraPromises = expectedCameras.map(async (cameraIdStr) => {
        const cameraId = parseInt(cameraIdStr);
        
        try {
            console.log(`[CONVERSION] Starting parallel processing for camera ${cameraId}...`);
            
            // Get ISS_VIDEO_TRANSFER_CONVERSION_COUNT oldest pending files for this camera
            const pendingFiles = await pool.query(`
                SELECT * FROM video_converted_buffer 
                WHERE camera_id = $1 AND status = 'pending'
                ORDER BY precise_time
                LIMIT $2
            `, [cameraId, ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
            
            if (pendingFiles.rows.length < ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
                console.log(`[CONVERSION] ✗ Camera ${cameraId} only has ${pendingFiles.rows.length}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files ready`);
                return { cameraId, success: false, reason: 'insufficient_files' };
            }
            
            // Estimate space needed for this camera's conversion
            const estimatedSpaceMB = ISS_VIDEO_TRANSFER_CONVERSION_COUNT * 2; // Rough estimate: 2MB per file
            if (!hasSpaceForProcessing(estimatedSpaceMB)) {
                console.log(`[CONVERSION] ⏸️  Insufficient space for camera ${cameraId} (need ~${estimatedSpaceMB}MB). Skipping.`);
                return { cameraId, success: false, reason: 'insufficient_space' };
            }
            
            const filesToConvert = pendingFiles.rows.slice(0, ISS_VIDEO_TRANSFER_CONVERSION_COUNT);
            console.log(`[CONVERSION] Converting ${filesToConvert.length} files for camera ${cameraId} in parallel`);
            
            // Create group key from first file
            const firstFile = filesToConvert[0];
            const groupKey = firstFile.group_key;
            const tempGroupDir = path.join(VIDEO_TEMP_DIR, groupKey);
            await fs.ensureDir(tempGroupDir);
            
            let convertedCount = 0;
            
            // Convert each pending file (keeping sequential for now to avoid overwhelming system)
            for (const bufferEntry of filesToConvert) {
                try {
                    // Get source file info
                    const sourceResult = await pool.query(`
                        SELECT * FROM iss_media_files WHERE id = $1
                    `, [bufferEntry.source_file_id]);
                    
                    if (sourceResult.rows.length === 0) {
                        console.error(`[CONVERSION] ✗ Source file not found in database for buffer ID ${bufferEntry.id}`);
                        await markBufferEntryAsFailed(bufferEntry.id, 'Source file not found in database');
                        continue;
                    }
                    
                    const sourceFile = sourceResult.rows[0];
                    
                    // Convert file
                    const filename = path.basename(sourceFile.file_name, '.issvd');
                    const mp4Path = path.join(tempGroupDir, `${filename}.mp4`);
                    
                    await convertToMp4(sourceFile.file_path, mp4Path);
                    
                    // Update buffer after successful conversion
                    await updateBufferAfterConversion(bufferEntry.id, mp4Path);
                    
                    convertedCount++;
                    console.log(`[CONVERSION] ✓ Camera ${cameraId}: Converted ${sourceFile.file_name} (${convertedCount}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT})`);
                    
                    // Reduced delay between conversions for faster processing
                    await sleep(50);
                    
                } catch (error) {
                    console.error(`[CONVERSION] ✗ Failed to convert buffer ID ${bufferEntry.id}:`, error.message);
                    await markBufferEntryAsFailed(bufferEntry.id, error.message);
                    videoStats.errorsCount++;
                }
            }
            
            console.log(`[CONVERSION] Camera ${cameraId}: Conversion completed: ${convertedCount}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files`);
            
            // Create grouped video if we have exactly ISS_VIDEO_TRANSFER_CONVERSION_COUNT converted files
            if (convertedCount === ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
                console.log(`[CONVERSION] Creating grouped video for camera ${cameraId}...`);
                
                // Extract date from the group key to ensure consistency
                const dateMatch = groupKey.match(/cam_\d+_(\d{4}-\d{2}-\d{2})_/);
                const date = dateMatch ? dateMatch[1] : (
                    firstFile.recording_date instanceof Date 
                        ? firstFile.recording_date.toISOString().split('T')[0]
                        : firstFile.recording_date
                );
                
                console.log(`[CONVERSION] Camera ${cameraId}: Using date: ${date} extracted from group key: ${groupKey}`);
                
                // Reduced wait time for database updates
                await sleep(500);
                
                // Verify files are actually marked as converted before concatenating
                const verifyResult = await pool.query(`
                    SELECT COUNT(*) as converted_count
                    FROM video_converted_buffer 
                    WHERE camera_id = $1 
                    AND group_key = $2 
                    AND status = 'converted'
                `, [cameraId, groupKey]);
                
                const actualConverted = parseInt(verifyResult.rows[0].converted_count);
                console.log(`[CONVERSION] Camera ${cameraId}: Verification: ${actualConverted}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files marked as converted`);
                
                if (actualConverted < ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
                    console.error(`[CONVERSION] ✗ Camera ${cameraId}: Only ${actualConverted}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files are marked as converted. Skipping concatenation.`);
                    return { cameraId, success: false, reason: 'verification_failed' };
                }
                    
                const videoData = await concatenateFromBuffer(cameraId, date, groupKey);
                
                if (videoData) {
                    await addVideoToTransferQueue(videoData, job);
                    console.log(`[CONVERSION] ✓ Camera ${cameraId}: Successfully created and queued video for immediate transfer`);
                    
                    // Mark camera as processed
                    await addCameraToProcessed(pool, job.id, cameraId);
                    return { cameraId, success: true, videoData };
                } else {
                    console.error(`[CONVERSION] ✗ Camera ${cameraId}: Failed to create grouped video`);
                    return { cameraId, success: false, reason: 'concatenation_failed' };
                }
            } else {
                console.log(`[CONVERSION] Camera ${cameraId}: Only ${convertedCount}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files converted. Skipping video creation.`);
                return { cameraId, success: false, reason: 'insufficient_converted' };
            }
            
        } catch (error) {
            console.error(`[CONVERSION] Error processing camera ${cameraId}:`, error);
            videoStats.errorsCount++;
            return { cameraId, success: false, reason: 'exception', error: error.message };
        }
    });
    
    // Wait for all camera processing to complete
    console.log(`[CONVERSION] Processing ${expectedCameras.length} cameras in parallel...`);
    const results = await Promise.allSettled(cameraPromises);
    
    // Analyze results
    let successfulCameras = 0;
    let failedCameras = 0;
    
    results.forEach((result, index) => {
        const cameraId = expectedCameras[index];
        
        if (result.status === 'fulfilled' && result.value.success) {
            successfulCameras++;
            console.log(`[CONVERSION] ✅ Camera ${result.value.cameraId}: Processing completed successfully`);
        } else {
            failedCameras++;
            const reason = result.status === 'rejected' 
                ? result.reason 
                : result.value.reason || 'unknown';
            console.log(`[CONVERSION] ❌ Camera ${cameraId}: Processing failed - ${reason}`);
        }
    });
    
    console.log(`[CONVERSION] Parallel processing summary: ${successfulCameras} successful, ${failedCameras} failed`);
    return { successfulCameras, failedCameras };
}

/**
 * Concatenate converted MP4 files from buffer (Phase 2)
 */
async function concatenateFromBuffer(cameraId, date, groupKey) {
    console.log(`[CONCAT] Starting concatenation for camera ${cameraId} group ${groupKey}`);
    
    try {
        // Debug: show what we're looking for
        console.log(`[CONCAT] Looking for: camera=${cameraId}, date=${date}, groupKey=${groupKey}`);
        
        // Get converted files from buffer
        const convertedFiles = await getConvertedFilesForGroup(cameraId, date, groupKey);
        
        if (convertedFiles.length !== ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            console.error(`[CONCAT] ✗ Expected ${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files, got ${convertedFiles.length} for group ${groupKey}`);
            
            // Debug: Check what's actually in the buffer for this camera
            const debugQuery = await pool.query(`
                SELECT group_key, recording_date, status, COUNT(*) as count
                FROM video_converted_buffer 
                WHERE camera_id = $1
                GROUP BY group_key, recording_date, status
                ORDER BY recording_date DESC, group_key
                LIMIT 10
            `, [cameraId]);
            
            console.log(`[DEBUG] Buffer contents for camera ${cameraId}:`);
            for (const row of debugQuery.rows) {
                console.log(`[DEBUG]   Group: ${row.group_key}, Date: ${row.recording_date}, Status: ${row.status}, Count: ${row.count}`);
            }
            
            return null;
        }
        
        // Verify all files exist on disk and mark missing ones as failed
        const mp4FilePaths = [];
        let missingFiles = 0;
        
        for (const file of convertedFiles) {
            if (await fs.pathExists(file.converted_file_path)) {
                mp4FilePaths.push(file.converted_file_path);
            } else {
                console.error(`[CONCAT] ✗ Converted file not found on disk: ${file.converted_file_path}`);
                
                // Mark this buffer entry as failed
                await markBufferEntryAsFailed(file.id, 'Converted file not found on disk');
                missingFiles++;
            }
        }
        
        if (missingFiles > 0) {
            console.error(`[CONCAT] ✗ ${missingFiles} files missing from disk for group ${groupKey}`);
            return null;
        }
        
        // Create final concatenated video
        const tempGroupDir = path.join(VIDEO_TEMP_DIR, groupKey);
        await fs.ensureDir(tempGroupDir);
        
        const startTime = Math.floor(convertedFiles[0].group_interval_start / 60).toString().padStart(2, '0') + 
                         (convertedFiles[0].group_interval_start % 60).toString().padStart(2, '0');
        const endTime = Math.floor(convertedFiles[0].group_interval_end / 60).toString().padStart(2, '0') + 
                       (convertedFiles[0].group_interval_end % 60).toString().padStart(2, '0');
        
        const finalVideoName = `CAM_${cameraId}_${date}_${startTime}_to_${endTime}.mp4`;
        const finalVideoPath = path.join(tempGroupDir, finalVideoName);
        
        console.log(`[CONCAT] Creating final video: ${finalVideoName}`);
        const success = await concatenateMp4Files(mp4FilePaths, finalVideoPath);
        
        if (success) {
            // Get file size
            const stats = await fs.stat(finalVideoPath);
            const fileSize = stats.size;
            
            console.log(`[CONCAT] ✓ Created: ${finalVideoName} (${(fileSize/1024/1024).toFixed(2)} MB)`);
            
            // Mark files as grouped in buffer
            const bufferIds = convertedFiles.map(f => f.id);
            await markFilesAsGrouped(bufferIds);
            
            // Clean up individual MP4 files
            const convertedFilePaths = convertedFiles.map(f => f.converted_file_path);
            await cleanupConvertedFiles(bufferIds, convertedFilePaths);
            
            videoStats.totalVideosCreated++;
            videoStats.totalFilesProcessed += convertedFiles.length;
            
            // Get source file IDs for marking as processed
            const sourceFileIds = convertedFiles.map(f => f.source_file_id);
            
            return {
                videoPath: finalVideoPath,
                videoName: finalVideoName,
                fileSize: fileSize,
                camera_id: cameraId,
                site_id: currentSiteId,
                sourceFileIds: sourceFileIds,
                recording_date: date,
                interval_start: convertedFiles[0].group_interval_start,
                interval_end: convertedFiles[0].group_interval_end
            };
        } else {
            console.error(`[CONCAT] ✗ Failed to concatenate files for group ${groupKey}`);
            return null;
        }
        
    } catch (error) {
        console.error(`[CONCAT] Error concatenating group ${groupKey}:`, error);
        videoStats.errorsCount++;
        return null;
    }
}

/**
 * Get camera groups that have ISS_VIDEO_TRANSFER_CONVERSION_COUNT converted files ready for concatenation
 */
async function getReadyCameraGroups() {
    try {
        const query = `
            SELECT 
                camera_id,
                recording_date,
                group_key,
                group_interval_start,
                group_interval_end,
                COUNT(*) as file_count
            FROM video_converted_buffer 
            WHERE status = 'converted'
            GROUP BY camera_id, recording_date, group_key, group_interval_start, group_interval_end
            HAVING COUNT(*) >= $1
            ORDER BY camera_id, recording_date, group_interval_start
        `;
        
        const result = await pool.query(query, [ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
        
        if (result.rows.length > 0) {
            console.log(`[READY] Found ${result.rows.length} camera groups ready for concatenation`);
            for (const group of result.rows) {
                console.log(`[READY] Camera ${group.camera_id}, ${group.recording_date}, ${group.group_key}: ${group.file_count} files`);
            }
        }
        
        return result.rows;
    } catch (error) {
        console.error(`[ERROR] Failed to get ready camera groups: ${error.message}`);
        return [];
    }
}

/**
 * Process a group of files into a single video with improved error handling
 */
async function processVideoGroup(group) {
    const { camera_id, date, interval_start, interval_end, files } = group;
    
    console.log(`[VIDEO] Processing camera ${camera_id}, date ${date}, interval ${interval_start}-${interval_end} minutes (${files.length} files)`);
    
    // Create temporary directory for this group
    const tempGroupDir = path.join(VIDEO_TEMP_DIR, `cam_${camera_id}_${date}_${interval_start}-${interval_end}`);
    
    try {
        await fs.ensureDir(tempGroupDir);
        
        // Check directory permissions
        try {
            const testFile = path.join(tempGroupDir, 'test_write.tmp');
            await fs.writeFile(testFile, 'test');
            // Add delay to ensure file handle is released before deletion
            await sleep(200);
            // Retry deletion with backoff if EBUSY
            let retries = 3;
            while (retries > 0) {
                try {
                    await fs.unlink(testFile);
                    break;
                } catch (unlinkError) {
                    if (unlinkError.code === 'EBUSY' && retries > 1) {
                        await sleep(500);
                        retries--;
                        continue;
                    }
                    throw unlinkError;
                }
            }
        } catch (error) {
            console.error(`[VIDEO] ✗ Directory write test failed: ${tempGroupDir} - ${error.message}`);
            return null;
        }
        
    } catch (error) {
        console.error(`[VIDEO] ✗ Failed to create temp directory: ${tempGroupDir} - ${error.message}`);
        return null;
    }
    
    const convertedFiles = [];
    const fileIds = [];
    
    try {
        // Sort files by precise time to ensure correct order
        files.sort((a, b) => a.precise_time.localeCompare(b.precise_time));
        
        // Convert each .issvd file to .mp4
        for (const file of files) {
            const filename = path.basename(file.file_name, '.issvd');
            const mp4Path = path.join(tempGroupDir, `${filename}.mp4`);
            
            try {
                // Check if source file exists before attempting conversion
                if (!await fs.pathExists(file.file_path)) {
                    console.error(`[VIDEO] ✗ Source file not found: ${file.file_path}`);
                    
                    // Mark file as deleted in database
                    try {
                        await pool.query(`
                            UPDATE iss_media_files 
                            SET deleted = true, updated_at = CURRENT_TIMESTAMP 
                            WHERE id = $1
                        `, [file.id]);
                        console.log(`[UPDATE] Marked file ${file.file_name} as deleted (ID: ${file.id})`);
                    } catch (dbError) {
                        console.error(`[ERROR] Failed to mark file as deleted: ${dbError.message}`);
                    }
                    
                    videoStats.errorsCount++;
                    continue;
                }
                
                await convertToMp4(file.file_path, mp4Path);
                convertedFiles.push(mp4Path);
                fileIds.push(file.id);
                console.log(`[VIDEO] ✓ Converted: ${file.file_name}`);
                
                // Small delay between conversions to prevent file system overload
                await sleep(100);
                
            } catch (error) {
                console.error(`[VIDEO] ✗ Failed to convert: ${file.file_name}`, error.message);
                videoStats.errorsCount++;
            }
        }
        
        if (convertedFiles.length === 0) {
            console.error(`[VIDEO] No files converted for group ${camera_id}_${date}_${interval_start}-${interval_end}`);
            return null;
        }
        
        // Add delay before concatenation to ensure all files are fully written
        await sleep(1000);
        
        // Create final concatenated video
        const startTime = Math.floor(interval_start / 60).toString().padStart(2, '0') + 
                         (interval_start % 60).toString().padStart(2, '0');
        const endTime = Math.floor(interval_end / 60).toString().padStart(2, '0') + 
                       (interval_end % 60).toString().padStart(2, '0');
        
        // Ensure date is properly formatted (YYYY-MM-DD)
        const formattedDate = date instanceof Date ? date.toISOString().split('T')[0] : date;
        const finalVideoName = `CAM_${camera_id}_${formattedDate}_${startTime}_to_${endTime}.mp4`;
        const finalVideoPath = path.join(tempGroupDir, finalVideoName);
        
        console.log(`[VIDEO] Starting concatenation to: ${finalVideoName}`);
        const success = await concatenateMp4Files(convertedFiles, finalVideoPath);
        
        if (success) {
            // Get file size
            const stats = await fs.stat(finalVideoPath);
            const fileSize = stats.size;
            
            console.log(`[VIDEO] ✓ Created: ${finalVideoName} (${(fileSize/1024/1024).toFixed(2)} MB)`);
            
            // Clean up individual MP4 files
            for (const file of convertedFiles) {
                try {
                    await fs.unlink(file);
                } catch (error) {
                    // Ignore cleanup errors
                }
            }
            
            videoStats.totalVideosCreated++;
            videoStats.totalFilesProcessed += files.length;
            
            return {
                videoPath: finalVideoPath,
                videoName: finalVideoName,
                fileSize: fileSize,
                camera_id: camera_id,
                site_id: currentSiteId,
                sourceFileIds: fileIds,
                recording_date: date,
                interval_start: interval_start,
                interval_end: interval_end
            };
        } else {
            console.error(`[VIDEO] ✗ Failed to concatenate files for group ${camera_id}_${date}_${interval_start}-${interval_end}`);
            return null;
        }
        
    } catch (error) {
        console.error(`[VIDEO] Error processing group ${camera_id}_${date}_${interval_start}-${interval_end}:`, error);
        videoStats.errorsCount++;
        return null;
    } finally {
        // Clean up temporary directory and handle partial failures
        try {
            const remainingFiles = await fs.readdir(tempGroupDir);
            
            // Clean up any leftover individual MP4 files
            for (const file of remainingFiles) {
                if (file.endsWith('.mp4') && !file.includes('_to_')) {
                    try {
                        await fs.unlink(path.join(tempGroupDir, file));
                        console.log(`[CLEANUP] Removed leftover file: ${file}`);
                    } catch (cleanupError) {
                        console.warn(`[CLEANUP] Failed to remove ${file}: ${cleanupError.message}`);
                    }
                }
            }
            
            // Leave temp directory for FileVideoTransferRedisService to clean up after successful transfer
            const updatedFiles = await fs.readdir(tempGroupDir);
            console.log(`[CLEANUP] Temp directory retained with ${updatedFiles.length} files for transfer service: ${path.basename(tempGroupDir)}`);
        } catch (error) {
            console.warn(`[CLEANUP] Error during directory cleanup: ${error.message}`);
        }
    }
}

/**
 * Job management functions (adapted from autoTransferRoutes.js)
 */
async function checkActiveJob(pool, origin = 'auto_video') {
    const result = await pool.query(`
        SELECT * FROM video_transfer_queue_job 
        WHERE batch_origin = $1 AND status IN ('created', 'pending', 'processing', 'transferring', 'paused')
        ORDER BY created_at DESC 
        LIMIT 1
    `, [origin]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
}

async function createTransferJob(pool, expectedCameras, origin = 'auto_video') {
    const batchId = uuidv4();
    const result = await pool.query(`
        INSERT INTO video_transfer_queue_job (
            batch_id, batch_origin, status, 
            expected_cameras, processed_cameras, 
            interval_duration_minutes, site_id
        ) 
        VALUES ($1, $2, 'created', $3, '{}', 5, $4) 
        RETURNING *
    `, [batchId, origin, expectedCameras, currentSiteId]);
    
    return result.rows[0];
}

async function updateJobStats(pool, jobId) {
    await pool.query(`
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

async function updateJobStatus(pool, jobId, status, errorMessage = null) {
    const updateFields = { status, updated_at: 'CURRENT_TIMESTAMP' };
    
    if (status === 'transferring' && !errorMessage) {
        updateFields.started_at = 'CURRENT_TIMESTAMP';
    } else if (status === 'transferred') {
        updateFields.completed_at = 'CURRENT_TIMESTAMP';
    }
    
    let setClause = Object.keys(updateFields).map((key, index) => 
        key === 'updated_at' || key === 'started_at' || key === 'completed_at' 
            ? `${key} = CURRENT_TIMESTAMP` 
            : `${key} = $${index + 2}`
    ).join(', ');
    
    const values = [jobId, ...Object.values(updateFields).filter(v => v !== 'CURRENT_TIMESTAMP')];
    
    if (errorMessage) {
        values.push(errorMessage);
        setClause += `, error_message = $${values.length}`;
    }
    
    await pool.query(`UPDATE video_transfer_queue_job SET ${setClause} WHERE id = $1`, values);
}

/**
 * Update job to set current processing camera
 */
async function updateJobCurrentCamera(pool, jobId, cameraId) {
    await pool.query(`
        UPDATE video_transfer_queue_job 
        SET current_camera_id = $2, updated_at = CURRENT_TIMESTAMP 
        WHERE id = $1
    `, [jobId, cameraId]);
}

/**
 * Add camera to processed cameras list in job
 */
async function addCameraToProcessed(pool, jobId, cameraId) {
    await pool.query(`
        UPDATE video_transfer_queue_job 
        SET 
            processed_cameras = array_append(processed_cameras, $2),
            updated_at = CURRENT_TIMESTAMP 
        WHERE id = $1
    `, [jobId, cameraId.toString()]);
}

/**
 * Check if all cameras have been processed for a job
 */
async function checkJobCompletion(pool, jobId) {
    const result = await pool.query(`
        SELECT 
            expected_cameras,
            processed_cameras,
            array_length(expected_cameras, 1) as expected_count,
            array_length(processed_cameras, 1) as processed_count
        FROM video_transfer_queue_job 
        WHERE id = $1
    `, [jobId]);
    
    if (result.rows.length === 0) return false;
    
    const { expected_cameras, processed_cameras, expected_count, processed_count } = result.rows[0];
    
    // Check if all expected cameras are in processed cameras
    if (expected_count === processed_count && expected_count > 0) {
        const allProcessed = expected_cameras.every(camera => 
            processed_cameras.includes(camera)
        );
        return allProcessed;
    }
    
    return false;
}

/**
 * Check for and fix inconsistent job states
 */
async function checkAndFixInconsistentJobStates() {
    try {
        // Find jobs that might be in inconsistent states
        const inconsistentJobs = await pool.query(`
            SELECT 
                vtqj.id, 
                vtqj.batch_id, 
                vtqj.status as job_status,
                vtqj.expected_cameras,
                vtqj.processed_cameras,
                array_length(vtqj.expected_cameras, 1) as expected_count,
                array_length(vtqj.processed_cameras, 1) as processed_count,
                COUNT(vtq.id) as queued_videos,
                COUNT(CASE WHEN vtq.status = 'pending' THEN 1 END) as pending_videos,
                COUNT(CASE WHEN vtq.status = 'transferred' THEN 1 END) as transferred_videos,
                COUNT(CASE WHEN vtq.status = 'failed' THEN 1 END) as failed_videos
            FROM video_transfer_queue_job vtqj
            LEFT JOIN video_transfer_queue vtq ON vtq.job_id = vtqj.id
            WHERE vtqj.batch_origin = 'auto_video'
            AND vtqj.status IN ('created', 'pending')
            GROUP BY vtqj.id, vtqj.batch_id, vtqj.status, vtqj.expected_cameras, vtqj.processed_cameras
        `);

        // console.log({
        //     checkAndFixInconsistentJobStates: inconsistentJobs.rows
        // })

        for (const job of inconsistentJobs.rows) {
            const { expected_cameras, processed_cameras, expected_count, processed_count } = job;
            
            // Check if all cameras have been processed but job status is still 'created'
            const allCamerasProcessed = expected_count === processed_count && expected_count > 0 &&
                expected_cameras.every(camera => processed_cameras.includes(camera));
                
            if (allCamerasProcessed && job.job_status === 'created') {
                console.log(`[DIAGNOSTIC] Found job ${job.id} (${job.batch_id}) with all cameras processed but status still 'created'`);
                console.log(`[DIAGNOSTIC] - Expected cameras: ${expected_cameras && expected_cameras.join ? expected_cameras.join(', ') : 'N/A'}`);
                console.log(`[DIAGNOSTIC] - Processed cameras: ${processed_cameras && processed_cameras.join ? processed_cameras.join(', ') : 'N/A'}`);
                console.log(`[DIAGNOSTIC] - Queued videos: ${job.queued_videos}, Transferred: ${job.transferred_videos}, Failed: ${job.failed_videos}`);
                
                // Update job stats and change to pending
                await updateJobStats(pool, job.id);
                await updateJobStatus(pool, job.id, 'pending');
                console.log(`[DIAGNOSTIC] ✓ Fixed job ${job.id}: status updated from 'created' to 'pending'`);
            }
            
            // Check if all videos have been transferred but job status is still 'pending'
            const allVideosTransferred = parseInt(job.queued_videos) > 0 && 
                                       parseInt(job.pending_videos) === 0 && 
                                       parseInt(job.transferred_videos) === parseInt(job.queued_videos);
                                       
            if (allVideosTransferred && job.job_status === 'pending') {
                console.log(`[DIAGNOSTIC] Found job ${job.id} (${job.batch_id}) with all videos transferred but status still 'pending'`);
                console.log(`[DIAGNOSTIC] - Queued videos: ${job.queued_videos}, Pending: ${job.pending_videos}, Transferred: ${job.transferred_videos}, Failed: ${job.failed_videos}`);
                
                // Update job stats and change to transferred
                await updateJobStats(pool, job.id);
                await updateJobStatus(pool, job.id, 'transferred');
                console.log(`[DIAGNOSTIC] ✓ Fixed job ${job.id}: status updated from 'pending' to 'transferred'`);
            }
            
            // Check for jobs in pending state with no videos queued (possible stale job)
            if (job.job_status === 'pending' && parseInt(job.queued_videos) === 0) {
                console.log(`[DIAGNOSTIC] WARNING: Job ${job.id} (${job.batch_id}) is pending but has no videos queued`);
                console.log(`[DIAGNOSTIC] - This could indicate a stale job or missing video creation`);
            }
        }
    } catch (error) {
        console.error('[DIAGNOSTIC] Error checking inconsistent job states:', error);
    }
}



/**
 * Add processed video to video transfer queue
 */
async function addVideoToTransferQueue(videoData, job) {
    try {
        const insertQuery = `
            INSERT INTO video_transfer_queue 
            (video_file_path, video_file_name, video_file_size, camera_id, site_id, 
             recording_date, interval_start_minutes, interval_end_minutes, 
             source_files_count, source_files_size, source_file_ids, status, job_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id;
        `;
        
        const result = await pool.query(insertQuery, [
            videoData.videoPath,
            videoData.videoName,
            videoData.fileSize,
            videoData.camera_id,
            videoData.site_id,
            videoData.recording_date,
            videoData.interval_start,
            videoData.interval_end,
            videoData.sourceFileIds.length,
            0, // source_files_size - we don't track individual source file sizes
            videoData.sourceFileIds, // Store actual source file IDs
            'pending',
            job.id
        ]);
        
        console.log(`[TRANSFER] Added video ${videoData.videoName} to video transfer queue (ID: ${result.rows[0].id})`);
        console.log(`[TRANSFER] Source files will be marked as transferred only after successful transfer`);
        
        return result.rows[0].id;
        
    } catch (error) {
        console.error('[ERROR] Failed to add video to video transfer queue:', error);
        throw error;
    }
}

/**
 * Mark source .issvd files as processed
 */
async function markSourceFilesAsProcessed(fileIds) {
    try {
        await pool.query(`
            UPDATE iss_media_files 
            SET is_auto_transferred = true, updated_at = CURRENT_TIMESTAMP 
            WHERE id = ANY($1)
        `, [fileIds]);
        
        console.log(`[UPDATE] Marked ${fileIds.length} source files as processed`);
    } catch (error) {
        console.error('[ERROR] Failed to mark files as processed:', error);
    }
}

/**
 * Add processing delay for failed files to prevent immediate retry
 */
async function addProcessingDelay(files) {
    try {
        const delayMinutes = 10; // Retry after 10 minutes
        const fileIds = files.map(f => f.id);
        
        // Store failed attempt info in Redis with TTL
        for (const file of files) {
            const key = `video_processing_failed:${file.id}`;
            await redis.setex(key, delayMinutes * 60, JSON.stringify({
                attempt_time: new Date().toISOString(),
                file_path: file.file_path,
                camera_id: file.camera_id
            }));
        }
        
        console.log(`[RETRY] Added ${delayMinutes}-minute processing delay for ${fileIds.length} files`);
    } catch (error) {
        console.error('[ERROR] Failed to add processing delay:', error);
    }
}

/**
 * Main video processing loop - Three Phase Approach
 */
async function runVideoProcessing() {
    if (isProcessing) {
        console.log('[INFO] Video processing already in progress');
        return;
    }
    
    isProcessing = true;
    
    try {
        // Check if video transfer is enabled
        if (!await isVideoTransferEnabled()) {
            console.log('[INFO] Video transfer is disabled');
            return;
        }
        
        // Update drive information and check space
        await updateDriveInfo();
        
        // Check if we should stop processing due to insufficient space or drive issues
        if (SHOULD_STOP_PROCESSING || !IS_DRIVE_CONNECTED) {
            const reason = !IS_DRIVE_CONNECTED ? 'No drive connected' : 
                          SHOULD_STOP_PROCESSING ? `Insufficient space (need more than ${MIN_REQUIRED_SPACE_MB}MB minimum)` : 'Unknown drive issue';
            console.log(`[SPACE] ⏸️  Video processing paused: ${reason}`);
            
            if (DRIVE_INFO) {
                // Handle different possible property names - values are in GB as strings
                let freeSpaceGB = parseFloat(DRIVE_INFO.remainingSpace || DRIVE_INFO.freeSize || DRIVE_INFO.availableSpace || DRIVE_INFO.available || 0);
                let totalSpaceGB = parseFloat(DRIVE_INFO.totalSpace || DRIVE_INFO.totalSize || DRIVE_INFO.size || DRIVE_INFO.total || 0);
                
                const freeSpaceMB = freeSpaceGB * 1024;
                const totalSpaceMB = totalSpaceGB * 1024;
                console.log(`[SPACE] Current free space: ${freeSpaceMB.toFixed(1)}MB / ${totalSpaceMB.toFixed(1)}MB total`);
            }
            
            return; // Wait for next cycle
        }
        
        // Get current site ID
        currentSiteId = await getCurrentSiteId();
        console.log(`[CONFIG] Current Site ID: ${currentSiteId || 'Not set'}`);
        
        // Calculate free space using the same logic as updateDriveInfo()
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
        console.log(`[SPACE] ✅ Space check passed: ${freeSpaceMB.toFixed(1)}MB available (${MIN_REQUIRED_SPACE_MB}MB minimum required)`);
        
        // PHASE 1: JOB MANAGEMENT
        console.log('\n=== PHASE 1: JOB MANAGEMENT ===');
        
        const activeJob = await checkActiveJob(pool, 'auto_video');
        
        if (activeJob) {
            console.log(`[PHASE1] Found active job: ${activeJob.batch_id} (status: ${activeJob.status})`);
            
            if (activeJob.status === 'pending') {
                console.log('[PHASE1] Job is pending transfer. Checking for inconsistent states...');
                
                // Check and fix any inconsistent job states
                await checkAndFixInconsistentJobStates();
                
                console.log('[PHASE1] Waiting for transfer to complete...');
                return;
            }
            
            if (activeJob.status === 'created') {
                console.log('[PHASE1] Job exists with created status. Checking progress...');
                
                // Check if all cameras have been processed
                const isComplete = await checkJobCompletion(pool, activeJob.id);
                if (isComplete) {
                    console.log('[PHASE1] All cameras processed. Moving job to pending status...');
                    await updateJobStats(pool, activeJob.id);
                    await updateJobStatus(pool, activeJob.id, 'pending');
                    console.log('[PHASE1] ✓ Job status changed to pending for transfer');
                    return;
                }
                
                // Continue processing remaining cameras
                console.log('[PHASE1] Job incomplete. Continuing with camera processing...');
            }
            
            if (activeJob.status === 'transferring' || activeJob.status === 'processing') {
                console.log('[PHASE1] Job is currently transferring/processing. Waiting...');
                return;
            }
        }
        
        // PHASE 2: CAMERA PROCESSING
        console.log('\n=== PHASE 2: CAMERA PROCESSING ===');
        
        let job = activeJob;
        
        // Create new job if none exists
        if (!job) {
            // Extract camera IDs from ISS_MEDIA_CAMERAS (remove 'CAM_' prefix if present)
            const expectedCameras = ISS_MEDIA_CAMERAS.map(cam => 
                cam.replace('CAM_', '')
            );
            
            // Check if there are any unprocessed files available for any camera before creating a job
            console.log(`[PHASE2] Checking for unprocessed files across all cameras...`);
            let totalAvailableFiles = 0;
            
            for (const cameraIdStr of expectedCameras) {
                const cameraId = parseInt(cameraIdStr);
                const files = await getUnprocessedFilesForCamera(cameraId);
                console.log(`[PHASE2] Camera ${cameraId}: ${files.length} unprocessed files available`);
                totalAvailableFiles += files.length;
            }
            
            if (totalAvailableFiles === 0) {
                console.log(`[PHASE2] ℹ No unprocessed files found for any camera. Skipping job creation.`);
                console.log(`[PHASE2] Will check again in next cycle.`);
                return;
            }
            
            console.log(`[PHASE2] Found ${totalAvailableFiles} total unprocessed files. Creating new job for cameras: ${expectedCameras.join(', ')}`);
            job = await createTransferJob(pool, expectedCameras, 'auto_video');
            console.log(`[PHASE2] ✓ Created job: ${job.batch_id} (status: created)`);
        }
        
        // Get list of cameras to process
        const expectedCameras = job.expected_cameras || ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
        const processedCameras = job.processed_cameras || [];
        
        console.log(`[PHASE2] Expected cameras: ${expectedCameras.join(', ')}`);
        console.log(`[PHASE2] Processed cameras: ${processedCameras.join(', ')}`);
        
        // Check if job is already complete
        const isJobComplete = await checkJobCompletion(pool, job.id);
        if (isJobComplete) {
            console.log('[PHASE2] ✓ Job already complete. Moving to Phase 3...');
        } else {
            // Add files to buffer for each camera that hasn't been processed yet
            console.log('\n[PHASE2] === FILE ACCUMULATION PHASE ===');
            
            for (const cameraIdStr of expectedCameras) {
                if (processedCameras.includes(cameraIdStr)) {
                    console.log(`[PHASE2] Camera ${cameraIdStr} already processed. Skipping.`);
                    continue;
                }
                
                const cameraId = parseInt(cameraIdStr);
                console.log(`[PHASE2] Adding files to buffer for camera ${cameraId}...`);
                
                try {
                    const addedCount = await addFilesToBuffer(cameraId, job);
                    console.log(`[PHASE2] ✓ Added ${addedCount} files to buffer for camera ${cameraId}`);
                    
                    // Reduced delay between cameras for faster processing
                    await sleep(200);
                    
                } catch (error) {
                    console.error(`[PHASE2] Error adding files for camera ${cameraId}:`, error);
                    videoStats.errorsCount++;
                }
            }
            
            // Check which cameras are ready for conversion (individual camera basis)
            console.log('\n[PHASE2] === READINESS CHECK ===');
            const { allReady, status } = await checkAllCamerasReady(expectedCameras);
            
            // Find cameras that are ready for individual conversion
            const readyCameras = expectedCameras.filter(cameraId => {
                const pending = status[parseInt(cameraId)] || 0;
                const isProcessed = processedCameras.includes(cameraId);
                return pending >= ISS_VIDEO_TRANSFER_CONVERSION_COUNT && !isProcessed;
            });
            
            if (readyCameras.length > 0) {
                console.log(`[PHASE2] ✅ ${readyCameras.length} camera(s) ready for conversion: ${readyCameras.join(', ')}`);
                
                // Double-check space before starting intensive conversion process
                await updateDriveInfo();
                if (SHOULD_STOP_PROCESSING || !IS_DRIVE_CONNECTED) {
                    const reason = !IS_DRIVE_CONNECTED ? 'Drive disconnected' : 'Insufficient space for conversion';
                    console.log(`[PHASE2] ⏸️  Conversion paused: ${reason}. Will retry in next cycle.`);
                    return;
                }
                
                // Estimate space needed for ready cameras only
                const totalFiles = readyCameras.reduce((sum, cameraId) => {
                    const pending = status[parseInt(cameraId)] || 0;
                    return sum + Math.min(pending, ISS_VIDEO_TRANSFER_CONVERSION_COUNT);
                }, 0);
                const estimatedSpaceMB = totalFiles * 2; // Rough estimate: 2MB per file for temp conversion
                
                if (!hasSpaceForProcessing(estimatedSpaceMB)) {
                    console.log(`[PHASE2] ⏸️  Insufficient space for conversion (need ~${estimatedSpaceMB}MB). Waiting for more space...`);
                    return;
                }
                
                console.log(`[PHASE2] 🚀 Space confirmed for conversion (~${estimatedSpaceMB}MB estimated). Processing ${readyCameras.length} ready camera(s)...`);
                
                // Convert only ready cameras
                const { successfulCameras, failedCameras } = await processAllReadyCameras(readyCameras, job);
                
                console.log(`[PHASE2] Conversion summary: ${successfulCameras} successful, ${failedCameras} failed`);
            } else {
                console.log('[PHASE2] ⏳ No cameras ready for conversion yet. Will continue accumulating files in next cycle...');
                
                // Show progress for all cameras
                for (const cameraId of expectedCameras) {
                    const pending = status[parseInt(cameraId)] || 0;
                    const isProcessed = processedCameras.includes(cameraId);
                    const progress = Math.round((pending / ISS_VIDEO_TRANSFER_CONVERSION_COUNT) * 100);
                    const readyStatus = isProcessed ? ' (COMPLETED)' : 
                                      pending >= ISS_VIDEO_TRANSFER_CONVERSION_COUNT ? ' (READY FOR CONVERSION)' : '';
                    console.log(`[PHASE2]   Camera ${cameraId}: ${pending}/${ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files (${progress}% ready)${readyStatus}`);
                }
            }
        }
        
        // PHASE 3: JOB COMPLETION
        console.log('\n=== PHASE 3: JOB COMPLETION ===');
        
        // Check if all cameras have been processed
        const finalJobComplete = await checkJobCompletion(pool, job.id);
        
        if (finalJobComplete) {
            // Update job stats and change status to pending
            await updateJobStats(pool, job.id);
            await updateJobStatus(pool, job.id, 'pending');
            
            console.log(`[PHASE3] ✓ All cameras processed! Job ${job.batch_id} status changed to 'pending'`);
            console.log(`[PHASE3] Job ready for transfer`);
            console.log(`[STATS] Total videos created: ${videoStats.totalVideosCreated}, Files processed: ${videoStats.totalFilesProcessed}, Errors: ${videoStats.errorsCount}`);
        } else {
            console.log(`[PHASE3] ⏳ Job in progress: continuing to accumulate and process files`);
            
            // Show current progress with detailed buffer status
            const detailedStatus = await checkCameraBufferStatusDetailed(expectedCameras);
            console.log('[PHASE3] Current buffer status:');
            for (const cameraId of expectedCameras) {
                const status = detailedStatus[parseInt(cameraId)] || { pending: 0, converted: 0 };
                const isCompleted = processedCameras.includes(cameraId);
                
                let statusText;
                if (isCompleted) {
                    statusText = `${status.pending} pending files ${status.converted} converted (COMPLETED)`;
                } else if (status.converted > 0) {
                    statusText = `${status.pending} pending files ${status.converted} converted`;
                } else if (status.pending > 0) {
                    statusText = `${status.pending} pending files ${status.converted} ready for conversion`;
                } else {
                    statusText = `${status.pending} pending files ${status.converted} ready for conversion`;
                }
                
                console.log(`[PHASE3]   Camera ${cameraId}: ${statusText}`);
            }
        }
        
        // Run diagnostic check for inconsistent job states
        await checkAndFixInconsistentJobStates();
        
        videoStats.lastProcessedTime = new Date();
        
    } catch (error) {
        console.error('[ERROR] Error in video processing:', error);
        videoStats.errorsCount++;
    } finally {
        isProcessing = false;
    }
}

/**
 * Clean up old failed jobs (older than 1 hour)
 */
async function cleanupOldFailedJobs() {
    try {
        const result = await pool.query(`
            DELETE FROM video_transfer_queue_job 
            WHERE status = 'failed' 
            AND created_at < NOW() - INTERVAL '1 hour'
            RETURNING id
        `);
        
        if (result.rows.length > 0) {
            console.log(`[CLEANUP] Removed ${result.rows.length} old failed jobs`);
        }
    } catch (error) {
        console.error('[ERROR] Error during cleanup of old failed jobs:', error);
    }
}

/**
 * Clean up corrupted buffer entries where files are marked as converted but don't exist on disk
 */
async function cleanupCorruptedBufferEntries() {
    try {
        // Get all converted entries older than 1 hour
        const result = await pool.query(`
            SELECT id, converted_file_path, source_file_id
            FROM video_converted_buffer 
            WHERE status = 'converted'
            AND created_at < NOW() - INTERVAL '1 hour'
        `);
        
        let cleanedCount = 0;
        
        for (const entry of result.rows) {
            // Check if file exists on disk
            if (!await fs.pathExists(entry.converted_file_path)) {
                // Mark as failed and clean up
                await markBufferEntryAsFailed(entry.id, 'File no longer exists on disk');
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`[CLEANUP] Marked ${cleanedCount} corrupted buffer entries as failed`);
        }
    } catch (error) {
        console.error('[ERROR] Failed to cleanup corrupted buffer entries:', error);
    }
}

/**
 * Clean up stale buffer entries that are blocking new file processing
 */
async function cleanupStaleBufferEntries() {
    try {
        // Remove old entries that are in completed states and older than 2 hours
        const result = await pool.query(`
            DELETE FROM video_converted_buffer 
            WHERE status IN ('converted', 'grouped', 'failed')
            AND created_at < NOW() - INTERVAL '2 hours'
            RETURNING id, status, source_file_id
        `);
        
        if (result.rows.length > 0) {
            console.log(`[CLEANUP] Removed ${result.rows.length} stale buffer entries`);
            const statusCounts = {};
            result.rows.forEach(row => {
                statusCounts[row.status] = (statusCounts[row.status] || 0) + 1;
            });
            console.log(`[CLEANUP] Status breakdown:`, statusCounts);
        }
    } catch (error) {
        console.error('[ERROR] Failed to cleanup stale buffer entries:', error);
    }
}







/**
 * Continuous video processing loop
 */
async function runContinuousVideoProcessing() {
    console.log('[START] Starting automatic video transfer service...');
    console.log(`[CONFIG] Video transfer size: ${ISS_VIDEO_TRANSFER_SIZE} minutes`);
    console.log(`[CONFIG] ISS Media Directory: ${ISS_MEDIA_DIR}`);
    
    // Ensure temp directory exists
    await fs.ensureDir(VIDEO_TEMP_DIR);
    
    // Temp directory cleanup is now handled by FileVideoTransferRedisService after successful transfer
    
    // Clean up stale buffer entries on startup
    await cleanupStaleBufferEntries();
    
    let cleanupCounter = 0;
    
    while (true) {
        try {
            await runVideoProcessing();
            
            // Run cleanup every 10 cycles (5 minutes)
            cleanupCounter++;
            if (cleanupCounter >= 10) {
                await cleanupOldFailedJobs();
                await cleanupCorruptedBufferEntries();
                await cleanupStaleBufferEntries();
                cleanupCounter = 0;
            }
            
            // Update drive info for next cycle and log status
            await updateDriveInfo();
            if (SHOULD_STOP_PROCESSING && DRIVE_INFO) {
                // Handle different possible property names - values are in GB as strings
                let freeSpaceGB = parseFloat(DRIVE_INFO.remainingSpace || DRIVE_INFO.freeSize || DRIVE_INFO.availableSpace || DRIVE_INFO.available || 0);
                let totalSpaceGB = parseFloat(DRIVE_INFO.totalSpace || DRIVE_INFO.totalSize || DRIVE_INFO.size || DRIVE_INFO.total || 0);
                
                const freeSpaceMB = freeSpaceGB * 1024;
                const totalSpaceMB = totalSpaceGB * 1024;
                const usedPercentage = totalSpaceMB > 0 ? ((totalSpaceMB - freeSpaceMB) / totalSpaceMB * 100).toFixed(1) : '0';
                console.log(`[SPACE] ⏸️  Waiting for space: ${freeSpaceMB.toFixed(1)}MB free (${usedPercentage}% used), need more than ${MIN_REQUIRED_SPACE_MB}MB minimum`);
            }
            
            // Reduced wait time for more responsive processing
            await sleep(5000); // Reduced from 30000ms for faster video pickup
            
        } catch (error) {
            console.error('[ERROR] Error in continuous video processing loop:', error);
            await sleep(10000); // Reduced from 60000ms for faster error recovery
        }
    }
}

/**
 * Continuous video ready detection for real-time processing
 * Runs more frequently to detect ready cameras and process them immediately
 */
async function continuousVideoReadyDetection() {
    console.log('[REALTIME] Starting continuous video ready detection service...');
    
    while (true) {
        try {
            // Only run if video transfer is enabled and we have proper connectivity
            if (!await isVideoTransferEnabled()) {
                await sleep(5000);
                continue;
            }

            // Quick space check
            await updateDriveInfo();
            if (SHOULD_STOP_PROCESSING || !IS_DRIVE_CONNECTED) {
                await sleep(2000); // Shorter wait when disabled
                continue;
            }

            // Get active job
            const job = await pool.query(`
                SELECT * FROM video_transfer_queue_job 
                WHERE status IN ('pending', 'transferring') 
                AND batch_origin = 'auto_video'
                ORDER BY created_at ASC 
                LIMIT 1
            `);

            if (job.rows.length === 0) {
                await sleep(3000); // No active job, wait a bit longer
                continue;
            }

            const activeJob = job.rows[0];
            const expectedCameras = activeJob.expected_cameras || ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
            const processedCameras = activeJob.processed_cameras || [];

            // Check which cameras are ready for immediate processing
            const pendingCameras = expectedCameras.filter(cameraId => !processedCameras.includes(cameraId));
            
            if (pendingCameras.length === 0) {
                await sleep(3000); // All cameras processed
                continue;
            }

            // Quick readiness check for unprocessed cameras
            const readyCameras = [];
            for (const cameraIdStr of pendingCameras) {
                const cameraId = parseInt(cameraIdStr);
                
                try {
                    const pendingCount = await pool.query(`
                        SELECT COUNT(*) as count FROM video_converted_buffer 
                        WHERE camera_id = $1 AND status = 'pending'
                    `, [cameraId]);
                    
                    const pending = parseInt(pendingCount.rows[0].count);
                    if (pending >= ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
                        readyCameras.push(cameraIdStr);
                        console.log(`[REALTIME] 🎯 Camera ${cameraId} ready for immediate processing (${pending} files available)`);
                    }
                } catch (error) {
                    console.error(`[REALTIME] Error checking camera ${cameraId}:`, error.message);
                }
            }

            // Process ready cameras immediately
            if (readyCameras.length > 0) {
                console.log(`[REALTIME] 🚀 Processing ${readyCameras.length} ready camera(s) immediately: ${readyCameras.join(', ')}`);
                
                // Use the optimized parallel processing function
                const { successfulCameras, failedCameras } = await processAllReadyCameras(readyCameras, activeJob);
                
                if (successfulCameras > 0) {
                    console.log(`[REALTIME] ✅ Successfully processed ${successfulCameras} camera(s) for immediate transfer`);
                }
                
                // Very short delay before checking again to allow for database updates
                await sleep(1000);
            } else {
                // No cameras ready yet, check again soon
                await sleep(2000);
            }

        } catch (error) {
            console.error('[REALTIME] Error in continuous video ready detection:', error);
            await sleep(5000); // Wait longer on error
        }
    }
}

// Initialize and start the video processing service
async function initializeVideoService() {
    try {
        // Load initial config from file first, then fallback to Redis
        let configLoaded = false;
        
        // Try to load from file first
        const fileConfig = readConfig();
        if (fileConfig) {
            CONFIG_STATE = fileConfig;
            console.log('[VIDEO] Loaded config from file');
            configLoaded = true;
        }
        
        // Fallback to Redis if file load failed
        if (!configLoaded) {
            const redisConfig = await redis.get(CONFIG_STATE_KEY);
            if (redisConfig) {
                CONFIG_STATE = JSON.parse(redisConfig);
                console.log('[VIDEO] Loaded config from Redis');
                configLoaded = true;
            }
        }
        
        if (!configLoaded) {
            console.log('[VIDEO] No config found in file or Redis - using defaults');
        }
        
        // Start both the main processing loop and real-time detection service
        runContinuousVideoProcessing();
        
        // Start continuous video ready detection for real-time processing
        // This runs in parallel to provide immediate processing of ready videos
        continuousVideoReadyDetection();
        
        console.log('[VIDEO] Started optimized video processing with real-time detection');
        
    } catch (error) {
        console.error('[VIDEO] Initialization error:', error);
        process.exit(1);
    }
}

initializeVideoService();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('[SHUTDOWN] Shutting down video transfer service...');
    await redis.quit();
    await pool.end();
    process.exit(0);
});

// Export functions for testing
module.exports = {
    runVideoProcessing,
    processVideoGroup,
    addFilesToBuffer,
    checkCameraBufferStatus,
    checkCameraBufferStatusDetailed,
    checkAllCamerasReady,
    processAllReadyCameras,
    groupFilesByCamera,
    getUnprocessedFilesForCamera,
    concatenateFromBuffer,
    getReadyCameraGroups,
    storeFileInBufferAsPending,
    updateBufferAfterConversion,
    markBufferEntryAsFailed,
    checkCameraGroupReady,
    getConvertedFilesForGroup,
    markFilesAsGrouped,
    cleanupConvertedFiles,
    convertToMp4,
    concatenateMp4Files,
    checkActiveJob,
    createTransferJob,
    updateJobStats,
    updateJobStatus,
    updateJobCurrentCamera,
    addCameraToProcessed,
    checkJobCompletion,
    checkAndFixInconsistentJobStates,
    addProcessingDelay,
    cleanupOldFailedJobs,
    cleanupCorruptedBufferEntries,
    cleanupStaleBufferEntries,
    updateDriveInfo,
    hasSpaceForProcessing,
    getEstimatedProcessingSize
};

const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const { sleep } = require('../utils.js');
const { MEDIA_INDEX_STATUS, MEDIA_INDEX_UPDATE, CONFIG_STATE_KEY } = require('../redisKeyStore.js');

// Configuration
const config = require('../utils/envConfig');
const { ISS_MEDIA_DIR, ISS_MEDIA_CAMERAS, ISS_MEDIA_FILE_SIZE, ISS_MEDIA_RETENTION } = config;

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
let isIndexing = false;
let currentSiteId = '';
let indexStats = {
    totalFiles: 0,
    processedFiles: 0,
    lastProcessedTime: null,
    camerasProcessed: 0,
    errorsCount: 0
};
let dailyStats = {
    date: new Date().toISOString().split('T')[0],
    addedToday: 0,
    lastResetTime: new Date()
};

/**
 * Parse date-time directory format: 2025-07-14T09+0300
 * Returns: { date, time, timezoneOffset }
 */
function parseDateTimeDirectory(dirName) {
    const match = dirName.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})\+(\d{4})$/);
    if (!match) return null;
    
    const [, year, month, day, hour, timezone] = match;
    
    return {
        date: `${year}-${month}-${day}`,
        time: `${hour}:00:00`,
        timezoneOffset: `+${timezone}`
    };
}

/**
 * Parse ISSVD filename format: 00-02-360_1.issvd
 * Returns: { offsetMinutes, offsetSeconds, offsetMs, cameraId }
 */
function parseISSVDFilename(filename) {
    const match = filename.match(/^(\d{2})-(\d{2})-(\d{3})_(\d+)\.issvd$/);
    if (!match) return null;
    
    const [, minutes, seconds, milliseconds, cameraId] = match;
    
    return {
        offsetMinutes: parseInt(minutes),
        offsetSeconds: parseInt(seconds),
        offsetMs: parseInt(milliseconds),
        cameraId: parseInt(cameraId)
    };
}

/**
 * Calculate precise time from base time and offset
 * Example: 09:00:00 + 00-02-360 = 09:02:02.360
 */
function calculatePreciseTime(baseTime, offsetMinutes, offsetSeconds, offsetMs) {
    const [baseHour, , ] = baseTime.split(':').map(Number);
    
    // Calculate total seconds including milliseconds
    const totalSeconds = offsetSeconds + Math.floor(offsetMs / 1000);
    const remainingMs = offsetMs % 1000;
    
    // Calculate final time
    const finalMinutes = offsetMinutes + Math.floor(totalSeconds / 60);
    const finalSeconds = totalSeconds % 60;
    const finalHours = baseHour + Math.floor(finalMinutes / 60);
    const normalizedMinutes = finalMinutes % 60;
    
    return `${String(finalHours).padStart(2, '0')}:${String(normalizedMinutes).padStart(2, '0')}:${String(finalSeconds).padStart(2, '0')}.${String(remainingMs).padStart(3, '0')}`;
}

/**
 * Get today's date in directory format: 2025-08-06T*
 */
function getTodayDirectoryPattern() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}T`;
}

/**
 * Check if a date directory has any files in database (to skip historical processing)
 */
async function hasFilesInDatabase(cameraId, dateStr) {
    try {
        const result = await pool.query(`
            SELECT COUNT(*) as count
            FROM iss_media_files 
            WHERE camera_id = $1 AND recording_date = $2 AND deleted = false
        `, [cameraId, dateStr]);
        
        return parseInt(result.rows[0].count) > 0;
    } catch (error) {
        console.error('[ERROR] Error checking database for date:', error);
        return false;
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
 * Check if date is within retention period
 */
function isWithinRetention(dateStr) {
    const fileDate = new Date(dateStr);
    const retentionDate = new Date();
    retentionDate.setDate(retentionDate.getDate() - ISS_MEDIA_RETENTION);
    return fileDate >= retentionDate;
}

/**
 * Get file size or use default
 */
async function getFileSize(filePath) {
    try {
        const stats = await fs.stat(filePath);
        return stats.size;
    } catch (error) {
        console.warn(`[WARN] Could not get file size for ${filePath}, using default: ${error.message}`);
        return ISS_MEDIA_FILE_SIZE * 1024; // Convert KB to bytes
    }
}

/**
 * Check if file already exists in database
 */
async function fileExistsInDB(filePath, fileName) {
    try {
        const result = await pool.query(
            'SELECT id, file_path, file_name FROM iss_media_files WHERE file_path = $1 OR (file_name = $2 AND file_path LIKE $3)',
            [filePath, fileName, `%${fileName}`]
        );
        
        if (result.rows.length > 0) {
            // console.log(`[DUPLICATE] File already exists in database: ${fileName}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error('[ERROR] Error checking file existence:', error);
        return false;
    }
}

/**
 * Get latest indexed date and time for a camera
 */
async function getLatestIndexedDateTime(cameraId) {
    try {
        const result = await pool.query(`
            SELECT recording_date, precise_time, file_name
            FROM iss_media_files 
            WHERE camera_id = $1 AND deleted = false
            ORDER BY recording_date DESC, precise_time DESC 
            LIMIT 1
        `, [cameraId]);
        
        if (result.rows.length > 0) {
            return {
                date: result.rows[0].recording_date,
                time: result.rows[0].precise_time,
                fileName: result.rows[0].file_name
            };
        }
    } catch (error) {
        console.error('[ERROR] Error getting latest indexed datetime:', error);
    }
    return null;
}

/**
 * Remove duplicate records based on file_path (keep the oldest record)
 */
async function removeDuplicateRecords() {
    try {
        const result = await pool.query(`
            DELETE FROM iss_media_files 
            WHERE id NOT IN (
                SELECT DISTINCT ON (file_path) id 
                FROM iss_media_files 
                ORDER BY file_path, created_at ASC
            )
        `);
        
        if (result.rowCount > 0) {
            console.log(`[CLEANUP] Removed ${result.rowCount} duplicate records`);
        }
        
        return result.rowCount;
    } catch (error) {
        console.error('[ERROR] Error removing duplicate records:', error);
        return 0;
    }
}

/**
 * Insert files into database with transaction
 */
async function insertFilesToDB(files) {
    if (files.length === 0) return;
    
    const client = await pool.connect();
    let insertedCount = 0;
    let duplicateCount = 0;
    
    try {
        await client.query('BEGIN');
        
        for (const file of files) {
            try {
                const result = await client.query(`
                    INSERT INTO iss_media_files (
                        file_path, file_name, file_size, camera_id, site_id,
                        recording_date, recording_time, timezone_offset, precise_time,
                        is_auto_transferred, is_ftp_transferred, deleted
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                    ON CONFLICT (file_path) DO NOTHING
                    RETURNING id
                `, [
                    file.filePath,
                    file.fileName, 
                    file.fileSize,
                    file.cameraId,
                    file.siteId,
                    file.date,
                    file.time,
                    file.timezoneOffset,
                    file.preciseTime,
                    false, // is_auto_transferred
                    false, // is_ftp_transferred
                    false  // deleted
                ]);
                
                if (result.rows.length > 0) {
                    insertedCount++;
                } else {
                    duplicateCount++;
                    // console.log(`[DUPLICATE] Skipped duplicate file: ${file.fileName}`);
                }
            } catch (insertError) {
                console.error(`[ERROR] Failed to insert file ${file.fileName}:`, insertError.message);
                indexStats.errorsCount++;
            }
        }
        
        await client.query('COMMIT');
        
        if (insertedCount > 0) {
            console.log(`[SUCCESS] Inserted ${insertedCount} new files to database`);
        }
        if (duplicateCount > 0) {
            console.log(`[INFO] Skipped ${duplicateCount} duplicate files`);
        }
        
        indexStats.processedFiles += insertedCount;
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[ERROR] Transaction failed during file insertion:', error);
        indexStats.errorsCount++;
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Process historical directories (only once, skip if already in DB)
 */
async function processHistoricalDirectories(cameraId, cameraPath) {
    try {
        const items = await fs.readdir(cameraPath, { withFileTypes: true });
        const dateDirs = items.filter(item => 
            item.isDirectory() && 
            /^\d{4}-\d{2}-\d{2}T\d{2}\+\d{4}$/.test(item.name)
        );
        
        const todayPattern = getTodayDirectoryPattern();
        const historicalDirs = dateDirs.filter(dir => !dir.name.startsWith(todayPattern));
        
        if (historicalDirs.length === 0) {
            console.log(`[HISTORICAL] No historical directories found for camera ${cameraId}`);
            return;
        }
        
        console.log(`[HISTORICAL] Processing ${historicalDirs.length} historical directories for camera ${cameraId}`);
        
        for (const dateDir of historicalDirs) {
            const dirInfo = parseDateTimeDirectory(dateDir.name);
            if (!dirInfo) continue;
            
            // Skip if retention period exceeded
            if (!isWithinRetention(dirInfo.date)) {
                console.log(`[SKIP] ${dateDir.name} - outside retention period`);
                continue;
            }
            
            // Skip if this date already has files in database
            const cameraIdNum = parseInt(cameraId.replace('CAM_', ''));
            if (await hasFilesInDatabase(cameraIdNum, dirInfo.date)) {
                console.log(`[SKIP] ${dateDir.name} - already processed (files exist in DB)`);
                continue;
            }
            
            console.log(`[HISTORICAL] Processing ${dateDir.name}`);
            const dateDirPath = path.join(cameraPath, dateDir.name);
            await processDateTimeDirectory(cameraIdNum, dateDirPath, dateDir.name, null);
        }
        
    } catch (error) {
        console.error(`[ERROR] Error processing historical directories:`, error);
    }
}

/**
 * Process only today's directories with incremental scanning
 */
async function processTodayDirectories(cameraId, cameraPath, latestFile = null) {
    try {
        const items = await fs.readdir(cameraPath, { withFileTypes: true });
        const todayPattern = getTodayDirectoryPattern();
        const todayDirs = items.filter(item => 
            item.isDirectory() && 
            item.name.startsWith(todayPattern)
        );
        
        if (todayDirs.length === 0) {
            console.log(`[TODAY] No directories found for today in camera ${cameraId}`);
            return 0;
        }
        
        console.log(`[TODAY] Processing ${todayDirs.length} today directories for camera ${cameraId}`);
        
        let addedCount = 0;
        for (const dateDir of todayDirs) {
            const dateDirPath = path.join(cameraPath, dateDir.name);
            const beforeCount = indexStats.processedFiles;
            
            await processDateTimeDirectory(
                parseInt(cameraId.replace('CAM_', '')), 
                dateDirPath, 
                dateDir.name, 
                latestFile
            );
            
            addedCount += (indexStats.processedFiles - beforeCount);
        }
        
        return addedCount;
        
    } catch (error) {
        console.error(`[ERROR] Error processing today's directories:`, error);
        return 0;
    }
}

/**
 * Process files in a camera directory by scanning date-time subdirectories
 */
async function processCameraFiles(cameraId, cameraPath, latestFile = null) {
    try {
        const items = await fs.readdir(cameraPath, { withFileTypes: true });
        const dateDirs = items.filter(item => 
            item.isDirectory() && 
            /^\d{4}-\d{2}-\d{2}T\d{2}\+\d{4}$/.test(item.name)
        );
        
        if (dateDirs.length === 0) {
            console.log(`[INFO] No date-time directories found in ${cameraPath}`);
            return;
        }
        
        // Sort directories chronologically
        dateDirs.sort((a, b) => a.name.localeCompare(b.name));
        
        console.log(`[INFO] Found ${dateDirs.length} date-time directories in ${cameraPath}`);
        
        for (const dateDir of dateDirs) {
            const dateDirPath = path.join(cameraPath, dateDir.name);
            await processDateTimeDirectory(cameraId, dateDirPath, dateDir.name, latestFile);
        }
        
    } catch (error) {
        console.error(`[ERROR] Error processing camera files in ${cameraPath}:`, error);
        indexStats.errorsCount++;
    }
}

/**
 * Process files in a specific date-time directory
 */
async function processDateTimeDirectory(cameraId, dateDirPath, dateDirName, latestFile = null) {
    try {
        console.log(`[DEBUG] processDateTimeDirectory: ${dateDirName}`)
        const dirInfo = parseDateTimeDirectory(dateDirName);
        if (!dirInfo) {
            console.warn(`[WARN] Invalid date-time directory format: ${dateDirName}`);
            return;
        }
        
        // Check retention policy for this date
        if (!isWithinRetention(dirInfo.date)) {
            console.log(`[SKIP] Skipping ${dateDirName} - outside retention period`);
            return;
        }
        
        const files = await fs.readdir(dateDirPath);
        const issvdFiles = files.filter(file => file.endsWith('.issvd'));
        
        if (issvdFiles.length === 0) {
            console.log(`[INFO] No ISSVD files found in ${dateDirPath}`);
            return;
        }
        
        // Sort files chronologically
        issvdFiles.sort();
        
        // If we have a latest file, start from there
        let startIndex = 0;
        if (latestFile && latestFile.fileName) {
            const latestIndex = issvdFiles.findIndex(file => file === latestFile.fileName);
            if (latestIndex >= 0) {
                startIndex = latestIndex + 1; // Start from next file
                console.log(`[CONTINUE] Continuing from: ${latestFile.fileName} in ${dateDirName}`);
            }
        }
        
        const filesToProcess = issvdFiles.slice(startIndex);
        console.log(`[PROCESS] Processing ${filesToProcess.length} ISSVD files in ${dateDirPath}`);
        
        const filesToInsert = [];
        
        for (const fileName of filesToProcess) {
            const filePath = path.join(dateDirPath, fileName);
            
            // Skip if already exists in database
            if (await fileExistsInDB(filePath, fileName)) {
                continue;
            }
            
            const parsedFile = parseISSVDFilename(fileName);
            if (!parsedFile) {
                console.warn(`[WARN] Invalid ISSVD filename format: ${fileName}`);
                continue;
            }
            
            const fileSize = await getFileSize(filePath);
            const preciseTime = calculatePreciseTime(
                dirInfo.time, 
                parsedFile.offsetMinutes, 
                parsedFile.offsetSeconds, 
                parsedFile.offsetMs
            );
            
            filesToInsert.push({
                filePath,
                fileName,
                fileSize,
                cameraId: parsedFile.cameraId,
                siteId: currentSiteId,
                date: dirInfo.date,
                time: dirInfo.time,
                timezoneOffset: dirInfo.timezoneOffset,
                preciseTime: preciseTime
            });
        }
        
        if (filesToInsert.length > 0) {
            await insertFilesToDB(filesToInsert);
        }
        
    } catch (error) {
        console.error(`[ERROR] Error processing date-time directory ${dateDirPath}:`, error);
        indexStats.errorsCount++;
    }
}

/**
 * Process a camera directory with new workflow
 */
async function processCameraDirectory(cameraId, isInitialScan = false) {
    const cameraPath = path.join(ISS_MEDIA_DIR, cameraId);
    
    try {
        if (!await fs.pathExists(cameraPath)) {
            console.warn(`[WARN] Camera directory not found: ${cameraPath}`);
            return;
        }
        
        const cameraIdNum = parseInt(cameraId.replace('CAM_', ''));
        
        if (isInitialScan) {
            console.log(`[CAMERA] Initial scan - processing historical files for: ${cameraId}`);
            // 1. Process historical directories (skip if already in DB)
            await processHistoricalDirectories(cameraId, cameraPath);
        }
        
        // 2. Process today's directories with resume capability
        console.log(`[CAMERA] Processing today's files for: ${cameraId}`);
        const latestIndexed = await getLatestIndexedDateTime(cameraIdNum);
        const addedToday = await processTodayDirectories(cameraId, cameraPath, latestIndexed);
        
        // 3. Update daily stats
        dailyStats.addedToday += addedToday;
        
        // 4. Print today's additions
        if (addedToday > 0) {
            console.log(`[TODAY] Added ${addedToday} new files for camera ${cameraId}`);
        }
        
        indexStats.camerasProcessed++;
        console.log(`[SUCCESS] Completed processing camera: ${cameraId}`);
        
    } catch (error) {
        console.error(`[ERROR] Error processing camera ${cameraId}:`, error);
        indexStats.errorsCount++;
    }
}

/**
 * Perform initial indexing of all cameras with new workflow
 */
async function performInitialIndexing() {
    if (isIndexing) {
        console.log('[INFO] Indexing already in progress');
        return;
    }
    
    isIndexing = true;
    indexStats = {
        totalFiles: 0,
        processedFiles: 0,
        lastProcessedTime: new Date(),
        camerasProcessed: 0,
        errorsCount: 0
    };
    
    // Reset daily stats
    dailyStats = {
        date: new Date().toISOString().split('T')[0],
        addedToday: 0,
        lastResetTime: new Date()
    };
    
    console.log('[START] Starting initial media file indexing...');
    console.log(`[CONFIG] ISS Media Directory: ${ISS_MEDIA_DIR}`);
    console.log(`[CONFIG] Cameras to process: ${ISS_MEDIA_CAMERAS.join(', ')}`);
    console.log(`[CONFIG] Retention period: ${ISS_MEDIA_RETENTION} days`);
    
    try {
        // Get current site ID
        currentSiteId = await getCurrentSiteId();
        console.log(`[CONFIG] Current Site ID: ${currentSiteId || 'Not set'}`);
        
        // Process each camera with initial scan flag
        for (const cameraId of ISS_MEDIA_CAMERAS) {
            await processCameraDirectory(cameraId, true); // isInitialScan = true
            
            // Update Redis status
            await redis.set(MEDIA_INDEX_STATUS, JSON.stringify(indexStats));
            await redis.publish(MEDIA_INDEX_UPDATE, JSON.stringify(indexStats));
        }
        
        indexStats.lastProcessedTime = new Date();
        
        // Clean up any duplicate records that might have been inserted
        console.log('[CLEANUP] Checking for duplicate records...');
        await removeDuplicateRecords();
        
        console.log('[COMPLETE] Initial indexing completed!');
        console.log(`[STATS] Total processed: ${indexStats.processedFiles} files, ${indexStats.camerasProcessed} cameras, ${indexStats.errorsCount} errors`);
        console.log(`[TODAY] Total files added today: ${dailyStats.addedToday}`);
        
    } catch (error) {
        console.error('[ERROR] Error during initial indexing:', error);
    } finally {
        isIndexing = false;
        
        // Final status update
        await redis.set(MEDIA_INDEX_STATUS, JSON.stringify(indexStats));
        await redis.publish(MEDIA_INDEX_UPDATE, JSON.stringify(indexStats));
    }
}

/**
 * Continuous monitoring and indexing loop with today-only focus
 */
async function runContinuousIndexing() {
    await performInitialIndexing();
    
    let lastCleanupTime = new Date();
    
    while (true) {
        try {
            // Check for site ID changes
            const newSiteId = await getCurrentSiteId();
            if (newSiteId !== currentSiteId) {
                console.log(`[UPDATE] Site ID changed from '${currentSiteId}' to '${newSiteId}'`);
                currentSiteId = newSiteId;
            }
            
            // Reset daily stats if new day
            const currentDate = new Date().toISOString().split('T')[0];
            if (currentDate !== dailyStats.date) {
                console.log(`[NEW DAY] Resetting daily stats for ${currentDate}`);
                dailyStats = {
                    date: currentDate,
                    addedToday: 0,
                    lastResetTime: new Date()
                };
            }
            
            // Only monitor TODAY's files (not historical)
            if (!isIndexing) {
                console.log('[MONITOR] Checking for new media files in today\'s directories...');
                
                const beforeTodayCount = dailyStats.addedToday;
                
                for (const cameraId of ISS_MEDIA_CAMERAS) {
                    await processCameraDirectory(cameraId, false); // isInitialScan = false
                    await sleep(1000); // 1 second between cameras
                }
                
                // Report daily additions
                const newAdditions = dailyStats.addedToday - beforeTodayCount;
                if (newAdditions > 0) {
                    console.log(`[TODAY] Added ${newAdditions} new files this cycle. Total today: ${dailyStats.addedToday}`);
                }
                
                // Update status
                indexStats.lastProcessedTime = new Date();
                await redis.set(MEDIA_INDEX_STATUS, JSON.stringify(indexStats));
                
                // Run duplicate cleanup once per day
                const now = new Date();
                const timeSinceLastCleanup = now - lastCleanupTime;
                const dayInMs = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
                
                if (timeSinceLastCleanup >= dayInMs) {
                    console.log('[CLEANUP] Running daily duplicate cleanup...');
                    await removeDuplicateRecords();
                    lastCleanupTime = now;
                }
            }
            
            // Wait 5 seconds before next check
            await sleep(5000);
            
        } catch (error) {
            console.error('[ERROR] Error in continuous indexing loop:', error);
            await sleep(60000); // Wait 1 minute on error
        }
    }
}

// Start the indexing process
runContinuousIndexing();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('[SHUTDOWN] Shutting down media indexing service...');
    await redis.quit();
    await pool.end();
    process.exit(0);
}); 
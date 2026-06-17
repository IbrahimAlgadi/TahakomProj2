const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const pLimit = require('p-limit');
const { sleep } = require('./utils.js');
const { MEDIA_INDEX_STATUS, MEDIA_INDEX_UPDATE, CONFIG_STATE_KEY } = require('./redisKeyStore.js');

// Configuration
const config = require('./utils/envConfig');
const { ISS_MEDIA_DIR, ISS_MEDIA_CAMERAS, ISS_MEDIA_FILE_SIZE, ISS_MEDIA_RETENTION } = config;

// Performance Configuration
const PERFORMANCE_CONFIG = {
    BULK_INSERT_BATCH_SIZE: 5000,     // Insert 5000 files at once
    PARALLEL_CAMERAS: 3,               // Process 3 cameras simultaneously
    DIRECTORY_SCAN_BATCH: 1000,       // Process 1000 files per directory batch
    STATS_LOG_INTERVAL: 10000,        // Log progress every 10k files
    DB_POOL_SIZE: 20,                 // Larger connection pool
    MEMORY_CLEANUP_THRESHOLD: 50000,  // Clean up arrays when they get large
    DUPLICATE_CHECK_BATCH: 1000       // Check duplicates in smaller batches
};

// Initialize Redis client
const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

// Initialize PostgreSQL pool with optimized settings
const pool = new Pool({
    user: config.database.user,
    host: config.database.host,
    database: config.database.database,
    port: 5432,
    password: config.database.password,
    max: PERFORMANCE_CONFIG.DB_POOL_SIZE,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
});

// State variables
let isHistoricalScanComplete = false;
let isRealTimeMonitoring = false;
let currentSiteId = '';
let fileWatchers = new Map(); // Store chokidar watchers

// Performance tracking
let performanceStats = {
    historicalScan: {
        startTime: null,
        endTime: null,
        totalFilesScanned: 0,
        totalFilesInserted: 0,
        totalDirectoriesScanned: 0,
        camerasCompleted: 0,
        averageFilesPerSecond: 0,
        errors: 0
    },
    realTimeMonitoring: {
        startTime: null,
        filesProcessedToday: 0,
        lastFileTime: null,
        averageProcessingTime: 0,
        errors: 0
    },
    database: {
        totalQueries: 0,
        averageQueryTime: 0,
        bulkInsertCount: 0,
        duplicatesSkipped: 0,
        connectionPoolStats: {
            totalConnections: 0,
            idleConnections: 0,
            waitingClients: 0
        }
    }
};

// Real-time file processing queue and batching
const realtimeFileQueue = [];

// Real-time batching configuration
const REALTIME_CONFIG = {
    BATCH_SIZE: 50,           // Process 50 files at once
    BATCH_TIMEOUT: 3000,      // Process batch every 3 seconds max
    MAX_QUEUE_SIZE: 500       // Prevent memory overflow
};

let lastBatchProcessTime = Date.now();

/**
 * Parse date-time directory format: 2025-07-14T09+0300
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
 */
function calculatePreciseTime(baseTime, offsetMinutes, offsetSeconds, offsetMs) {
    const [baseHour, , ] = baseTime.split(':').map(Number);
    
    const totalSeconds = offsetSeconds + Math.floor(offsetMs / 1000);
    const remainingMs = offsetMs % 1000;
    
    const finalMinutes = offsetMinutes + Math.floor(totalSeconds / 60);
    const finalSeconds = totalSeconds % 60;
    const finalHours = baseHour + Math.floor(finalMinutes / 60);
    const normalizedMinutes = finalMinutes % 60;
    
    return `${String(finalHours).padStart(2, '0')}:${String(normalizedMinutes).padStart(2, '0')}:${String(finalSeconds).padStart(2, '0')}.${String(remainingMs).padStart(3, '0')}`;
}

/**
 * Get today's date patterns for directory matching
 * Each day has 24 hourly directories: T00+0300 through T23+0300
 */
function getTodayPatterns() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    
    // Generate all 24 hourly patterns for today
    const hourlyPatterns = [];
    for (let hour = 0; hour < 24; hour++) {
        const hourStr = String(hour).padStart(2, '0');
        hourlyPatterns.push(`${year}-${month}-${day}T${hourStr}+0300`);
    }
    
    return {
        basePattern: `${year}-${month}-${day}T`,
        fullDate: `${year}-${month}-${day}`,
        hourlyPatterns: hourlyPatterns,
        // Regex to match any hour for today
        todayRegex: new RegExp(`^${year}-${month}-${day}T(0[0-9]|1[0-9]|2[0-3])\\+0300$`)
    };
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
 * Check if files exist in database (batch check for performance)
 */
async function checkFileExistsInDB(filePaths) {
    if (filePaths.length === 0) return new Set();
    
    try {
        const client = await pool.connect();
        const existingFiles = new Set();
        
        // Check in batches to avoid query size limits
        for (let i = 0; i < filePaths.length; i += PERFORMANCE_CONFIG.DUPLICATE_CHECK_BATCH) {
            const batch = filePaths.slice(i, i + PERFORMANCE_CONFIG.DUPLICATE_CHECK_BATCH);
            const placeholders = batch.map((_, index) => `$${index + 1}`).join(',');
            
            const result = await client.query(
                `SELECT file_path FROM iss_media_files WHERE file_path IN (${placeholders})`,
                batch
            );
            
            result.rows.forEach(row => existingFiles.add(row.file_path));
        }
        
        client.release();
        return existingFiles;
        
    } catch (error) {
        console.error('[ERROR] Error checking file existence in batch:', error);
        return new Set();
    }
}

/**
 * High-performance bulk insert with proper error handling and duplicate prevention
 */
async function bulkInsertFiles(files) {
    if (files.length === 0) return { inserted: 0, duplicates: 0 };

    console.log(`[BULK INSERT] Processing ${files.length} files for database insert...`);

    // First, check which files already exist
    const filePaths = files.map(f => f.filePath);
    console.log(`[BULK INSERT] Checking ${filePaths.length} files for duplicates in database...`);
    const existingFiles = await checkFileExistsInDB(filePaths);

    // Filter out existing files
    const newFiles = files.filter(f => !existingFiles.has(f.filePath));
    const duplicateCount = files.length - newFiles.length;

    console.log(`[BULK INSERT] Found ${duplicateCount} existing files, ${newFiles.length} new files to insert`);

    if (newFiles.length === 0) {
        console.log(`[BULK INSERT] All ${files.length} files already exist in database`);
        performanceStats.database.duplicatesSkipped += duplicateCount;
        return { inserted: 0, duplicates: duplicateCount };
    }

    const client = await pool.connect();
    let insertedCount = 0;
    const startTime = Date.now();

    try {
        console.log(`[BULK INSERT] Starting database transaction for ${newFiles.length} new files`);
        await client.query('BEGIN');

        // Process in batches to avoid memory issues
        for (let i = 0; i < newFiles.length; i += PERFORMANCE_CONFIG.BULK_INSERT_BATCH_SIZE) {
            const batch = newFiles.slice(i, i + PERFORMANCE_CONFIG.BULK_INSERT_BATCH_SIZE);
            console.log(`[BULK INSERT] Processing batch ${Math.floor(i / PERFORMANCE_CONFIG.BULK_INSERT_BATCH_SIZE) + 1}: ${batch.length} files`);
            
            // Build VALUES clause for bulk insert
            const values = [];
            const params = [];
            
            batch.forEach((file, index) => {
                const baseIndex = index * 12;
                values.push(`($${baseIndex + 1}, $${baseIndex + 2}, $${baseIndex + 3}, $${baseIndex + 4}, $${baseIndex + 5}, $${baseIndex + 6}, $${baseIndex + 7}, $${baseIndex + 8}, $${baseIndex + 9}, $${baseIndex + 10}, $${baseIndex + 11}, $${baseIndex + 12})`);
                
                params.push(
                    file.filePath, file.fileName, file.fileSize, file.cameraId, file.siteId,
                    file.date, file.time, file.timezoneOffset, file.preciseTime,
                    false, false, false // is_auto_transferred, is_ftp_transferred, deleted
                );
            });

            const result = await client.query(`
                INSERT INTO iss_media_files (
                    file_path, file_name, file_size, camera_id, site_id,
                    recording_date, recording_time, timezone_offset, precise_time,
                    is_auto_transferred, is_ftp_transferred, deleted
                ) VALUES ${values.join(',')}
                ON CONFLICT (file_path) DO NOTHING
                RETURNING id
            `, params);

            insertedCount += result.rows.length;
        }

        console.log(`[BULK INSERT] Committing transaction...`);
        await client.query('COMMIT');

        const duration = Date.now() - startTime;
        performanceStats.database.totalQueries++;
        performanceStats.database.bulkInsertCount++;
        performanceStats.database.averageQueryTime =
            (performanceStats.database.averageQueryTime + duration) / performanceStats.database.totalQueries;
        performanceStats.database.duplicatesSkipped += duplicateCount;

        console.log(`[BULK INSERT] Successfully inserted ${insertedCount} new files, skipped ${duplicateCount} duplicates in ${duration}ms`);
        console.log(`[BULK INSERT] Average query time: ${Math.round(performanceStats.database.averageQueryTime)}ms, Total queries: ${performanceStats.database.totalQueries}`);

        return { inserted: insertedCount, duplicates: duplicateCount };

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[ERROR] Bulk insert failed:', error);
        performanceStats.historicalScan.errors++;
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Memory-efficient directory scanning with streaming
 */
async function scanDirectoryEfficiently(dirPath, dirName) {
    const files = [];
    const dirInfo = parseDateTimeDirectory(dirName);
    
    if (!dirInfo || !isWithinRetention(dirInfo.date)) {
        return [];
    }

    try {
        const fileList = await fs.readdir(dirPath);
        const issvdFiles = fileList.filter(file => file.endsWith('.issvd'));
        
        for (const fileName of issvdFiles) {
            const filePath = path.join(dirPath, fileName);
            const parsedFile = parseISSVDFilename(fileName);
            
            if (!parsedFile) continue;

            const preciseTime = calculatePreciseTime(
                dirInfo.time,
                parsedFile.offsetMinutes,
                parsedFile.offsetSeconds,
                parsedFile.offsetMs
            );

            files.push({
                filePath,
                fileName,
                fileSize: ISS_MEDIA_FILE_SIZE * 1024, // Use fixed size for performance
                cameraId: parsedFile.cameraId,
                siteId: currentSiteId,
                date: dirInfo.date,
                time: dirInfo.time,
                timezoneOffset: dirInfo.timezoneOffset,
                preciseTime: preciseTime
            });
        }

        return files;

    } catch (error) {
        console.error(`[ERROR] Failed to scan directory ${dirPath}:`, error);
        performanceStats.historicalScan.errors++;
        return [];
    }
}

/**
 * Get latest indexed date and time for a camera (for resume capability)
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
 * Remove duplicate records based on file_path (keep the oldest record) - optimized version
 */
async function removeDuplicateRecords() {
    try {
        console.log('[CLEANUP] Running optimized duplicate removal...');
        
        // Use a more efficient approach with CTE and window functions
        const result = await pool.query(`
            WITH duplicates AS (
                SELECT id, file_path,
                       ROW_NUMBER() OVER (PARTITION BY file_path ORDER BY created_at ASC) as rn
                FROM iss_media_files
            )
            DELETE FROM iss_media_files 
            WHERE id IN (
                SELECT id FROM duplicates WHERE rn > 1
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
 * Update database connection pool statistics
 */
function updatePoolStats() {
    performanceStats.database.connectionPoolStats = {
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingClients: pool.waitingCount
    };
}

/**
 * Historical scan for one camera with performance tracking
 */
async function performHistoricalScanForCamera(cameraId) {
    const cameraPath = path.join(ISS_MEDIA_DIR, cameraId);

    console.log(`[HISTORICAL] Starting scan for camera: ${cameraId}`);
    console.log(`[HISTORICAL] Camera path: ${cameraPath}`);

    if (!await fs.pathExists(cameraPath)) {
        console.warn(`[WARN] Camera directory not found: ${cameraPath}`);
        return;
    }

    const todayPatterns = getTodayPatterns();
    let cameraFilesScanned = 0;
    let cameraFilesInserted = 0;
    let cameraDirectories = 0;

    try {
        console.log(`[HISTORICAL] Reading directory contents for ${cameraId}...`);
        const items = await fs.readdir(cameraPath, { withFileTypes: true });
        console.log(`[HISTORICAL] Found ${items.length} total items in ${cameraId} directory`);

        const dateDirs = items.filter(item =>
            item.isDirectory() &&
            /^\d{4}-\d{2}-\d{2}T\d{2}\+0300$/.test(item.name) &&
            !todayPatterns.todayRegex.test(item.name) // Skip today's directories
        );

        console.log(`[HISTORICAL] Found ${dateDirs.length} historical directories for ${cameraId}`);
        console.log(`[HISTORICAL] Sample directories: ${dateDirs.slice(0, 3).map(d => d.name).join(', ')}${dateDirs.length > 3 ? '...' : ''}`);

        // Show retention info
        const retentionDays = ISS_MEDIA_RETENTION;
        console.log(`[HISTORICAL] Processing directories within ${retentionDays} day retention period`);

        let allFiles = [];
        let dirCount = 0;

        for (const dateDir of dateDirs) {
            dirCount++;
            const dateDirPath = path.join(cameraPath, dateDir.name);

            console.log(`[HISTORICAL] [${dirCount}/${dateDirs.length}] Scanning directory: ${dateDir.name}`);

            const files = await scanDirectoryEfficiently(dateDirPath, dateDir.name);

            if (files.length > 0) {
                console.log(`[HISTORICAL] Found ${files.length} .issvd files in ${dateDir.name}`);
                console.log(`[HISTORICAL] Sample files: ${files.slice(0, 3).map(f => f.fileName).join(', ')}${files.length > 3 ? '...' : ''}`);
            } else {
                console.log(`[HISTORICAL] No .issvd files found in ${dateDir.name}`);
            }

            allFiles.push(...files);
            cameraFilesScanned += files.length;
            cameraDirectories++;

            // Log progress every 10 directories
            if (dirCount % 10 === 0) {
                console.log(`[PROGRESS] ${cameraId}: Processed ${dirCount}/${dateDirs.length} directories, ${cameraFilesScanned} files so far`);
            }

            // Bulk insert when we reach threshold to manage memory
            if (allFiles.length >= PERFORMANCE_CONFIG.MEMORY_CLEANUP_THRESHOLD) {
                console.log(`[HISTORICAL] Memory threshold reached (${allFiles.length} files), performing bulk insert...`);
                const result = await bulkInsertFiles(allFiles);
                cameraFilesInserted += result.inserted;
                allFiles = []; // Clear memory

                console.log(`[BULK INSERT] Inserted ${result.inserted} files, skipped ${result.duplicates} duplicates`);

                // Log progress
                if (cameraFilesScanned % PERFORMANCE_CONFIG.STATS_LOG_INTERVAL === 0) {
                    console.log(`[PROGRESS] ${cameraId}: Scanned ${cameraFilesScanned} files, inserted ${cameraFilesInserted}`);
                    updatePoolStats();
                }
            }
        }

        // Insert remaining files
        if (allFiles.length > 0) {
            console.log(`[HISTORICAL] Inserting remaining ${allFiles.length} files...`);
            const result = await bulkInsertFiles(allFiles);
            cameraFilesInserted += result.inserted;
            console.log(`[BULK INSERT] Final batch: Inserted ${result.inserted} files, skipped ${result.duplicates} duplicates`);
        }

        console.log(`[HISTORICAL COMPLETE] ${cameraId}: ${cameraFilesScanned} files scanned, ${cameraFilesInserted} inserted, ${cameraDirectories} directories`);
        console.log(`[HISTORICAL COMPLETE] Average files per directory: ${Math.round(cameraFilesScanned / cameraDirectories)}`);

        // Update global stats
        performanceStats.historicalScan.totalFilesScanned += cameraFilesScanned;
        performanceStats.historicalScan.totalFilesInserted += cameraFilesInserted;
        performanceStats.historicalScan.totalDirectoriesScanned += cameraDirectories;
        performanceStats.historicalScan.camerasCompleted++;

    } catch (error) {
        console.error(`[ERROR] Historical scan failed for ${cameraId}:`, error);
        performanceStats.historicalScan.errors++;
    }
}

/**
 * Calculate estimated file counts based on file structure
 */
function getExpectedFileCounts() {
    const filesPerCameraPerDay = 42000; // As mentioned by user
    const camerasCount = ISS_MEDIA_CAMERAS.length;
    const retentionDays = ISS_MEDIA_RETENTION;
    
    // Exclude today from historical scan
    const historicalDays = retentionDays - 1;
    
    const expectedHistorical = camerasCount * historicalDays * filesPerCameraPerDay;
    const expectedTodayTotal = camerasCount * filesPerCameraPerDay;
    
    return {
        filesPerCameraPerDay,
        filesPerCameraPerHour: Math.round(filesPerCameraPerDay / 24),
        expectedHistorical,
        expectedTodayTotal,
        directoriesPerCameraPerDay: 24, // T00 through T23
        totalHistoricalDirectories: camerasCount * historicalDays * 24
    };
}

/**
 * Perform complete historical scan for all cameras
 */
async function performHistoricalScan() {
    const fileEstimates = getExpectedFileCounts();

    console.log('[HISTORICAL SCAN] Starting comprehensive historical scan...');
    console.log(`[CONFIG] Cameras: ${ISS_MEDIA_CAMERAS.join(', ')}`);
    console.log(`[CONFIG] Retention: ${ISS_MEDIA_RETENTION} days`);
    console.log(`[CONFIG] Media Directory: ${ISS_MEDIA_DIR}`);
    console.log(`[STRUCTURE] Each day has 24 hourly directories (T00+0300 to T23+0300)`);
    console.log(`[STRUCTURE] Each hour contains ~${fileEstimates.filesPerCameraPerHour} files (MM-SS-mmm_C.issvd)`);
    console.log(`[ESTIMATE] Expected historical files: ~${fileEstimates.expectedHistorical.toLocaleString()}`);
    console.log(`[ESTIMATE] Expected historical directories: ~${fileEstimates.totalHistoricalDirectories.toLocaleString()}`);

    performanceStats.historicalScan.startTime = new Date();

    // Get current site ID
    currentSiteId = await getCurrentSiteId();
    console.log(`[CONFIG] Site ID: ${currentSiteId || 'Not set'}`);

    // Create parallel processing limit
    const limit = pLimit(PERFORMANCE_CONFIG.PARALLEL_CAMERAS);
    console.log(`[PARALLEL] Processing up to ${PERFORMANCE_CONFIG.PARALLEL_CAMERAS} cameras simultaneously`);

    // Process cameras in parallel
    console.log(`[PARALLEL] Starting parallel processing of ${ISS_MEDIA_CAMERAS.length} cameras...`);
    const scanPromises = ISS_MEDIA_CAMERAS.map(cameraId =>
        limit(() => performHistoricalScanForCamera(cameraId))
    );

    await Promise.all(scanPromises);
    console.log(`[PARALLEL] All camera processing completed`);
    
    performanceStats.historicalScan.endTime = new Date();
    const duration = performanceStats.historicalScan.endTime - performanceStats.historicalScan.startTime;
    const durationSeconds = duration / 1000;
    
    performanceStats.historicalScan.averageFilesPerSecond = 
        performanceStats.historicalScan.totalFilesScanned / durationSeconds;

    const scanEstimates = getExpectedFileCounts();
    const completionPercentage = ((performanceStats.historicalScan.totalFilesScanned / scanEstimates.expectedHistorical) * 100).toFixed(1);
    
    console.log('='.repeat(80));
    console.log('[HISTORICAL SCAN COMPLETE] Performance Summary:');
    console.log(`Duration: ${Math.round(durationSeconds)} seconds (${Math.round(durationSeconds/60)} minutes)`);
    console.log(`Total Files Scanned: ${performanceStats.historicalScan.totalFilesScanned.toLocaleString()} (${completionPercentage}% of estimated)`);
    console.log(`Total Files Inserted: ${performanceStats.historicalScan.totalFilesInserted.toLocaleString()}`);
    console.log(`Total Directories: ${performanceStats.historicalScan.totalDirectoriesScanned.toLocaleString()}`);
    console.log(`Processing Speed: ${Math.round(performanceStats.historicalScan.averageFilesPerSecond)} files/second`);
    console.log(`Database Duplicates Skipped: ${performanceStats.database.duplicatesSkipped.toLocaleString()}`);
    console.log(`Cameras Completed: ${performanceStats.historicalScan.camerasCompleted}/${ISS_MEDIA_CAMERAS.length}`);
    console.log(`Database Pool - Total: ${performanceStats.database.connectionPoolStats.totalConnections}, Idle: ${performanceStats.database.connectionPoolStats.idleConnections}`);
    console.log(`Errors: ${performanceStats.historicalScan.errors}`);
    console.log('='.repeat(80));

    // Clean up any duplicate records that might have been inserted (async, non-blocking)
    console.log('[CLEANUP] Starting async duplicate cleanup (non-blocking)...');
    removeDuplicateRecords().then(removedCount => {
        if (removedCount > 0) {
            console.log(`[CLEANUP] Async cleanup completed - removed ${removedCount} duplicates`);
        } else {
            console.log('[CLEANUP] Async cleanup completed - no duplicates found');
        }
    }).catch(error => {
        console.error('[CLEANUP] Async cleanup failed:', error.message);
    });

    isHistoricalScanComplete = true;
}

/**
 * Add file to real-time processing queue
 */
function addToRealtimeQueue(filePath, cameraId) {
    try {
        const fileName = path.basename(filePath);
        const dirName = path.basename(path.dirname(filePath));
        
        const dirInfo = parseDateTimeDirectory(dirName);
        const parsedFile = parseISSVDFilename(fileName);
        
        if (!dirInfo || !parsedFile) {
            console.warn(`[REALTIME] Invalid file format: ${filePath}`);
            return;
        }

        const preciseTime = calculatePreciseTime(
            dirInfo.time,
            parsedFile.offsetMinutes,
            parsedFile.offsetSeconds,
            parsedFile.offsetMs
        );

        const fileData = {
            filePath,
            fileName,
            fileSize: ISS_MEDIA_FILE_SIZE * 1024,
            cameraId: parsedFile.cameraId,
            siteId: currentSiteId,
            date: dirInfo.date,
            time: dirInfo.time,
            timezoneOffset: dirInfo.timezoneOffset,
            preciseTime: preciseTime,
            detectedAt: new Date()
        };

        // Add to queue
        realtimeFileQueue.push(fileData);
        
        // Prevent memory overflow
        if (realtimeFileQueue.length > REALTIME_CONFIG.MAX_QUEUE_SIZE) {
            console.warn(`[REALTIME] Queue size exceeded ${REALTIME_CONFIG.MAX_QUEUE_SIZE}, forcing batch process`);
            setImmediate(processRealtimeBatch);
        }
        
        console.log(`[REALTIME] File queued: ${fileName} (Camera: ${cameraId}) - Queue size: ${realtimeFileQueue.length}`);

    } catch (error) {
        console.error(`[ERROR] Failed to add file to realtime queue ${filePath}:`, error);
        performanceStats.realTimeMonitoring.errors++;
    }
}

/**
 * Process batched real-time files
 */
async function processRealtimeBatch() {
    if (realtimeFileQueue.length === 0) return;
    
    const startTime = Date.now();
    const batchSize = Math.min(realtimeFileQueue.length, REALTIME_CONFIG.BATCH_SIZE);
    const filesToProcess = realtimeFileQueue.splice(0, batchSize);
    
    try {
        console.log(`[REALTIME BATCH] Processing ${filesToProcess.length} files...`);
        
        const result = await bulkInsertFiles(filesToProcess);
        
        if (result.inserted > 0) {
            performanceStats.realTimeMonitoring.filesProcessedToday += result.inserted;
            console.log(`[REALTIME BATCH] Successfully inserted ${result.inserted} files, skipped ${result.duplicates} duplicates`);
            
            // Log sample of inserted files
            const sampleFiles = filesToProcess.slice(0, Math.min(5, filesToProcess.length));
            sampleFiles.forEach(file => {
                console.log(`  └─ ${file.fileName} (Camera: ${file.cameraId}) - ${file.date} ${file.preciseTime}`);
            });
            
            if (filesToProcess.length > 5) {
                console.log(`  └─ ... and ${filesToProcess.length - 5} more files`);
            }
        }

        const processingTime = Date.now() - startTime;
        performanceStats.realTimeMonitoring.averageProcessingTime = 
            (performanceStats.realTimeMonitoring.averageProcessingTime + processingTime) / 2;
        performanceStats.realTimeMonitoring.lastFileTime = new Date();
        
        lastBatchProcessTime = Date.now();

    } catch (error) {
        console.error(`[ERROR] Failed to process realtime batch:`, error);
        performanceStats.realTimeMonitoring.errors++;
        
        // Put files back in queue for retry
        realtimeFileQueue.unshift(...filesToProcess);
    }
}

/**
 * Validate directory structure and provide diagnostic information
 */
async function validateDirectoryStructure() {
    console.log('[VALIDATION] Checking directory structure...');
    
    const todayPatterns = getTodayPatterns();
    let validationSummary = {
        camerasFound: 0,
        todayDirectoriesFound: 0,
        historicalDirectoriesFound: 0,
        sampleFilesFound: 0
    };
    
    for (const cameraId of ISS_MEDIA_CAMERAS) {
        const cameraPath = path.join(ISS_MEDIA_DIR, cameraId);
        
        if (await fs.pathExists(cameraPath)) {
            validationSummary.camerasFound++;
            
            try {
                const items = await fs.readdir(cameraPath, { withFileTypes: true });
                const directories = items.filter(item => item.isDirectory());
                
                // Count today's directories
                const todayDirs = directories.filter(dir => 
                    todayPatterns.todayRegex.test(dir.name)
                );
                validationSummary.todayDirectoriesFound += todayDirs.length;
                
                // Count historical directories
                const historicalDirs = directories.filter(dir => 
                    /^\d{4}-\d{2}-\d{2}T\d{2}\+0300$/.test(dir.name) &&
                    !todayPatterns.todayRegex.test(dir.name)
                );
                validationSummary.historicalDirectoriesFound += historicalDirs.length;
                
                // Check for sample files in first available directory
                if (directories.length > 0) {
                    const sampleDir = path.join(cameraPath, directories[0].name);
                    const sampleFiles = await fs.readdir(sampleDir);
                    const issvdFiles = sampleFiles.filter(file => file.endsWith('.issvd'));
                    validationSummary.sampleFilesFound += issvdFiles.length;
                    
                    if (issvdFiles.length > 0) {
                        console.log(`[VALIDATION] ${cameraId}: Sample directory ${directories[0].name} contains ${issvdFiles.length} .issvd files`);
                        console.log(`[VALIDATION] ${cameraId}: Sample file: ${issvdFiles[0]} to ${issvdFiles[issvdFiles.length-1]}`);
                    }
                }
                
            } catch (error) {
                console.error(`[VALIDATION] Error reading ${cameraId}:`, error.message);
            }
        } else {
            console.warn(`[VALIDATION] Camera directory missing: ${cameraPath}`);
        }
    }
    
    console.log(`[VALIDATION] Found ${validationSummary.camerasFound}/${ISS_MEDIA_CAMERAS.length} camera directories`);
    console.log(`[VALIDATION] Found ${validationSummary.todayDirectoriesFound} today directories (expected: ${ISS_MEDIA_CAMERAS.length * 24})`);
    console.log(`[VALIDATION] Found ${validationSummary.historicalDirectoriesFound} historical directories`);
    console.log(`[VALIDATION] Sample files found: ${validationSummary.sampleFilesFound}`);
    
    return validationSummary;
}

/**
 * Setup chokidar file watching for today's files only
 */
async function setupRealtimeMonitoring() {
    console.log('[REALTIME] Setting up file watchers for today\'s directories...');
    
    // Validate directory structure first
    await validateDirectoryStructure();
    
    const todayPattern = getTodayPatterns();
    performanceStats.realTimeMonitoring.startTime = new Date();

    for (const cameraId of ISS_MEDIA_CAMERAS) {
        const cameraPath = path.join(ISS_MEDIA_DIR, cameraId);
        
        if (!await fs.pathExists(cameraPath)) {
            console.warn(`[WARN] Camera directory not found: ${cameraPath}`);
            continue;
        }

        // Watch all 24 hourly directories for today
        // Pattern: CAM_1/2025-09-09T00+0300/*.issvd through CAM_1/2025-09-09T23+0300/*.issvd
        const watchPatterns = todayPattern.hourlyPatterns.map(hourPattern => 
            path.join(cameraPath, hourPattern, '*.issvd')
        );
        
        console.log(`[REALTIME] Setting up watchers for ${cameraId} - ${watchPatterns.length} hourly directories`);
        console.log(`[REALTIME] Today's pattern: ${todayPattern.basePattern}[00-23]+0300`);
        
        const watcher = chokidar.watch(watchPatterns, {
            persistent: true,
            ignoreInitial: true, // Don't process existing files
            awaitWriteFinish: {
                stabilityThreshold: 2000, // Wait for file to be stable
                pollInterval: 100
            },
            depth: 1 // Watch exactly 1 level deep (hourly directories)
        });

        watcher.on('add', (filePath) => {
            // Add to real-time processing queue
            addToRealtimeQueue(filePath, cameraId);
        });

        watcher.on('error', (error) => {
            console.error(`[ERROR] File watcher error for ${cameraId}:`, error);
            performanceStats.realTimeMonitoring.errors++;
        });

        fileWatchers.set(cameraId, watcher);
        console.log(`[REALTIME] File watcher active for camera: ${cameraId}`);
    }

    isRealTimeMonitoring = true;
    console.log('[REALTIME] All file watchers are active');
}

/**
 * Main execution function
 */
async function runOptimizedMonitoring() {
    console.log('Starting Optimized ISS Media Files Microservice...');
    console.log(`Process ID: ${process.pid}`);
    
    try {
        // Phase 1: Historical scan
        await performHistoricalScan();
        
        // Phase 2: Real-time monitoring
        console.log('[REALTIME] Historical scan complete, starting real-time monitoring setup...');
        await setupRealtimeMonitoring();
        console.log('[REALTIME] Real-time monitoring is now active!');
        
        // Phase 3: Status reporting loop
        let lastStatsReport = Date.now();
        let lastCleanupTime = new Date();
        const STATS_REPORT_INTERVAL = 60000; // Report every minute
        const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // Once per day

        while (true) {
            const now = Date.now();
            
            // Process real-time batch if timeout reached or batch is full
            const timeSinceLastBatch = now - lastBatchProcessTime;
            if (realtimeFileQueue.length > 0 && 
                (realtimeFileQueue.length >= REALTIME_CONFIG.BATCH_SIZE || 
                 timeSinceLastBatch >= REALTIME_CONFIG.BATCH_TIMEOUT)) {
                await processRealtimeBatch();
            }
            
            // Periodic status reporting
            if (now - lastStatsReport >= STATS_REPORT_INTERVAL) {
                updatePoolStats();
                
                console.log(`[STATUS] Realtime files processed today: ${performanceStats.realTimeMonitoring.filesProcessedToday}`);
                console.log(`[STATUS] Real-time queue size: ${realtimeFileQueue.length}`);
                console.log(`[STATUS] Average batch processing time: ${Math.round(performanceStats.realTimeMonitoring.averageProcessingTime)}ms`);
                console.log(`[STATUS] Last file processed: ${performanceStats.realTimeMonitoring.lastFileTime || 'None'}`);
                console.log(`[STATUS] DB Pool - Active: ${performanceStats.database.connectionPoolStats.totalConnections - performanceStats.database.connectionPoolStats.idleConnections}/${performanceStats.database.connectionPoolStats.totalConnections}`);
                
                // Update Redis status with queue info
                const statusWithQueue = {
                    ...performanceStats,
                    realTimeQueue: {
                        size: realtimeFileQueue.length,
                        lastBatchTime: lastBatchProcessTime,
                        batchConfig: REALTIME_CONFIG
                    }
                };
                await redis.set(MEDIA_INDEX_STATUS, JSON.stringify(statusWithQueue));
                await redis.publish(MEDIA_INDEX_UPDATE, JSON.stringify(statusWithQueue));
                
                lastStatsReport = now;
            }
            
            // Check for site ID changes
            const newSiteId = await getCurrentSiteId();
            if (newSiteId !== currentSiteId) {
                console.log(`[UPDATE] Site ID changed from '${currentSiteId}' to '${newSiteId}'`);
                currentSiteId = newSiteId;
            }
            
            // Daily cleanup
            const timeSinceLastCleanup = now - lastCleanupTime.getTime();
            if (timeSinceLastCleanup >= CLEANUP_INTERVAL) {
                console.log('[CLEANUP] Running daily duplicate cleanup...');
                // await removeDuplicateRecords();
                lastCleanupTime = new Date();
            }
            
            await sleep(2000); // Check every 2 seconds for more responsive batch processing
        }

    } catch (error) {
        console.error('[FATAL ERROR] Monitoring failed:', error);
        process.exit(1);
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('[SHUTDOWN] Shutting down optimized media indexing microservice...');
    
    // Close file watchers
    for (const [cameraId, watcher] of fileWatchers) {
        await watcher.close();
        console.log(`[SHUTDOWN] Closed watcher for ${cameraId}`);
    }
    
    // Process any remaining files in queue before shutdown
    if (realtimeFileQueue.length > 0) {
        console.log(`[SHUTDOWN] Processing final ${realtimeFileQueue.length} files in queue...`);
        await processRealtimeBatch();
    }
    
    // Close connections
    await redis.quit();
    await pool.end();
    
    console.log('[SHUTDOWN] Final Statistics:');
    console.log(`[SHUTDOWN] Historical files scanned: ${performanceStats.historicalScan.totalFilesScanned.toLocaleString()}`);
    console.log(`[SHUTDOWN] Historical files inserted: ${performanceStats.historicalScan.totalFilesInserted.toLocaleString()}`);
    console.log(`[SHUTDOWN] Today's files processed: ${performanceStats.realTimeMonitoring.filesProcessedToday}`);
    console.log(`[SHUTDOWN] Final queue size: ${realtimeFileQueue.length}`);
    console.log(`[SHUTDOWN] Total directories scanned: ${performanceStats.historicalScan.totalDirectoriesScanned}`);
    console.log(`[SHUTDOWN] Database duplicates skipped: ${performanceStats.database.duplicatesSkipped.toLocaleString()}`);
    console.log('[SHUTDOWN] Cleanup complete');
    process.exit(0);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('[UNCAUGHT EXCEPTION]', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION] at:', promise, 'reason:', reason);
    process.exit(1);
});

// Start the monitoring
runOptimizedMonitoring();

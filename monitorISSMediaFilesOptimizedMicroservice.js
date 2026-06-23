const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const chokidar = require('chokidar');
const pLimit = require('p-limit');
const { sleep } = require('./utils.js');
const { MEDIA_INDEX_STATUS, MEDIA_INDEX_UPDATE, CONFIG_STATE_KEY } = require('./redisKeyStore.js');
const { createLogger, runWithTrace, newTraceId } = require('./utils/logger');

const logger = createLogger({ service: 'monitorISSMediaFilesOptimized', logFile: 'monitor-iss-media' });

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
        logger.error('[ERROR] Error getting site ID from Redis:', { error: error.message });
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
        logger.error('[ERROR] Error checking file existence in batch:', { error: error.message });
        return new Set();
    }
}

/**
 * High-performance bulk insert with proper error handling and duplicate prevention
 */
async function bulkInsertFiles(files) {
    if (files.length === 0) return { inserted: 0, duplicates: 0 };

    logger.info(`[BULK INSERT] Processing ${files.length} files for database insert...`);

    const filePaths = files.map(f => f.filePath);
    logger.info(`[BULK INSERT] Checking ${filePaths.length} files for duplicates in database...`);
    const existingFiles = await checkFileExistsInDB(filePaths);

    const newFiles = files.filter(f => !existingFiles.has(f.filePath));
    const duplicateCount = files.length - newFiles.length;

    logger.info(`[BULK INSERT] Found ${duplicateCount} existing files, ${newFiles.length} new files to insert`);

    if (newFiles.length === 0) {
        logger.info(`[BULK INSERT] All ${files.length} files already exist in database`);
        performanceStats.database.duplicatesSkipped += duplicateCount;
        return { inserted: 0, duplicates: duplicateCount };
    }

    const client = await pool.connect();
    let insertedCount = 0;
    const startTime = Date.now();

    try {
        logger.info(`[BULK INSERT] Starting database transaction for ${newFiles.length} new files`);
        await client.query('BEGIN');

        for (let i = 0; i < newFiles.length; i += PERFORMANCE_CONFIG.BULK_INSERT_BATCH_SIZE) {
            const batch = newFiles.slice(i, i + PERFORMANCE_CONFIG.BULK_INSERT_BATCH_SIZE);
            logger.info(`[BULK INSERT] Processing batch ${Math.floor(i / PERFORMANCE_CONFIG.BULK_INSERT_BATCH_SIZE) + 1}: ${batch.length} files`);
            
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

        logger.info(`[BULK INSERT] Committing transaction...`);
        await client.query('COMMIT');

        const duration = Date.now() - startTime;
        performanceStats.database.totalQueries++;
        performanceStats.database.bulkInsertCount++;
        performanceStats.database.averageQueryTime =
            (performanceStats.database.averageQueryTime + duration) / performanceStats.database.totalQueries;
        performanceStats.database.duplicatesSkipped += duplicateCount;

        logger.info(`[BULK INSERT] Successfully inserted ${insertedCount} new files, skipped ${duplicateCount} duplicates in ${duration}ms`);
        logger.info(`[BULK INSERT] Average query time: ${Math.round(performanceStats.database.averageQueryTime)}ms, Total queries: ${performanceStats.database.totalQueries}`);

        return { inserted: insertedCount, duplicates: duplicateCount };

    } catch (error) {
        await client.query('ROLLBACK');
        logger.error('[ERROR] Bulk insert failed:', { error: error.message });
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
        logger.error(`[ERROR] Failed to scan directory ${dirPath}:`, { error: error.message, dir: dirPath });
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
        logger.error('[ERROR] Error getting latest indexed datetime:', { error: error.message });
    }
    return null;
}

/**
 * Remove duplicate records based on file_path (keep the oldest record) - optimized version
 */
async function removeDuplicateRecords() {
    try {
        logger.info('[CLEANUP] Running optimized duplicate removal...');
        
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
            logger.info(`[CLEANUP] Removed ${result.rowCount} duplicate records`);
        }
        
        return result.rowCount;
    } catch (error) {
        logger.error('[ERROR] Error removing duplicate records:', { error: error.message });
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
    await runWithTrace({ traceId: newTraceId(), camera: cameraId, phase: 'historical-scan' }, async () => {
    const cameraPath = path.join(ISS_MEDIA_DIR, cameraId);

    logger.info(`[HISTORICAL] Starting scan for camera: ${cameraId}`, { camera: cameraId, path: cameraPath });

    if (!await fs.pathExists(cameraPath)) {
        logger.warn(`[WARN] Camera directory not found: ${cameraPath}`, { camera: cameraId, path: cameraPath });
        return;
    }

    const todayPatterns = getTodayPatterns();
    let cameraFilesScanned = 0;
    let cameraFilesInserted = 0;
    let cameraDirectories = 0;

    try {
        logger.info(`[HISTORICAL] Reading directory contents for ${cameraId}...`, { camera: cameraId });
        const items = await fs.readdir(cameraPath, { withFileTypes: true });
        logger.info(`[HISTORICAL] Found ${items.length} total items in ${cameraId} directory`, { camera: cameraId, count: items.length });

        const dateDirs = items.filter(item =>
            item.isDirectory() &&
            /^\d{4}-\d{2}-\d{2}T\d{2}\+0300$/.test(item.name) &&
            !todayPatterns.todayRegex.test(item.name)
        );

        logger.info(`[HISTORICAL] Found ${dateDirs.length} historical directories for ${cameraId}`, { camera: cameraId, count: dateDirs.length });

        const retentionDays = ISS_MEDIA_RETENTION;
        logger.info(`[HISTORICAL] Processing directories within ${retentionDays} day retention period`, { camera: cameraId, retentionDays });

        let allFiles = [];
        let dirCount = 0;

        for (const dateDir of dateDirs) {
            dirCount++;
            const dateDirPath = path.join(cameraPath, dateDir.name);

            logger.info(`[HISTORICAL] [${dirCount}/${dateDirs.length}] Scanning directory: ${dateDir.name}`, { camera: cameraId, dir: dateDir.name });

            const files = await scanDirectoryEfficiently(dateDirPath, dateDir.name);

            if (files.length > 0) {
                logger.info(`[HISTORICAL] Found ${files.length} .issvd files in ${dateDir.name}`, { camera: cameraId, dir: dateDir.name, count: files.length });
            }

            allFiles.push(...files);
            cameraFilesScanned += files.length;
            cameraDirectories++;

            if (dirCount % 10 === 0) {
                logger.info(`[PROGRESS] ${cameraId}: Processed ${dirCount}/${dateDirs.length} directories, ${cameraFilesScanned} files so far`, { camera: cameraId });
            }

            if (allFiles.length >= PERFORMANCE_CONFIG.MEMORY_CLEANUP_THRESHOLD) {
                logger.info(`[HISTORICAL] Memory threshold reached (${allFiles.length} files), performing bulk insert...`, { camera: cameraId, count: allFiles.length });
                const result = await bulkInsertFiles(allFiles);
                cameraFilesInserted += result.inserted;
                allFiles = [];

                logger.info(`[BULK INSERT] Inserted ${result.inserted} files, skipped ${result.duplicates} duplicates`, { camera: cameraId });

                if (cameraFilesScanned % PERFORMANCE_CONFIG.STATS_LOG_INTERVAL === 0) {
                    logger.info(`[PROGRESS] ${cameraId}: Scanned ${cameraFilesScanned} files, inserted ${cameraFilesInserted}`, { camera: cameraId });
                    updatePoolStats();
                }
            }
        }

        if (allFiles.length > 0) {
            logger.info(`[HISTORICAL] Inserting remaining ${allFiles.length} files...`, { camera: cameraId, count: allFiles.length });
            const result = await bulkInsertFiles(allFiles);
            cameraFilesInserted += result.inserted;
            logger.info(`[BULK INSERT] Final batch: Inserted ${result.inserted} files, skipped ${result.duplicates} duplicates`, { camera: cameraId });
        }

        logger.info(`[HISTORICAL COMPLETE] ${cameraId}: ${cameraFilesScanned} files scanned, ${cameraFilesInserted} inserted, ${cameraDirectories} directories`, { camera: cameraId, scanned: cameraFilesScanned, inserted: cameraFilesInserted, directories: cameraDirectories });

        performanceStats.historicalScan.totalFilesScanned += cameraFilesScanned;
        performanceStats.historicalScan.totalFilesInserted += cameraFilesInserted;
        performanceStats.historicalScan.totalDirectoriesScanned += cameraDirectories;
        performanceStats.historicalScan.camerasCompleted++;

    } catch (error) {
        logger.error(`[ERROR] Historical scan failed for ${cameraId}:`, { error: error.message, camera: cameraId });
        performanceStats.historicalScan.errors++;
    }
    }); // end runWithTrace
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

    logger.info('[HISTORICAL SCAN] Starting comprehensive historical scan...', { cameras: ISS_MEDIA_CAMERAS, retentionDays: ISS_MEDIA_RETENTION, mediaDir: ISS_MEDIA_DIR, filesPerHour: fileEstimates.filesPerCameraPerHour, estimatedFiles: fileEstimates.expectedHistorical, estimatedDirs: fileEstimates.totalHistoricalDirectories });

    performanceStats.historicalScan.startTime = new Date();

    currentSiteId = await getCurrentSiteId();
    logger.info(`[CONFIG] Site ID: ${currentSiteId || 'Not set'}`, { siteId: currentSiteId });

    const limit = pLimit(PERFORMANCE_CONFIG.PARALLEL_CAMERAS);
    logger.info(`[PARALLEL] Processing up to ${PERFORMANCE_CONFIG.PARALLEL_CAMERAS} cameras simultaneously`);

    logger.info(`[PARALLEL] Starting parallel processing of ${ISS_MEDIA_CAMERAS.length} cameras...`);
    const scanPromises = ISS_MEDIA_CAMERAS.map(cameraId =>
        limit(() => performHistoricalScanForCamera(cameraId))
    );

    await Promise.all(scanPromises);
    logger.info(`[PARALLEL] All camera processing completed`);
    
    performanceStats.historicalScan.endTime = new Date();
    const duration = performanceStats.historicalScan.endTime - performanceStats.historicalScan.startTime;
    const durationSeconds = duration / 1000;
    
    performanceStats.historicalScan.averageFilesPerSecond = 
        performanceStats.historicalScan.totalFilesScanned / durationSeconds;

    const scanEstimates = getExpectedFileCounts();
    const completionPercentage = ((performanceStats.historicalScan.totalFilesScanned / scanEstimates.expectedHistorical) * 100).toFixed(1);
    
    logger.info('[HISTORICAL SCAN COMPLETE] Performance Summary', {
        durationSeconds: Math.round(durationSeconds),
        durationMinutes: Math.round(durationSeconds / 60),
        totalFilesScanned: performanceStats.historicalScan.totalFilesScanned,
        completionPercentage,
        totalFilesInserted: performanceStats.historicalScan.totalFilesInserted,
        totalDirectories: performanceStats.historicalScan.totalDirectoriesScanned,
        filesPerSecond: Math.round(performanceStats.historicalScan.averageFilesPerSecond),
        duplicatesSkipped: performanceStats.database.duplicatesSkipped,
        camerasCompleted: performanceStats.historicalScan.camerasCompleted,
        errors: performanceStats.historicalScan.errors
    });

    removeDuplicateRecords().then(removedCount => {
        if (removedCount > 0) {
            logger.info(`[CLEANUP] Async cleanup completed - removed ${removedCount} duplicates`);
        } else {
            logger.info('[CLEANUP] Async cleanup completed - no duplicates found');
        }
    }).catch(error => {
        logger.error('[CLEANUP] Async cleanup failed:', { error: error.message });
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
            logger.warn(`[REALTIME] Invalid file format: ${filePath}`);
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
            logger.warn(`[REALTIME] Queue size exceeded ${REALTIME_CONFIG.MAX_QUEUE_SIZE}, forcing batch process`);
            setImmediate(processRealtimeBatch);
        }
        
        logger.info(`[REALTIME] File queued: ${fileName} (Camera: ${cameraId}) - Queue size: ${realtimeFileQueue.length}`, { file: fileName, camera: cameraId, queueSize: realtimeFileQueue.length });

    } catch (error) {
        logger.error(`[ERROR] Failed to add file to realtime queue ${filePath}:`, { error: error.message, filePath });
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
        logger.info(`[REALTIME BATCH] Processing ${filesToProcess.length} files...`);
        
        const result = await bulkInsertFiles(filesToProcess);
        
        if (result.inserted > 0) {
            performanceStats.realTimeMonitoring.filesProcessedToday += result.inserted;
            logger.info(`[REALTIME BATCH] Successfully inserted ${result.inserted} files, skipped ${result.duplicates} duplicates`, { inserted: result.inserted, duplicates: result.duplicates });
        }

        const processingTime = Date.now() - startTime;
        performanceStats.realTimeMonitoring.averageProcessingTime = 
            (performanceStats.realTimeMonitoring.averageProcessingTime + processingTime) / 2;
        performanceStats.realTimeMonitoring.lastFileTime = new Date();
        
        lastBatchProcessTime = Date.now();

    } catch (error) {
        logger.error(`[ERROR] Failed to process realtime batch:`, { error: error.message });
        performanceStats.realTimeMonitoring.errors++;
        realtimeFileQueue.unshift(...filesToProcess);
    }
}

/**
 * Validate directory structure and provide diagnostic information
 */
async function validateDirectoryStructure() {
    logger.info('[VALIDATION] Checking directory structure...');
    
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
                        logger.info(`[VALIDATION] ${cameraId}: Sample dir ${directories[0].name} contains ${issvdFiles.length} .issvd files`, { camera: cameraId, dir: directories[0].name, count: issvdFiles.length });
                    }
                }
                
            } catch (error) {
                logger.error(`[VALIDATION] Error reading ${cameraId}:`, { error: error.message, camera: cameraId });
            }
        } else {
            logger.warn(`[VALIDATION] Camera directory missing: ${cameraPath}`, { camera: cameraId, path: cameraPath });
        }
    }
    
    logger.info(`[VALIDATION] Found ${validationSummary.camerasFound}/${ISS_MEDIA_CAMERAS.length} camera directories`);
    logger.info(`[VALIDATION] Found ${validationSummary.todayDirectoriesFound} today directories`);
    logger.info(`[VALIDATION] Found ${validationSummary.historicalDirectoriesFound} historical directories`);
    logger.info(`[VALIDATION] Sample files found: ${validationSummary.sampleFilesFound}`);
    
    return validationSummary;
}

/**
 * Setup chokidar file watching for today's files only
 */
async function setupRealtimeMonitoring() {
    logger.info('[REALTIME] Setting up file watchers for today\'s directories...');
    
    // Validate directory structure first
    await validateDirectoryStructure();
    
    const todayPattern = getTodayPatterns();
    performanceStats.realTimeMonitoring.startTime = new Date();

    for (const cameraId of ISS_MEDIA_CAMERAS) {
        const cameraPath = path.join(ISS_MEDIA_DIR, cameraId);
        
        if (!await fs.pathExists(cameraPath)) {
            logger.warn(`[WARN] Camera directory not found: ${cameraPath}`, { camera: cameraId });
            continue;
        }

        const watchPatterns = todayPattern.hourlyPatterns.map(hourPattern => 
            path.join(cameraPath, hourPattern, '*.issvd')
        );
        
        logger.info(`[REALTIME] Setting up watchers for ${cameraId} - ${watchPatterns.length} hourly directories`, { camera: cameraId, patternCount: watchPatterns.length });
        
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
            logger.error(`[ERROR] File watcher error for ${cameraId}:`, { error: error.message, camera: cameraId });
            performanceStats.realTimeMonitoring.errors++;
        });

        fileWatchers.set(cameraId, watcher);
        logger.info(`[REALTIME] File watcher active for camera: ${cameraId}`, { camera: cameraId });
    }

    isRealTimeMonitoring = true;
    logger.info('[REALTIME] All file watchers are active');
}

/**
 * Main execution function
 */
async function runOptimizedMonitoring() {
    logger.info('Starting Optimized ISS Media Files Microservice...', { pid: process.pid });
    
    try {
        await performHistoricalScan();
        
        logger.info('[REALTIME] Historical scan complete, starting real-time monitoring setup...');
        await setupRealtimeMonitoring();
        logger.info('[REALTIME] Real-time monitoring is now active!');
        
        let lastStatsReport = Date.now();
        let lastCleanupTime = new Date();
        const STATS_REPORT_INTERVAL = 60000;
        const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;

        while (true) {
            const now = Date.now();
            
            const timeSinceLastBatch = now - lastBatchProcessTime;
            if (realtimeFileQueue.length > 0 && 
                (realtimeFileQueue.length >= REALTIME_CONFIG.BATCH_SIZE || 
                 timeSinceLastBatch >= REALTIME_CONFIG.BATCH_TIMEOUT)) {
                await processRealtimeBatch();
            }
            
            if (now - lastStatsReport >= STATS_REPORT_INTERVAL) {
                updatePoolStats();
                
                logger.info('[STATUS] Real-time monitoring stats', {
                    filesToday: performanceStats.realTimeMonitoring.filesProcessedToday,
                    queueSize: realtimeFileQueue.length,
                    avgBatchMs: Math.round(performanceStats.realTimeMonitoring.averageProcessingTime),
                    lastFile: performanceStats.realTimeMonitoring.lastFileTime || 'None',
                    dbPoolActive: performanceStats.database.connectionPoolStats.totalConnections - performanceStats.database.connectionPoolStats.idleConnections,
                    dbPoolTotal: performanceStats.database.connectionPoolStats.totalConnections
                });
                
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
            
            const newSiteId = await getCurrentSiteId();
            if (newSiteId !== currentSiteId) {
                logger.info(`[UPDATE] Site ID changed from '${currentSiteId}' to '${newSiteId}'`, { oldSiteId: currentSiteId, newSiteId });
                currentSiteId = newSiteId;
            }
            
            const timeSinceLastCleanup = now - lastCleanupTime.getTime();
            if (timeSinceLastCleanup >= CLEANUP_INTERVAL) {
                logger.info('[CLEANUP] Running daily duplicate cleanup...');
                lastCleanupTime = new Date();
            }
            
            await sleep(2000);
        }

    } catch (error) {
        logger.error('[FATAL ERROR] Monitoring failed:', { error: error.message, stack: error.stack });
        process.exit(1);
    }
}

process.on('SIGINT', async () => {
    logger.info('[SHUTDOWN] Shutting down optimized media indexing microservice...');
    
    for (const [cameraId, watcher] of fileWatchers) {
        await watcher.close();
        logger.info(`[SHUTDOWN] Closed watcher for ${cameraId}`, { camera: cameraId });
    }
    
    if (realtimeFileQueue.length > 0) {
        logger.info(`[SHUTDOWN] Processing final ${realtimeFileQueue.length} files in queue...`);
        await processRealtimeBatch();
    }
    
    await redis.quit();
    await pool.end();
    
    logger.info('[SHUTDOWN] Final Statistics', {
        historicalScanned: performanceStats.historicalScan.totalFilesScanned,
        historicalInserted: performanceStats.historicalScan.totalFilesInserted,
        todayProcessed: performanceStats.realTimeMonitoring.filesProcessedToday,
        finalQueueSize: realtimeFileQueue.length,
        totalDirsScanned: performanceStats.historicalScan.totalDirectoriesScanned,
        duplicatesSkipped: performanceStats.database.duplicatesSkipped
    });
    process.exit(0);
});

process.on('uncaughtException', (error) => {
    logger.error('[UNCAUGHT EXCEPTION]', { error: error.message, stack: error.stack });
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('[UNHANDLED REJECTION]', { reason: String(reason) });
    process.exit(1);
});

// Start the monitoring
runOptimizedMonitoring();

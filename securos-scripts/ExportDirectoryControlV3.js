const {Pool} = require("pg");
const fs = require('fs-extra');
const securos = require('securos');
const path = require('path');

console.log('\r\n');

let DB_USER = "postgres";
let DB_PASSWORD = "postgres";
let DB_HOST = "localhost";
let DB_APP = "tahakom_transfer";
let ROOT_DIR = 'D:\\ISS\\SA\\6_Tahakom\\TahakomDataTransfer2026\\VideoTransferApp\\VideoTransferApp\\app';
let PRESERVE_ROOT_DIRS = ["C:\\export"]; // Directories to never delete

const CONFIG_FILE_PATH = path.join(ROOT_DIR, 'data_transfer_v2', 'dataTransferConfig.json');
let REMOVE_FIFO_WHEN_STORAGE_IS = "20 GB";
let RETENTION_DAYS = 7;
let BATCH_SIZE = 100;
let MAX_BATCHES_PER_CYCLE = 50;
let CLEANUP_EMPTY_DIRS = true; // Enable/disable directory cleanup

// Load configuration
function loadConfig() {
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
        if (config && config.storage && config.storage.maxCapacity) {
            REMOVE_FIFO_WHEN_STORAGE_IS = `${config.storage.maxCapacity} GB`;
            console.log(`Loaded storage max capacity: ${REMOVE_FIFO_WHEN_STORAGE_IS}`);
        } else {
            console.warn('Using default storage capacity: 20 GB');
        }
        
        if (config && config.storage && config.storage.retentionDays) {
            RETENTION_DAYS = config.storage.retentionDays;
            console.log(`Loaded retention days: ${RETENTION_DAYS}`);
        } else {
            console.log(`Using default retention: ${RETENTION_DAYS} days`);
        }
        
        if (config && config.processing) {
            BATCH_SIZE = config.processing.batchSize || BATCH_SIZE;
            MAX_BATCHES_PER_CYCLE = config.processing.maxBatchesPerCycle || MAX_BATCHES_PER_CYCLE;
            CLEANUP_EMPTY_DIRS = config.processing.cleanupEmptyDirectories !== false;
        }
        
        if (config && config.storage && config.storage.preserveRootDirs) {
            PRESERVE_ROOT_DIRS = config.storage.preserveRootDirs;
        }
    } catch (error) {
        console.error('Error reading config:', error);
    }
}

// Load initial configuration
loadConfig();

const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD
});

// Function to convert human-readable size to bytes
function convertToBytes(size) {
    const units = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const regex = /^(\d+(?:\.\d+)?)\s*(Bytes|KB|MB|GB|TB|PB)$/;
    const match = size.match(regex);
    
    if (!match) throw new Error("Invalid size format");
    
    const value = parseFloat(match[1]);
    const unitIndex = units.indexOf(match[2]);
    
    return value * Math.pow(1024, unitIndex);
}

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';

    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = (bytes / Math.pow(1024, i)).toFixed(2);

    return `${value} ${sizes[i]}`;
}

// Check if directory is empty
function isDirectoryEmpty(dirPath) {
    try {
        const files = fs.readdirSync(dirPath);
        return files.length === 0;
    } catch (error) {
        return false;
    }
}

// Check if a path should be preserved
function shouldPreservePath(dirPath) {
    const normalizedPath = path.normalize(dirPath).toLowerCase();
    for (const preservePath of PRESERVE_ROOT_DIRS) {
        const normalizedPreserve = path.normalize(preservePath).toLowerCase();
        if (normalizedPath === normalizedPreserve || normalizedPath.startsWith(normalizedPreserve + path.sep)) {
            // Check if this is exactly the preserve path
            if (normalizedPath === normalizedPreserve) {
                return true;
            }
        }
    }
    return false;
}

// Recursively remove empty directories up the tree
function removeEmptyDirectoriesUpward(dirPath, maxLevels = 4) {
    let currentPath = path.normalize(dirPath);
    let levelsChecked = 0;
    const removedDirs = [];
    
    while (levelsChecked < maxLevels) {
        // Don't delete preserved directories
        if (shouldPreservePath(currentPath)) {
            break;
        }
        
        // Check if directory exists and is empty
        if (!fs.existsSync(currentPath)) {
            break;
        }
        
        if (isDirectoryEmpty(currentPath)) {
            try {
                fs.rmdirSync(currentPath);
                removedDirs.push(currentPath);
                // Move to parent directory
                const parentPath = path.dirname(currentPath);
                if (parentPath === currentPath) {
                    // Reached root
                    break;
                }
                currentPath = parentPath;
                levelsChecked++;
            } catch (error) {
                // Directory might not be empty or other error
                break;
            }
        } else {
            // Directory is not empty, stop here
            break;
        }
    }
    
    return removedDirs;
}

// Clean up empty directories from a set of file paths
function cleanupEmptyDirectories(filePaths) {
    if (!CLEANUP_EMPTY_DIRS || !filePaths || filePaths.length === 0) {
        return { totalRemoved: 0, uniqueDirsRemoved: 0 };
    }
    
    // Get unique directories from file paths
    const uniqueDirectories = new Set();
    for (const filePath of filePaths) {
        const dir = path.dirname(filePath);
        uniqueDirectories.add(dir);
    }
    
    const allRemovedDirs = new Set();
    
    // Check each unique directory
    for (const dir of uniqueDirectories) {
        const removed = removeEmptyDirectoriesUpward(dir);
        removed.forEach(d => allRemovedDirs.add(d));
    }
    
    return {
        totalRemoved: allRemovedDirs.size,
        uniqueDirsRemoved: allRemovedDirs.size
    };
}

// Atomic batch deletion function with directory cleanup
async function deleteFileBatch(fileIds, client) {
    const successfullyDeleted = [];
    const failedDeletions = [];
    const deletedFilePaths = [];
    let totalFreedSize = 0;

    try {
        // First, mark files as pending deletion in the database (within transaction)
        const markPendingQuery = `
            UPDATE files 
            SET pending_deletion = true 
            WHERE id = ANY($1::int[])
            RETURNING id, file_path, file_size
        `;
        const pendingResult = await client.query(markPendingQuery, [fileIds]);
        const filesToDelete = pendingResult.rows;

        // Try to delete physical files
        for (const file of filesToDelete) {
            try {
                if (fs.existsSync(file.file_path)) {
                    fs.unlinkSync(file.file_path);
                    successfullyDeleted.push(file.id);
                    deletedFilePaths.push(file.file_path);
                    totalFreedSize += file.file_size;
                } else {
                    // File doesn't exist, mark as deleted anyway
                    successfullyDeleted.push(file.id);
                    deletedFilePaths.push(file.file_path);
                    totalFreedSize += file.file_size;
                }
            } catch (fsError) {
                console.error(`Failed to delete file ${file.file_path}:`, fsError.message);
                failedDeletions.push(file.id);
            }
        }

        // Clean up empty directories
        const dirCleanupResult = cleanupEmptyDirectories(deletedFilePaths);

        // Update database for successfully deleted files
        if (successfullyDeleted.length > 0) {
            const markDeletedQuery = `
                UPDATE files 
                SET deleted = true, 
                    deleted_date_time = $1,
                    pending_deletion = false
                WHERE id = ANY($2::int[])
            `;
            await client.query(markDeletedQuery, [new Date(), successfullyDeleted]);
        }

        // Reset pending_deletion flag for failed files
        if (failedDeletions.length > 0) {
            const resetPendingQuery = `
                UPDATE files 
                SET pending_deletion = false 
                WHERE id = ANY($1::int[])
            `;
            await client.query(resetPendingQuery, [failedDeletions]);
        }

        return {
            successCount: successfullyDeleted.length,
            failCount: failedDeletions.length,
            freedSize: totalFreedSize,
            dirsRemoved: dirCleanupResult.uniqueDirsRemoved
        };

    } catch (error) {
        // On any error, reset pending_deletion for all files in batch
        const resetAllQuery = `
            UPDATE files 
            SET pending_deletion = false 
            WHERE id = ANY($1::int[])
        `;
        await client.query(resetAllQuery, [fileIds]);
        throw error;
    }
}

// Get file system size
async function getFileSystemSize() {
    const client = await pool.connect();
    let res;

    try {
        const query = `
            SELECT 
                SUM(file_size) AS total_size_bytes 
            FROM files WHERE deleted = false AND pending_deletion = false;
        `;
        res = await client.query(query, []);
        let result = res.rows[0].total_size_bytes;
        
        let fileSystemSize = result ? formatFileSize(result) : "0KB";

        return {
            fileSystemSize
        }
    } catch (e) {
        throw e;
    } finally {
        client.release();
    }
}

// Get average file size
async function getAverageFileSize() {
    const client = await pool.connect();
    let res;

    try {
        const query = `
            SELECT 
                AVG(file_size) AS avg_file_size_bytes 
            FROM files WHERE deleted = false AND pending_deletion = false;
        `;
        res = await client.query(query, []);
        let avgFileSize = res.rows[0].avg_file_size_bytes;

        return avgFileSize ? avgFileSize : 0;
    } catch (e) {
        throw e;
    } finally {
        client.release();
    }
}

// Delete files older than retention period with atomic transactions
async function deleteOldFilesByRetention() {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // Calculate the cutoff date
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - RETENTION_DAYS);
        
        console.log(`Checking for files older than ${RETENTION_DAYS} days (before ${cutoffDate.toISOString()})...`);

        // Get count of files to delete
        const countQuery = `
            SELECT COUNT(*) as total_count
            FROM files 
            WHERE deleted = false
                AND pending_deletion = false
                AND (date + time::interval) < $1
        `;
        
        const countResult = await client.query(countQuery, [cutoffDate]);
        const totalFiles = parseInt(countResult.rows[0].total_count);
        
        if (totalFiles === 0) {
            console.log(`No files found older than ${RETENTION_DAYS} days.`);
            await client.query('COMMIT');
            return 0;
        }
        
        console.log(`Found ${totalFiles} files older than ${RETENTION_DAYS} days.`);
        console.log(`Processing in batches of ${BATCH_SIZE}, max ${MAX_BATCHES_PER_CYCLE} batches per cycle...`);

        let totalFreedSize = 0;
        let totalDeletedCount = 0;
        let totalDirsRemoved = 0;
        let batchesProcessed = 0;

        // Process in batches
        while (batchesProcessed < MAX_BATCHES_PER_CYCLE) {
            // Get next batch of files to delete
            const selectBatchQuery = `
                SELECT id
                FROM files 
                WHERE deleted = false
                    AND pending_deletion = false
                    AND (date + time::interval) < $1
                ORDER BY (date + time::interval) ASC
                LIMIT $2
            `;
            
            const batchResult = await client.query(selectBatchQuery, [cutoffDate, BATCH_SIZE]);
            
            if (batchResult.rows.length === 0) {
                break; // No more files to process
            }

            const fileIds = batchResult.rows.map(row => row.id);
            
            // Delete this batch atomically
            const result = await deleteFileBatch(fileIds, client);
            
            totalFreedSize += result.freedSize;
            totalDeletedCount += result.successCount;
            totalDirsRemoved += result.dirsRemoved;
            batchesProcessed++;

            // Progress update every 10 batches
            if (batchesProcessed % 10 === 0) {
                console.log(`Progress: Processed ${batchesProcessed} batches, deleted ${totalDeletedCount} files, removed ${totalDirsRemoved} empty dirs, freed ${formatFileSize(totalFreedSize)}`);
            }
        }

        await client.query('COMMIT');
        
        console.log(`Retention cleanup: Deleted ${totalDeletedCount} files in ${batchesProcessed} batches, removed ${totalDirsRemoved} empty directories, freed ${formatFileSize(totalFreedSize)}`);
        
        if (totalFiles - totalDeletedCount > 0) {
            console.log(`Note: ${totalFiles - totalDeletedCount} files remaining for next cycle`);
        }
        
        return totalFreedSize;
        
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Error during retention cleanup:", e);
        return 0;
    } finally {
        client.release();
    }
}

// Delete files based on storage capacity with atomic transactions
async function deleteOldFilesByCapacity() {
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        // Get the total current size of files in the system
        let totalSize = await getFileSystemSize();
        
        // Define the storage threshold
        let REMOVE_FIFO_WHEN_STORAGE_IS_BYTES = convertToBytes(REMOVE_FIFO_WHEN_STORAGE_IS);
        totalSize = convertToBytes(totalSize.fileSystemSize);
        
        // Calculate how much we need to free
        let sizeToFree = totalSize - REMOVE_FIFO_WHEN_STORAGE_IS_BYTES;

        if (sizeToFree <= 0) {
            console.log("Storage size is within the limit. No capacity-based deletion needed.");
            await client.query('COMMIT');
            return;
        }

        console.log(`Size ${formatFileSize(totalSize)} exceeds limit. Need to free ${formatFileSize(sizeToFree)} to reach ${REMOVE_FIFO_WHEN_STORAGE_IS}`);

        let totalFreedSize = 0;
        let totalDeletedCount = 0;
        let totalDirsRemoved = 0;
        let batchesProcessed = 0;

        // Process in batches until we free enough space or hit batch limit
        while (totalFreedSize < sizeToFree && batchesProcessed < MAX_BATCHES_PER_CYCLE) {
            // Get next batch of oldest files
            const selectBatchQuery = `
                SELECT id
                FROM files 
                WHERE deleted = false
                    AND pending_deletion = false
                ORDER BY (date + time::interval) ASC
                LIMIT $1
            `;
            
            const batchResult = await client.query(selectBatchQuery, [BATCH_SIZE]);
            
            if (batchResult.rows.length === 0) {
                break; // No more files to process
            }

            const fileIds = batchResult.rows.map(row => row.id);
            
            // Delete this batch atomically
            const result = await deleteFileBatch(fileIds, client);
            
            totalFreedSize += result.freedSize;
            totalDeletedCount += result.successCount;
            totalDirsRemoved += result.dirsRemoved;
            batchesProcessed++;

            // Progress update
            if (batchesProcessed % 10 === 0) {
                console.log(`Progress: Processed ${batchesProcessed} batches, freed ${formatFileSize(totalFreedSize)} of ${formatFileSize(sizeToFree)} needed, removed ${totalDirsRemoved} empty dirs`);
            }
        }

        await client.query('COMMIT');
        
        console.log(`Capacity cleanup: Deleted ${totalDeletedCount} files in ${batchesProcessed} batches, removed ${totalDirsRemoved} empty directories, freed ${formatFileSize(totalFreedSize)}`);
        
        if (totalFreedSize < sizeToFree) {
            console.log(`Note: Still need to free ${formatFileSize(sizeToFree - totalFreedSize)} in next cycle`);
        }
        
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Error during capacity cleanup:", e);
    } finally {
        client.release();
    }
}

// Cleanup orphaned pending deletions (recovery mechanism)
async function cleanupOrphanedPendingDeletions() {
    const client = await pool.connect();
    
    try {
        // Reset files that have been pending for too long (e.g., 5 minutes)
        const resetQuery = `
            UPDATE files 
            SET pending_deletion = false 
            WHERE pending_deletion = true 
                AND deleted = false
                AND updated_at < NOW() - INTERVAL '5 minutes'
            RETURNING id
        `;
        
        const result = await client.query(resetQuery);
        
        if (result.rows.length > 0) {
            console.log(`Reset ${result.rows.length} orphaned pending deletions`);
        }
    } catch (error) {
        console.error("Error cleaning up orphaned pending deletions:", error);
    } finally {
        client.release();
    }
}

// One-time cleanup of all empty directories (for initial cleanup)
async function performGlobalDirectoryCleanup() {
    const client = await pool.connect();
    
    try {
        console.log("Performing global empty directory cleanup...");
        
        // Get all unique directories from deleted files
        const query = `
            SELECT DISTINCT file_path 
            FROM files 
            WHERE deleted = true
            ORDER BY file_path
        `;
        
        const result = await client.query(query);
        const filePaths = result.rows.map(row => row.file_path);
        
        if (filePaths.length > 0) {
            const cleanupResult = cleanupEmptyDirectories(filePaths);
            console.log(`Global cleanup: Removed ${cleanupResult.uniqueDirsRemoved} empty directories`);
        }
        
    } catch (error) {
        console.error("Error during global directory cleanup:", error);
    } finally {
        client.release();
    }
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function performCleanup() {
    try {
        // Clean up any orphaned pending deletions first
        await cleanupOrphanedPendingDeletions();
        
        // Get initial size
        let fileSize = await getFileSystemSize();
        console.log("\n=== Starting Cleanup Cycle ===");
        console.log("Current directory size: ", fileSize.fileSystemSize);
        console.log("Storage limit: ", REMOVE_FIFO_WHEN_STORAGE_IS);
        console.log("Retention period: ", RETENTION_DAYS, " days");
        console.log("Batch size: ", BATCH_SIZE, ", Max batches per cycle: ", MAX_BATCHES_PER_CYCLE);
        console.log("Empty directory cleanup: ", CLEANUP_EMPTY_DIRS ? "Enabled" : "Disabled");
        
        // First, delete files older than retention period
        console.log("\n--- Step 1: Checking retention policy ---");
        await deleteOldFilesByRetention();
        
        // Then, check if we still need to free space based on capacity
        console.log("\n--- Step 2: Checking storage capacity ---");
        await deleteOldFilesByCapacity();
        
        // Get final size
        fileSize = await getFileSystemSize();
        console.log("\n=== Cleanup Complete ===");
        console.log("Final directory size: ", fileSize.fileSystemSize);
        
    } catch (error) {
        console.error("Error during cleanup:", error);
    }
    
    // Sleep for 20 seconds before next cycle
    await sleep(20000);
}

// Initialize database schema if needed
async function initializeDatabase() {
    const client = await pool.connect();
    
    try {
        // Add pending_deletion column if it doesn't exist
        await client.query(`
            ALTER TABLE files 
            ADD COLUMN IF NOT EXISTS pending_deletion BOOLEAN DEFAULT FALSE
        `);
        
        // Add index for better performance
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_files_pending_deletion 
            ON files(pending_deletion) 
            WHERE pending_deletion = true
        `);
        
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_files_date_time 
            ON files((date + time::interval))
            WHERE deleted = false
        `);
        
        // Add updated_at column for orphaned pending deletion cleanup
        await client.query(`
            ALTER TABLE files 
            ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()
        `);
        
        // Create trigger to update updated_at
        await client.query(`
            CREATE OR REPLACE FUNCTION update_updated_at()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = NOW();
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);
        
        await client.query(`
            DROP TRIGGER IF EXISTS update_files_updated_at ON files;
            CREATE TRIGGER update_files_updated_at
            BEFORE UPDATE ON files
            FOR EACH ROW
            EXECUTE FUNCTION update_updated_at();
        `);
        
        console.log("Database schema initialized successfully");
        
    } catch (error) {
        console.error("Error initializing database:", error);
    } finally {
        client.release();
    }
}

securos.connect(async (core) => {
    // Initialize database on startup
    await initializeDatabase();
    
    // Optionally perform a one-time global cleanup of empty directories
    // Uncomment the line below for initial cleanup of existing empty directories
    // await performGlobalDirectoryCleanup();
    
    while (true) {
        // Reload configuration each cycle
        loadConfig();
        
        // Perform cleanup (both retention and capacity based)
        await performCleanup();
    }
});
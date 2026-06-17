/**
 * Batch utility functions for transfer queue management
 */

/**
 * Check if there are any active batches (transferring or paused)
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Object} Object containing activeBatchCount and activeFileCount
 */
async function checkActiveBatches(pool) {
    const result = await pool.query(`
        SELECT 
            COUNT(DISTINCT batch_id) as active_batch_count,
            COUNT(*) as active_file_count
        FROM transfer_queue 
        WHERE status IN ('transferring', 'paused')
        AND file_origin = 'auto'
    `);
    return {
        activeBatchCount: parseInt(result.rows[0].active_batch_count),
        activeFileCount: parseInt(result.rows[0].active_file_count)
    };
}

/**
 * Get detailed information about a specific batch
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} batchId - UUID of the batch
 * @returns {Object} Batch information including file counts and timing
 */
async function getBatchInfo(pool, batchId) {
    const result = await pool.query(`
        SELECT 
            batch_id,
            COUNT(*) as total_files,
            SUM(file_size) as total_size,
            SUM(CASE WHEN status = 'transferred' THEN 1 ELSE 0 END) as completed_files,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_files,
            SUM(CASE WHEN status IN ('transferring', 'paused') THEN 1 ELSE 0 END) as active_files,
            MIN(created_at) as batch_start_time,
            MAX(transferred_at) as batch_end_time
        FROM transfer_queue 
        WHERE batch_id = $1
        GROUP BY batch_id
    `, [batchId]);
    return result.rows[0];
}

/**
 * Get all active batches with their status
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Array} Array of active batch information
 */
async function getActiveBatchesInfo(pool) {
    const result = await pool.query(`
        SELECT 
            batch_id,
            file_origin,
            status,
            COUNT(*) as file_count,
            SUM(file_size) as total_size,
            MIN(created_at) as batch_start,
            MAX(updated_at) as last_update,
            EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - MIN(created_at)))/60 as duration_minutes
        FROM transfer_queue 
        WHERE status IN ('transferring', 'paused')
        GROUP BY batch_id, file_origin, status
        ORDER BY batch_start ASC
    `);
    return result.rows;
}

/**
 * Get batch history with completion status
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {number} limit - Number of batches to return (default: 10)
 * @returns {Array} Array of batch history information
 */
async function getBatchHistory(pool, limit = 10) {
    const result = await pool.query(`
        SELECT 
            batch_id,
            file_origin,
            COUNT(*) as total_files,
            SUM(file_size) as total_size,
            SUM(CASE WHEN status = 'transferred' THEN 1 ELSE 0 END) as completed_files,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed_files,
            SUM(CASE WHEN status IN ('transferring', 'paused') THEN 1 ELSE 0 END) as active_files,
            MIN(created_at) as batch_start,
            MAX(transferred_at) as batch_end,
            CASE 
                WHEN SUM(CASE WHEN status IN ('transferring', 'paused') THEN 1 ELSE 0 END) > 0 THEN 'ACTIVE'
                WHEN SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) > 0 THEN 'COMPLETED_WITH_ERRORS'
                ELSE 'COMPLETED'
            END as batch_status
        FROM transfer_queue 
        WHERE file_origin = 'auto'
        GROUP BY batch_id, file_origin
        ORDER BY batch_start DESC
        LIMIT $1
    `, [limit]);
    return result.rows;
}

/**
 * Get detailed information about files in a specific batch
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} batchId - UUID of the batch
 * @returns {Array} Array of file details in the batch
 */
async function getBatchDetails(pool, batchId) {
    const result = await pool.query(`
        SELECT 
            id,
            file_path,
            file_size,
            file_type,
            status,
            retry_count,
            error_message,
            created_at,
            updated_at,
            transferred_at
        FROM transfer_queue 
        WHERE batch_id = $1
        ORDER BY created_at ASC
    `, [batchId]);
    return result.rows;
}

/**
 * Calculate batch statistics from files to copy
 * @param {Array} filesToCopy - Array of file groups to copy
 * @returns {Object} Object containing totalFiles and totalSize
 */
function calculateBatchStats(filesToCopy) {
    let totalFiles = 0;
    let totalSize = 0;
    
    filesToCopy.forEach(row => {
        totalFiles += row.ids.length;
        row.file_sizes.forEach(size => totalSize += size || 0);
    });
    
    return { totalFiles, totalSize };
}

/**
 * Format file size in human readable format
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = (bytes / Math.pow(1024, i)).toFixed(2);
    return `${value} ${sizes[i]}`;
}

module.exports = {
    checkActiveBatches,
    getBatchInfo,
    getActiveBatchesInfo,
    getBatchHistory,
    getBatchDetails,
    calculateBatchStats,
    formatFileSize
};
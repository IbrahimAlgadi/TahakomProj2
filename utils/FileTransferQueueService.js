const { Pool } = require('pg');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const config = require('./envConfig');

const pool = new Pool({
    user: config.database.user,
    host: config.database.host,
    database: config.database.database,
    port: 5432,
    password: config.database.password,
    // Connection pool settings
    max: 20, // Maximum number of clients in the pool
    min: 2,  // Minimum number of clients in the pool
    // Connection timeout settings
    connectionTimeoutMillis: 5000, // Time to wait for connection
    idleTimeoutMillis: 30000,      // Time before closing idle connections
    // Keep connections alive
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    // Application name for debugging
    application_name: 'file_transfer_service'
});

class FileTransferQueueService {
    
    /**
     * Add files to transfer queue with priority
     * @param {Array} files - Array of file objects
     * @param {string} serviceType - 'auto', 'manual', 'video'
     * @param {number} priority - 1=image, 2=video, 3=manual
     * @param {string} destinationPath - Base destination path
     * @param {number} transferJobId - Optional transfer job ID for manual transfers
     * @returns {Promise<string>} - Batch ID
     */
    async addFilesToQueue(files, serviceType, priority, destinationPath, transferJobId = null) {
        const batchId = uuidv4();
        const client = await pool.connect();
        
        try {
            await client.query('BEGIN');

            // Build parallel arrays for a single unnest bulk INSERT instead of N individual
            // round-trips. For 977 files this reduces ~5 s of sequential awaits to <100 ms.
            const fileIds    = [];
            const filePaths  = [];
            const fileSizes  = [];
            const fileNames  = [];
            const metadatas  = [];

            for (const file of files) {
                fileIds.push(file.id);
                filePaths.push(file.file_path);
                fileSizes.push(file.file_size || 0);
                fileNames.push(file.file_name || path.basename(file.file_path));
                metadatas.push(JSON.stringify({
                    plate_num:   file.plate_num   || null,
                    site_id:     file.site_id     || null,
                    date_folder: file.date_folder || null,
                    time_folder: file.time_folder || null,
                    cam_id:      file.cam_id      || null
                }));
            }

            await client.query(`
                INSERT INTO file_transfer_queue
                    (service_type, file_id, file_path, file_size, file_name,
                     destination_path, priority, batch_id, transfer_job_id, metadata)
                SELECT $1,
                       unnest($2::int[]),
                       unnest($3::text[]),
                       unnest($4::int[]),
                       unnest($5::text[]),
                       $6, $7, $8, $9,
                       unnest($10::jsonb[])
            `, [
                serviceType,
                fileIds,
                filePaths,
                fileSizes,
                fileNames,
                destinationPath,
                priority,
                batchId,
                transferJobId,
                metadatas
            ]);

            await client.query('COMMIT');
            console.log(`Added ${files.length} files to transfer queue with batch ID: ${batchId}`);
            return batchId;
            
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Add a single converted video file to the transfer queue.
     * Used after a manual_video_group_queue group has been fully converted.
     * file_id is NULL because the source is iss_media_files, not files.
     *
     * @param {Object} video        - { file_path, file_size, file_name, video_group_id, camera_id }
     * @param {string} serviceType  - 'manual'
     * @param {number} priority
     * @param {string} destinationPath
     * @param {number} transferJobId
     */
    async addVideoToQueue(video, serviceType, priority, destinationPath, transferJobId = null) {
        const batchId = uuidv4();
        const metadata = JSON.stringify({
            video_group_id: video.video_group_id || null,
            camera_id:      video.camera_id      || null,
        });
        await pool.query(`
            INSERT INTO file_transfer_queue
                (service_type, file_id, file_path, file_size, file_name,
                 destination_path, priority, batch_id, transfer_job_id, metadata)
            VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9)
        `, [
            serviceType,
            video.file_path,
            video.file_size || 0,
            video.file_name,
            destinationPath,
            priority,
            batchId,
            transferJobId,
            metadata
        ]);
        return batchId;
    }

    /**
     * Get next batch of files to transfer (by priority)
     * @param {number} limit - Number of files to get
     * @returns {Promise<Array>} - Array of files to transfer
     */
    async getNextFilesToTransfer(limit = 100) {
        const result = await pool.query(`
            SELECT id, service_type, file_id, file_path, file_size, file_name, 
                   destination_path, priority, batch_id, transfer_job_id, metadata,
                   created_at
            FROM file_transfer_queue 
            WHERE status = 'pending'
            ORDER BY priority DESC, created_at ASC
            LIMIT $1
        `, [limit]);
        
        return result.rows;
    }

    /**
     * Mark files as processing
     * @param {Array} fileIds - Array of queue IDs
     */
    async markFilesAsProcessing(fileIds) {
        await pool.query(`
            UPDATE file_transfer_queue 
            SET status = 'processing', updated_at = CURRENT_TIMESTAMP
            WHERE id = ANY($1)
        `, [fileIds]);
    }

    /**
     * Mark files as transferred
     * @param {Array} fileIds - Array of queue IDs
     */
    async markFilesAsTransferred(fileIds) {
        await pool.query(`
            UPDATE file_transfer_queue 
            SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
            WHERE id = ANY($1)
        `, [fileIds]);

        // Also update source tables based on service type
        const fileDetails = await pool.query(`
            SELECT file_id, service_type, transfer_job_id FROM file_transfer_queue WHERE id = ANY($1)
        `, [fileIds]);

        for (const file of fileDetails.rows) {
            if (file.service_type === 'auto') {
                await pool.query(`
                    UPDATE files SET is_auto_transferred = true WHERE id = $1
                `, [file.file_id]);
            }
            // Only update transfer_job_log for image entries (file_id is NOT NULL for images).
            // Video entries have file_id = NULL; their log row (manual_video_group_queue) is
            // updated by the consumer loop directly after the fs.copy succeeds.
            if (file.service_type === 'manual' && file.transfer_job_id && file.file_id !== null) {
                await pool.query(
                    `UPDATE transfer_job_log SET transferred = true
                     WHERE file_id = $1 AND transfer_job_id = $2`,
                    [file.file_id, file.transfer_job_id]
                );
            }
        }
    }

    /**
     * Mark files as failed
     * @param {Array} fileIds - Array of queue IDs
     * @param {string} errorMessage - Error message
     */
    async markFilesAsFailed(fileIds, errorMessage) {
        await pool.query(`
            UPDATE file_transfer_queue 
            SET status = 'failed', error_message = $2, 
                retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
            WHERE id = ANY($1)
        `, [fileIds, errorMessage]);
    }

    /**
     * Check if all files in a batch are completed
     * @param {string} batchId - Batch ID to check
     * @returns {Promise<Object>} - Status object with completion info
     */
    async getBatchStatus(batchId) {
        const result = await pool.query(`
            SELECT 
                COUNT(*) as total_files,
                COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_files,
                COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_files,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_files
            FROM file_transfer_queue 
            WHERE batch_id = $1
        `, [batchId]);

        const stats = result.rows[0];
        const isCompleted = parseInt(stats.pending_files) === 0 && parseInt(stats.processing_files) === 0;
        
        return {
            batchId,
            totalFiles: parseInt(stats.total_files),
            transferredFiles: parseInt(stats.transferred_files),
            failedFiles: parseInt(stats.failed_files),
            processingFiles: parseInt(stats.processing_files),
            pendingFiles: parseInt(stats.pending_files),
            isCompleted
        };
    }

    /**
     * Get batch status by service type (for manual transfers)
     * @param {string} serviceType - Service type
     * @param {number} transferJobId - Transfer job ID
     * @returns {Promise<Object>} - Status object
     */
    async getServiceTransferStatus(serviceType, transferJobId = null) {
        let query = `
            SELECT 
                COUNT(*) as total_files,
                COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files,
                COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_files,
                COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing_files,
                COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_files
            FROM file_transfer_queue 
            WHERE service_type = $1
        `;
        
        const params = [serviceType];
        
        if (transferJobId) {
            query += ' AND transfer_job_id = $2';
            params.push(transferJobId);
        }

        const result = await pool.query(query, params);
        const stats = result.rows[0];
        
        return {
            serviceType,
            transferJobId,
            totalFiles: parseInt(stats.total_files),
            transferredFiles: parseInt(stats.transferred_files),
            failedFiles: parseInt(stats.failed_files),
            processingFiles: parseInt(stats.processing_files),
            pendingFiles: parseInt(stats.pending_files),
            isCompleted: parseInt(stats.pending_files) === 0 && parseInt(stats.processing_files) === 0
        };
    }

    /**
     * Cancel all pending transfers for a batch or service
     * @param {string} batchId - Batch ID (optional)
     * @param {string} serviceType - Service type (optional)
     * @param {number} transferJobId - Transfer job ID (optional)
     */
    async cancelTransfers(batchId = null, serviceType = null, transferJobId = null) {
        let query = `
            UPDATE file_transfer_queue 
            SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
            WHERE status IN ('pending', 'processing')
        `;
        const params = [];
        let paramCount = 1;

        if (batchId) {
            query += ` AND batch_id = $${paramCount}`;
            params.push(batchId);
            paramCount++;
        }

        if (serviceType) {
            query += ` AND service_type = $${paramCount}`;
            params.push(serviceType);
            paramCount++;
        }

        if (transferJobId) {
            query += ` AND transfer_job_id = $${paramCount}`;
            params.push(transferJobId);
        }

        await pool.query(query, params);
    }

    /**
     * Cleanup old records (older than 2 days)
     */
    async cleanupOldRecords() {
        const result = await pool.query(`
            DELETE FROM file_transfer_queue 
            WHERE created_at < NOW() - INTERVAL '2 days'
            AND status IN ('transferred', 'failed', 'cancelled')
        `);
        
        console.log(`Cleaned up ${result.rowCount} old transfer queue records.`);
        return result.rowCount;
    }

    /**
     * Reset stuck processing files (files that have been processing for too long)
     */
    async resetStuckFiles() {
        const result = await pool.query(`
            UPDATE file_transfer_queue 
            SET status = 'pending', updated_at = CURRENT_TIMESTAMP
            WHERE status = 'processing' 
            AND updated_at < NOW() - INTERVAL '30 minutes'
        `);
        
        console.log(`Reset ${result.rowCount} stuck transfer files.`);
        return result.rowCount;
    }
}

module.exports = new FileTransferQueueService(); 
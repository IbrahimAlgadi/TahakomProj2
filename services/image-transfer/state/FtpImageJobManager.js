const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'FtpImageJobManager', logFile: 'image-ftp-pipeline' });
const ImageJobManager = require('./ImageJobManager');
const { v4: uuidv4 } = require('uuid');

class FtpImageJobManager extends ImageJobManager {
    constructor(pool, redis, config) {
        super(pool, redis, config);
        
        // FTP Image transfer tables
        this.jobTable = 'ftp_image_transfer_queue_job';
        this.transferQueueTable = 'ftp_image_transfer_queue';
        this.sourceFilesTable = 'files'; // Same source files table
    }

    /**
     * Create new FTP image transfer job with FTP-specific fields
     */
    async createTransferJob(origin = 'auto_ftp') {
        const batchId = uuidv4();
        const result = await this.pool.query(`
            INSERT INTO ${this.jobTable} (batch_id, batch_origin, status, ftp_server_config) 
            VALUES ($1, $2, 'pending', $3) 
            RETURNING *
        `, [batchId, origin, JSON.stringify(this.config.ftpConfig || {})]);
        
        logger.info(`[FTP_IMAGE_JOB] Created new FTP image transfer job: ${batchId} (ID: ${result.rows[0].id})`);
        return result.rows[0];
    }

    /**
     * Create FTP transfer batch from file groups
     */
    async createTransferBatch(filesToCopy, job) {
        const insertPromises = [];
        
        for (const row of filesToCopy) {
            const { ids, file_paths, file_sizes, file_names } = row;
            
            for (let i = 0; i < file_paths.length; i++) {
                const fileType = 'image';
                
                // Generate FTP remote path based on file structure
                const relativePath = file_paths[i].replace(/\\/g, '/');
                const remotePath = this.generateFtpRemotePath(relativePath, row);
                
                const insertQuery = `
                    INSERT INTO ${this.transferQueueTable} 
                    (file_id, file_path, file_size, file_type, file_origin, status, job_id, ftp_remote_path)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING id;
                `;
                
                insertPromises.push(
                    this.pool.query(insertQuery, [
                        ids[i],
                        file_paths[i],
                        file_sizes[i],
                        fileType,
                        'auto',
                        'pending',
                        job.id,
                        remotePath
                    ])
                );
            }
        }
        
        await Promise.all(insertPromises);
        
        // Update job statistics
        await this.updateJobStats(job.id);
        
        logger.info(`[FTP_IMAGE_JOB] Created FTP transfer batch for job ${job.id} with ${filesToCopy.length} groups`);
        return job.batch_id;
    }

    /**
     * Generate FTP remote path for file
     */
    generateFtpRemotePath(localPath, fileGroup) {
        // Extract meaningful path components
        const { plate_num, site_id, date_folder, time_folder } = fileGroup;
        
        // Create structured FTP path
        // Example: /images/site_123/2024-01-15/14-30/ABC123/filename.jpg
        const fileName = localPath.split(/[\\\/]/).pop();
        // FTP unable to handle arabic letters
        const sanitizedPlateNum = plate_num
            .replace(/[|<>:"/\\*?]/g, '_')
            .replace(/[^\x00-\x7F]/g, '') // Remove all non-ASCII
            .replace(/_{2,}/g, '_'); // Replace multiple underscores with single

        const sanitizedFileName = fileName
            .replace(/[|<>:"/\\*?]/g, '_')
            .replace(/[^\x00-\x7F]/g, '')
            .replace(/_{2,}/g, '_')
            .trim();
        const remotePath = `/images/${site_id}/${date_folder}/${time_folder}/${sanitizedPlateNum}/${sanitizedFileName}`;
        
        logger.info(remotePath);

        return remotePath;
    }

    /**
     * Get existing active job or create new one if files are available
     */
    async getOrCreateActiveJob(origin = 'auto_ftp') {
        // Check for active job (exclude completed/failed jobs)
        const result = await this.pool.query(`
            SELECT * FROM ${this.jobTable} 
            WHERE batch_origin = $1 AND status NOT IN ('transferred', 'failed') 
            ORDER BY created_at DESC 
            LIMIT 1
        `, [origin]);
        
        if (result.rows.length > 0) {
            const activeJob = result.rows[0];
            logger.info(`[IMAGE_JOB] Found active job: ${activeJob.batch_id} (status: ${activeJob.status})`);
            
            // If paused, resume it
            if (activeJob.status === 'paused') {
                await this.updateJobStatus(activeJob.id, 'transferring');
                logger.info(`[IMAGE_JOB] Resumed paused job: ${activeJob.batch_id}`);
            }
            
            return activeJob;
        }
        
        // Check if there are files to transfer before creating job
        const filesToTransfer = await this.getFilesToTransfer(1);
        if (filesToTransfer.length === 0) {
            return null; // No files available
        }
        
        // Create new job and batch
        logger.info(`[IMAGE_JOB] Creating new job for ${filesToTransfer.length} file groups`);
        const newJob = await this.createTransferJob(origin);
        await this.createTransferBatch(filesToTransfer, newJob);
        await this.updateJobStatus(newJob.id, 'transferring');
        
        logger.info(`[IMAGE_JOB] ✓ Created and started new job: ${newJob.batch_id} (ID: ${newJob.id})`);
        return newJob;
    }


    /**
     * Pause active FTP jobs
     */
    async pauseActiveJobs(reason = 'FTP transfer disabled') {
        const result = await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET status = 'paused', error_message = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'transferring' AND batch_origin = 'auto_ftp'
            RETURNING id, batch_id
        `, [reason]);

        if (result.rows.length > 0) {
            logger.info(`[FTP_IMAGE_JOB] Paused ${result.rows.length} FTP image jobs: ${result.rows.map(j => j.batch_id).join(', ')}`);
        }
    }

    /**
     * Resume paused FTP jobs
     */
    async resumeActiveJobs() {
        const result = await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET status = 'transferring', error_message = NULL, updated_at = CURRENT_TIMESTAMP 
            WHERE status IN ('paused', 'pending') AND batch_origin = 'auto_ftp'
            RETURNING id, batch_id
        `);

        if (result.rows.length > 0) {
            logger.info(`[FTP_IMAGE_JOB] Resumed ${result.rows.length} FTP image jobs: ${result.rows.map(j => j.batch_id).join(', ')}`);
        }
    }

    /**
     * Update job stats for FTP transfers
     */
    async updateJobStats(jobId) {
        await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET 
                total_files = (SELECT COUNT(*) FROM ${this.transferQueueTable} WHERE job_id = $1),
                total_size = (SELECT COALESCE(SUM(file_size), 0) FROM ${this.transferQueueTable} WHERE job_id = $1),
                transferred_files = (SELECT COUNT(*) FROM ${this.transferQueueTable} WHERE job_id = $1 AND status = 'transferred'),
                transferred_size = (SELECT COALESCE(SUM(file_size), 0) FROM ${this.transferQueueTable} WHERE job_id = $1 AND status = 'transferred'),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [jobId]);
    }

    /**
     * Get count of pending files across all FTP jobs
     */
    async getPendingFilesCount() {
        try {
            const result = await this.pool.query(`
                SELECT COUNT(*) as count 
                FROM ${this.transferQueueTable} tq
                JOIN ${this.jobTable} j ON tq.job_id = j.id
                WHERE tq.status = 'pending' 
                AND j.batch_origin = 'auto_ftp'
                AND j.status NOT IN ('transferred', 'failed', 'cancelled')
            `);
            return parseInt(result.rows[0].count) || 0;
        } catch (error) {
            logger.error('[FTP_IMAGE_JOB] Error getting pending files count:', error);
            return 0;
        }
    }

    /**
     * Get count of completed files across all FTP jobs
     */
    async getCompletedFilesCount() {
        try {
            const result = await this.pool.query(`
                SELECT COUNT(*) as count 
                FROM ${this.transferQueueTable} tq
                JOIN ${this.jobTable} j ON tq.job_id = j.id
                WHERE tq.status = 'transferred' 
                AND j.batch_origin = 'auto_ftp'
            `);
            return parseInt(result.rows[0].count) || 0;
        } catch (error) {
            logger.error('[FTP_IMAGE_JOB] Error getting completed files count:', error);
            return 0;
        }
    }
}

module.exports = FtpImageJobManager;

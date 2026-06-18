const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'ImageJobManager' });
const { v4: uuidv4 } = require('uuid');
const { calculateBatchStats } = require('../../../utils/batchUtils.js');

class ImageJobManager {
    constructor(pool, redis, config) {
        this.pool = pool;
        this.redis = redis;
        this.config = config;
        
        // USB Image transfer tables
        this.jobTable = 'transfer_queue_job';
        this.transferQueueTable = 'transfer_queue';
        this.sourceFilesTable = 'files';
    }

    /**
     * Check for active image transfer job
     */
    async checkActiveJob(origin = 'auto') {
        const result = await this.pool.query(`
            SELECT * FROM ${this.jobTable} 
            WHERE batch_origin = $1 AND status IN ('pending', 'transferring', 'paused') 
            ORDER BY created_at DESC 
            LIMIT 1
        `, [origin]);
        
        return result.rows.length > 0 ? result.rows[0] : null;
    }

    /**
     * Get existing active job or create new one if files are available
     */
    async getOrCreateActiveJob(origin = 'auto', limit=100) {
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
        const filesToTransfer = await this.getFilesToTransfer(limit);
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
     * Create new image transfer job
     */
    async createTransferJob(origin = 'auto') {
        const batchId = uuidv4();
        const result = await this.pool.query(`
            INSERT INTO ${this.jobTable} (batch_id, batch_origin, status) 
            VALUES ($1, $2, 'pending') 
            RETURNING *
        `, [batchId, origin]);
        
        logger.info(`[IMAGE_JOB] Created new image transfer job: ${batchId} (ID: ${result.rows[0].id})`);
        return result.rows[0];
    }

    /**
     * Update job statistics
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
     * Update job status
     */
    async updateJobStatus(jobId, status, errorMessage = null) {
        const updateFields = { status, updated_at: 'CURRENT_TIMESTAMP' };
        
        if (status === 'transferring' && !errorMessage) {
            updateFields.started_at = 'CURRENT_TIMESTAMP';
        } else if (status === 'transferred') {
            updateFields.completed_at = 'CURRENT_TIMESTAMP';
        }
        
        const setClause = Object.keys(updateFields).map((key, index) => 
            key === 'updated_at' || key === 'started_at' || key === 'completed_at' 
                ? `${key} = CURRENT_TIMESTAMP` 
                : `${key} = $${index + 2}`
        ).join(', ');
        
        const values = [jobId, ...Object.values(updateFields).filter(v => v !== 'CURRENT_TIMESTAMP')];
        
        if (errorMessage) {
            values.push(errorMessage);
            setClause += `, error_message = $${values.length}`;
        }
        
        await this.pool.query(`UPDATE ${this.jobTable} SET ${setClause} WHERE id = $1`, values);
        logger.info(`[IMAGE_JOB] Updated job ${jobId} status to: ${status}`);
    }

    /**
     * Get files to transfer for image batches
     */
    async getFilesToTransfer(limit = 1000) {
        let query = `
            SELECT 
                ARRAY_AGG(f.id) AS ids, 
                ARRAY_AGG(f.tid) AS tids, 
                plate_num, 
                site_id,
                date_folder, 
                time_folder, 
                ARRAY_AGG(f.file_path) AS file_paths,
                ARRAY_AGG(f.file_size) AS file_sizes, 
                ARRAY_AGG(f.file_name) AS file_names
            FROM public.${this.sourceFilesTable} f
            WHERE f.deleted = false 
            GROUP BY f.plate_num, f.site_id, f.date_folder, f.time_folder
            HAVING 
                BOOL_AND(f.file_size > 0) 
                AND BOOL_OR(NOT COALESCE(f.is_auto_transferred, false))
                AND COUNT(f.id) = $2
            ORDER BY 
                TO_TIMESTAMP(MIN(f.date)::text || ' ' || MIN(f.time)::text, 'YYYY-MM-DD HH24:MI:SS') DESC
            LIMIT $1;
        `;

        let query2 = `
            WITH filtered AS (
                SELECT *
                FROM public.${this.sourceFilesTable}
                WHERE deleted = false
                    AND file_size > 0
                    AND ts::date = CURRENT_DATE
                    AND is_auto_transferred = false
            )
            SELECT 
                ARRAY_AGG(f.id) AS ids, 
                ARRAY_AGG(f.tid) AS tids, 
                f.plate_num, 
                f.site_id,
                f.date_folder, 
                f.time_folder, 
                ARRAY_AGG(f.file_path) AS file_paths,
                ARRAY_AGG(f.file_size) AS file_sizes, 
                ARRAY_AGG(f.file_name) AS file_names
            FROM filtered f
            GROUP BY f.plate_num, f.site_id, f.date_folder, f.time_folder
            HAVING 
                BOOL_OR(NOT COALESCE(f.is_auto_transferred, false))
                AND COUNT(f.id) = $2
            ORDER BY MIN(f.ts) DESC
            LIMIT $1;
        `;
        const result = await this.pool.query(query, [limit, 3]);
        return result.rows;
    }

    /**
     * Create transfer batch from file groups (optimized bulk insert)
     */
    async createTransferBatch(filesToCopy, job) {
        const insertValues = [];
        const insertParams = [];
        let paramIndex = 1;

        for (const row of filesToCopy) {
            const { ids, file_paths, file_sizes } = row;

            for (let i = 0; i < file_paths.length; i++) {
                insertValues.push(`($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}, $${paramIndex + 5}, $${paramIndex + 6})`);
                insertParams.push(
                    ids[i],
                    file_paths[i],
                    file_sizes[i],
                    'image',
                    'auto',
                    'pending',
                    job.id
                );
                paramIndex += 7;
            }
        }

        if (insertValues.length === 0) {
            logger.info(`[IMAGE_JOB] No files to insert for job ${job.id}`);
            return job.batch_id;
        }

        const insertQuery = `
            INSERT INTO ${this.transferQueueTable}
            (file_id, file_path, file_size, file_type, file_origin, status, job_id)
            VALUES ${insertValues.join(', ')}
        `;

        await this.pool.query(insertQuery, insertParams);

        // Update job statistics
        await this.updateJobStats(job.id);

        logger.info(`[IMAGE_JOB] Created transfer batch for job ${job.id} with ${filesToCopy.length} groups (${insertParams.length / 7} total files)`);
        return job.batch_id;
    }

    /**
     * Get job progress information
     */
    async getJobProgress(jobId) {
        const result = await this.pool.query(`
            SELECT * FROM ${this.jobTable} WHERE id = $1
        `, [jobId]);
        
        return result.rows[0] || null;
    }

    /**
     * Check and update completed jobs
     */
    async checkAndUpdateCompletedJobs() {
        // Find jobs that might be completed
        const jobsToCheck = await this.pool.query(`
            SELECT DISTINCT tqj.id, tqj.batch_id
            FROM ${this.jobTable} tqj
            WHERE tqj.status = 'transferring'
            AND NOT EXISTS (
                SELECT 1 FROM ${this.transferQueueTable} tq 
                WHERE tq.job_id = tqj.id AND tq.status = 'pending'
            )
        `);

        for (const job of jobsToCheck.rows) {
            const jobStatus = await this.pool.query(`
                SELECT 
                    COUNT(*) as total_files,
                    COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_files
                FROM ${this.transferQueueTable} 
                WHERE job_id = $1
            `, [job.id]);
            
            const stats = jobStatus.rows[0];
            const jobFinalStatus = stats.transferred_files > 0 ? 'transferred' : 'failed';
            
            await this.pool.query(`
                UPDATE ${this.jobTable} 
                SET status = $1, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [jobFinalStatus, job.id]);
            
            logger.info(`[IMAGE_JOB] Job ${job.id} (${job.batch_id}) marked as ${jobFinalStatus} - transferred: ${stats.transferred_files}, failed: ${stats.failed_files}`);
        }
    }

    /**
     * Pause active jobs (when auto transfer is disabled)
     */
    async pauseActiveJobs(reason = 'Auto transfer disabled') {
        const result = await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET status = 'paused', error_message = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'transferring' AND batch_origin = 'auto'
            RETURNING id, batch_id
        `, [reason]);

        if (result.rows.length > 0) {
            logger.info(`[IMAGE_JOB] Paused ${result.rows.length} image jobs: ${result.rows.map(j => j.batch_id).join(', ')}`);
        }
    }

    /**
     * Resume paused jobs (when auto transfer is re-enabled)
     */
    async resumeActiveJobs() {
        const result = await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET status = 'transferring', error_message = NULL, updated_at = CURRENT_TIMESTAMP 
            WHERE status IN ('paused', 'pending') AND batch_origin = 'auto'
            RETURNING id, batch_id
        `);

        if (result.rows.length > 0) {
            logger.info(`[IMAGE_JOB] Resumed ${result.rows.length} image jobs: ${result.rows.map(j => j.batch_id).join(', ')}`);
        } else {
            logger.info(`[IMAGE_JOB] No image jobs to resume`);
        }
    }
}

module.exports = ImageJobManager;


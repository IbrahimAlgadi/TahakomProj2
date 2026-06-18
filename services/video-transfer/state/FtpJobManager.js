const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'FtpJobManager' });
const { v4: uuidv4 } = require('uuid');
const TransferUtils = require('../../shared/TransferUtils');

class FtpJobManager {
    constructor(eventEmitter, pool, redis, config, processingStateManager) {
        this.pool = pool;
        this.redis = redis;
        this.config = config;
        this.ISS_MEDIA_CAMERAS = config.ISS_MEDIA_CAMERAS || ['1', '2'];
        this.currentSiteId = '';
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = this.config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
        this.processingStateManager = processingStateManager;
        
        // FTP-specific table names
        this.jobTable = 'ftp_video_transfer_queue_job';
        this.transferQueueTable = 'ftp_video_transfer_queue';
        this.bufferTable = 'ftp_video_converted_buffer';
    }

    /**
     * Update current site ID
     */
    setCurrentSiteId(siteId) {
        this.currentSiteId = siteId;
    }

    /**
     * Create new FTP job with UUID
     */
    async createNewJobWithUUID() {
        const expectedCameras = this.ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
        const batchId = uuidv4();
        
        const insertQuery = `
            INSERT INTO ${this.jobTable} (
                batch_id, batch_origin, status, expected_cameras, 
                interval_duration_minutes, site_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *
        `;
        
        const { rows } = await this.pool.query(insertQuery, [
            batchId, 'auto_ftp_video', 'created', expectedCameras,
            this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT, this.currentSiteId
        ]);
        
        logger.info(`[FTP_JOB] createNewJobWithUUID: ✓ Created new FTP job: ${batchId} (ID: ${rows[0].id})`);
        return rows[0];
    }

    /**
     * Get existing uncompleted FTP jobs
     */
    async getExistingUncompletedJobs() {
        const { rows } = await this.pool.query(`
            SELECT * FROM ${this.jobTable} 
            WHERE batch_origin = 'auto_ftp_video' 
            AND status NOT IN ('completed', 'transferred', 'failed')
            ORDER BY created_at DESC
        `);
        
        return rows;
    }

    /**
     * Request additional files for camera (reuses existing iss_media_files)
     */
    async requestAdditionalFilesForCamera(cameraId, currentCount, targetCount, jobId) {
        const needCount = Math.max(0, targetCount - currentCount);
        if (needCount === 0) return [];

        logger.info(`[FTP_JOB] requestAdditionalFilesForCamera: Requesting ${needCount} additional files for camera ${cameraId}`);

        // Get files that haven't been FTP transferred yet and aren't in any FTP buffer
        const { rows } = await this.pool.query(`
            SELECT imf.* 
            FROM iss_media_files imf
            WHERE imf.camera_id = $1 
            AND imf.deleted = false
            AND imf.is_ftp_transferred = false
            AND NOT EXISTS (
                SELECT 1 FROM ${this.bufferTable} fcb 
                WHERE fcb.source_file_id = imf.id
            )
            ORDER BY imf.recording_date DESC, imf.recording_time DESC
            LIMIT $2
        `, [cameraId, needCount]);

        logger.info(`[FTP_JOB] requestAdditionalFilesForCamera: Found ${rows.length} additional files for camera ${cameraId}`);
        return rows;
    }

    /**
     * Get pending records for camera from FTP buffer
     */
    async requestPendingRecordsForCamera(cameraId, jobId) {
        const { rows } = await this.pool.query(`
            SELECT * FROM ${this.bufferTable}
            WHERE camera_id = $1 
            AND job_id = $2
            AND status = 'pending'
            ORDER BY created_at ASC
        `, [cameraId, jobId]);

        return rows;
    }

    /**
     * Get media file by ID
     */
    async getMediaFileById(fileId) {
        const { rows } = await this.pool.query(`
            SELECT * FROM iss_media_files WHERE id = $1
        `, [fileId]);

        return rows[0];
    }

    /**
     * Get camera file counts and status from FTP buffer
     */
    async getCameraFileCountsStatusBufferCheck(jobId, cameraId) {
        const { rows } = await this.pool.query(`
            SELECT 
                status,
                COUNT(*) as count
            FROM ${this.bufferTable}
            WHERE job_id = $1 AND camera_id = $2
            GROUP BY status
        `, [jobId, cameraId]);

        const counts = {};
        rows.forEach(row => {
            counts[row.status] = parseInt(row.count);
        });

        return {
            pending: counts.pending || 0,
            converted: counts.converted || 0,
            grouped: counts.grouped || 0
        };
    }

    /**
     * Check if video exists in FTP transfer queue
     */
    async getVideoInTransferQueue(jobId, cameraId) {
        const { rows } = await this.pool.query(`
            SELECT * FROM ${this.transferQueueTable}
            WHERE job_id = $1 AND camera_id = $2
            ORDER BY created_at DESC
            LIMIT 1
        `, [jobId, cameraId]);

        return rows[0];
    }

    /**
     * Add video to FTP transfer queue
     */
    async addVideoToTransferQueue(videoData, jobId) {
        logger.info(`[FTP_JOB] addVideoToTransferQueue: Adding video ${videoData.videoName} to FTP transfer queue for job ${jobId}`);

        const insertQuery = `
            INSERT INTO ${this.transferQueueTable} (
                video_file_path, video_file_name, video_file_size,
                camera_id, site_id, recording_date,
                interval_start_minutes, interval_end_minutes,
                source_files_count, source_files_size, source_file_ids,
                status, job_id, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *
        `;
        const params = [
            videoData.videoPath,
            videoData.videoName,
            videoData.fileSize,
            videoData.camera_id,
            this.currentSiteId,
            videoData.recordingDate,
            videoData.intervalStart,
            videoData.intervalEnd,
            videoData.sourceFilesCount,
            videoData.sourceFilesSize,
            videoData.sourceFileIds,
            'pending',
            jobId
        ];
        logger.info(params);

        const { rows } = await this.pool.query(insertQuery, params);

        logger.info(`[FTP_JOB] addVideoToTransferQueue: ✓ Added video to FTP transfer queue with ID: ${rows[0].id}`);
        return rows[0];
    }

    /**
     * Add camera to processed list
     */
    async addCameraToProcessed(jobId, cameraId) {
        await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET processed_cameras = array_append(processed_cameras, $1::text),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 
            AND NOT ($1::text = ANY(processed_cameras))
        `, [cameraId, jobId]);

        logger.info(`[FTP_JOB] addCameraToProcessed: ✓ Added camera ${cameraId} to processed list for job ${jobId}`);
    }

    /**
     * Update job statistics
     */
    async updateJobStats(jobId) {
        return await TransferUtils.updateJobStatistics(
            this.pool, 
            jobId, 
            this.jobTable, 
            this.transferQueueTable
        );
    }

    /**
     * Update job statistics for transferred videos
     */
    async updateJobStatsToTransfered(jobId) {
        return await this.updateJobStats(jobId);
    }

    /**
     * Update job status
     */
    async updateJobStatus(jobId, status) {
        return await TransferUtils.updateJobStatus(this.pool, jobId, status, this.jobTable);
    }

    /**
     * Check job completion
     */
    async checkJobCompletion(jobId) {
        try {
            const result = await this.pool.query(`
                SELECT 
                    expected_cameras,
                    processed_cameras
                FROM ${this.jobTable}
                WHERE id = $1
            `, [jobId]);

            if (result.rows.length === 0) return false;

            const { expected_cameras, processed_cameras } = result.rows[0];
            const isComplete = expected_cameras && processed_cameras && 
                             expected_cameras.length === processed_cameras.length &&
                             expected_cameras.every(cam => processed_cameras.includes(cam));

            logger.info(`[FTP_JOB] checkJobCompletion: Job ${jobId} completion check: ${isComplete} (${(processed_cameras && processed_cameras.length) || 0}/${(expected_cameras && expected_cameras.length) || 0} cameras)`);
            
            return isComplete;

        } catch (error) {
            logger.error('[FTP_JOB] checkJobCompletion: Error:', error);
            return false;
        }
    }

    /**
     * Check job video transfer completion
     */
    async checkJobVideoTransferCompletion(jobId) {
        return await TransferUtils.checkJobCompletion(
            this.pool, 
            jobId, 
            this.transferQueueTable, 
            this.jobTable
        );
    }

    /**
     * Check and complete job
     */
    async checkAndCompleteJob(jobId) {
        const isJobComplete = await this.checkJobCompletion(jobId);
        const isTransferComplete = await this.checkJobVideoTransferCompletion(jobId);
        
        if (isJobComplete && isTransferComplete) {
            await this.updateJobStatus(jobId, 'completed');
            logger.info(`[FTP_JOB] checkAndCompleteJob: ✓ Job ${jobId} marked as completed`);
            return true;
        }
        
        return false;
    }

    /**
     * Get unprocessed files count for FTP
     */
    async getUnprocessedFilesCount() {
        const { rows } = await this.pool.query(`
            SELECT COUNT(*) as count 
            FROM iss_media_files 
            WHERE deleted = false 
            AND is_ftp_transferred = false
            AND NOT EXISTS (
                SELECT 1 FROM ${this.bufferTable} fcb 
                WHERE fcb.source_file_id = iss_media_files.id
            )
        `);

        return parseInt(rows[0].count);
    }

    /**
     * Get job statistics
     */
    async getJobStatistics(jobId) {
        return await TransferUtils.getJobStatistics(this.pool, jobId, this.transferQueueTable);
    }

    /**
     * Get transfer statistics for metrics
     */
    async getTransferStatistics() {
        try {
            // Get active jobs count
            const activeJobsResult = await this.pool.query(`
                SELECT COUNT(*) as count 
                FROM ${this.jobTable} 
                WHERE status IN ('pending', 'transferring', 'processing')
            `);

            // Get completed jobs count
            const completedJobsResult = await this.pool.query(`
                SELECT COUNT(*) as count 
                FROM ${this.jobTable} 
                WHERE status = 'transferred'
            `);

            // Get videos in queue
            const videosInQueueResult = await this.pool.query(`
                SELECT COUNT(*) as count 
                FROM ${this.transferQueueTable} 
                WHERE status = 'pending'
            `);

            // Get videos transferred
            const videosTransferredResult = await this.pool.query(`
                SELECT COUNT(*) as count 
                FROM ${this.transferQueueTable} 
                WHERE status = 'transferred'
            `);

            return {
                activeJobs: parseInt(activeJobsResult.rows[0].count) || 0,
                completedJobs: parseInt(completedJobsResult.rows[0].count) || 0,
                videosInQueue: parseInt(videosInQueueResult.rows[0].count) || 0,
                videosTransferred: parseInt(videosTransferredResult.rows[0].count) || 0
            };

        } catch (error) {
            logger.error('[FTP_JOB] Error getting transfer statistics:', error);
            return {
                activeJobs: 0,
                completedJobs: 0,
                videosInQueue: 0,
                videosTransferred: 0
            };
        }
    }
}

module.exports = FtpJobManager;

const { v4: uuidv4 } = require('uuid');
const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'JobManager', logFile: 'video-usb-pipeline' });
const fs = require('fs-extra');

class JobManager {
    constructor(eventEmitter, pool, redis, config, processingStateManager) {
        this.eventEmitter = eventEmitter;
        this.pool = pool;
        this.redis = redis;
        this.config = config;
        this.ISS_MEDIA_CAMERAS = config.ISS_MEDIA_CAMERAS || ['1', '2'];
        this.currentSiteId = '';
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = this.config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
        this.processingStateManager = processingStateManager;
    }

    /**
     * Update current site ID
     */
    setCurrentSiteId(siteId) {
        this.currentSiteId = siteId;
    }

    /**
     * Get or create active job with proper state management
     */
    async getOrCreateActiveJob() {
        // Check for active job (exclude completed jobs)
        const result = await this.pool.query(`
            SELECT * FROM video_transfer_queue_job 
            WHERE batch_origin = 'auto_video' AND status NOT IN ('completed', 'failed')
            ORDER BY created_at DESC 
            LIMIT 1
        `);
        
        if (result.rows.length > 0) {
            const activeJob = result.rows[0];
            logger.info(`[JOB] JobManager.getOrCreateActiveJob: Found active job: ${activeJob.batch_id} (status: ${activeJob.status})`);
            
            // If job is created, check if all cameras are complete
            const isComplete = await this.checkJobCompletion(activeJob.id) && await this.checkJobVideoTransferCompletion(activeJob.id);
            if (isComplete) {
                logger.info('[JOB] JobManager.getOrCreateActiveJob: All cameras processed. Moving job to pending status...');
                await this.updateJobStatus(activeJob.id, 'pending');
                logger.info('[JOB] JobManager.getOrCreateActiveJob: ✓ Job status changed to pending for transfer');
                return null; // Job is now ready for transfer, don't create new content
            }
            
            // Job exists but is incomplete - continue with this job
            logger.info('[JOB] JobManager.getOrCreateActiveJob: Job incomplete. Continuing with current job...');
            
            return activeJob;
        }
        
        // Check if there are unprocessed files before creating job
        const unprocessedFilesCount = await this.getUnprocessedFilesCount();
        if (unprocessedFilesCount === 0) {
            return null;
        }
        
        // Create new job
        const expectedCameras = this.ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
        const batchId = uuidv4();
        
        logger.info(`[JOB] JobManager.getOrCreateActiveJob: Creating new job for cameras: ${expectedCameras.join(', ')}`);
        const createResult = await this.pool.query(`
            INSERT INTO video_transfer_queue_job (
                batch_id, batch_origin, status, 
                expected_cameras, processed_cameras, 
                interval_duration_minutes, site_id
            ) 
            VALUES ($1, $2, 'created', $3, '{}', 5, $4) 
            RETURNING *
        `, [batchId, 'auto_video', expectedCameras, this.currentSiteId]);
        
        logger.info(`[JOB] JobManager.getOrCreateActiveJob: ✓ Created new job: ${createResult.rows[0].batch_id}`);
        return createResult.rows[0];
    }

    /**
     * Get count of unprocessed files (helper method for job creation decision)
     */
    async getUnprocessedFilesCount() {
        const query = `
            SELECT COUNT(*) as count
            FROM iss_media_files 
            WHERE 
                deleted = false 
                AND is_auto_transferred = false
                AND recording_date >= CURRENT_DATE - INTERVAL '7 days'
                AND id NOT IN (
                    SELECT DISTINCT unnest(source_file_ids) 
                    FROM video_transfer_queue 
                    WHERE status IN ('pending', 'transferred')
                )
                AND id NOT IN (
                    SELECT DISTINCT source_file_id 
                    FROM video_converted_buffer 
                    WHERE status IN ('pending', 'converted', 'grouped')
                )
        `;
        
        const result = await this.pool.query(query);
        return parseInt(result.rows[0].count);
    }

    /**
     * Add video to transfer queue
     */
    async addVideoToTransferQueue(videoData, jobId) {
        const insertQuery = `
            INSERT INTO video_transfer_queue 
            (video_file_path, video_file_name, video_file_size, camera_id, site_id, 
             recording_date, interval_start_minutes, interval_end_minutes, 
             source_files_count, source_files_size, source_file_ids, status, job_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            RETURNING id;
        `;
        
        const result = await this.pool.query(insertQuery, [
            videoData.videoPath,
            videoData.videoName,
            videoData.fileSize,
            videoData.camera_id,
            videoData.site_id,
            videoData.recording_date,
            videoData.interval_start,
            videoData.interval_end,
            videoData.sourceFileIds.length,
            0,
            videoData.sourceFileIds,
            'pending',
            jobId
        ]);
        
        logger.info(`[QUEUE] JobManager.addVideoToTransferQueue: Added video ${videoData.videoName} to transfer queue (ID: ${result.rows[0].id})`);
        return result.rows[0].id;
    }

    /**
     * Check if all cameras have been processed for a job
     */
    async checkJobCompletion(jobId) {
        const result = await this.pool.query(`
            SELECT 
                expected_cameras,
                processed_cameras,
                array_length(expected_cameras, 1) as expected_count,
                array_length(processed_cameras, 1) as processed_count
            FROM video_transfer_queue_job 
            WHERE id = $1
        `, [jobId]);

        if (result.rows.length === 0) return false;
        
        const row = result.rows[0];
        const expectedCount = row.expected_count || 0;
        const processedCount = row.processed_count || 0;

        logger.info(`[JOB] JobManager.checkJobCompletion: Completion camera check - Expected count: ${expectedCount} (${row.expected_cameras}), Processed count: ${processedCount} (${row.processed_cameras})`);
        return expectedCount > 0 && processedCount >= expectedCount;
    }

    async checkJobVideoTransferCompletion(jobId) {
        const videosGenerated = await this.pool.query(`
            SELECT 
                status,
                COUNT(status) as count
            FROM video_transfer_queue
            WHERE job_id = $1
            GROUP BY status
        `, [jobId]);

        if (videosGenerated.rows.length === 0) return false;
        
        // Video Check
        const videosGeneratedFailedCount = videosGenerated.rows.find(row => row.status === 'failed') ? videosGenerated.rows.find(row => row.status === 'failed').count : 0;
        const videosGeneratedTransferredCount = videosGenerated.rows.find(row => row.status === 'transferred') ? videosGenerated.rows.find(row => row.status === 'transferred').count : 0;
        const totalProcessedCount = videosGeneratedTransferredCount + videosGeneratedFailedCount;

        logger.info(`[JOB] JobManager.checkJobVideoTransferCompletion: Completion video check - Processed: ${totalProcessedCount}`);

        return totalProcessedCount >= this.ISS_MEDIA_CAMERAS.length;
    }

    /**
     * Update job status
     */
    async updateJobStatus(jobId, status, errorMessage = null) {
        logger.info(`[JOB] JobManager.updateJobStatus: Updating job ${jobId} status to: ${status} with error message: ${errorMessage}`);

        const updateQuery = errorMessage 
            ? `UPDATE video_transfer_queue_job SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`
            : `UPDATE video_transfer_queue_job SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`;
            
        const params = errorMessage ? [status, errorMessage, jobId] : [status, jobId];
        
        await this.pool.query(updateQuery, params);
        logger.info(`[JOB] JobManager.updateJobStatus: Updated job ${jobId} status to: ${status}`);
    }

    /**
     * Pause all active jobs (created / pending / transferring) for monitoring accuracy.
     * Called every processing-loop iteration while the drive is not ready, so it is idempotent
     * — SQL returns 0 rows when all jobs are already paused.
     */
    async pauseActiveJobs(reason = 'USB drive disconnected') {
        try {
            const result = await this.pool.query(`
                UPDATE video_transfer_queue_job
                SET status = 'paused', error_message = $1, updated_at = CURRENT_TIMESTAMP
                WHERE status IN ('created', 'pending', 'transferring')
                AND batch_origin = 'auto_video'
                RETURNING id, batch_id
            `, [reason]);

            if (result.rows.length > 0) {
                logger.info(`[JOB] JobManager.pauseActiveJobs: Paused ${result.rows.length} video job(s): ${result.rows.map(j => j.batch_id).join(', ')} — reason: ${reason}`);
            }
        } catch (error) {
            logger.error('[JOB_ERROR] JobManager.pauseActiveJobs: Error pausing active jobs:', error);
            throw error;
        }
    }

    /**
     * Resume all paused jobs back to 'created' so the processing loop re-evaluates their phase.
     * Called when the drive reconnects.
     */
    async resumeActiveJobs() {
        try {
            const result = await this.pool.query(`
                UPDATE video_transfer_queue_job
                SET status = 'created', error_message = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE status = 'paused'
                AND batch_origin = 'auto_video'
                RETURNING id, batch_id
            `);

            if (result.rows.length > 0) {
                logger.info(`[JOB] JobManager.resumeActiveJobs: Resumed ${result.rows.length} video job(s): ${result.rows.map(j => j.batch_id).join(', ')}`);
            } else {
                logger.info('[JOB] JobManager.resumeActiveJobs: No paused video jobs to resume');
            }
        } catch (error) {
            logger.error('[JOB_ERROR] JobManager.resumeActiveJobs: Error resuming jobs:', error);
            throw error;
        }
    }

    /**
     * Add camera to processed list
     */
    async addCameraToProcessed(jobId, cameraId) {
        await this.pool.query(`
            UPDATE video_transfer_queue_job 
            SET processed_cameras = array_append(processed_cameras, $1::text),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $2 
            AND NOT ($1::text = ANY(processed_cameras))
        `, [cameraId.toString(), jobId]);
        
        logger.info(`[JOB] JobManager.addCameraToProcessed: Added camera ${cameraId} to processed list for job ${jobId}`);
    }

    /**
     * Update job statistics
     */
    async updateJobStatsToTransfered(jobId) {
        await this.pool.query(`
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

    async getVideoInTransferQueue(jobId, cameraId) {
        const result = await this.pool.query(`
            SELECT *
            FROM video_transfer_queue
            WHERE job_id = $1 AND camera_id = $2
        `, [jobId, cameraId]);

        return result.rows[0];
    }

    /**
     * Handle video creation completion
     */
    async videoGrouppingCompleted (videoData, jobId) {
        logger.info(`[EVENT] JobManager.videoGrouppingCompleted: Video created: ${videoData.videoName} for job ${jobId}`);
        
        try {
            // // Add video to transfer queue using JobManager
            await this.addVideoToTransferQueue(videoData, jobId);
            
            // // Mark camera as processed
            await this.addCameraToProcessed(jobId, videoData.camera_id);
            
            // // Update job stats
            // await this.updateJobStatsToTransfered(jobId);
            
            // Remove processing markers for source files
            const sourceFiles = videoData.sourceFileIds.map(id => ({ id }));
            await this.processingStateManager.removeProcessingMarkers(sourceFiles);
            
            logger.info(`[EVENT] JobManager.videoGrouppingCompleted: Video queued for transfer: ${videoData.videoName}`);
            
        } catch (error) {
            this.emit('error', error);
        }
    };

    /**
     * Check if job is complete and update status accordingly
     */
    async checkAndCompleteJob(jobId) {
        try {
            const result = await this.pool.query(`
                SELECT 
                    vtqj.id,
                    vtqj.batch_id,
                    vtqj.status,
                    COUNT(vtq.id) as total_videos,
                    COUNT(CASE WHEN vtq.status = 'transferred' THEN 1 END) as transferred_videos
                FROM video_transfer_queue_job vtqj
                LEFT JOIN video_transfer_queue vtq ON vtqj.id = vtq.job_id
                WHERE vtqj.id = $1
                GROUP BY vtqj.id, vtqj.batch_id, vtqj.status
            `, [jobId]);
            
            if (result.rows.length === 0) {
                return;
            }
            
            const job = result.rows[0];
            const totalVideos = parseInt(job.total_videos);
            const transferredVideos = parseInt(job.transferred_videos);
            
            logger.info(`[JOB] JobManager.checkAndCompleteJob: Transfer progress for job ${job.batch_id}: ${transferredVideos}/${totalVideos} videos transferred`);
            
            // If all videos have been transferred, mark job as completed
            if (totalVideos > 0 && transferredVideos >= this.ISS_MEDIA_CAMERAS.length) {
                await this.updateJobStatus(jobId, 'completed');
                logger.info(`[JOB] ✓ JobManager.checkAndCompleteJob: Job ${job.batch_id} completed - all ${totalVideos} videos transferred`);
            }
            
        } catch (error) {
            logger.error(`[JOB_ERROR] JobManager.checkAndCompleteJob: Error checking job completion for job ${jobId}:`, error);
        }
    }

    // ===== NEW METHODS FOR REFACTORED JOB MANAGEMENT =====

    /**
     * Get existing uncompleted jobs ordered by creation date (newest first)
     */
    async getExistingUncompletedJobs() {
        try {
            const result = await this.pool.query(`
                SELECT id,
                       batch_id,
                       expected_cameras,
                       processed_cameras,
                       total_videos,
                       transferred_videos,
                       status
                FROM video_transfer_queue_job
                WHERE 
                    batch_origin = 'auto_video'
                    AND status NOT IN ('failed', 'completed')
                ORDER BY created_at DESC
            `);
            
            logger.info(`[JOB] JobManager.getExistingUncompletedJobs: Found ${result.rows.length} uncompleted jobs`);
            return result.rows;
        } catch (error) {
            logger.error('[JOB_ERROR] JobManager.getExistingUncompletedJobs: Error getting existing uncompleted jobs:', error);
            throw error;
        }
    }

    /**
     * Get camera file counts in video_converted_buffer for a specific job
     */
    async getCameraFileCountsInBuffer(jobId = null) {
        try {
            const cameraFileCounts = {};
            
            for (const camera of this.ISS_MEDIA_CAMERAS) {
                const cameraId = camera.replace('CAM_', '');
                
                let query, params;
                if (jobId) {
                    // Query for specific job
                    query = `
                        SELECT COUNT(*) as count
                        FROM video_converted_buffer 
                        WHERE camera_id = $1 
                        AND status IN ('pending', 'converted', 'grouped')
                        AND site_id = $2
                        AND job_id = $3
                    `;
                    params = [parseInt(cameraId), this.currentSiteId, jobId];
                } else {
                    // Query without job filter (legacy support)
                    query = `
                        SELECT COUNT(*) as count
                        FROM video_converted_buffer 
                        WHERE camera_id = $1 
                        AND status IN ('pending', 'converted', 'grouped')
                        AND site_id = $2
                    `;
                    params = [parseInt(cameraId), this.currentSiteId];
                }
                
                const result = await this.pool.query(query, params);
                cameraFileCounts[cameraId] = parseInt(result.rows[0].count);
            }
            
            logger.info(`[JOB] JobManager.getCameraFileCountsInBuffer: Camera file counts in buffer${jobId ? ` for job ${jobId}` : ''}:`, cameraFileCounts);
            return cameraFileCounts;
        } catch (error) {
            logger.error('[JOB_ERROR] JobManager.getCameraFileCountsInBuffer: Error getting camera file counts in buffer:', error);
            throw error;
        }
    }

    /**
     * Get camera file counts in video_converted_buffer for a specific job
     */
    async getCameraFileCountsStatusBufferCheck(jobId, cameraId) {
        try {
            logger.info(`[JOB] JobManager.getCameraFileCountsStatusBufferCheck: Getting camera file counts in buffer for job ${jobId}`);
            // const statusList = ['pending', 'converted', 'grouped'];
            const cameraFileStatusCounts = {
                "pending": 0,
                "converted": 0,
                "grouped": 0
            }
            
            let query, params;
            query = `
                SELECT 
                    status,
                    COUNT(*) as count
                FROM video_converted_buffer 
                WHERE camera_id = $1 AND job_id = $2
                group by status
            `;
            params = [parseInt(cameraId), jobId];
            
            const result = await this.pool.query(query, params);
            // logger.info(`[JOB] JobManager.getCameraFileCountsStatusBufferCheck: Result for camera ${cameraId}:`, JSON.stringify(result.rows));
            // result.rows = [{"status":"converted","count":"38"}]
            for (const status of result.rows) {
                // logger.info(status);
                // logger.info(status.status);
                // logger.info(status.count);
                // logger.info(cameraFileStatusCounts[`${status.status}`]);
                cameraFileStatusCounts[status.status] = parseInt(status.count);
                // logger.info("cameraFileStatusCounts after assign: ", cameraFileStatusCounts[status.status]);
            }
            
            logger.info(`[JOB] JobManager.getCameraFileCountsStatusBufferCheck: Camera file counts in buffer${jobId ? ` for job ${jobId}` : ''}:`, JSON.stringify(cameraFileStatusCounts));
            return cameraFileStatusCounts;
        } catch (error) {
            logger.error('[JOB_ERROR] JobManager.getCameraFileCountsStatusBufferCheck: Error getting camera file counts in buffer:', error);
            throw error;
        }
    }

    /**
     * Request additional files for a camera to reach the target count (38 files)
     */
    async requestAdditionalFilesForCamera(cameraId, currentCount, targetCount = 38, jobId = null) {
        try {
            const needed = targetCount - currentCount;
            if (needed <= 0) {
                logger.info(`[JOB] JobManager.requestAdditionalFilesForCamera: Camera ${cameraId} already has enough files (${currentCount}/${targetCount})`);
                return [];
            }

            logger.info(`[JOB] JobManager.requestAdditionalFilesForCamera: Camera ${cameraId} needs ${needed} more files to reach ${targetCount}`);
            
            // Request more files than needed to account for missing files on disk
            const requestCount = Math.min(needed * 2, 100); // Request up to 2x needed or 100 max
            const params = [parseInt(cameraId), requestCount];
            const query = `
                SELECT imf.*
                FROM iss_media_files imf
                WHERE imf.camera_id = $1
                AND imf.deleted = false 
                AND imf.is_auto_transferred = false
                AND imf.recording_date >= CURRENT_DATE - INTERVAL '7 days'
                AND imf.id NOT IN (
                    SELECT DISTINCT unnest(source_file_ids) 
                    FROM video_transfer_queue 
                    WHERE status IN ('pending', 'transferred', 'converted')
                )
                AND imf.id NOT IN (
                    SELECT DISTINCT source_file_id 
                    FROM video_converted_buffer 
                    WHERE status IN ('pending', 'converted', 'grouped')
                )
                ORDER BY imf.recording_date ASC, imf.precise_time ASC
                LIMIT $2
            `;
            
            const result = await this.pool.query(query, params);
            logger.info(`[JOB] JobManager.requestAdditionalFilesForCamera: Found ${result.rows.length} candidates for camera ${cameraId}${jobId ? ` for job ${jobId}` : ''}`);
            
            // Filter files that actually exist on disk
            const validFiles = [];
            const invalidFileIds = [];
            
            for (const file of result.rows) {
                if (await fs.pathExists(file.file_path)) {
                    validFiles.push(file);
                    // Stop when we have enough valid files
                    if (validFiles.length >= needed) {
                        break;
                    }
                } else {
                    logger.info(`[JOB] JobManager.requestAdditionalFilesForCamera: File not found on disk: ${file.file_path} (ID: ${file.id})`);
                    invalidFileIds.push(file.id);
                }
            }
            
            // Mark missing files as deleted in database (batch update for efficiency)
            if (invalidFileIds.length > 0) {
                try {
                    await this.pool.query(`
                        UPDATE iss_media_files 
                        SET deleted = true, updated_at = CURRENT_TIMESTAMP 
                        WHERE id = ANY($1)
                    `, [invalidFileIds]);
                    logger.info(`[JOB] JobManager.requestAdditionalFilesForCamera: Marked ${invalidFileIds.length} missing files as deleted for camera ${cameraId}`);
                } catch (dbError) {
                    logger.error(`[JOB_ERROR] JobManager.requestAdditionalFilesForCamera: Failed to mark files as deleted:`, dbError);
                }
            }

            logger.info(`[JOB] JobManager.requestAdditionalFilesForCamera: Found ${validFiles.length} valid files for camera ${cameraId}${jobId ? ` for job ${jobId}` : ''} (${invalidFileIds.length} files marked as deleted)`);
            return validFiles;
            
        } catch (error) {
            logger.error(`[JOB_ERROR] JobManager.requestAdditionalFilesForCamera: Error requesting additional files for camera ${cameraId}:`, error);
            throw error;
        }
    }

    /**
     * Get media file by id
     */
    async getMediaFileById(fileId) {
        const result = await this.pool.query(`
            SELECT *
            FROM iss_media_files
            WHERE id = $1
        `, [fileId]);
        return result.rows[0];
    }

    /**
     * Get pending records for a camera and job
     */
    async requestPendingRecordsForCamera(cameraId, jobId) {
        const result = await this.pool.query(`
            SELECT *
            FROM video_converted_buffer
            WHERE camera_id = $1 AND job_id = $2 AND status = 'pending'
        `, [cameraId, jobId]);
        return result.rows;
    }

    /**
     * Check if job has all cameras with required files in buffer
     */
    async checkJobHasRequiredFiles(jobId, targetCount = 38) {
        try {
            const cameraFileCounts = await this.getCameraFileCountsInBuffer(jobId);
            let allCamerasReady = true;
            
            for (const camera of this.ISS_MEDIA_CAMERAS) {
                const cameraId = camera.replace('CAM_', '');
                const count = cameraFileCounts[cameraId] || 0;
                
                if (count < targetCount) {
                    logger.info(`[JOB] JobManager.checkJobHasRequiredFiles: Job ${jobId} - Camera ${cameraId} has only ${count}/${targetCount} files - not ready`);
                    allCamerasReady = false;
                } else {
                    logger.info(`[JOB] JobManager.checkJobHasRequiredFiles: Job ${jobId} - Camera ${cameraId} has ${count}/${targetCount} files - ready`);
                }
            }
            
            return allCamerasReady;
        } catch (error) {
            logger.error(`[JOB_ERROR] JobManager.checkJobHasRequiredFiles: Error checking if job ${jobId} has required files:`, error);
            throw error;
        }
    }

    /**
     * Check if job is complete based on video_transfer_queue status
     */
    async checkJobVideoTransferCompletion(jobId) {
        try {
            // Check if all expected cameras have videos in the transfer queue
            const result = await this.pool.query(`
                SELECT 
                    vtqj.expected_cameras,
                    ARRAY_AGG(DISTINCT vtq.camera_id::text) as cameras_with_videos,
                    COUNT(vtq.id) as total_videos,
                    COUNT(CASE WHEN vtq.status = 'transferred' THEN 1 END) as transferred_videos
                FROM video_transfer_queue_job vtqj
                LEFT JOIN video_transfer_queue vtq ON vtqj.id = vtq.job_id
                WHERE vtqj.id = $1
                GROUP BY vtqj.id, vtqj.expected_cameras
            `, [jobId]);

            if (result.rows.length === 0) {
                return false;
            }

            const row = result.rows[0];
            const expectedCameras = row.expected_cameras || [];
            const camerasWithGroupedVideos = row.cameras_with_videos || [];
            const totalVideos = parseInt(row.total_videos) || 0;
            const transferredVideos = parseInt(row.transferred_videos) || 0;

            // Loop through each camera and get count of files in video_converted_buffer
            const cameraBufferCounts = {};
            let allCamerasHaveVideos = false;
            for (const cameraId of expectedCameras) {
                const bufferResult = await this.pool.query(`
                    SELECT COUNT(*) as file_count
                    FROM video_converted_buffer
                    WHERE camera_id = $1 AND job_id = $2
                `, [parseInt(cameraId), jobId]);
                
                cameraBufferCounts[cameraId] = parseInt(bufferResult.rows[0].file_count) || 0;
                if (cameraBufferCounts[cameraId] >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
                    allCamerasHaveVideos = true;
                }
            }

            logger.info(`[JOB] JobManager.checkJobVideoTransferCompletion: Job ${jobId} completion check:`);
            logger.info(`      JobManager.checkJobVideoTransferCompletion:  Expected cameras: ${expectedCameras.join(', ')}`);
            logger.info(`      JobManager.checkJobVideoTransferCompletion:  Cameras with grouped videos: ${camerasWithGroupedVideos.join(', ')}`);
            logger.info(`      JobManager.checkJobVideoTransferCompletion:  All cameras have videos: ${allCamerasHaveVideos}`);
            logger.info(`      JobManager.checkJobVideoTransferCompletion:  Videos: ${transferredVideos}/${totalVideos} transferred`);
            logger.info(`      JobManager.checkJobVideoTransferCompletion:  Buffer file counts per camera:`, cameraBufferCounts);

            return allCamerasHaveVideos && totalVideos > 0;
        } catch (error) {
            logger.error(`[JOB_ERROR] JobManager.checkJobVideoTransferCompletion: Error checking job video transfer completion for job ${jobId}:`, error);
            throw error;
        }
    }

    /**
     * Create new job with UUID batch ID and 'created' status
     */
    async createNewJobWithUUID(expectedCameras = null) {
        try {
            const cameras = expectedCameras || this.ISS_MEDIA_CAMERAS.map(cam => cam.replace('CAM_', ''));
            const batchId = uuidv4();
            
            logger.info(`[JOB] JobManager.createNewJobWithUUID: Creating new job with UUID: ${batchId}`);
            logger.info(`[JOB] JobManager.createNewJobWithUUID: Expected cameras: ${cameras.join(', ')}`);
            
            const result = await this.pool.query(`
                INSERT INTO video_transfer_queue_job (
                    batch_id, batch_origin, status, 
                    expected_cameras, processed_cameras, 
                    interval_duration_minutes, site_id,
                    created_at, updated_at
                ) 
                VALUES ($1, $2, 'created', $3, '{}', 5, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) 
                RETURNING *
            `, [batchId, 'auto_video', cameras, this.currentSiteId]);
            
            logger.info(`[JOB] JobManager.createNewJobWithUUID: ✓ Created new job: ${result.rows[0].batch_id} (ID: ${result.rows[0].id})`);
            return result.rows[0];
        } catch (error) {
            logger.error('[JOB] JobManager.createNewJobWithUUID: Error creating new job with UUID:', error);
            throw error;
        }
    }

    /**
     * Delete a job completely from the database
     */
    async deleteJob(jobId) {
        try {
            // First delete any related video_transfer_queue entries
            await this.pool.query('DELETE FROM video_transfer_queue WHERE job_id = $1', [jobId]);
            
            // Then delete the job itself
            await this.pool.query('DELETE FROM video_transfer_queue_job WHERE id = $1', [jobId]);
            
            logger.info(`[JOB] JobManager.deleteJob: Successfully deleted job ${jobId} and related entries`);
        } catch (error) {
            logger.error(`[JOB_ERROR] JobManager.deleteJob: Error deleting job ${jobId}:`, error);
            throw error;
        }
    }
}

module.exports = JobManager;

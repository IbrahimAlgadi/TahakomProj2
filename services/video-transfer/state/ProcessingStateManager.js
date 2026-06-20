const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'ProcessingStateManager', logFile: 'video-usb-pipeline' });
class ProcessingStateManager {
    constructor(eventEmitter, pool, redis, config) {
        this.eventEmitter = eventEmitter;
        this.pool = pool;
        this.redis = redis;
        this.config = config;
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
    }

    /**
     * Get unprocessed files from database
     */
    async getUnprocessedFiles() {
        try {
            const query = `
                SELECT 
                    id, file_path, file_name, file_size, camera_id, site_id,
                    recording_date, recording_time, timezone_offset, precise_time
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
                ORDER BY camera_id, recording_date, precise_time
            `;
            
            const result = await this.pool.query(query);
            
            // Filter out files in retry delay or already being processed
            const filteredFiles = [];
            for (const file of result.rows) {
                const retryKey = `video_processing_failed:${file.id}`;
                const processingKey = `video_processing_in_progress:${file.id}`;
                
                const isInRetryDelay = await this.redis.exists(retryKey);
                const isBeingProcessed = await this.redis.exists(processingKey);
                
                if (!isInRetryDelay && !isBeingProcessed) {
                    filteredFiles.push(file);
                }
            }
            
            return filteredFiles;
        } catch (error) {
            logger.error('[ERROR] Error fetching unprocessed files:', error);
            return [];
        }
    }

    /**
     * Group files by camera for video creation
     */
    async groupFilesByCamera(cameraId, jobId, dbName='video_converted_buffer') {
        logger.info(`[PROCESSING] ProcessingStateManager.groupFilesByCamera: Grouping files for camera ${cameraId} in job ${jobId}`);
        // Check if file already exists in buffer for this job
        const convertedFilesReadyForGrouping = await this.pool.query(`
            SELECT 
                id, 
                converted_file_name,
                recording_date,
                precise_time,
                timezone_offset,
                status, 
                job_id 
            FROM ${dbName} 
            WHERE camera_id = $1 AND job_id = $2 AND status = 'converted'
        `, [cameraId, jobId]);

        if (convertedFilesReadyForGrouping.rows.length < this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
            logger.info(`[PROCESSING] ProcessingStateManager.groupFilesByCamera: Found ${convertedFilesReadyForGrouping.rows.length} converted files ready for grouping, but need ${this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files`);
            return null;
        }

        const firstFile = convertedFilesReadyForGrouping.rows[0];
        const lastFile = convertedFilesReadyForGrouping.rows[convertedFilesReadyForGrouping.rows.length - 1];
        const formattedFirstFileTime = firstFile.precise_time.replace(/:/g, '_').replace('.', '__'); // 17_00_01__295
        const formattedLastFileTime = lastFile.precise_time.replace(/:/g, '_').replace('.', '__'); // 17_04_53__306
        // cam_3_2025-08-09___17_00:01__295--17_04:53__306.mp4
        const groupFileName = `cam_${cameraId}_${firstFile.recording_date.toISOString().split('T')[0]}___${formattedFirstFileTime}--${formattedLastFileTime}`;

        const REQUIRED_FILES_PER_GROUP = this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
        logger.info(`[PROCESSING] ProcessingStateManager.groupFilesByCamera: Grouping files for camera ${cameraId} in job ${jobId} - ${convertedFilesReadyForGrouping.rows.length} files, ${REQUIRED_FILES_PER_GROUP} files per group`);
        
        // Get client from pool and start transaction
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            
            for (const file of convertedFilesReadyForGrouping.rows) {
                await client.query(`
                    UPDATE ${dbName} 
                    SET group_key = $1, status = 'grouped'
                    WHERE id = $2
                `, [groupFileName, file.id]);
            }
            
            await client.query('COMMIT');
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }

        return groupFileName;
    }

    /**
     * Mark files as being processed to prevent duplicates
     */
    async markFilesAsProcessing(files) {
        try {
            for (const file of files) {
                const processingKey = `video_processing_in_progress:${file.id}`;
                await this.redis.setex(processingKey, 3600, JSON.stringify({
                    fileId: file.id,
                    camera_id: file.camera_id,
                    startedAt: new Date().toISOString()
                }));
            }
            logger.info(`[PROCESSING] Marked ${files.length} files as being processed`);
        } catch (error) {
            logger.error('[PROCESSING] Failed to mark files as processing:', error);
        }
    }

    /**
     * Remove processing markers for files
     */
    async removeProcessingMarkers(files) {
        try {
            for (const file of files) {
                const processingKey = `video_processing_in_progress:${file.id}`;
                await this.redis.del(processingKey);
            }
            logger.info(`[PROCESSING] Removed processing markers for ${files.length} files`);
        } catch (error) {
            logger.error('[PROCESSING] Failed to remove processing markers:', error);
        }
    }

    /**
     * Check if a video already exists for the same camera/interval combination
     */
    async checkDuplicateVideo(group, jobId) {
        try {
            const result = await this.pool.query(`
                SELECT 
                    COUNT(id) as count
                FROM video_converted_buffer vcb  
                WHERE job_id = $1 AND camera_id = $2 
            `, [jobId, group.camera_id]);
            logger.info(`[DUPLICATE] ProcessingStateManager.checkDuplicateVideo: videos for camera ${group.camera_id} found ${JSON.stringify(result.rows)}`);
            
            if (result.rows.count > 0) {
                logger.info(`[DUPLICATE] ProcessingStateManager.checkDuplicateVideo: Found existing video for camera ${group.camera_id}, interval ${group.interval_start}-${group.interval_end}: ${result.rows[0].count}`);
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[DUPLICATE] ProcessingStateManager.checkDuplicateVideo: Error checking for duplicate video:', error);
            return false;
        }
    }

    /**
     * Check if a camera has already contributed a video to the current active job
     */
    async checkCameraAlreadyProcessedInCurrentJob(cameraId) {
        try {
            // Get current active job
            const jobResult = await this.pool.query(`
                SELECT id, processed_cameras, expected_cameras, status 
                FROM video_transfer_queue_job 
                WHERE batch_origin = 'auto_video' 
                AND status IN ('created', 'pending', 'processing', 'transferring', 'paused')
                ORDER BY created_at DESC 
                LIMIT 1
            `);
            
            if (jobResult.rows.length === 0) {
                logger.info(`[CAMERA_CHECK] No active job found`);
                return false;
            }
            
            const currentJob = jobResult.rows[0];
            
            // Check if camera is already in processed_cameras array
            const processedCameras = currentJob.processed_cameras || [];
            const isAlreadyProcessed = processedCameras.includes(cameraId.toString());
            
            if (isAlreadyProcessed) {
                logger.info(`[CAMERA_CHECK] Camera ${cameraId} already processed in job ${currentJob.id} (processed_cameras: [${processedCameras.join(', ')}])`);
                return true;
            }
            
            // Double-check by looking at actual videos in transfer queue for this job
            const videoResult = await this.pool.query(`
                SELECT id, video_file_name, camera_id 
                FROM video_transfer_queue 
                WHERE job_id = $1 
                AND camera_id = $2
                AND status IN ('pending', 'transferred')
                LIMIT 1
            `, [currentJob.id, cameraId]);
            
            if (videoResult.rows.length > 0) {
                logger.info(`[CAMERA_CHECK] Camera ${cameraId} already has video in transfer queue for job ${currentJob.id}: ${videoResult.rows[0].video_file_name}`);
                return true;
            }
            
            logger.info(`[CAMERA_CHECK] Camera ${cameraId} has not yet contributed to job ${currentJob.id}`);
            return false;
            
        } catch (error) {
            logger.error(`[CAMERA_CHECK] Error checking if camera ${cameraId} already processed in current job:`, error);
            return false; // Default to allowing processing if check fails
        }
    }

    /**
     * Clean up stale processing markers
     */
    async cleanupStaleProcessingMarkers() {
        try {
            const pattern = 'video_processing_in_progress:*';
            const keys = await this.redis.keys(pattern);
            
            let cleanedCount = 0;
            for (const key of keys) {
                try {
                    const value = await this.redis.get(key);
                    if (value) {
                        const data = JSON.parse(value);
                        const startedAt = new Date(data.startedAt);
                        const hoursSinceStart = (Date.now() - startedAt.getTime()) / (1000 * 60 * 60);
                        
                        // Remove markers older than 2 hours
                        if (hoursSinceStart > 2) {
                            await this.redis.del(key);
                            cleanedCount++;
                        }
                    }
                } catch (parseError) {
                    // Remove invalid markers
                    await this.redis.del(key);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                logger.info(`[CLEANUP] Removed ${cleanedCount} stale processing markers`);
            }
        } catch (error) {
            logger.error('[CLEANUP] Failed to cleanup stale processing markers:', error);
        }
    }
}

module.exports = ProcessingStateManager;

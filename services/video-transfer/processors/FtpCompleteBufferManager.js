const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'FtpCompleteBufferManager', logFile: 'video-ftp-pipeline' });
const path = require('path');
const fs = require('fs-extra');
const TransferUtils = require('../../shared/TransferUtils');

class FtpCompleteBufferManager {
    constructor(eventEmitter, pool, config, videoProcessor, jobManager) {
        this.eventEmitter = eventEmitter;
        this.pool = pool;
        this.config = config;
        this.videoProcessor = videoProcessor;
        this.jobManager = jobManager;
        this.currentSiteId = '';
        
        // FTP-specific table names
        this.bufferTable = 'ftp_video_converted_buffer';
        
        // Video statistics
        this.videoStats = {
            videosCreated: 0,
            totalProcessingTime: 0,
            errorsCount: 0,
            lastVideoCreated: null
        };
    }

    /**
     * Set current site ID
     */
    setCurrentSiteId(siteId) {
        this.currentSiteId = siteId;
    }

    /**
     * Get video statistics
     */
    getVideoStats() {
        return { ...this.videoStats };
    }

    /**
     * Store file in FTP buffer as pending
     */
    async storeFileInBufferAsPending(file, groupKey, intervalStart, intervalEnd, jobId, groupIntervalEnd) {
        logger.info(`[FTP_BUFFER] storeFileInBufferAsPending: Adding file ${file.id} to FTP buffer for job ${jobId}`);

        const insertQuery = `
            INSERT INTO ${this.bufferTable} (
                source_file_id, camera_id, site_id, recording_date, recording_time,
                precise_time, timezone_offset, group_key, job_id,
                group_interval_start, group_interval_end, status,
                created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            RETURNING *
        `;

        const { rows } = await this.pool.query(insertQuery, [
            file.id,
            file.camera_id,
            this.currentSiteId,
            file.recording_date,
            file.recording_time,
            file.precise_time,
            file.timezone_offset,
            groupKey,
            jobId,
            intervalStart,
            groupIntervalEnd || intervalEnd,
            'pending'
        ]);

        logger.info(`[FTP_BUFFER] storeFileInBufferAsPending: ✓ Stored file ${file.id} in FTP buffer with ID: ${rows[0].id}`);
        return rows[0];
    }

    /**
     * Convert single file and update FTP buffer
     */
    async convertSingleFile(file, bufferRecord, group) {
        logger.info(`[FTP_BUFFER] convertSingleFile: Converting file ${file.file_path} for FTP buffer record ${bufferRecord.id}`);

        try {
            // Construct temporary group directory path using bufferRecord since group might be null
            const cameraId = (group && group.camera_id) || bufferRecord.camera_id || 'unknown';
            const jobId = (group && group.job_id) || bufferRecord.job_id || 'unknown';
            
            logger.info(`[FTP_BUFFER] convertSingleFile: Debug - VIDEO_TEMP_DIR: ${this.videoProcessor.VIDEO_TEMP_DIR}, cameraId: ${cameraId}, jobId: ${jobId}`);
            
            // Ensure VIDEO_TEMP_DIR is defined
            const videoTempDir = this.videoProcessor.VIDEO_TEMP_DIR || path.join(__dirname, '../../../temp_video_processing_ftp');
            
            const tempGroupDir = path.join(
                videoTempDir,
                `ftp_cam_${cameraId}_job_${jobId}_${Date.now()}`
            );
            
            logger.info(`[FTP_BUFFER] convertSingleFile: Using tempGroupDir: ${tempGroupDir}`);

            // Use video processor to convert the file
            const convertedPath = await this.videoProcessor.convertSingleFile(file, bufferRecord, tempGroupDir);
            
            if (!convertedPath) {
                throw new Error('File conversion failed - no converted file returned');
            }

            // Get file size of converted file
            const stats = await fs.stat(convertedPath);
            const convertedSize = stats.size;

            const convertedFile = {
                convertedPath: convertedPath,
                convertedSize: convertedSize
            };

            // Update buffer record with converted file info
            await this.pool.query(`
                UPDATE ${this.bufferTable}
                SET 
                    converted_file_path = $1,
                    converted_file_name = $2,
                    converted_file_size = $3,
                    status = 'converted',
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $4
            `, [
                convertedFile.convertedPath,
                path.basename(convertedFile.convertedPath),
                convertedFile.convertedSize,
                bufferRecord.id
            ]);

            logger.info(`[FTP_BUFFER] convertSingleFile: ✓ Updated FTP buffer record ${bufferRecord.id} with converted file info`);
            return convertedFile;

        } catch (error) {
            logger.error(`[FTP_BUFFER] convertSingleFile: Failed to convert file ${file.id}:`, error);
            await this.markBufferEntryAsFailed(bufferRecord.id, error.message);
            throw error;
        }
    }

    /**
     * Mark buffer entry as failed
     */
    async markBufferEntryAsFailed(bufferRecordId, errorMessage) {
        await this.pool.query(`
            UPDATE ${this.bufferTable}
            SET 
                status = 'failed',
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [bufferRecordId]);

        logger.info(`[FTP_BUFFER] markBufferEntryAsFailed: ❌ Marked FTP buffer record ${bufferRecordId} as failed: ${errorMessage}`);
    }


    async searchFindalVideoInConversionStorage(finalVideoPath, finalVideoName, convertedFilePaths) {
        // Check if file already exists return it directly
        try {
            await fs.access(finalVideoPath);
            logger.info(`[VIDEO] VideoProcessor.searchFindalVideoInConversionStorage: Found existing file: ${finalVideoPath}`);
            const stats = await fs.stat(finalVideoPath);
            const fileSize = stats.size;
            
            logger.info(`[VIDEO] VideoProcessor.searchFindalVideoInConversionStorage: ✓ Found: ${finalVideoName} (${(fileSize/1024/1024).toFixed(2)} MB)`);
            
            return {
                videoPath: finalVideoPath,
                videoName: finalVideoName,
                fileSize: fileSize,
                convertedFilePaths: convertedFilePaths
            };
        } catch (error) {
            logger.info(`[VIDEO] VideoProcessor.searchFindalVideoInConversionStorage: File not found: ${finalVideoPath}`);
            return null;
        }
    }


    /**
     * Create video from FTP buffer for specific job and camera
     */
    async createVideoFromBuffer(jobId, cameraId) {
        logger.info(`[FTP_BUFFER] createVideoFromBuffer: Creating video for FTP job ${jobId}, camera ${cameraId}`);

        try {
            // Get converted files for this camera and job
            const { rows: groupedFiles } = await this.pool.query(`
                SELECT * FROM ${this.bufferTable}
                WHERE job_id = $1 
                AND camera_id = $2 
                AND status = 'grouped'
                ORDER BY recording_date, recording_time
            `, [jobId, cameraId]);
            // logger.info(groupedFiles);

            if (groupedFiles.length === 0) {
                throw new Error(`No grouped files found in FTP buffer for job ${jobId}, camera ${cameraId}`);
            }

            logger.info(`[FTP_BUFFER] createVideoFromBuffer: Found ${groupedFiles.length} grouped files for video creation`);

            // Extract file paths for concatenation
            const groupKey = groupedFiles[0].group_key;
            const convertedFilePaths = groupedFiles.map(f => f.converted_file_path);
            const bufferIds = groupedFiles.map(f => f.id);
            const sourceFileIds = groupedFiles.map(f => f.source_file_id);

            const finalVideoName = groupKey.endsWith('.mp4') ? groupKey : `${groupKey}.mp4`;
            const tempGroupDir = path.dirname(convertedFilePaths[0]);
            const finalVideoPath = path.join(tempGroupDir, finalVideoName);
            
            const startTime = Date.now();
            const processingTime = Date.now() - startTime;

            let videoResult = null;

            videoResult = await this.searchFindalVideoInConversionStorage(
                finalVideoPath, finalVideoName, convertedFilePaths
            );

            if (!videoResult) {
                // Create final concatenated video using VideoProcessor
                videoResult = await this.videoProcessor.createFinalVideo(
                    convertedFilePaths, finalVideoPath, finalVideoName
                );
            }

            // logger.info({
            //     videoResult
            // });

            // videoData.recordingDate,
            // videoData.intervalStart,
            // videoData.intervalEnd,
            // videoData.sourceFilesCount,

            
            // Update stats
            this.videoStats.videosCreated++;
            this.videoStats.totalProcessingTime += processingTime;
            this.videoStats.lastVideoCreated = new Date();

            const videoData = {
                videoPath: videoResult.videoPath,
                videoName: videoResult.videoName,
                fileSize: videoResult.fileSize,
                camera_id: cameraId,
                site_id: this.currentSiteId,
                sourceFileIds: sourceFileIds,
                group_key: groupKey
            };

            logger.info(`[FTP_BUFFER] createVideoFromBuffer: ✓ Created FTP video: ${finalVideoName} (${videoResult.fileSize} bytes) in ${processingTime}ms`);
            return videoData;

        } catch (error) {
            this.videoStats.errorsCount++;
            logger.error(`[FTP_BUFFER] createVideoFromBuffer: Failed to create video for FTP job ${jobId}, camera ${cameraId}:`, error);
            throw error;
        }
    }

    /**
     * Process files to FTP buffer (similar to existing buffer manager)
     */
    async processFilesToBuffer(group, jobId) {
        logger.info(`[FTP_BUFFER] processFilesToBuffer: Processing ${group.files.length} files for FTP job ${jobId}, camera ${group.camera_id}`);

        for (const file of group.files) {
            try {
                // Store file in FTP buffer as pending
                const bufferRecord = await this.storeFileInBufferAsPending(
                    file, 
                    group.groupKey, 
                    group.interval_start, 
                    group.interval_end, 
                    jobId, 
                    group.interval_end
                );

                // Convert the file
                await this.convertSingleFile(file, bufferRecord, group);

            } catch (error) {
                logger.error(`[FTP_BUFFER] processFilesToBuffer: Failed to process file ${file.id}:`, error);
                // Continue with other files
            }
        }

        logger.info(`[FTP_BUFFER] processFilesToBuffer: ✓ Completed processing files for FTP job ${jobId}, camera ${group.camera_id}`);
    }

    /**
     * Check for ready groups in FTP buffer
     */
    async checkReadyGroupsInBuffer() {
        logger.info('[FTP_BUFFER] checkReadyGroupsInBuffer: Checking for ready groups in FTP buffer');

        try {
            // Find groups that have enough converted files
            const { rows: readyGroups } = await this.pool.query(`
                SELECT 
                    job_id, 
                    camera_id, 
                    group_key,
                    COUNT(*) as converted_count
                FROM ${this.bufferTable}
                WHERE status = 'converted'
                AND group_key IS NOT NULL
                GROUP BY job_id, camera_id, group_key
                HAVING COUNT(*) >= $1
            `, [this.config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10]);

            logger.info(`[FTP_BUFFER] checkReadyGroupsInBuffer: Found ${readyGroups.length} ready groups in FTP buffer`);

            for (const group of readyGroups) {
                try {
                    // Mark files as grouped
                    await this.pool.query(`
                        UPDATE ${this.bufferTable}
                        SET status = 'grouped', updated_at = CURRENT_TIMESTAMP
                        WHERE job_id = $1 
                        AND camera_id = $2 
                        AND group_key = $3 
                        AND status = 'converted'
                    `, [group.job_id, group.camera_id, group.group_key]);

                    logger.info(`[FTP_BUFFER] checkReadyGroupsInBuffer: ✓ Marked group ${group.group_key} as ready for FTP job ${group.job_id}, camera ${group.camera_id}`);

                } catch (error) {
                    logger.error(`[FTP_BUFFER] checkReadyGroupsInBuffer: Failed to mark group as ready:`, error);
                }
            }

        } catch (error) {
            logger.error('[FTP_BUFFER] checkReadyGroupsInBuffer: Error:', error);
        }
    }

    /**
     * Clean up old FTP buffer entries
     */
    async cleanupOldBufferEntries(daysOld = 7) {
        try {
            const { rows } = await this.pool.query(`
                DELETE FROM ${this.bufferTable}
                WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '${daysOld} days'
                AND status IN ('failed', 'grouped')
                RETURNING id
            `);

            logger.info(`[FTP_BUFFER] cleanupOldBufferEntries: ✓ Cleaned up ${rows.length} old FTP buffer entries`);
            return rows.length;

        } catch (error) {
            logger.error('[FTP_BUFFER] cleanupOldBufferEntries: Error:', error);
            return 0;
        }
    }

    /**
     * Get FTP buffer statistics
     */
    async getBufferStatistics() {
        try {
            const { rows } = await this.pool.query(`
                SELECT 
                    status,
                    COUNT(*) as count,
                    COALESCE(SUM(converted_file_size), 0) as total_size
                FROM ${this.bufferTable}
                GROUP BY status
            `);

            const stats = {
                pending: 0,
                converted: 0,
                grouped: 0,
                failed: 0,
                totalSize: 0
            };

            rows.forEach(row => {
                stats[row.status] = parseInt(row.count);
                stats.totalSize += parseInt(row.total_size);
            });

            return stats;

        } catch (error) {
            logger.error('[FTP_BUFFER] getBufferStatistics: Error:', error);
            return null;
        }
    }
}

module.exports = FtpCompleteBufferManager;

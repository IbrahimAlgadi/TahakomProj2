const fs = require('fs-extra');
const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'CompleteBufferManager', logFile: 'video-usb-pipeline' });
const path = require('path');
const { sleep } = require('../../../utils.js');

class CompleteBufferManager {
    constructor(eventEmitter, pool, config, videoProcessor, jobManager) {
        this.eventEmitter = eventEmitter;
        this.pool = pool;
        this.config = config;
        this.videoProcessor = videoProcessor;
        this.jobManager = jobManager;
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
        this.VIDEO_TEMP_DIR = path.join(__dirname, '../../../temp_video_processing');
        this.currentSiteId = '';
        
        // Statistics
        this.videoStats = {
            totalVideosCreated: 0,
            totalFilesProcessed: 0,
            lastProcessedTime: null,
            errorsCount: 0
        };
    }

    /**
     * Update current site ID
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
     * Store file entry in buffer table with pending status
     */
    async storeFileInBufferAsPending(sourceFile, groupKey, intervalStart, intervalEnd, jobId, consistentDate = null) {
        try {
            // Check if file already exists in buffer for this job
            const existingCheck = await this.pool.query(`
                SELECT id, status FROM video_converted_buffer 
                WHERE source_file_id = $1 AND job_id = $2
            `, [sourceFile.id, jobId]);
            
            if (existingCheck.rows.length > 0) {
                const existing = existingCheck.rows[0];
                if (existing.status === 'pending') {
                    logger.info(`[BUFFER] CompleteBufferManager.storeFileInBufferAsPending: File ${sourceFile.file_name} already in buffer as pending for job ${jobId}, returning existing record (Buffer ID: ${existing.id})`);
                    return existing;
                } else if (existing.status === 'converted') {
                    logger.info(`[BUFFER] CompleteBufferManager.storeFileInBufferAsPending: File ${sourceFile.file_name} already converted in buffer for job ${jobId}, returning existing record (Buffer ID: ${existing.id})`);
                    return existing;
                } else {
                    // Clean up old entries with failed/error status and allow re-adding
                    logger.info(`[BUFFER] CompleteBufferManager.storeFileInBufferAsPending: Cleaning up old buffer entry for ${sourceFile.file_name} (status: ${existing.status}) in job ${jobId}`);
                    await this.pool.query(`DELETE FROM video_converted_buffer WHERE id = $1`, [existing.id]);
                }
            }

            const recordingDate = consistentDate || (
                sourceFile.recording_date instanceof Date 
                    ? sourceFile.recording_date.toISOString().split('T')[0]
                    : sourceFile.recording_date
            );
            
            const insertQuery = `
                INSERT INTO video_converted_buffer 
                (source_file_id, converted_file_path, converted_file_name, converted_file_size,
                 camera_id, site_id, recording_date, recording_time, precise_time, timezone_offset,
                 group_key, job_id, group_interval_start, group_interval_end, status)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
                RETURNING *;
            `;
            
            const result = await this.pool.query(insertQuery, [
                sourceFile.id, '', sourceFile.file_name.replace('.issvd', '_pending.mp4'), 0, sourceFile.camera_id, sourceFile.site_id,
                recordingDate, sourceFile.recording_time, sourceFile.precise_time, sourceFile.timezone_offset,
                groupKey, jobId, intervalStart, intervalEnd, 'pending'
            ]);
            
            const bufferRecord = result.rows[0];
            logger.info(`[BUFFER] CompleteBufferManager.storeFileInBufferAsPending: Added file to buffer for job ${jobId}: ${sourceFile.file_name} (Buffer ID: ${bufferRecord.id})`);
            return bufferRecord;
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.storeFileInBufferAsPending: Failed to store file in buffer for job ${jobId}: ${sourceFile.file_name}`, error);
            throw error;
        }
    }

    /**
     * Update buffer entry after successful conversion
     */
    async updateBufferAfterConversion(bufferId, convertedFilePath) {
        try {
            const stats = await fs.stat(convertedFilePath);
            const convertedFileName = path.basename(convertedFilePath);
            
            const result = await this.pool.query(`
                UPDATE video_converted_buffer 
                SET converted_file_path = $2, converted_file_name = $3, converted_file_size = $4,
                    status = 'converted', updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING id, status, group_key
            `, [bufferId, convertedFilePath, convertedFileName, stats.size]);
            
            if (result.rows.length > 0) {
                logger.info(`[BUFFER] CompleteBufferManager.updateBufferAfterConversion: ✓ Updated buffer entry ${bufferId}: ${convertedFileName} (${(stats.size/1024/1024).toFixed(2)} MB)`);
                return result.rows[0];
            } else {
                throw new Error(`[BUFFER_ERROR] CompleteBufferManager.updateBufferAfterConversion: Buffer entry ${bufferId} not found for update`);
            }
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.updateBufferAfterConversion: Failed to update buffer entry ${bufferId}:`, error);
            throw error;
        }
    }

    /**
     * Mark buffer entry as failed
     */
    async markBufferEntryAsFailed(bufferId, errorMessage) {
        try {
            await this.pool.query(`
                UPDATE video_converted_buffer 
                SET status = 'failed', updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [bufferId]);
            
            logger.info(`[BUFFER] CompleteBufferManager.markBufferEntryAsFailed: Marked buffer entry as failed (ID: ${bufferId})`);
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.markBufferEntryAsFailed: Failed to mark buffer entry as failed: ${error.message}`);
        }
    }

    /**
     * Check if camera group has enough converted files ready
     */
    async checkCameraGroupReady(cameraId, date, groupKey) {
        try {
            const query = `
                SELECT COUNT(*) as file_count
                FROM video_converted_buffer 
                WHERE camera_id = $1 
                AND recording_date = $2 
                AND group_key = $3 
                AND status = 'converted'
            `;
            
            const result = await this.pool.query(query, [cameraId, date, groupKey]);
            const fileCount = parseInt(result.rows[0].file_count);
            
            logger.info(`[BUFFER] CompleteBufferManager.checkCameraGroupReady: Camera ${cameraId} group ${groupKey}: ${fileCount}/${this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT} files converted`);
            
            return fileCount >= this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.checkCameraGroupReady: Failed to check camera group readiness:`, error);
            return false;
        }
    }

    /**
     * Get converted files for a specific group
     */
    async getConvertedFilesForGroup(cameraId, date, groupKey) {
        try {
            logger.info(`[BUFFER] CompleteBufferManager.getConvertedFilesForGroup: Querying for: camera=${cameraId}, date=${date}, groupKey=${groupKey}, status=converted`);
            
            const query = `
                SELECT * FROM video_converted_buffer 
                WHERE camera_id = $1 
                AND recording_date = $2 
                AND group_key = $3 
                AND status = 'converted'
                ORDER BY precise_time
                LIMIT $4
            `;
            
            const result = await this.pool.query(query, [cameraId, date, groupKey, this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
            logger.info(`[BUFFER] CompleteBufferManager.getConvertedFilesForGroup: Retrieved ${result.rows.length} converted files for concatenation`);
            
            return result.rows;
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.getConvertedFilesForGroup: Failed to get converted files for group:`, error);
            return [];
        }
    }


    /**
     * Get converted files for a specific group
     */
    async getConvertedFilesForJob(jobId, cameraId) {
        try {
            logger.info(`[BUFFER] CompleteBufferManager.getConvertedFilesForJob: Querying for: jobId=${jobId}, status=converted`);
            
            const query = `
                SELECT * FROM video_converted_buffer 
                WHERE camera_id = $1 AND job_id = $2 
                AND status = 'converted'
                ORDER BY precise_time
            `;
            
            const result = await this.pool.query(query, [cameraId, jobId]);
            logger.info(`[BUFFER] CompleteBufferManager.getConvertedFilesForJob: Retrieved ${result.rows.length} converted files for concatenation`);
            
            return result.rows;
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.getConvertedFilesForJob: Failed to get converted files for group:`, error);
            return [];
        }
    }


    /**
     * Get converted files for a specific group
     */
    async getGroupedFilesForJob(jobId, cameraId) {
        try {
            logger.info(`[BUFFER] CompleteBufferManager.getGroupedFilesForJob: Querying for: jobId=${jobId}, status=converted`);
            
            const query = `
                SELECT * FROM video_converted_buffer 
                WHERE camera_id = $1 AND job_id = $2 
                AND status = 'grouped'
                ORDER BY precise_time
            `;
            
            const result = await this.pool.query(query, [cameraId, jobId]);
            logger.info(`[BUFFER] CompleteBufferManager.getGroupedFilesForJob: Retrieved ${result.rows.length} grouped files for concatenation`);
            
            return result.rows;
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.getGroupedFilesForJob: Failed to get grouped files for group:`, error);
            return [];
        }
    }

    /**
     * Mark converted files as grouped after successful concatenation
     */
    async markFilesAsGrouped(bufferIds) {
        try {
            await this.pool.query(`
                UPDATE video_converted_buffer 
                SET status = 'grouped', updated_at = CURRENT_TIMESTAMP 
                WHERE id = ANY($1)
            `, [bufferIds]);
            
            logger.info(`[BUFFER] CompleteBufferManager.markFilesAsGrouped: Marked ${bufferIds.length} converted files as grouped`);
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.markFilesAsGrouped: Failed to mark files as grouped: ${error.message}`);
        }
    }

    /**
     * Process files to buffer (add to buffer, convert individually)
     */
    async processFilesToBuffer(group, jobId) {
        try {
            // After all files are processed, check if group is ready for concatenation
            const isReady = await this.checkCameraGroupReady(camera_id, date, group_key);
            if (isReady) {
                logger.info(`[BUFFER] CompleteBufferManager.processFilesToBuffer: Group ready for concatenation: camera ${camera_id}, interval ${interval_start}-${interval_end}`);
                // await this.createVideoFromBuffer(camera_id, date, group_key, interval_start, interval_end);
                const videoData = await this.createVideoFromBuffer(jobId, camera_id, date, group_key, interval_start, interval_end);
                if (videoData && this.eventEmitter) {
                    // Store the concatenated video in transfer queue
                    // [NOTE] Emitting videoCreated event to trigger job manager to add video to transfer queue
                    this.eventEmitter.emit('videoCreated', videoData, jobId);
                }
            }
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.processFilesToBuffer: Error processing files to buffer:`, error);
            throw error;
        }
    }

    /**
     * Convert a single file and update buffer
     */
    async convertSingleFile(file, bufferRecord, group=null) {
        // const { camera_id, date, interval_start, interval_end } = group;
        
        const tempGroupDir = path.join(this.VIDEO_TEMP_DIR, 'temp_cam_' + bufferRecord.camera_id);
        
        try {
            // Check if source file exists before attempting conversion
            if (!await fs.pathExists(file.file_path)) {
                const error = new Error(`Source file not found: ${file.file_path}`);
                logger.error(`[VIDEO_CONVERT_ERROR] CompleteBufferManager.convertSingleFile: ${error.message}`);
                
                // Mark file as deleted in database if it doesn't exist
                try {
                    await this.pool.query(`
                        UPDATE iss_media_files 
                        SET deleted = true, updated_at = CURRENT_TIMESTAMP 
                        WHERE id = $1
                    `, [file.id]);
                    logger.info(`[UPDATE] CompleteBufferManager.convertSingleFile: Marked file ${file.file_name} as deleted (ID: ${file.id})`);
                } catch (dbError) {
                    logger.error(`[ERROR] CompleteBufferManager.convertSingleFile: Failed to mark file as deleted: ${dbError.message}`);
                }
                
                // Mark buffer entry as failed due to missing source file
                await this.markBufferEntryAsFailed(bufferRecord.id, error.message);
                this.videoStats.errorsCount++;
                return;
            }
            
            logger.info(`[VIDEO_CONVERT] CompleteBufferManager.convertSingleFile: Converting file: ${bufferRecord.converted_file_name} -> ${tempGroupDir}`);

            const convertedFilePath = await this.videoProcessor.convertSingleFile(file, bufferRecord, tempGroupDir);
            
            // Update buffer entry with converted file info
            await this.updateBufferAfterConversion(bufferRecord.id, convertedFilePath);
            
            await sleep(100);
            
        } catch (error) {
            logger.error(`[VIDEO_CONVERT] CompleteBufferManager.convertSingleFile: Failed to convert: ${file.file_name}`, error.message);
            
            // Only mark as failed if we haven't already done so above
            if (!error.message.includes('Source file not found')) {
                await this.markBufferEntryAsFailed(bufferRecord.id, error.message);
                this.videoStats.errorsCount++;
            }
            return;
        }
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
     * Create final video from buffer when group is ready
     */
    async createVideoFromBuffer(jobId, cameraId) {
        const t0Build = Date.now();
        try {
            let videoResult;

            logger.info(`[BUFFER] CompleteBufferManager.createVideoFromBuffer: Creating video from buffer for camera ${cameraId} - ${jobId}`, { phase: 'video-build', cameraId, jobId });
            
            const cameraFileStatusCounts = await this.jobManager.getCameraFileCountsStatusBufferCheck(jobId, cameraId);

            // const cameraPendingCount = cameraFileStatusCounts.pending || 0;
            // const cameraConvertedCount = cameraFileStatusCounts.converted || 0;
            const cameraGroupedCount = cameraFileStatusCounts.grouped || 0;

            if (cameraGroupedCount < this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT) {
                logger.info(`[BUFFER] CompleteBufferManager.createVideoFromBuffer: ⚠️ Camera ${cameraId} has ${cameraGroupedCount} grouped files. Skipping video creation.`);
                return null;
            }
            
            // Get grouped files for this group
            const groupedFiles = await this.getGroupedFilesForJob(jobId, cameraId);
            
            if (groupedFiles.length === 0) {
                logger.error(`[BUFFER] CompleteBufferManager.createVideoFromBuffer: No grouped files found for group ${cameraId}_${jobId}`);
                return null;
            }
            
            // Extract file paths for concatenation
            const groupKey = groupedFiles[0].group_key;
            const convertedFilePaths = groupedFiles.map(f => f.converted_file_path);
            const bufferIds = groupedFiles.map(f => f.id);
            const sourceFileIds = groupedFiles.map(f => f.source_file_id);

            const finalVideoName = groupKey.endsWith('.mp4') ? groupKey : `${groupKey}.mp4`;
            const tempGroupDir = path.dirname(convertedFilePaths[0]);
            const finalVideoPath = path.join(tempGroupDir, finalVideoName);
            
            videoResult = await this.searchFindalVideoInConversionStorage(
                finalVideoPath, finalVideoName, convertedFilePaths
            );

            if (!videoResult) {
                // Create final concatenated video using VideoProcessor
                videoResult = await this.videoProcessor.createFinalVideo(
                    convertedFilePaths, finalVideoPath, finalVideoName, groupKey
                );
            }

            if (videoResult) {
                logger.info(`[VIDEO] CompleteBufferManager.createVideoFromBuffer: ✓ Created: ${videoResult.videoName} (${(videoResult.fileSize/1024/1024).toFixed(2)} MB)`, { phase: 'video-build', durationMs: Date.now() - t0Build, cameraId, groupKey, segmentCount: groupedFiles.length });
                
                // Mark buffer files as grouped
                // await this.markFilesAsGrouped(bufferIds);
                
                this.videoStats.totalVideosCreated++;
                this.videoStats.totalFilesProcessed += convertedFilePaths.length;
                this.videoStats.lastProcessedTime = new Date();

                // Clean up individual MP4 files
                logger.info(`[VIDEO_SEGMENT_CLEANUP] CompleteBufferManager.createVideoFromBuffer: Cleaning up ${videoResult.videoName} total of (${videoResult.convertedFilePaths.length}) files`);
                for (const filePath of videoResult.convertedFilePaths) {
                    try {
                        await fs.unlink(filePath);
                        logger.info(`[VIDEO_SEGMENT_CLEANUP] CompleteBufferManager.createVideoFromBuffer: Removed segment ${filePath} for final created video ${videoResult.videoName}`);
                    } catch (error) {
                        // Ignore cleanup errors
                    }
                }
                
                const videoData = {
                    videoPath: videoResult.videoPath,
                    videoName: videoResult.videoName,
                    fileSize: videoResult.fileSize,
                    camera_id: cameraId,
                    site_id: this.currentSiteId,
                    sourceFileIds: sourceFileIds,
                    group_key: groupKey
                };
                
                return videoData;
            } else {
                logger.error(`[VIDEO] CompleteBufferManager.createVideoFromBuffer: ✗ Failed to create video for group ${cameraId}_${groupKey}`, { phase: 'video-build', durationMs: Date.now() - t0Build, cameraId, groupKey });
                return null;
            }
            
        } catch (error) {
            logger.error(`[BUFFER] CompleteBufferManager.createVideoFromBuffer: Error creating video from buffer:`, error);
            return null;
        }
    }

    /**
     * Validate and fix file paths before concatenation
     */
    async validateAndFixFilePaths(groupedFiles, cameraId) {
        const validPaths = [];
        const invalidRecords = [];
        
        for (const file of groupedFiles) {
            try {
                // Check if the stored path exists
                await fs.access(file.converted_file_path);
                validPaths.push(file.converted_file_path);
            } catch (error) {
                logger.warn(`[BUFFER] File not found: ${file.converted_file_path}`);
                
                // Try to find the actual converted file
                const tempDir = path.join(this.VIDEO_TEMP_DIR, `temp_cam_${cameraId}`);
                const possiblePaths = [
                    path.join(tempDir, file.converted_file_name.replace('_pending.mp4', '.mp4')),
                    // path.join(tempDir, file.converted_file_name.replace('_pending', '_converted')),
                    // path.join(tempDir, file.converted_file_name.replace('pending', 'converted'))
                ];
                
                let foundPath = null;
                for (const possiblePath of possiblePaths) {
                    try {
                        await fs.access(possiblePath);
                        foundPath = possiblePath;
                        break;
                    } catch (e) {
                        // Continue searching
                    }
                }
                
                if (foundPath) {
                    logger.info(`[BUFFER] Found actual file: ${foundPath}`);
                    // Update database with correct path
                    await this.pool.query(
                        'UPDATE video_converted_buffer SET converted_file_path = $1 WHERE id = $2',
                        [foundPath, file.id]
                    );
                    validPaths.push(foundPath);
                } else {
                    invalidRecords.push(file);
                    logger.error(`[BUFFER] Could not locate converted file for: ${file.converted_file_name}`);
                }
            }
        }
        
        return { validPaths, invalidRecords };
    }

    /**
     * Check for ready groups and trigger video creation + transfer.
     * Called by _runBufferMonitoringLoop every 30 s as a catch-up pass for
     * converted files that the main processing loop has not yet grouped/concat'd.
     */
    async checkReadyGroupsInBuffer() {
        try {
            // Resolve the current active job once, before iterating groups
            const activeJobResult = await this.pool.query(`
                SELECT id, batch_id, processed_cameras, expected_cameras, status
                FROM video_transfer_queue_job
                WHERE batch_origin = 'auto_video'
                AND status IN ('created', 'transferring', 'paused')
                ORDER BY created_at DESC
                LIMIT 1
            `);

            if (activeJobResult.rows.length === 0) {
                return; // No active job — nothing to do
            }

            const activeJob = activeJobResult.rows[0];

            // Get distinct groups that have enough converted files
            const readyGroups = await this.pool.query(`
                SELECT 
                    camera_id, 
                    recording_date, 
                    group_key, 
                    group_interval_start, 
                    group_interval_end,
                    COUNT(*) as converted_count
                FROM video_converted_buffer 
                WHERE status = 'converted'
                GROUP BY camera_id, recording_date, group_key, group_interval_start, group_interval_end
                HAVING COUNT(*) >= $1
                ORDER BY recording_date, group_interval_start
            `, [this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT]);
            
            if (readyGroups.rows.length === 0) {
                return;
            }
            
            logger.info(`[BUFFER_MONITOR] CompleteBufferManager.checkReadyGroupsInBuffer: Found ${readyGroups.rows.length} ready groups for video creation`);
            
            for (const group of readyGroups.rows) {
                try {
                    logger.info(`[BUFFER_MONITOR] CompleteBufferManager.checkReadyGroupsInBuffer: Processing ready group: camera ${group.camera_id}, interval ${group.group_interval_start}-${group.group_interval_end}`);
                    
                    // Check if this camera has already contributed to the current job
                    const hasAlreadyContributed = await this.checkCameraAlreadyProcessedInCurrentJob(group.camera_id);
                    if (hasAlreadyContributed) {
                        logger.info(`[BUFFER_MONITOR] CompleteBufferManager.checkReadyGroupsInBuffer: Skipping ready group for camera ${group.camera_id} - already contributed to current job`);
                        continue;
                    }
                    
                    const videoData = await this.createVideoFromBuffer(
                        activeJob.id,
                        group.camera_id
                    );
                    
                    if (videoData && this.eventEmitter) {
                        await this.jobManager.addVideoToTransferQueue(videoData, activeJob.id);
                        await this.jobManager.addCameraToProcessed(activeJob.id, videoData.camera_id);
                        await this.jobManager.updateJobStatsToTransfered(activeJob.id);
                        logger.info(`[BUFFER_MONITOR] CompleteBufferManager.checkReadyGroupsInBuffer: Video queued for transfer: ${videoData.videoName}`);
                        this.eventEmitter.emit('startTransferToStorage', activeJob.id, videoData.camera_id, activeJob.batch_id);
                    }
                    
                } catch (error) {
                    logger.error(`[BUFFER_MONITOR] CompleteBufferManager.checkReadyGroupsInBuffer: Error processing ready group for camera ${group.camera_id}:`, error);
                }
            }
            
        } catch (error) {
            logger.error('[BUFFER_MONITOR] CompleteBufferManager.checkReadyGroupsInBuffer: Error checking ready groups:', error);
        }
    }

    /**
     * Helper method to check if camera already processed in current job
     */
    async checkCameraAlreadyProcessedInCurrentJob(cameraId) {
        try {
            // Get current active job
            const jobResult = await this.pool.query(`
                SELECT id, processed_cameras, expected_cameras, status 
                FROM video_transfer_queue_job 
                WHERE batch_origin = 'auto_video' 
                AND status IN ('created', 'transferring', 'paused')
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
                logger.info(`[CAMERA_CHECK] CompleteBufferManager.checkCameraAlreadyProcessedInCurrentJob: Camera ${cameraId} already processed in job ${currentJob.id} (processed_cameras: [${processedCameras.join(', ')}])`);
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
                logger.info(`[CAMERA_CHECK] CompleteBufferManager.checkCameraAlreadyProcessedInCurrentJob: Camera ${cameraId} already has video in transfer queue for job ${currentJob.id}: ${videoResult.rows[0].video_file_name}`);
                return true;
            }
            
            logger.info(`[CAMERA_CHECK] CompleteBufferManager.checkCameraAlreadyProcessedInCurrentJob: Camera ${cameraId} has not yet contributed to job ${currentJob.id}`);
            return false;
            
        } catch (error) {
            logger.error(`[CAMERA_CHECK] CompleteBufferManager.checkCameraAlreadyProcessedInCurrentJob: Error checking if camera ${cameraId} already processed in current job:`, error);
            return false; // Default to allowing processing if check fails
        }
    }
}

module.exports = CompleteBufferManager;

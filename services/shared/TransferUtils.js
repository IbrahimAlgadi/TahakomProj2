const { createLogger } = require('../../utils/logger');

const logger = createLogger({ service: 'TransferUtils', logFile: 'image-usb-pipeline' });

/**
 * Shared Transfer Utilities
 * Common operations used by both USB and FTP video/image transfer services
 */

class TransferUtils {
    
    /**
     * Mark source files as transferred in iss_media_files table
     */
    static async markSourceFilesAsTransferred(pool, sourceFileIds, transferType = 'auto') {
        if (!sourceFileIds || sourceFileIds.length === 0) {
            return;
        }

        logger.info(`[TRANSFER_UTILS] markSourceFilesAsTransferred: Marking ${sourceFileIds.length} source files as transferred (${transferType})`);
        
        try {
            const updateField = transferType === 'ftp' ? 'is_ftp_transferred' : 'is_auto_transferred';
            
            await pool.query(`
                UPDATE iss_media_files 
                SET ${updateField} = true, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ANY($1)
            `, [sourceFileIds]);

            logger.info(`[TRANSFER_UTILS] markSourceFilesAsTransferred: ✓ Marked ${sourceFileIds.length} source files as ${transferType} transferred`);
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] markSourceFilesAsTransferred: Error:', error);
            throw error;
        }
    }

    /**
     * Mark source files as transferred in iss_media_files table
     */
    static async markUSBSourceFilesAsTransferred(pool, sourceFileIds, transferType = 'auto') {
        if (!sourceFileIds || sourceFileIds.length === 0) {
            return;
        }

        logger.info(`[TRANSFER_UTILS] markSourceFilesAsTransferred: Marking ${sourceFileIds.length} source files as transferred (${transferType})`);
        
        try {
            
            await pool.query(`
                UPDATE files 
                SET is_auto_transferred = true
                WHERE id = ANY($1)
            `, [sourceFileIds]);

            logger.info(`[TRANSFER_UTILS] markSourceFilesAsTransferred: ✓ Marked ${sourceFileIds.length} source files as ${transferType} transferred`);
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] markSourceFilesAsTransferred: Error:', error);
            throw error;
        }
    }

    /**
     * Handle transfer error with retry logic
     */
    static async handleTransferError(pool, file, error, tableName = 'video_transfer_queue') {
        logger.error(`[TRANSFER_UTILS] handleTransferError: Transfer failed for ${file.video_file_name}:`, error);
        
        const newRetryCount = (file.retry_count || 0) + 1;
        const shouldStopProcessing = error.message.includes('ENOSPC') || 
                                   error.message.includes('space') ||
                                   error.message.includes('Connection') ||
                                   error.message.includes('ECONNREFUSED');
        
        if (newRetryCount >= (file.max_retries || 3)) {
            await pool.query(`
                UPDATE ${tableName} 
                SET status = 'failed', retry_count = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [newRetryCount, error.message.substring(0, 500), file.id]);
            
            logger.info(`[TRANSFER_UTILS] handleTransferError: ❌ Max retries reached for file ${file.id}, marked as failed`);
        } else {
            await pool.query(`
                UPDATE ${tableName} 
                SET retry_count = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [newRetryCount, error.message.substring(0, 500), file.id]);
            
            logger.info(`[TRANSFER_UTILS] handleTransferError: ⏳ Retry ${newRetryCount}/${file.max_retries || 3} scheduled for file ${file.id}`);
        }
        
        return { 
            shouldStopProcessing,
            retryCount: newRetryCount,
            maxRetriesReached: newRetryCount >= (file.max_retries || 3)
        };
    }

    /**
     * Cleanup temporary video file
     */
    static async cleanupTempVideo(videoPath) {
        const fs = require('fs-extra');
        try {
            if (await fs.pathExists(videoPath)) {
                await fs.remove(videoPath);
                logger.info(`[TRANSFER_UTILS] cleanupTempVideo: ✓ Cleaned up temp video: ${videoPath}`);
                return true;
            }
            return false;
        } catch (error) {
            logger.error('[TRANSFER_UTILS] cleanupTempVideo: Error cleaning up temp video:', error);
            return false;
        }
    }

    /**
     * Update transfer queue job status
     */
    static async updateJobStatus(pool, jobId, status, tableName = 'video_transfer_queue_job') {
        try {
            const statusField = status === 'transferring' ? 'started_at' : 
                              status === 'completed' ? 'completed_at' : null;
            
            let query = `UPDATE ${tableName} SET status = $1, updated_at = CURRENT_TIMESTAMP`;
            let params = [status, jobId];
            
            if (statusField) {
                query += `, ${statusField} = CURRENT_TIMESTAMP`;
            }
            
            query += ` WHERE id = $2`;
            
            await pool.query(query, params);
            logger.info(`[TRANSFER_UTILS] updateJobStatus: ✓ Updated job ${jobId} status to ${status}`);
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] updateJobStatus: Error:', error);
            throw error;
        }
    }

    /**
     * Check if job is complete (all cameras processed and transferred)
     */
    static async checkJobCompletion(pool, jobId, transferQueueTable, jobTable) {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_videos,
                    COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_videos
                FROM ${transferQueueTable}
                WHERE job_id = $1
            `, [jobId]);
            
            const { total_videos, transferred_videos } = result.rows[0];
            const isComplete = total_videos > 0 && transferred_videos === total_videos;
            
            if (isComplete) {
                await TransferUtils.updateJobStatus(pool, jobId, 'completed', jobTable);
                logger.info(`[TRANSFER_UTILS] checkJobCompletion: ✓ Job ${jobId} marked as completed (${transferred_videos}/${total_videos} videos transferred)`);
            }
            
            return isComplete;
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] checkJobCompletion: Error:', error);
            return false;
        }
    }

    /**
     * Get file statistics for a job
     */
    static async getJobStatistics(pool, jobId, transferQueueTable) {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_videos,
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_videos,
                    COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_videos,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_videos,
                    COALESCE(SUM(video_file_size), 0) as total_size,
                    COALESCE(SUM(CASE WHEN status = 'transferred' THEN video_file_size ELSE 0 END), 0) as transferred_size
                FROM ${transferQueueTable}
                WHERE job_id = $1
            `, [jobId]);
            
            return result.rows[0];
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] getJobStatistics: Error:', error);
            return {
                total_videos: 0,
                pending_videos: 0,
                transferred_videos: 0,
                failed_videos: 0,
                total_size: 0,
                transferred_size: 0
            };
        }
    }

    /**
     * Update job statistics
     */
    static async updateJobStatistics(pool, jobId, jobTable, transferQueueTable) {
        try {
            const stats = await TransferUtils.getJobStatistics(pool, jobId, transferQueueTable);
            
            await pool.query(`
                UPDATE ${jobTable} 
                SET 
                    total_videos = $1,
                    total_size = $2,
                    transferred_videos = $3,
                    transferred_size = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5
            `, [
                stats.total_videos,
                stats.total_size,
                stats.transferred_videos,
                stats.transferred_size,
                jobId
            ]);
            
            logger.info(`[TRANSFER_UTILS] updateJobStatistics: ✓ Updated job ${jobId} stats: ${stats.transferred_videos}/${stats.total_videos} videos transferred`);
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] updateJobStatistics: Error:', error);
            throw error;
        }
    }

    /**
     * Validate file before transfer
     */
    static async validateFileForTransfer(filePath) {
        const fs = require('fs-extra');
        const path = require('path');
        
        try {
            if (!await fs.pathExists(filePath)) {
                throw new Error(`File does not exist: ${filePath}`);
            }
            
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) {
                throw new Error(`Path is not a file: ${filePath}`);
            }
            
            if (stats.size === 0) {
                throw new Error(`File is empty: ${filePath}`);
            }
            
            const ext = path.extname(filePath).toLowerCase();
            if (!['.mp4', '.avi', '.mov', '.mkv'].includes(ext)) {
                logger.warn(`[TRANSFER_UTILS] validateFileForTransfer: Warning - unusual video file extension: ${ext}`);
            }
            
            return {
                valid: true,
                size: stats.size,
                extension: ext
            };
            
        } catch (error) {
            return {
                valid: false,
                error: error.message
            };
        }
    }

    /**
     * Generate transfer destination path
     */
    static generateDestinationPath(baseDir, videoFileName, cameraId, recordingDate) {
        const path = require('path');
        
        // Create directory structure: baseDir/videos/YYYY-MM-DD/camera_X/
        const dateStr = recordingDate ? new Date(recordingDate).toISOString().split('T')[0] : 
                       new Date().toISOString().split('T')[0];
        
        const relativePath = path.join('videos', dateStr, `camera_${cameraId}`, videoFileName);
        const fullPath = path.join(baseDir, relativePath);
        
        return {
            relativePath,
            fullPath,
            directory: path.dirname(fullPath)
        };
    }

    // ==================== IMAGE-SPECIFIC METHODS ====================

    /**
     * Mark source image files as transferred in files table
     */
    static async markImageFilesAsTransferred(pool, fileIds, transferType = 'auto') {
        if (!fileIds || fileIds.length === 0) {
            return;
        }

        logger.info(`[TRANSFER_UTILS] markImageFilesAsTransferred: Marking ${fileIds.length} image files as transferred (${transferType})`);
        
        try {
            const updateField = transferType === 'ftp' ? 'is_ftp_transferred' : 'is_auto_transferred';
            
            await pool.query(`
                UPDATE files 
                SET ${updateField} = true 
                WHERE id = ANY($1)
            `, [fileIds]);

            logger.info(`[TRANSFER_UTILS] markImageFilesAsTransferred: ✓ Marked ${fileIds.length} image files as ${transferType} transferred`);
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] markImageFilesAsTransferred: Error:', error);
            throw error;
        }
    }

    /**
     * Handle image transfer error with retry logic
     */
    static async handleImageTransferError(pool, file, error, tableName = 'transfer_queue') {
        logger.error(`[TRANSFER_UTILS] handleImageTransferError: Transfer failed for ${file.file_path}:`, error);
        
        const newRetryCount = (file.retry_count || 0) + 1;
        const shouldStopProcessing = error.message.includes('ENOSPC') || 
                                   error.message.includes('space') ||
                                   error.message.includes('Connection') ||
                                   error.message.includes('ECONNREFUSED') ||
                                   error.message.includes('Drive') ||
                                   error.message.includes('USB');
        
        if (newRetryCount >= (file.max_retries || 3)) {
            await pool.query(`
                UPDATE ${tableName} 
                SET status = 'failed', retry_count = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [newRetryCount, error.message.substring(0, 500), file.id]);
            
            logger.info(`[TRANSFER_UTILS] handleImageTransferError: ❌ Max retries reached for image file ${file.id}, marked as failed`);
        } else {
            await pool.query(`
                UPDATE ${tableName} 
                SET retry_count = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [newRetryCount, error.message.substring(0, 500), file.id]);
            
            logger.info(`[TRANSFER_UTILS] handleImageTransferError: ⏳ Retry ${newRetryCount}/${file.max_retries || 3} scheduled for image file ${file.id}`);
        }
        
        return { 
            shouldStopProcessing,
            retryCount: newRetryCount,
            maxRetriesReached: newRetryCount >= (file.max_retries || 3)
        };
    }

    /**
     * Validate image file before transfer
     */
    static async validateImageFileForTransfer(filePath) {
        const fs = require('fs-extra');
        const path = require('path');
        
        const supportedImageExtensions = ['.jpg', '.jpeg', '.png'];
        
        try {
            if (!await fs.pathExists(filePath)) {
                throw new Error(`Image file does not exist: ${filePath}`);
            }
            
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) {
                throw new Error(`Path is not a file: ${filePath}`);
            }
            
            if (stats.size === 0) {
                throw new Error(`Image file is empty: ${filePath}`);
            }
            
            const ext = path.extname(filePath).toLowerCase();
            if (!supportedImageExtensions.includes(ext)) {
                throw new Error(`Unsupported image format: ${ext}. Supported formats: ${supportedImageExtensions.join(', ')}`);
            }
            
            return {
                valid: true,
                size: stats.size,
                extension: ext,
                isImage: true
            };
            
        } catch (error) {
            return {
                valid: false,
                error: error.message,
                isImage: false
            };
        }
    }

    /**
     * Get image file statistics for a job
     */
    static async getImageJobStatistics(pool, jobId, transferQueueTable) {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_files,
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_files,
                    COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_files,
                    COALESCE(SUM(file_size), 0) as total_size,
                    COALESCE(SUM(CASE WHEN status = 'transferred' THEN file_size ELSE 0 END), 0) as transferred_size
                FROM ${transferQueueTable}
                WHERE job_id = $1
            `, [jobId]);
            
            return result.rows[0];
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] getImageJobStatistics: Error:', error);
            return {
                total_files: 0,
                pending_files: 0,
                transferred_files: 0,
                failed_files: 0,
                total_size: 0,
                transferred_size: 0
            };
        }
    }

    /**
     * Update image job statistics
     */
    static async updateImageJobStatistics(pool, jobId, jobTable, transferQueueTable) {
        try {
            const stats = await TransferUtils.getImageJobStatistics(pool, jobId, transferQueueTable);
            
            await pool.query(`
                UPDATE ${jobTable} 
                SET 
                    total_files = $1,
                    total_size = $2,
                    transferred_files = $3,
                    transferred_size = $4,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $5
            `, [
                stats.total_files,
                stats.total_size,
                stats.transferred_files,
                stats.transferred_size,
                jobId
            ]);
            
            logger.info(`[TRANSFER_UTILS] updateImageJobStatistics: ✓ Updated job ${jobId} stats: ${stats.transferred_files}/${stats.total_files} images transferred`);
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] updateImageJobStatistics: Error:', error);
            throw error;
        }
    }

    /**
     * Check if image job is complete
     */
    static async checkImageJobCompletion(pool, jobId, transferQueueTable, jobTable) {
        try {
            const result = await pool.query(`
                SELECT 
                    COUNT(*) as total_files,
                    COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files
                FROM ${transferQueueTable}
                WHERE job_id = $1
            `, [jobId]);
            
            const { total_files, transferred_files } = result.rows[0];
            const isComplete = total_files > 0 && transferred_files === total_files;
            
            if (isComplete) {
                await TransferUtils.updateJobStatus(pool, jobId, 'completed', jobTable);
                logger.info(`[TRANSFER_UTILS] checkImageJobCompletion: ✓ Job ${jobId} marked as completed (${transferred_files}/${total_files} images transferred)`);
            }
            
            return isComplete;
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] checkImageJobCompletion: Error:', error);
            return false;
        }
    }

    /**
     * Generate image transfer destination path maintaining folder structure
     */
    static generateImageDestinationPath(sourceFilePath, exportDir, targetDir) {
        const path = require('path');
        
        try {
            // Calculate relative path from export directory
            const relativePath = path.relative(exportDir, sourceFilePath);
            const destinationPath = path.join(targetDir, relativePath);
            
            // Normalize path separators for the target platform
            const normalizedPath = path.normalize(destinationPath);
            
            return {
                relativePath,
                fullPath: normalizedPath,
                directory: path.dirname(normalizedPath),
                filename: path.basename(normalizedPath)
            };
            
        } catch (error) {
            logger.error('[TRANSFER_UTILS] generateImageDestinationPath: Error:', error);
            throw new Error(`Failed to generate destination path: ${error.message}`);
        }
    }

    /**
     * Calculate estimated transfer time for images
     */
    static calculateImageTransferEstimate(files) {
        const totalSize = files.reduce((sum, file) => sum + (file.file_size || 0), 0);
        const avgTransferSpeedMBps = 15; // Average MB/s for image transfers
        
        const totalSizeMB = totalSize / (1024 * 1024);
        const estimatedSeconds = Math.ceil(totalSizeMB / avgTransferSpeedMBps);
        
        return {
            totalFiles: files.length,
            totalSizeMB: Math.round(totalSizeMB * 100) / 100,
            estimatedSeconds,
            estimatedTimeString: TransferUtils.formatDuration(estimatedSeconds)
        };
    }

    /**
     * Format duration in seconds to human-readable string
     */
    static formatDuration(seconds) {
        if (seconds < 60) {
            return `${seconds} seconds`;
        } else if (seconds < 3600) {
            const minutes = Math.floor(seconds / 60);
            const remainingSeconds = seconds % 60;
            return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes} minutes`;
        } else {
            const hours = Math.floor(seconds / 3600);
            const remainingMinutes = Math.floor((seconds % 3600) / 60);
            return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours} hours`;
        }
    }

    /**
     * Detect if error is drive/USB related
     */
    static isDriveRelatedError(error) {
        const driveErrorPatterns = [
            /drive.*disconnected/i,
            /usb.*removed/i,
            /device.*not.*ready/i,
            /no.*such.*device/i,
            /unknown.*error.*mkdir/i,
            /enoent.*mkdir/i,
            /write.*[f-z]:\\/i,
            /path.*not.*found/i
        ];
        
        const errorText = error.message || error.toString();
        return driveErrorPatterns.some(pattern => pattern.test(errorText));
    }

    /**
     * Detect if error is file-not-found related
     */
    static isFileNotFoundError(error) {
        return error.code === 'ENOENT' && ['lstat', 'stat', 'open', 'read'].includes(error.syscall);
    }

    /**
     * Batch process image files with size validation
     */
    static async validateImageBatch(files, maxBatchSizeMB = 100) {
        const results = {
            valid: [],
            invalid: [],
            oversized: [],
            totalSize: 0
        };

        let currentBatchSize = 0;
        
        for (const file of files) {
            const fileSizeMB = (file.file_size || 0) / (1024 * 1024);
            
            // Check if adding this file would exceed batch size
            if (currentBatchSize + fileSizeMB > maxBatchSizeMB && results.valid.length > 0) {
                results.oversized.push({
                    file: file,
                    reason: `Would exceed batch size limit (${maxBatchSizeMB}MB)`
                });
                continue;
            }
            
            try {
                const validation = await TransferUtils.validateImageFileForTransfer(file.file_path);
                
                if (validation.valid) {
                    results.valid.push(file);
                    results.totalSize += file.file_size || 0;
                    currentBatchSize += fileSizeMB;
                } else {
                    results.invalid.push({
                        file: file,
                        error: validation.error
                    });
                }
            } catch (error) {
                results.invalid.push({
                    file: file,
                    error: error.message
                });
            }
        }

        logger.info(`[TRANSFER_UTILS] validateImageBatch: ${results.valid.length} valid, ${results.invalid.length} invalid, ${results.oversized.length} oversized`);
        return results;
    }
}

module.exports = TransferUtils;

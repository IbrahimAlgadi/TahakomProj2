const { createLogger } = require('../../utils/logger');

const logger = createLogger({ service: 'CleanupService', logFile: 'video-usb-pipeline' });
const fs = require('fs-extra');
const path = require('path');

class CleanupService {
    constructor(eventEmitter, pool, redis, config) {
        this.eventEmitter = eventEmitter;
        this.pool = pool;
        this.redis = redis;
        this.config = config;
        this.VIDEO_TEMP_DIR = path.join(__dirname, '../../temp_video_processing');
    }

    /**
     * Recursively remove directory (Node.js v12 compatible)
     */
    async removeDirectoryRecursive(dirPath) {
        try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dirPath, entry.name);
                if (entry.isDirectory()) {
                    await this.removeDirectoryRecursive(fullPath);
                } else {
                    await fs.unlink(fullPath);
                }
            }
            
            await fs.rmdir(dirPath);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    /**
     * Run all cleanup tasks
     */
    async runAllCleanupTasks() {
        logger.info('[CLEANUP] Running all cleanup tasks');
        
        try {
            await this.cleanupOldFailedJobs();
            await this.cleanupCorruptedBufferEntries();
            await this.cleanupStaleBufferEntries();
            await this.cleanupStaleProcessingMarkers();
            await this.cleanupTempVideoFiles();
            
            logger.info('[CLEANUP] All cleanup tasks completed successfully');
        } catch (error) {
            logger.error('[CLEANUP] Error during cleanup tasks:', error);
            throw error;
        }
    }

    /**
     * Clean up old failed jobs
     */
    async cleanupOldFailedJobs() {
        try {
            const result = await this.pool.query(`
                DELETE FROM video_transfer_queue_job 
                WHERE status = 'failed' 
                AND created_at < NOW() - INTERVAL '1 hour'
                RETURNING id
            `);
            
            if (result.rows.length > 0) {
                logger.info(`[CLEANUP] Removed ${result.rows.length} old failed jobs`);
            }
        } catch (error) {
            logger.error('[CLEANUP] Error during cleanup of old failed jobs:', error);
            throw error;
        }
    }

    /**
     * Clean up corrupted buffer entries
     */
    async cleanupCorruptedBufferEntries() {
        try {
            const result = await this.pool.query(`
                SELECT id, converted_file_path, source_file_id
                FROM video_converted_buffer 
                WHERE status = 'converted'
                AND created_at < NOW() - INTERVAL '1 hour'
            `);
            
            let cleanedCount = 0;
            
            for (const entry of result.rows) {
                if (!await fs.pathExists(entry.converted_file_path)) {
                    await this.pool.query(`
                        UPDATE video_converted_buffer 
                        SET status = 'failed', updated_at = CURRENT_TIMESTAMP 
                        WHERE id = $1
                    `, [entry.id]);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                logger.info(`[CLEANUP] Marked ${cleanedCount} corrupted buffer entries as failed`);
            }
        } catch (error) {
            logger.error('[CLEANUP] Failed to cleanup corrupted buffer entries:', error);
            throw error;
        }
    }

    /**
     * Clean up stale buffer entries.
     * Excludes entries belonging to any job that is still active (created / transferring / paused)
     * so that in-flight conversions are never removed mid-pipeline.
     */
    async cleanupStaleBufferEntries() {
        try {
            // Exclude entries whose job is still active so mid-pipeline files are untouched
            const activeJobGuard = `
                (job_id IS NULL OR job_id NOT IN (
                    SELECT id FROM video_transfer_queue_job
                    WHERE status IN ('created', 'transferring', 'paused')
                ))
            `;

            // Delete disk files first so DB stays consistent even if fs call fails
            const oldConvertedFiles = await this.pool.query(`
                SELECT id, converted_file_path, status
                FROM video_converted_buffer 
                WHERE status IN ('converted', 'grouped', 'failed')
                AND created_at < NOW() - INTERVAL '2 hours'
                AND converted_file_path != ''
                AND ${activeJobGuard}
            `);
            
            for (const file of oldConvertedFiles.rows) {
                try {
                    if (await fs.pathExists(file.converted_file_path)) {
                        await fs.unlink(file.converted_file_path);
                        logger.info(`[CLEANUP] Removed old converted file: ${file.converted_file_path}`);
                    }
                } catch (fileError) {
                    logger.warn(`[CLEANUP] Failed to remove file ${file.converted_file_path}:`, fileError.message);
                }
            }
            
            // Now clean up database entries (same guard applied)
            const result = await this.pool.query(`
                DELETE FROM video_converted_buffer 
                WHERE status IN ('converted', 'grouped', 'failed')
                AND created_at < NOW() - INTERVAL '2 hours'
                AND ${activeJobGuard}
                RETURNING id, status, source_file_id
            `);
            
            if (result.rows.length > 0) {
                logger.info(`[CLEANUP] Removed ${result.rows.length} stale buffer entries (active-job rows protected)`);
            }
        } catch (error) {
            logger.error('[CLEANUP] Failed to cleanup stale buffer entries:', error);
            throw error;
        }
    }

    /**
     * Clean up stale processing markers.
     * Skips markers whose source file is still present in video_converted_buffer
     * with status 'pending' or 'converted' to avoid allowing duplicate pickup of
     * slow-converting files.
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
                            // Skip if the file is still actively in the conversion buffer
                            const fileId = key.split(':').pop();
                            if (fileId) {
                                const bufferCheck = await this.pool.query(`
                                    SELECT id FROM video_converted_buffer
                                    WHERE source_file_id = $1
                                    AND status IN ('pending', 'converted')
                                    LIMIT 1
                                `, [parseInt(fileId, 10)]);
                                
                                if (bufferCheck.rows.length > 0) {
                                    logger.info(`[CLEANUP] Skipping stale marker for file ${fileId} — still active in buffer`);
                                    continue;
                                }
                            }
                            
                            await this.redis.del(key);
                            cleanedCount++;
                        }
                    }
                } catch (parseError) {
                    // Remove markers with invalid JSON (no fileId to check)
                    await this.redis.del(key);
                    cleanedCount++;
                }
            }
            
            if (cleanedCount > 0) {
                logger.info(`[CLEANUP] Removed ${cleanedCount} stale processing markers`);
            }
        } catch (error) {
            logger.error('[CLEANUP] Failed to cleanup stale processing markers:', error);
            throw error;
        }
    }

    /**
     * Clean up temporary video files and directories.
     * Skips any path (or directory containing a path) that is currently referenced
     * by a pending video_transfer_queue row so a queued-but-not-yet-transferred
     * video is never deleted beneath an active transfer.
     */
    async cleanupTempVideoFiles() {
        try {
            if (!await fs.pathExists(this.VIDEO_TEMP_DIR)) {
                return;
            }

            // Build a protected-path index from the transfer queue
            const pendingResult = await this.pool.query(`
                SELECT video_file_path
                FROM video_transfer_queue
                WHERE status = 'pending'
                AND video_file_path IS NOT NULL
                AND video_file_path != ''
            `);
            const pendingPaths = new Set(pendingResult.rows.map(r => r.video_file_path));
            const pendingDirs  = new Set(pendingResult.rows.map(r => path.dirname(r.video_file_path)));

            const entries = await fs.readdir(this.VIDEO_TEMP_DIR, { withFileTypes: true });
            let cleanedCount = 0;

            for (const entry of entries) {
                if (entry.isDirectory()) {
                    const dirPath = path.join(this.VIDEO_TEMP_DIR, entry.name);

                    // Skip if a pending transfer lives inside this directory
                    if (pendingDirs.has(dirPath)) {
                        logger.info(`[CLEANUP] Skipping temp directory with pending transfer: ${entry.name}`);
                        continue;
                    }

                    try {
                        const dirStats = await fs.stat(dirPath);
                        const hoursSinceModified = (Date.now() - dirStats.mtime.getTime()) / (1000 * 60 * 60);
                        
                        // Remove directories older than 4 hours
                        if (hoursSinceModified > 4) {
                            await this.removeDirectoryRecursive(dirPath);
                            cleanedCount++;
                            logger.info(`[CLEANUP] Removed old temp directory: ${entry.name}`);
                        }
                    } catch (error) {
                        logger.warn(`[CLEANUP_ERROR] Failed to remove temp directory ${entry.name}:`, error.message);
                    }
                } else if (entry.isFile()) {
                    const filePath = path.join(this.VIDEO_TEMP_DIR, entry.name);

                    // Skip if this exact file is pending transfer
                    if (pendingPaths.has(filePath)) {
                        logger.info(`[CLEANUP] Skipping temp file with pending transfer: ${entry.name}`);
                        continue;
                    }

                    try {
                        const fileStats = await fs.stat(filePath);
                        const hoursSinceModified = (Date.now() - fileStats.mtime.getTime()) / (1000 * 60 * 60);
                        
                        // Remove files older than 2 hours
                        if (hoursSinceModified > 2) {
                            await fs.unlink(filePath);
                            cleanedCount++;
                            logger.info(`[CLEANUP] Removed old temp file: ${entry.name}`);
                        }
                    } catch (error) {
                        logger.warn(`[CLEANUP] Failed to remove temp file ${entry.name}:`, error.message);
                    }
                }
            }

            if (cleanedCount > 0) {
                logger.info(`[CLEANUP] Removed ${cleanedCount} old temporary files/directories`);
            }
        } catch (error) {
            logger.error('[CLEANUP] Failed to cleanup temporary video files:', error);
            throw error;
        }
    }

    /**
     * Clean up specific temporary video file
     */
    async cleanupTempVideo(videoPath) {
        try {
            await fs.unlink(videoPath);
            logger.info(`[CLEANUP] Deleted temporary video: ${videoPath}`);
            
            const parentDir = path.dirname(videoPath);
            const files = await fs.readdir(parentDir);
            if (files.length === 0) {
                await fs.rmdir(parentDir);
                logger.info(`[CLEANUP] Removed empty temporary directory: ${parentDir}`);
            }
        } catch (error) {
            logger.warn(`[CLEANUP] Could not clean up temporary file/directory: ${videoPath}`, error.message);
        }
    }

    /**
     * Clean up Redis cache entries
     */
    async cleanupRedisCache(pattern, maxAge = 3600000) { // Default 1 hour
        try {
            const keys = await this.redis.keys(pattern);
            let cleanedCount = 0;
            
            for (const key of keys) {
                try {
                    const ttl = await this.redis.ttl(key);
                    if (ttl === -1) { // No expiration set
                        await this.redis.del(key);
                        cleanedCount++;
                    }
                } catch (error) {
                    logger.warn(`[CLEANUP] Failed to check/remove Redis key ${key}:`, error.message);
                }
            }
            
            if (cleanedCount > 0) {
                logger.info(`[CLEANUP] Removed ${cleanedCount} Redis cache entries matching pattern: ${pattern}`);
            }
        } catch (error) {
            logger.error(`[CLEANUP] Failed to cleanup Redis cache for pattern ${pattern}:`, error);
            throw error;
        }
    }

    /**
     * Clean up orphaned database entries
     */
    async cleanupOrphanedEntries() {
        try {
            // Clean up video_transfer_queue entries without corresponding jobs
            const orphanedVideos = await this.pool.query(`
                DELETE FROM video_transfer_queue 
                WHERE job_id NOT IN (SELECT id FROM video_transfer_queue_job)
                RETURNING id
            `);
            
            if (orphanedVideos.rows.length > 0) {
                logger.info(`[CLEANUP] Removed ${orphanedVideos.rows.length} orphaned video transfer entries`);
            }
            
            // Clean up buffer entries for files that no longer exist
            const orphanedBuffer = await this.pool.query(`
                DELETE FROM video_converted_buffer 
                WHERE source_file_id NOT IN (SELECT id FROM iss_media_files)
                RETURNING id
            `);
            
            if (orphanedBuffer.rows.length > 0) {
                logger.info(`[CLEANUP] Removed ${orphanedBuffer.rows.length} orphaned buffer entries`);
            }
            
        } catch (error) {
            logger.error('[CLEANUP] Failed to cleanup orphaned entries:', error);
            throw error;
        }
    }
}

module.exports = CleanupService;

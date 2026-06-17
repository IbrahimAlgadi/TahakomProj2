const express = require('express');

function createMediaFilesRouter({ logger, pool }) {
    const router = express.Router();

    // Media Files Dashboard Page
    router.get('/media-files', (req, res) => {
        res.render('media-files/dashboard');
    });

    // API: Get media files statistics
    router.get('/api/media-files/stats', async (req, res) => {
        try {
            // Get overall statistics
            const overallStatsQuery = `
                SELECT 
                    COUNT(*) as total_files,
                    COALESCE(SUM(file_size), 0) as total_size,
                    COUNT(DISTINCT camera_id) as total_cameras,
                    MIN(recording_date) as oldest_file_date,
                    MAX(recording_date) as newest_file_date,
                    COUNT(CASE WHEN deleted = false THEN 1 END) as active_files,
                    COUNT(CASE WHEN deleted = true THEN 1 END) as deleted_files
                FROM iss_media_files
            `;

            const overallStats = await pool.query(overallStatsQuery);

            // Get statistics per camera
            const cameraStatsQuery = `
                SELECT 
                    camera_id,
                    COUNT(*) as file_count,
                    COALESCE(SUM(file_size), 0) as total_size,
                    COUNT(CASE WHEN deleted = false THEN 1 END) as active_files,
                    COUNT(CASE WHEN deleted = true THEN 1 END) as deleted_files,
                    MIN(recording_date) as oldest_file,
                    MAX(recording_date) as newest_file,
                    MAX(created_at) as last_indexed
                FROM iss_media_files
                GROUP BY camera_id
                ORDER BY camera_id
            `;

            const cameraStats = await pool.query(cameraStatsQuery);

            // Get daily statistics for the last 7 days (or all available data if less than 7 days)
            const dailyStatsQuery = `
                SELECT 
                    recording_date,
                    COUNT(*) as files_count,
                    COALESCE(SUM(file_size), 0) as total_size,
                    COUNT(DISTINCT camera_id) as cameras_active
                FROM iss_media_files
                WHERE deleted = false
                GROUP BY recording_date
                ORDER BY recording_date DESC
                LIMIT 7
            `;

            const dailyStats = await pool.query(dailyStatsQuery);

            // Get hourly distribution for today or most recent day with activity
            const hourlyStatsQuery = `
                SELECT 
                    EXTRACT(HOUR FROM precise_time) as hour,
                    COUNT(*) as files_count,
                    COUNT(DISTINCT camera_id) as cameras_active,
                    recording_date
                FROM iss_media_files
                WHERE recording_date = (
                    SELECT recording_date 
                    FROM iss_media_files 
                    WHERE deleted = false 
                    ORDER BY recording_date DESC 
                    LIMIT 1
                ) AND deleted = false
                GROUP BY EXTRACT(HOUR FROM precise_time), recording_date
                ORDER BY hour
            `;

            const hourlyStats = await pool.query(hourlyStatsQuery);

            // Get storage growth trend (last 30 days)
            const storageGrowthQuery = `
                SELECT 
                    recording_date,
                    COALESCE(SUM(file_size), 0) as daily_size,
                    COUNT(*) as daily_files
                FROM iss_media_files
                WHERE recording_date >= CURRENT_DATE - INTERVAL '30 days'
                    AND deleted = false
                GROUP BY recording_date
                ORDER BY recording_date
            `;

            const storageGrowth = await pool.query(storageGrowthQuery);

            // Calculate retention period and estimated cleanup
            const retentionDays = 7; // From your ISS_MEDIA_RETENTION config
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            const retentionQuery = `
                SELECT 
                    COUNT(*) as files_beyond_retention,
                    COALESCE(SUM(file_size), 0) as size_beyond_retention
                FROM iss_media_files
                WHERE recording_date < $1 AND deleted = false
            `;

            const retentionStats = await pool.query(retentionQuery, [cutoffDate.toISOString().split('T')[0]]);

            res.json({
                success: true,
                data: {
                    overall: overallStats.rows[0],
                    cameras: cameraStats.rows,
                    daily: dailyStats.rows,
                    hourly: hourlyStats.rows,
                    storageGrowth: storageGrowth.rows,
                    retention: {
                        retentionDays: retentionDays,
                        cutoffDate: cutoffDate.toISOString().split('T')[0],
                        ...retentionStats.rows[0]
                    }
                }
            });

        } catch (error) {
            logger.error('Error fetching media files statistics:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch media files statistics'
            });
        }
    });

    // API: Get real-time monitoring status from Redis
    router.get('/api/media-files/monitoring-status', async (req, res) => {
        try {
            const Redis = require('ioredis');
            const redis = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: process.env.REDIS_PORT || 6379,
                retryStrategy: () => null // Don't retry on failure
            });

            const { MEDIA_INDEX_STATUS } = require('../redisKeyStore.js');
            const statusData = await redis.get(MEDIA_INDEX_STATUS);
            
            if (statusData) {
                const status = JSON.parse(statusData);
                res.json({
                    success: true,
                    data: status
                });
            } else {
                res.json({
                    success: true,
                    data: {
                        historicalScan: {
                            totalFilesScanned: 0,
                            totalFilesInserted: 0,
                            camerasCompleted: 0,
                            errors: 0
                        },
                        realTimeMonitoring: {
                            filesProcessedToday: 0,
                            lastFileTime: null,
                            errors: 0
                        }
                    }
                });
            }

            await redis.quit();

        } catch (error) {
            logger.error('Error fetching monitoring status:', error);
            res.json({
                success: false,
                data: null
            });
        }
    });

    // API: Get file system information
    router.get('/api/media-files/filesystem-info', async (req, res) => {
        try {
            const config = require('../utils/envConfig');
            const { ISS_MEDIA_DIR, ISS_MEDIA_CAMERAS, ISS_MEDIA_RETENTION } = config;

            // Calculate expected vs actual file counts
            const filesPerCameraPerDay = 42000; // From your configuration
            const totalCameras = ISS_MEDIA_CAMERAS.length;
            const expectedTotalFiles = totalCameras * ISS_MEDIA_RETENTION * filesPerCameraPerDay;

            res.json({
                success: true,
                data: {
                    mediaDirectory: ISS_MEDIA_DIR,
                    cameras: ISS_MEDIA_CAMERAS,
                    retentionDays: ISS_MEDIA_RETENTION,
                    expectedFilesPerCameraPerDay: filesPerCameraPerDay,
                    expectedTotalFiles: expectedTotalFiles,
                    totalCameras: totalCameras
                }
            });

        } catch (error) {
            logger.error('Error fetching filesystem info:', error);
            res.status(500).json({
                success: false,
                error: 'Failed to fetch filesystem information'
            });
        }
    });

    return router;
}

module.exports = { createMediaFilesRouter };

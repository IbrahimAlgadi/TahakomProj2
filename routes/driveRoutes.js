const express = require('express');
const { 
    getDriveInfo, 
    testDriveConnection, 
    getConnectedDrives, 
    getAllSystemDrives,
    isValidDriveLetter 
} = require('../utils/driveUtils');

function createDriveRouter({ logger, redis }) {
    const router = express.Router();

    /**
     * GET /drives
     * Get list of all connected drives
     */
    router.get('/drives', async (req, res) => {
        try {
            const drives = await getConnectedDrives(redis);
            res.json({ success: true, drives });
        } catch (error) {
            logger.error('Error getting drives:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get drives' 
            });
        }
    });

    /**
     * POST /drives/test
     * Test drive connection and space availability
     * Body: { drive: string, minRequiredSpace?: number }
     * minRequiredSpace is optional - defaults to 1GB if not provided
     */
    router.post('/drives/test', async (req, res) => {
        try {
            let { drive, minRequiredSpace } = req.body;
            minRequiredSpace = minRequiredSpace || 1024 * 1024;
            drive = drive.slice(0, 1).toUpperCase();
            // console.log(drive, minRequiredSpace);
            
            if (!drive) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Drive letter is required', 
                    connected: false 
                });
            }

            if (!isValidDriveLetter(drive)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid drive letter format', 
                    connected: false 
                });
            }

            // Pass minRequiredSpace only if provided, let the function use its default if undefined
            const result = await testDriveConnection(drive, minRequiredSpace);
            
            // Set appropriate HTTP status based on result
            const statusCode = result.success ? 200 : (result.connected ? 200 : 500);
            res.status(statusCode).json(result);
            
        } catch (error) {
            logger.error('Error testing drive:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Internal server error during drive test', 
                connected: false 
            });
        }
    });

    /**
     * GET /drives/info/:drive
     * Get detailed information about a specific drive
     */
    router.get('/drives/info/:drive', async (req, res) => {
        try {
            const { drive } = req.params;
            
            if (!isValidDriveLetter(drive)) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid drive letter format' 
                });
            }

            const driveInfo = await getDriveInfo(`${drive}:`);
            res.json({ 
                success: true, 
                driveInfo 
            });
            
        } catch (error) {
            logger.error(`Error getting drive info for ${req.params.drive}:`, error);
            res.status(500).json({ 
                success: false, 
                error: 'Drive not found or not accessible' 
            });
        }
    });

    /**
     * POST /drives/refresh
     * Refresh and get updated list of all system drives
     */
    router.post('/drives/refresh', async (req, res) => {
        try {
            // Get fresh system drives data
            const systemDrives = await getAllSystemDrives();
            
            // You could also trigger a Redis update here if needed
            // await updateRedisWithDrives(redis, systemDrives);
            
            res.json({ 
                success: true, 
                drives: systemDrives,
                message: 'Drives refreshed successfully' 
            });
            
        } catch (error) {
            logger.error('Error refreshing drives:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to refresh drives' 
            });
        }
    });

    /**
     * GET /drives/system
     * Get all available system drives (not just connected ones)
     */
    router.get('/drives/system', async (req, res) => {
        try {
            const drives = await getAllSystemDrives();
            res.json({ success: true, drives });
        } catch (error) {
            logger.error('Error getting system drives:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to get system drives' 
            });
        }
    });

    return router;
}

module.exports = { createDriveRouter }; 
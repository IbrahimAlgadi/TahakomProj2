const si = require('systeminformation');
const { CONNECTED_DRIVE_LIST } = require('../redisKeyStore.js');

/**
 * Get detailed information about a specific drive
 * @param {string} driveLetter - Drive letter (e.g., 'C:', 'E:')
 * @returns {Promise<Object>} Drive information object
 */
async function getDriveInfo(driveLetter) {
    console.log("getDriveInfo: ", driveLetter);
    try {
        const data = await si.fsSize(driveLetter);
        if (!data || data.length === 0) {
            throw new Error(`Drive ${driveLetter} not found or not accessible.`);
        }
        const fs = data[0];
        return {
            drive: driveLetter,
            totalSpace: fs.size,
            usedSpace: fs.used,
            remainingSpace: fs.available,
            usedPercentage: fs.use,
            type: fs.type,
            readWrite: fs.rw
        };
    } catch (error) {
        throw error;
    }
}

/**
 * Test drive connection and check if it has sufficient space
 * @param {string} drive - Drive letter (without colon)
 * @param {number} minRequiredSpace - Minimum required space in bytes (default: 1MB)
 * @returns {Promise<Object>} Test result object
 */
async function testDriveConnection(drive, minRequiredSpace = 1024 * 1024) {
    try {
        drive = drive.slice(0, 1).toUpperCase();
        const driveInfo = await getDriveInfo(`${drive}:`);
        
        if (driveInfo.remainingSpace < minRequiredSpace) {
            return {
                success: false,
                connected: true,
                error: `Drive has insufficient space (minimum ${formatFileSize(minRequiredSpace)} required)`,
                driveInfo
            };
        }
        
        return {
            success: true,
            connected: true,
            message: 'Drive is connected and has sufficient space',
            driveInfo
        };
    } catch (error) {
        console.log("testDriveConnection error: ", error);
        return {
            success: false,
            connected: false,
            error: 'Drive not found or not accessible'
        };
    }
}

/**
 * Get list of connected drives from Redis
 * @param {Object} redis - Redis client instance
 * @returns {Promise<Array>} Array of drive objects
 */
async function getConnectedDrives(redis) {
    try {
        let driveList = await redis.get(CONNECTED_DRIVE_LIST);
        driveList = JSON.parse(driveList || '[]');
        return driveList.map(drive => ({
            letter: drive.drive,
            label: drive.label || `Drive ${drive.drive}`,
            totalSpace: drive.totalSpace,
            usedSpace: drive.usedSpace,
            remainingSpace: drive.remainingSpace,
            usedPercentage: drive.usedPercentage,
            type: drive.type,
            readWrite: drive.readWrite,
            status: drive.status || 'connected'
        }));
    } catch (error) {
        console.error('Error getting connected drives:', error);
        return [];
    }
}

/**
 * Get information for all available drives
 * @returns {Promise<Array>} Array of all system drives
 */
async function getAllSystemDrives() {
    try {
        const drives = await si.fsSize();
        return drives.map(drive => ({
            letter: drive.fs.replace(':', ''),
            label: drive.fs,
            totalSpace: drive.size,
            usedSpace: drive.used,
            remainingSpace: drive.available,
            usedPercentage: drive.use,
            type: drive.type,
            readWrite: drive.rw
        }));
    } catch (error) {
        console.error('Error getting system drives:', error);
        return [];
    }
}

/**
 * Format file size in human readable format
 * @param {number} bytes - Size in bytes
 * @returns {string} Formatted size string
 */
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = (bytes / Math.pow(1024, i)).toFixed(2);
    return `${value} ${sizes[i]}`;
}

/**
 * Check if a drive letter is valid
 * @param {string} drive - Drive letter to validate
 * @returns {boolean} True if valid
 */
function isValidDriveLetter(drive) {
    return /^[A-Za-z]$/.test(drive);
}

module.exports = {
    getDriveInfo,
    testDriveConnection,
    getConnectedDrives,
    getAllSystemDrives,
    formatFileSize,
    isValidDriveLetter
};

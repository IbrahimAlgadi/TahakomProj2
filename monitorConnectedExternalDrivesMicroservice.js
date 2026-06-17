const Redis = require('ioredis');
const si = require('systeminformation');
const { CONNECTED_DRIVE_LIST, CONNECTED_DRIVE_LIST_UPDATE, CONNECTED_DRIVE_STATE, CONFIG_STATE_KEY } = require('./redisKeyStore.js');
const { sleep, formatGB } = require('./utils.js');
const { Pool } = require('pg');

let DB_USER = "postgres";
let DB_PASSWORD = "postgres";
let DB_HOST = "localhost";
let DB_APP = "tahakom_transfer";

// Initialize Redis clients
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

const redisPubSub = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD
});

// Track currently connected drives and config state
let connectedDrives = new Set();
let CONFIG_STATE = {};
let lastUptimeUpdate = 0;
const UPTIME_UPDATE_INTERVAL = 60000; // Update uptime every minute

// Subscribe to config updates
redisPubSub.subscribe(CONFIG_STATE_KEY + '_update', (err, count) => {
    if (err) {
        console.error('[CONFIG UPDATE] Failed to subscribe to config updates: %s', err.message);
    } else {
        console.log(`[CONFIG UPDATE] Subscribed successfully to config updates! Listening on ${count} channel(s).`);
    }
});

redisPubSub.on('message', async (channel, message) => {
    if (channel === CONFIG_STATE_KEY + '_update') {
        CONFIG_STATE = JSON.parse(message);
        console.log('[CONFIG UPDATE] Config updated:', CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive);
    }
});

// Function to insert new device connection
async function insertDeviceConnection(driveInfo) {
    // First mark any existing connected records as disconnected
    await markDeviceDisconnected(driveInfo.drive);
    
    const query = `
        INSERT INTO device_connections 
        (drive_letter, label, total_space, used_space, remaining_space, 
         used_percentage, filesystem_type, is_read_write)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        RETURNING id;
    `;
    
    try {
        const result = await pool.query(query, [
            driveInfo.drive,
            driveInfo.label,
            driveInfo.totalSpace,
            driveInfo.usedSpace,
            driveInfo.remainingSpace,
            driveInfo.usedPercentage,
            driveInfo.type,
            driveInfo.readWrite === 'Yes'
        ]);
        return result.rows[0].id;
    } catch (error) {
        console.error('Error inserting device connection:', error);
        return null;
    }
}

// Function to update device status to disconnected
async function markDeviceDisconnected(driveLetter) {
    console.log(`[MARK DRIVE DISCONNECTED] Marking drive ${driveLetter} as disconnected`);
    const query = `
        UPDATE device_connections 
        SET status = 'disconnected', 
            disconnected_at = CURRENT_TIMESTAMP,
            last_updated = CURRENT_TIMESTAMP
        WHERE drive_letter = $1 
        AND status = 'connected';
    `;

    
    try {
        await pool.query(query, [driveLetter]);
        console.log(`[MARK DRIVE DISCONNECTED] Marked drive ${driveLetter} as disconnected`);
    } catch (error) {
        console.error('[MARK DRIVE DISCONNECTED] Error marking device as disconnected:', error);
    }
}

// Function to update device information
async function updateDeviceInfo(driveInfo) {
    console.log(`[UPDATE DRIVE INFO] Updating drive ${driveInfo.drive} info`);
    const query = `
        UPDATE device_connections 
        SET total_space = $1,
            used_space = $2,
            remaining_space = $3,
            used_percentage = $4,
            last_updated = CURRENT_TIMESTAMP
        WHERE drive_letter = $5 
        AND status = 'connected';
    `;
    
    try {
        await pool.query(query, [
            driveInfo.totalSpace,
            driveInfo.usedSpace,
            driveInfo.remainingSpace,
            driveInfo.usedPercentage,
            driveInfo.drive
        ]);
        console.log(`[UPDATE DRIVE INFO] Updated drive ${driveInfo.drive} info`);
    } catch (error) {
        console.error('[UPDATE DRIVE INFO] Error updating device info:', error);
    }
}

// Enhanced uptime calculation function
async function calculateAndUpdateUptime() {
    console.log(`[UPDATE UPTIME] Calculating and updating uptime`);
    const query = `
        UPDATE device_connections 
        SET 
            current_uptime_minutes = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - connected_at))/60,
            total_uptime_minutes = COALESCE(total_uptime_minutes, 0) + 1,
            last_updated = CURRENT_TIMESTAMP
        WHERE status = 'connected';
    `;
    
    try {
        const result = await pool.query(query);
        if (result.rowCount > 0) {
            console.log(`[UPDATE UPTIME] Updated uptime for ${result.rowCount} connected devices`);
        }
    } catch (error) {
        console.error('[UPDATE UPTIME] Error calculating uptime:', error);
    }
}

// Function to get specific drive info for auto-transfer
async function getSpecificDriveInfo(driveLetter) {
    console.log(`[GET DRIVE INFO] Getting specific drive info for ${driveLetter}`);
    if (!driveLetter) {
        return {
            isConnected: false,
            drive: 'N/A',
            totalSpace: 0,
            usedSpace: 0,
            remainingSpace: 0,
            usedPercentage: 0
        };
    }

    try {
        const fsData = await si.fsSize(driveLetter + ":");
        console.log(`[GET DRIVE INFO] Drive ${driveLetter} info`);
        
        // Check if fsData exists and has data
        if (!fsData || fsData.length === 0 || !fsData[0]) {
            console.log(`[GET DRIVE INFO] Drive ${driveLetter} not found or not accessible`);
            return {
                isConnected: false,
                drive: driveLetter,
                totalSpace: 0,
                usedSpace: 0,
                remainingSpace: 0,
                usedPercentage: 0,
                type: 'N/A',
                readWrite: 'No'
            };
        }
        
        const fs = fsData[0];
        if (!fs) {
            console.log(`[GET DRIVE INFO] Drive ${driveLetter} info not found`);
            return {
                isConnected: false,
                drive: driveLetter,
                totalSpace: 0,
                usedSpace: 0,
                remainingSpace: 0,
                usedPercentage: 0,
                type: 'N/A',
                readWrite: 'No'
            };
        }

        // Additional safety check for fs properties (similar to main loop)
        if (!fs.size || !fs.used || !fs.available) {
            console.log(`[GET DRIVE INFO] Drive ${driveLetter} has incomplete filesystem data`);
            return {
                isConnected: false,
                drive: driveLetter,
                totalSpace: 0,
                usedSpace: 0,
                remainingSpace: 0,
                usedPercentage: 0,
                type: 'N/A',
                readWrite: 'No'
            };
        }


        console.log(`[GET DRIVE INFO] Drive ${driveLetter} info:`);
        return {
            isConnected: true,
            drive: driveLetter,
            totalSpace: formatGB(fs.size),
            usedSpace: formatGB(fs.used),
            remainingSpace: formatGB(fs.available),
            usedPercentage: fs.use,
            type: fs.type ? fs.type.toUpperCase() : 'UNKNOWN',
            readWrite: fs.rw ? 'Yes' : 'No'
        };
    } catch (error) {
        console.error(`[GET DRIVE INFO] Error getting drive info for ${driveLetter}:`, error);
        return {
            isConnected: false,
            drive: driveLetter,
            totalSpace: 0,
            usedSpace: 0,
            remainingSpace: 0,
            usedPercentage: 0
        };
    }
}

// Run the enhanced monitor service
async function runEnhancedMonitor() {
    // Clear existing Redis data
    await redis.del(CONNECTED_DRIVE_LIST);

    console.log('[START DRIVE MONITOR] Starting Enhanced Drive Monitor Service...');

    // Cache for inaccessible drives to avoid repeated expensive checks
    const inaccessibleDrives = new Map(); // Map<driveLetter, lastCheckTime>
    const INACCESSIBLE_RECHECK_INTERVAL = 30000; // Recheck inaccessible drives every 30 seconds

    while (true) {
        const now = Date.now();
        let driveList = [];
        let driveListString = JSON.stringify(driveList);

        try {
            // 1. Monitor ALL external drives (existing functionality)
            const blockData = await si.blockDevices();
            const systemDrives = ['C:', 'D:', 'I:'];
            const externalDrives = blockData.filter(drive => !systemDrives.includes(drive.name));

            // Get current drive letters
            const currentDrives = new Set(externalDrives.map(drive => drive.name.slice(0, 2)));

            // Clean up cache for disconnected drives
            for (const [cachedDrive] of inaccessibleDrives) {
                if (!currentDrives.has(cachedDrive)) {
                    inaccessibleDrives.delete(cachedDrive);
                }
            }

            // Check for disconnected drives
            for (const drive of connectedDrives) {
                if (!currentDrives.has(drive)) {
                    await markDeviceDisconnected(drive);
                    connectedDrives.delete(drive);
                    console.log(`[DRIVE DISCONNECTED] Drive ${drive} disconnected`);
                }
            }

            // Process connected external drives
            for (const drive of externalDrives) {
                const driveLetter = drive.name.slice(0, 2);

                // Skip drives we know are inaccessible (but recheck periodically)
                const lastCheck = inaccessibleDrives.get(driveLetter);
                if (lastCheck && (now - lastCheck) < INACCESSIBLE_RECHECK_INTERVAL) {
                    continue; // Skip this drive for now
                }

                try {
                    const fsData = await si.fsSize(drive.mount);

                    // Check if filesystem data exists
                    if (!fsData || fsData.length === 0 || !fsData[0]) {
                        if (!inaccessibleDrives.has(driveLetter)) {
                            console.log(`[SKIP DRIVE] Drive ${driveLetter} has no accessible filesystem`);
                        }
                        inaccessibleDrives.set(driveLetter, now); // Cache with timestamp
                        continue;
                    }

                    const fs = fsData[0];

                    // Additional safety check for fs properties
                    if (!fs.size || !fs.used || !fs.available) {
                        if (!inaccessibleDrives.has(driveLetter)) {
                            console.log(`[SKIP DRIVE] Drive ${driveLetter} has incomplete filesystem data`);
                        }
                        inaccessibleDrives.set(driveLetter, now); // Cache with timestamp
                        continue;
                    }

                    // Drive is accessible - remove from inaccessible cache if present
                    if (inaccessibleDrives.has(driveLetter)) {
                        console.log(`[DRIVE ACCESSIBLE] Drive ${driveLetter} is now accessible`);
                        inaccessibleDrives.delete(driveLetter);
                    }

                    const driveInfo = {
                        isConnected: true,
                        drive: driveLetter,
                        label: drive.label,
                        totalSpace: formatGB(fs.size),
                        usedSpace: formatGB(fs.used),
                        remainingSpace: formatGB(fs.available),
                        usedPercentage: fs.use,
                        type: fs.type ? fs.type.toUpperCase() : 'UNKNOWN',
                        readWrite: fs.rw ? 'Yes' : 'No'
                    };

                    // If drive is newly connected, insert new record
                    if (!connectedDrives.has(driveInfo.drive)) {
                        await insertDeviceConnection(driveInfo);
                        connectedDrives.add(driveInfo.drive);
                        console.log(`[DRIVE CONNECTED] Drive ${driveInfo.drive} connected`);
                    } else {
                        // Update existing record (silently, no log spam)
                        await updateDeviceInfo(driveInfo);
                    }

                    driveList.push(driveInfo);
                } catch (error) {
                    console.error('[PROCESS DRIVE ERROR] Error processing drive:', error);
                }
            }

            // 2. Handle specific drive for auto-transfer
            const autoTransferDrive = CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive;
            const specificDriveState = await getSpecificDriveInfo(autoTransferDrive);

            // 3. Update Redis and publish updates
            driveListString = JSON.stringify(driveList);

            // Publish to both channels
            await redis.set(CONNECTED_DRIVE_LIST, driveListString);
            await redis.publish(CONNECTED_DRIVE_LIST_UPDATE, driveListString);

            await redis.set(CONNECTED_DRIVE_STATE, JSON.stringify(specificDriveState));
            await redis.publish(CONNECTED_DRIVE_STATE + '_update', JSON.stringify(specificDriveState));

            // 4. Update uptime periodically
            if (now - lastUptimeUpdate > UPTIME_UPDATE_INTERVAL) {
                await calculateAndUpdateUptime();
                lastUptimeUpdate = now;
            }

            // Log status (reduced verbosity)
            console.log(`[MONITOR] Drives: ${driveList.length} accessible, ${inaccessibleDrives.size} cached as inaccessible`);

            await sleep(1000); // Keep 1 second for real-time detection

        } catch (error) {
            console.error('[MONITOR ERROR] Enhanced Monitor error:', error);
            // Still publish empty data on error
            await redis.set(CONNECTED_DRIVE_LIST, driveListString);
            await redis.publish(CONNECTED_DRIVE_LIST_UPDATE, driveListString);

            const disconnectedState = {
                isConnected: false,
                drive: (CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive) || 'N/A',
                totalSpace: 0,
                usedSpace: 0,
                remainingSpace: 0,
                usedPercentage: 0
            };
            await redis.set(CONNECTED_DRIVE_STATE, JSON.stringify(disconnectedState));
            await redis.publish(CONNECTED_DRIVE_STATE + '_update', JSON.stringify(disconnectedState));

            await sleep(1000);
            continue;
        }
    }
}

// Start the service
async function startService() {
    console.log('[MONITOR START] Initializing Enhanced Drive Monitor...');
    
    // Start the monitoring loop
    await runEnhancedMonitor();
}

// Start the service
startService();

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('[MONITRO CLOSE] Cleaning up Enhanced Drive Monitor...');
    await redis.quit();
    await redisPubSub.quit();
    await pool.end();
    process.exit(0);
});

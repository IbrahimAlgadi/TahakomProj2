const Redis = require('ioredis');
const si = require('systeminformation');
const { CONNECTED_DRIVE_LIST, CONNECTED_DRIVE_LIST_UPDATE, CONNECTED_DRIVE_STATE, CONFIG_STATE_KEY } = require('./redisKeyStore.js');
const { sleep, formatGB } = require('./utils.js');
const { Pool } = require('pg');
const { createLogger } = require('./utils/logger');

const logger = createLogger({ service: 'monitorConnectedExternalDrives' });

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

// Cache for inaccessible drives — shared across reconcile calls
const inaccessibleDrives = new Map(); // Map<driveLetter, lastCheckTime>
const INACCESSIBLE_RECHECK_INTERVAL = 30000; // Recheck inaccessible drives every 30 seconds

// Subscribe to config updates
redisPubSub.subscribe(CONFIG_STATE_KEY + '_update', (err, count) => {
    if (err) {
        logger.error('[CONFIG UPDATE] Failed to subscribe to config updates:', { error: err.message });
    } else {
        logger.info(`[CONFIG UPDATE] Subscribed successfully to config updates! Listening on ${count} channel(s).`);
    }
});

redisPubSub.on('message', async (channel, message) => {
    if (channel === CONFIG_STATE_KEY + '_update') {
        CONFIG_STATE = JSON.parse(message);
        logger.info('[CONFIG UPDATE] Config updated', { drive: CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive });
        // Immediately refresh specific drive state when config changes
        triggerReconcile('config-change');
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
        logger.error('Error inserting device connection:', { error: error.message, drive: driveInfo.drive });
        return null;
    }
}

// Function to update device status to disconnected
async function markDeviceDisconnected(driveLetter) {
    logger.info(`[MARK DRIVE DISCONNECTED] Marking drive ${driveLetter} as disconnected`, { drive: driveLetter });
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
        logger.info(`[MARK DRIVE DISCONNECTED] Marked drive ${driveLetter} as disconnected`, { drive: driveLetter });
    } catch (error) {
        logger.error('[MARK DRIVE DISCONNECTED] Error marking device as disconnected:', { error: error.message, drive: driveLetter });
    }
}

// Function to update device information
async function updateDeviceInfo(driveInfo) {
    logger.info(`[UPDATE DRIVE INFO] Updating drive ${driveInfo.drive} info`, { drive: driveInfo.drive });
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
        logger.info(`[UPDATE DRIVE INFO] Updated drive ${driveInfo.drive} info`, { drive: driveInfo.drive });
    } catch (error) {
        logger.error('[UPDATE DRIVE INFO] Error updating device info:', { error: error.message, drive: driveInfo.drive });
    }
}

// Enhanced uptime calculation function
async function calculateAndUpdateUptime() {
    logger.info(`[UPDATE UPTIME] Calculating and updating uptime`);
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
            logger.info(`[UPDATE UPTIME] Updated uptime for ${result.rowCount} connected devices`, { count: result.rowCount });
        }
    } catch (error) {
        logger.error('[UPDATE UPTIME] Error calculating uptime:', { error: error.message });
    }
}

// Function to get specific drive info for auto-transfer
async function getSpecificDriveInfo(driveLetter) {
    logger.info(`[GET DRIVE INFO] Getting specific drive info for ${driveLetter}`, { drive: driveLetter });
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
        logger.info(`[GET DRIVE INFO] Drive ${driveLetter} info retrieved`, { drive: driveLetter });
        
        if (!fsData || fsData.length === 0 || !fsData[0]) {
            logger.warn(`[GET DRIVE INFO] Drive ${driveLetter} not found or not accessible`, { drive: driveLetter });
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
            logger.warn(`[GET DRIVE INFO] Drive ${driveLetter} info not found`, { drive: driveLetter });
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

        // Use nullish checks so a valid 0-byte drive is not mistaken for inaccessible
        if (fs.size == null || fs.used == null || fs.available == null) {
            logger.warn(`[GET DRIVE INFO] Drive ${driveLetter} has incomplete filesystem data`, { drive: driveLetter });
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


        logger.info(`[GET DRIVE INFO] Drive ${driveLetter} info:`, { drive: driveLetter });
        return {
            drive: driveLetter,
            totalSpace: formatGB(fs.size),
            usedSpace: formatGB(fs.used),
            remainingSpace: formatGB(fs.available),
            usedPercentage: fs.use,
            type: fs.type ? fs.type.toUpperCase() : 'UNKNOWN',
            readWrite: fs.rw ? 'Yes' : 'No'
        };
    } catch (error) {
        logger.error(`[GET DRIVE INFO] Error getting drive info for ${driveLetter}:`, { error: error.message, drive: driveLetter });
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

// ─── Core reconcile function ─────────────────────────────────────────────────
// Idempotent: safe to call at any time from any trigger (hotplug event,
// safety-net timer, config change, or polling fallback).
// Produces identical Redis/Postgres outputs as the original polling loop.
async function reconcileDrives(reason) {
    const now = Date.now();
    let driveList = [];
    let driveListString = JSON.stringify(driveList);

    try {
        // 1. Monitor ALL external drives
        const blockData = await si.blockDevices();
        const systemDrives = ['C:', 'D:', 'I:'];
        const externalDrives = blockData.filter(drive => !systemDrives.includes(drive.name));

        // Get current drive letters
        const currentDrives = new Set(externalDrives.map(drive => drive.name.slice(0, 2)));

        // Clean up inaccessible cache for drives no longer present
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
                logger.info(`[DRIVE DISCONNECTED] Drive ${drive} disconnected`, { drive, reason });
            }
        }

        // Process connected external drives
        for (const drive of externalDrives) {
            const driveLetter = drive.name.slice(0, 2);

            // Skip drives cached as inaccessible (recheck after interval)
            const lastCheck = inaccessibleDrives.get(driveLetter);
            if (lastCheck && (now - lastCheck) < INACCESSIBLE_RECHECK_INTERVAL) {
                continue;
            }

            try {
                const fsData = await si.fsSize(drive.mount);

                // Check if filesystem data exists
                if (!fsData || fsData.length === 0 || !fsData[0]) {
                    if (!inaccessibleDrives.has(driveLetter)) {
                        logger.warn(`[SKIP DRIVE] Drive ${driveLetter} has no accessible filesystem`, { drive: driveLetter });
                    }
                    inaccessibleDrives.set(driveLetter, now);
                    continue;
                }

                const fs = fsData[0];

                // Use nullish checks — a drive with used=0 or available=0 is valid
                if (fs.size == null || fs.used == null || fs.available == null) {
                    if (!inaccessibleDrives.has(driveLetter)) {
                        logger.warn(`[SKIP DRIVE] Drive ${driveLetter} has incomplete filesystem data`, { drive: driveLetter });
                    }
                    inaccessibleDrives.set(driveLetter, now);
                    continue;
                }

                if (inaccessibleDrives.has(driveLetter)) {
                    logger.info(`[DRIVE ACCESSIBLE] Drive ${driveLetter} is now accessible`, { drive: driveLetter });
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

                if (!connectedDrives.has(driveInfo.drive)) {
                    await insertDeviceConnection(driveInfo);
                    connectedDrives.add(driveInfo.drive);
                    logger.info(`[DRIVE CONNECTED] Drive ${driveInfo.drive} connected`, { drive: driveInfo.drive, reason });
                } else {
                    await updateDeviceInfo(driveInfo);
                }

                driveList.push(driveInfo);
            } catch (error) {
                logger.error('[PROCESS DRIVE ERROR] Error processing drive:', { error: error.message });
            }
        }

        // 2. Handle specific drive for auto-transfer
        const autoTransferDrive = CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive;
        const specificDriveState = await getSpecificDriveInfo(autoTransferDrive);

        // 3. Update Redis and publish updates
        driveListString = JSON.stringify(driveList);

        await redis.set(CONNECTED_DRIVE_LIST, driveListString);
        await redis.publish(CONNECTED_DRIVE_LIST_UPDATE, driveListString);

        await redis.set(CONNECTED_DRIVE_STATE, JSON.stringify(specificDriveState));
        await redis.publish(CONNECTED_DRIVE_STATE + '_update', JSON.stringify(specificDriveState));

        // 4. Update uptime periodically
        if (now - lastUptimeUpdate > UPTIME_UPDATE_INTERVAL) {
            await calculateAndUpdateUptime();
            lastUptimeUpdate = now;
        }

        logger.info(`[MONITOR] reason=${reason} Drives: ${driveList.length} accessible, ${inaccessibleDrives.size} cached as inaccessible`, { accessible: driveList.length, inaccessible: inaccessibleDrives.size, reason });

    } catch (error) {
        logger.error('[MONITOR ERROR] reconcileDrives error:', { error: error.message, reason });
        // Still publish empty / disconnected data on error so consumers don't stall
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
    }
}

// ─── Concurrency guard ────────────────────────────────────────────────────────
// Ensures only one reconcileDrives() runs at a time. If a second trigger
// arrives while one is in flight, it is coalesced into a single follow-up run.
let _running = false;
let _rerun = false;

function triggerReconcile(reason) {
    if (_running) {
        _rerun = true;
        return;
    }
    _running = true;
    (async () => {
        try {
            do {
                _rerun = false;
                await reconcileDrives(reason);
            } while (_rerun);
        } catch (e) {
            logger.error('[RECONCILE] Unhandled error in triggerReconcile', { error: e.message, reason });
        } finally {
            _running = false;
        }
    })();
}

// ─── USB hotplug (usb@3 WebUSB API) ──────────────────────────────────────────
// Loaded in try/catch: if the native module fails to load we fall back to the
// original 1s polling loop so the service can never be worse than before.
let usbModule = null;
let onUsbConnect = null;
let onUsbDisconnect = null;

try {
    const { usb } = require('usb');
    usbModule = usb;
    logger.info('[USB] usb@3 loaded successfully — event-driven mode active');
} catch (e) {
    logger.warn('[USB] usb@3 native module failed to load — using 1s poll fallback', { error: e.message });
}

function onUsbChange(kind) {
    // Schedule reconciles at 400 ms / 1200 ms / 3000 ms after the event so
    // Windows has time to assign the drive letter after a plug, and to fully
    // remove the drive after an unplug.
    [400, 1200, 3000].forEach(ms => setTimeout(() => triggerReconcile('usb-' + kind), ms));
}

// ─── Safety-net timer handle (kept for SIGINT cleanup) ────────────────────────
let safetyNetTimer = null;
const SAFETY_NET_MS = 15000;

// ─── Service entry point ──────────────────────────────────────────────────────
async function startService() {
    logger.info('[MONITOR START] Initializing Enhanced Drive Monitor...');
    await redis.del(CONNECTED_DRIVE_LIST);

    if (usbModule) {
        // ── Event-driven path ──────────────────────────────────────────────
        onUsbConnect = () => onUsbChange('connect');
        onUsbDisconnect = () => onUsbChange('disconnect');
        usbModule.addEventListener('connect', onUsbConnect);
        usbModule.addEventListener('disconnect', onUsbDisconnect);

        // Run an initial reconcile so the state is correct at startup
        await reconcileDrives('startup');

        // Safety-net: catches non-USB removable media, missed events, and
        // refreshes space / uptime even when no plug/unplug occurs
        safetyNetTimer = setInterval(() => triggerReconcile('safety-net'), SAFETY_NET_MS);

        logger.info(`[USB] Hotplug listeners registered; safety-net interval ${SAFETY_NET_MS}ms`);
    } else {
        // ── Polling fallback path (original behaviour) ─────────────────────
        logger.warn('[USB] Running 1s polling loop (usb module unavailable)');
        await runPollingFallback();
    }
}

// Original 1-second polling loop, preserved verbatim as fallback.
// Now delegates to reconcileDrives() so both paths share identical logic.
async function runPollingFallback() {
    while (true) {
        triggerReconcile('poll');
        await sleep(1000);
    }
}

startService();

process.on('SIGINT', async () => {
    logger.info('[MONITOR CLOSE] Cleaning up Enhanced Drive Monitor...');
    if (safetyNetTimer) {
        clearInterval(safetyNetTimer);
    }
    if (usbModule && onUsbConnect) {
        usbModule.removeEventListener('connect', onUsbConnect);
        usbModule.removeEventListener('disconnect', onUsbDisconnect);
    }
    await redis.quit();
    await redisPubSub.quit();
    await pool.end();
    process.exit(0);
});

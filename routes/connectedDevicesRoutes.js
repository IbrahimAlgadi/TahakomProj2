const express = require('express');
const { CONNECTED_DRIVE_LIST_UPDATE } = require('../redisKeyStore.js');

async function getCurrentDevices(pool, logger) {
    try {
        const result = await pool.query(`
            SELECT 
                drive_letter as drive, 
                label, 
                total_space as totalSpace, 
                used_space as usedSpace,
                remaining_space as remainingSpace, 
                used_percentage as usedPercentage,
                filesystem_type as type, 
                is_read_write as readWrite, 
                status as isConnected,
                connected_at as connectedAt, 
                last_updated as lastUpdated,
                EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - connected_at))/60 as currentUptimeMinutes,
                get_readable_uptime((EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - connected_at))/60)::INTEGER) as readableUptime
            FROM device_connections
            WHERE status = 'connected'
            ORDER BY connected_at DESC
        `);
        return result.rows;
    } catch (error) {
        logger.error('Error getting current devices:', error);
        return [];
    }
}

async function getDeviceHistory(pool, logger) {
    try {
        const result = await pool.query(`
            SELECT 
                drive_letter as drive, 
                label, 
                filesystem_type as type, 
                connected_at as connectedAt,
                disconnected_at as disconnectedAt, 
                status as isConnected,
                EXTRACT(EPOCH FROM (COALESCE(disconnected_at, CURRENT_TIMESTAMP) - connected_at))/60 as duration,
                get_readable_uptime((EXTRACT(EPOCH FROM (COALESCE(disconnected_at, CURRENT_TIMESTAMP) - connected_at))/60)::INTEGER) as readableDuration
            FROM device_connections
            ORDER BY connected_at DESC
            LIMIT 100
        `);
        return result.rows;
    } catch (error) {
        logger.error('Error getting device history:', error);
        return [];
    }
}

function createConnectedDevicesRouter({ logger, pool, sendDeviceUpdates }) {
    const router = express.Router();

    router.get('/devices', async (req, res) => {
        try {
            const devices = await getCurrentDevices(pool, logger);
            res.json({ success: true, devices });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.get('/devices/history', async (req, res) => {
        try {
            const history = await getDeviceHistory(pool, logger);
            res.json({ success: true, history });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/devices/refresh', async (req, res) => {
        try {
            await sendDeviceUpdates();
            const devices = await getCurrentDevices(pool, logger);
            res.json({ success: true, devices });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
}

function setupConnectedDevicesListeners({ wss, logger, pool, redisPubSub, clients }) {

    async function sendDeviceUpdates() {
        try {
            const devices = await getCurrentDevices(pool, logger);
            const history = await getDeviceHistory(pool, logger);
            const devicesMessage = JSON.stringify({ event: 'devices', devices });
            const historyMessage = JSON.stringify({ event: 'deviceHistory', history });
            for (const client of clients) {
                if (client.readyState === 1 /* WebSocket.OPEN */) {
                    client.send(devicesMessage);
                    client.send(historyMessage);
                }
            }
        } catch (error) {
            logger.error('Error sending device updates:', error);
        }
    }
    
    wss.on('connection', (ws) => {
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.action === 'subscribe' && data.event === 'devices') {
                    sendDeviceUpdates();
                }
            } catch (error) {
                logger.error('Error processing WebSocket message for devices:', error);
            }
        });
    });

    redisPubSub.subscribe(CONNECTED_DRIVE_LIST_UPDATE, (err, count) => {
        if (err) {
            logger.error('Failed to subscribe to device updates:', err.message);
        } else {
            logger.info(`Subscribed successfully to device updates! Listening on ${count} channel(s).`);
        }
    });

    redisPubSub.on('message', async (channel, message) => {
        if (channel === CONNECTED_DRIVE_LIST_UPDATE) {
            await sendDeviceUpdates();
        }
    });

    return { sendDeviceUpdates };
}

module.exports = { createConnectedDevicesRouter, setupConnectedDevicesListeners }; 
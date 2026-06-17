const express = require('express');
const { PROCESS_MONITOR_KEY, PROCESS_MONITOR_UPDATE } = require('../redisKeyStore.js');

function createProcessMonitorRouter({ logger, redis, sendProcessUpdates }) {
    const router = express.Router();

    async function getCurrentProcesses() {
        try {
            const data = await redis.get(PROCESS_MONITOR_KEY);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            logger.error('Error getting current processes:', error);
            return [];
        }
    }

    router.get('/processes', async (req, res) => {
        try {
            const processes = await getCurrentProcesses();
            res.json({ success: true, processes });
        } catch (error) {
            logger.error('Error in /processes endpoint:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    router.post('/processes/refresh', async (req, res) => {
        try {
            const processes = await getCurrentProcesses();
            await sendProcessUpdates();
            res.json({ success: true, processes });
        } catch (error) {
            logger.error('Error in /processes/refresh endpoint:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
}

function setupProcessMonitorListeners({ wss, logger, redis, redisPubSub, clients }) {
    
    async function getCurrentProcesses() {
        try {
            const data = await redis.get(PROCESS_MONITOR_KEY);
            return data ? JSON.parse(data) : [];
        } catch (error) {
            logger.error('Error getting current processes:', error);
            return [];
        }
    }

    async function sendProcessUpdates() {
        try {
            const processes = await getCurrentProcesses();
            const message = JSON.stringify({
                event: 'processes',
                processes: processes
            });

            for (const client of clients) {
                if (client.readyState === 1) { // WebSocket.OPEN
                    client.send(message);
                }
            }
        } catch (error) {
            logger.error('Error sending process updates:', error);
        }
    }

    // Handle WebSocket messages for 'processes'
    wss.on('connection', (ws) => {
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (data.action === 'subscribe' && data.event === 'processes') {
                    sendProcessUpdates();
                }
            } catch (error) {
                logger.error('Error processing WebSocket message for processes:', error);
            }
        });
    });

    // Subscribe to Redis Pub/Sub
    redisPubSub.subscribe(PROCESS_MONITOR_UPDATE, (err, count) => {
        if (err) {
            logger.error('Failed to subscribe:', err.message);
        } else {
            logger.info(`Subscribed successfully to process monitor updates! Listening on ${count} channel(s).`);
        }
    });

    redisPubSub.on('message', async (channel, message) => {
        if (channel === PROCESS_MONITOR_UPDATE) {
            await sendProcessUpdates();
        }
    });

    return { sendProcessUpdates };
}

module.exports = { createProcessMonitorRouter, setupProcessMonitorListeners }; 
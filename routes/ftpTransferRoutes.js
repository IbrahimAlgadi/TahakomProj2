const express = require('express');
const fs = require('fs');
const path = require('path');
const Redis = require('ioredis');
const { FTP_IMAGE_METRICS_KEY, FTP_VIDEO_METRICS_KEY, FTP_COMBINED_METRICS_KEY } = require('../redisKeyStore');

// FTP Transfer configuration file path
const FTP_CONFIG_FILE_PATH = path.join(__dirname, '../config/ftp-transfer.json');

// Default FTP configuration
const DEFAULT_FTP_CONFIG = {
  "server": {
    "protocol": "ftp",
    "host": "",
    "port": 21,
    "username": "",
    "password": "",
    "remoteDirectory": ""
  },
  "transferSchedule": {
    "scheduleType": "scheduled",
    "scheduleFrequency": "weekly", 
    "dayOfWeek": "monday",
    "transferTime": "09:00",
    "dataType": "both",
    "startPoint": {
      "type": "lastStopped",
      "customDateTime": null
    }
  },
  "connection": {
    "status": "disconnected",
    "lastConnected": null,
    "connectionTest": {
      "lastTest": null,
      "result": null,
      "message": ""
    }
  },
  "transfer": {
    "startTransfer": false,    
    "currentTransfer": null,
    "lastTransferCheckpoint": {
      "exists": false,
      "stoppedAt": null,
      "lastProcessedFile": null,
      "reason": null
    },
    "statistics": {
      "filesPending": 0,
      "filesTransferred": 0,
      "totalFiles": 0,
      "transferSpeed": 0,
      "bytesTransferred": 0,
      "totalBytes": 0
    },
    "progress": {
      "currentFile": null,
      "percentage": 0,
      "eta": null,
      "status": "idle"
    }
  }
};

// Helper function to read FTP configuration
function readFtpConfig() {
    try {
        if (fs.existsSync(FTP_CONFIG_FILE_PATH)) {
            const config = JSON.parse(fs.readFileSync(FTP_CONFIG_FILE_PATH, 'utf8'));
            return { ...DEFAULT_FTP_CONFIG, ...config };
        }
        // Create default config file if it doesn't exist
        fs.writeFileSync(FTP_CONFIG_FILE_PATH, JSON.stringify(DEFAULT_FTP_CONFIG, null, 2));
        return DEFAULT_FTP_CONFIG;
    } catch (error) {
        console.error('Error reading FTP config:', error);
        return DEFAULT_FTP_CONFIG;
    }
}

// Helper function to write FTP configuration
function writeFtpConfig(config) {
    try {
        const mergedConfig = { ...DEFAULT_FTP_CONFIG, ...config };
        fs.writeFileSync(FTP_CONFIG_FILE_PATH, JSON.stringify(mergedConfig, null, 2));
        return true;
    } catch (error) {
        console.error('Error writing FTP config:', error);
        return false;
    }
}

function createFtpTransferRouter({ logger, redis, emitEventToClients }) {
    console.log("[*] Loading FTP Transfer routes...")
    const router = express.Router();
    
    // Subscribe to FTP metrics updates
    const redisSub = new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: process.env.REDIS_PORT || 6379,
        retryStrategy: (times) => Math.min(times * 50, 2000)
    });
    
    // Subscribe to both image and video metrics
    redisSub.subscribe([
        FTP_IMAGE_METRICS_KEY + '_update',
        FTP_VIDEO_METRICS_KEY + '_update',
        FTP_COMBINED_METRICS_KEY + '_update'
    ]);
    
    redisSub.on('message', async (channel, message) => {
        try {
            const metricsData = JSON.parse(message);
            
            // Emit to WebSocket clients based on channel
            if (channel === FTP_IMAGE_METRICS_KEY + '_update') {
                emitEventToClients('ftpImageMetricsUpdate', metricsData);
            } else if (channel === FTP_VIDEO_METRICS_KEY + '_update') {
                emitEventToClients('ftpVideoMetricsUpdate', metricsData);
            } else if (channel === FTP_COMBINED_METRICS_KEY + '_update') {
                emitEventToClients('ftpCombinedMetricsUpdate', metricsData);
            }
            
            // Also emit a general FTP metrics update
            emitEventToClients('ftpMetricsUpdate', {
                channel: channel.replace('_update', ''),
                data: metricsData
            });
            
        } catch (error) {
            logger.error('Error processing FTP metrics update:', error);
        }
    });

    // ===== FTP CONFIGURATION ROUTES =====
    
    // Get complete FTP configuration
    router.get('/api/ftp-transfer/config', (req, res) => {
        try {
            const config = readFtpConfig();
            res.json({ success: true, config: config });
        } catch (error) {
            logger.error('Error reading FTP config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Update FTP configuration
    router.post('/api/ftp-transfer/config', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            const updatedConfig = { ...currentConfig, ...req.body };
            
            if (writeFtpConfig(updatedConfig)) {
                // Emit event to notify clients of config change
                emitEventToClients('ftpConfigChanged', updatedConfig);
                res.json({ success: true, config: updatedConfig });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save FTP configuration' });
            }
        } catch (error) {
            logger.error('Error updating FTP config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Update server configuration only
    router.post('/api/ftp-transfer/config/server', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            currentConfig.server = { ...currentConfig.server, ...req.body };
            
            if (writeFtpConfig(currentConfig)) {
                emitEventToClients('ftpServerConfigChanged', currentConfig.server);
                res.json({ success: true, server: currentConfig.server });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save server configuration' });
            }
        } catch (error) {
            logger.error('Error updating FTP server config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Update transfer schedule configuration only
    router.post('/api/ftp-transfer/config/schedule', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            currentConfig.transferSchedule = { ...currentConfig.transferSchedule, ...req.body };
            
            if (writeFtpConfig(currentConfig)) {
                emitEventToClients('ftpScheduleConfigChanged', currentConfig.transferSchedule);
                res.json({ success: true, schedule: currentConfig.transferSchedule });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save schedule configuration' });
            }
        } catch (error) {
            logger.error('Error updating FTP schedule config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== TRANSFER CONTROL ROUTES =====
    
    // Start FTP transfer
    router.post('/api/ftp-transfer/start', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            currentConfig.transfer.startTransfer = true;
            currentConfig.transfer.progress.status = 'starting';
            
            if (writeFtpConfig(currentConfig)) {
                emitEventToClients('ftpTransferStarted', { 
                    startTransfer: true, 
                    status: 'starting',
                    timestamp: new Date().toISOString()
                });
                res.json({ success: true, message: 'FTP transfer started', startTransfer: true });
            } else {
                res.status(500).json({ success: false, error: 'Failed to start FTP transfer' });
            }
        } catch (error) {
            logger.error('Error starting FTP transfer:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Stop FTP transfer
    router.post('/api/ftp-transfer/stop', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            currentConfig.transfer.startTransfer = false;
            currentConfig.transfer.progress.status = 'stopped';
            
            if (writeFtpConfig(currentConfig)) {
                emitEventToClients('ftpTransferStopped', { 
                    startTransfer: false, 
                    status: 'stopped',
                    timestamp: new Date().toISOString()
                });
                res.json({ success: true, message: 'FTP transfer stopped', startTransfer: false });
            } else {
                res.status(500).json({ success: false, error: 'Failed to stop FTP transfer' });
            }
        } catch (error) {
            logger.error('Error stopping FTP transfer:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== STATUS AND MONITORING ROUTES =====
    
    // Get FTP transfer status
    router.get('/api/ftp-transfer/status', (req, res) => {
        try {
            const config = readFtpConfig();
            const status = {
                startTransfer: config.transfer.startTransfer,
                connection: config.connection,
                progress: config.transfer.progress,
                statistics: config.transfer.statistics,
                currentTransfer: config.transfer.currentTransfer
            };
            res.json({ success: true, status: status });
        } catch (error) {
            logger.error('Error getting FTP status:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Test FTP connection (mock implementation)
    router.post('/api/ftp-transfer/test-connection', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            const { server } = currentConfig;
            
            // Mock connection test - in real implementation this would actually test the connection
            const testResult = {
                success: server.host && server.username, // Simple validation
                message: server.host && server.username ? 'Connection test successful' : 'Missing required server configuration',
                timestamp: new Date().toISOString()
            };
            
            // Update connection test result in config
            currentConfig.connection.connectionTest = {
                lastTest: testResult.timestamp,
                result: testResult.success,
                message: testResult.message
            };
            
            if (testResult.success) {
                currentConfig.connection.status = 'connected';
                currentConfig.connection.lastConnected = testResult.timestamp;
            } else {
                currentConfig.connection.status = 'disconnected';
            }
            
            writeFtpConfig(currentConfig);
            emitEventToClients('ftpConnectionTested', testResult);
            
            res.json({ success: true, test: testResult });
        } catch (error) {
            logger.error('Error testing FTP connection:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Update transfer progress (for future microservice integration)
    router.post('/api/ftp-transfer/update-progress', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            const progressData = req.body;
            
            // Update progress information
            if (progressData.statistics) {
                currentConfig.transfer.statistics = { ...currentConfig.transfer.statistics, ...progressData.statistics };
            }
            
            if (progressData.progress) {
                currentConfig.transfer.progress = { ...currentConfig.transfer.progress, ...progressData.progress };
            }
            
            if (progressData.currentTransfer !== undefined) {
                currentConfig.transfer.currentTransfer = progressData.currentTransfer;
            }
            
            if (writeFtpConfig(currentConfig)) {
                emitEventToClients('ftpProgressUpdated', {
                    statistics: currentConfig.transfer.statistics,
                    progress: currentConfig.transfer.progress,
                    currentTransfer: currentConfig.transfer.currentTransfer
                });
                res.json({ success: true, message: 'Progress updated' });
            } else {
                res.status(500).json({ success: false, error: 'Failed to update progress' });
            }
        } catch (error) {
            logger.error('Error updating FTP progress:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Update transfer checkpoint (for microservice integration)
    router.post('/api/ftp-transfer/checkpoint', (req, res) => {
        try {
            const currentConfig = readFtpConfig();
            const checkpointData = req.body;
            
            // Update checkpoint information
            if (!currentConfig.transfer.lastTransferCheckpoint) {
                currentConfig.transfer.lastTransferCheckpoint = {};
            }
            
            currentConfig.transfer.lastTransferCheckpoint = {
                exists: checkpointData.exists || false,
                stoppedAt: checkpointData.stoppedAt || null,
                lastProcessedFile: checkpointData.lastProcessedFile || null,
                reason: checkpointData.reason || null
            };
            
            if (writeFtpConfig(currentConfig)) {
                emitEventToClients('ftpCheckpointUpdated', currentConfig.transfer.lastTransferCheckpoint);
                res.json({ success: true, checkpoint: currentConfig.transfer.lastTransferCheckpoint });
            } else {
                res.status(500).json({ success: false, error: 'Failed to update checkpoint' });
            }
        } catch (error) {
            logger.error('Error updating FTP checkpoint:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Reset FTP configuration to defaults
    router.post('/api/ftp-transfer/reset', (req, res) => {
        try {
            if (writeFtpConfig(DEFAULT_FTP_CONFIG)) {
                emitEventToClients('ftpConfigReset', DEFAULT_FTP_CONFIG);
                res.json({ success: true, message: 'FTP configuration reset to defaults', config: DEFAULT_FTP_CONFIG });
            } else {
                res.status(500).json({ success: false, error: 'Failed to reset FTP configuration' });
            }
        } catch (error) {
            logger.error('Error resetting FTP config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Get current FTP metrics endpoint
    router.get('/api/ftp-transfer/metrics', async (req, res) => {
        try {
            const imageMetrics = await redis.get(FTP_IMAGE_METRICS_KEY);
            const videoMetrics = await redis.get(FTP_VIDEO_METRICS_KEY);
            
            const metrics = {
                image: imageMetrics ? JSON.parse(imageMetrics) : null,
                video: videoMetrics ? JSON.parse(videoMetrics) : null,
                combined: null
            };
            
            // Calculate combined metrics if both exist
            if (metrics.image && metrics.video) {
                metrics.combined = {
                    totalFilesPending: (metrics.image.filesPending || 0) + (metrics.video.videosInQueue || 0),
                    totalFilesTransferred: (metrics.image.filesTransferred || 0) + (metrics.video.videosTransferred || 0),
                    averageTransferSpeed: ((metrics.image.transferSpeed || 0) + (metrics.video.transferSpeed || 0)) / 2,
                    overallStatus: metrics.image.connectionStatus === 'connected' && metrics.video.connectionStatus === 'connected' ? 'connected' : 'disconnected'
                };
            }
            
            res.json({ success: true, metrics });
        } catch (error) {
            logger.error('Error getting FTP metrics:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    return router;
}

module.exports = { createFtpTransferRouter, readFtpConfig, writeFtpConfig };

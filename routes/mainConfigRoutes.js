const express = require('express');
const si = require('systeminformation');
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');

// Helper function to get drive info
async function getDriveInfo(driveLetter) {
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

function createMainConfigRouter({ logger, redis, writeConfig, emitEventToClients, readConfig }) {
    console.log("[*] Loading main config files...")
    const router = express.Router();

    // ===== GENERAL CONFIG ROUTES =====
    
    // Get complete application config
    router.get('/api/config', (req, res) => {
        try {
            const config = readConfig();
            res.json(config);
        } catch (error) {
            logger.error('Error reading config:', error);
            res.status(500).json({ error: 'Failed to read configuration' });
        }
    });

    // Update complete application config
    router.post('/api/config', (req, res) => {
        try {
            const newConfig = req.body;
            if (writeConfig(newConfig)) {
                res.json({ success: true, config: newConfig });
            } else {
                res.status(500).json({ error: 'Failed to write configuration' });
            }
        } catch (error) {
            logger.error('Error updating config:', error);
            res.status(500).json({ error: 'Failed to update configuration' });
        }
    });

    // ===== AUTO TRANSFER CONFIG ROUTES =====
    
    // Get auto transfer configuration
    router.get('/auto-transfer/config', async (req, res) => {
        try {
            const config = readConfig();
            res.json({ success: true, config: config.autoTransfer });
        } catch (error) {
            logger.error('Error reading auto-transfer config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Test drive connection for auto transfer
    router.post('/auto-transfer/test-drive', async (req, res) => {
        const { drive } = req.body;
        if (!drive) return res.status(400).json({ success: false, error: 'Drive letter is required', connected: false });
        try {
            const driveInfo = await getDriveInfo(`${drive}:`);
            const minRequiredSpace = 1024 * 1024 * 1024; // 1GB
            if (driveInfo.remainingSpace < minRequiredSpace) {
                return res.json({ success: false, error: 'Drive has insufficient space', connected: true, driveInfo });
            }
            res.json({ success: true, connected: true, message: 'Drive is connected and has sufficient space', driveInfo });
        } catch (error) {
            logger.error('Error testing auto-transfer drive:', error);
            res.status(500).json({ success: false, error: 'Drive not found or not accessible', connected: false });
        }
    });

    // Save auto transfer configuration
    router.post('/auto-transfer/save-config', async (req, res) => {
        try {
            const config = readConfig();
            config.autoTransfer = { ...config.autoTransfer, ...req.body };
            if (writeConfig(config)) {
                emitEventToClients('autoTransferConfigChanged', config.autoTransfer);
                res.json({ success: true });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save configuration' });
            }
        } catch (error) {
            logger.error('Error saving auto-transfer config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Toggle auto transfer active state
    router.post('/auto-transfer/toggle', async (req, res) => {
        console.log('🔄 Auto-transfer toggle called from centralized config');
        try {
            console.log('📊 Toggle request data:', req.body);
            
            const { isActive, schedule } = req.body;
            const config = readConfig();
            
            console.log('📋 Config before update:', { autoTransfer: config.autoTransfer });
            
            config.autoTransfer.isActive = isActive;
            
            // Update schedule if provided
            if (schedule) {
                config.autoTransfer.schedule = { ...config.autoTransfer.schedule, ...schedule };
            }
            
            console.log('📋 Config after update:', { autoTransfer: config.autoTransfer });
            
            if (writeConfig(config)) {
                emitEventToClients('autoTransferConfigChanged', config.autoTransfer);
                logger.info(`Auto-transfer toggled: ${isActive ? 'activated' : 'deactivated'}`);
                res.json({ success: true });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save configuration' });
            }
        } catch (error) {
            logger.error('Error toggling auto-transfer:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== MANUAL TRANSFER CONFIG ROUTES =====
    
    // Get manual transfer configuration
    router.get('/manual-transfer/config', (req, res) => {
        try {
            const config = readConfig();
            res.json({ success: true, config: config.manualTransfer || null });
        } catch (error) {
            logger.error('Error reading manual transfer config:', error);
            res.status(500).json({ success: false, error: 'Failed to read config' });
        }
    });

    // Update manual transfer configuration
    router.post('/manual-transfer/config', (req, res) => {
        try {
            const config = readConfig();
            config.manualTransfer = { ...config.manualTransfer, ...req.body };
            if (writeConfig(config)) {
                res.json({ success: true });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save configuration' });
            }
        } catch (error) {
            logger.error('Error updating manual transfer config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== FTP TRANSFER CONFIG ROUTES =====
    
    // Get FTP transfer configuration
    router.get('/ftp-transfer/config', (req, res) => {
        try {
            const config = readConfig();
            res.json({ success: true, config: config.ftpTransfer });
        } catch (error) {
            logger.error('Error reading FTP config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Save FTP transfer configuration
    router.post('/ftp-transfer/config', (req, res) => {
        try {
            const config = readConfig();
            config.ftpTransfer = { ...config.ftpTransfer, ...req.body };
            if (writeConfig(config)) {
                res.json({ success: true });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save configuration' });
            }
        } catch (error) {
            logger.error('Error saving FTP config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== STORAGE CONFIG ROUTES =====
    
    // Get storage configuration
    router.get('/storage/config', (req, res) => {
        try {
            const config = readConfig();
            res.json({ success: true, config: config.storage });
        } catch (error) {
            logger.error('Error reading storage config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Save storage configuration
    router.post('/storage/config', (req, res) => {
        try {
            const config = readConfig();
            config.storage = { ...config.storage, ...req.body };
            if (writeConfig(config)) {
                res.json({ success: true });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save configuration' });
            }
        } catch (error) {
            logger.error('Error saving storage config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== ENCRYPTION CONFIG ROUTES =====
    
    // Get encryption configuration
    router.get('/encryption/config', (req, res) => {
        try {
            const config = readConfig();
            res.json({ success: true, config: config.encryption });
        } catch (error) {
            logger.error('Error reading encryption config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Save encryption configuration
    router.post('/encryption/config', (req, res) => {
        try {
            const config = readConfig();
            config.encryption = { ...config.encryption, ...req.body };
            if (writeConfig(config)) {
                res.json({ success: true });
            } else {
                res.status(500).json({ success: false, error: 'Failed to save configuration' });
            }
        } catch (error) {
            logger.error('Error saving encryption config:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // ===== CERTIFICATE MANAGEMENT ROUTES =====
    
    // Configure multer for certificate file uploads
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            const config = readConfig();
            const certDir = path.resolve(config.certificates.directory);
            
            // Ensure certificate directory exists
            if (!fs.existsSync(certDir)) {
                fs.mkdirSync(certDir, { recursive: true });
            }
            
            cb(null, certDir);
        },
        filename: function (req, file, cb) {
            const config = readConfig();
            const filename = req.body.type === 'public' 
                ? config.certificates.publicKeyFilename 
                : config.certificates.privateKeyFilename;
            cb(null, filename);
        }
    });

    const upload = multer({ 
        storage: storage,
        fileFilter: function (req, file, cb) {
            // Only allow .pem and .crt files
            if (file.originalname.match(/\.(pem|crt)$/)) {
                cb(null, true);
            } else {
                cb(new Error('Only .pem and .crt files are allowed!'), false);
            }
        },
        limits: {
            fileSize: 10 * 1024 * 1024 // 10MB limit
        }
    });

    // Upload certificate endpoint
    router.post('/api/certificates/upload', upload.single('certificate'), (req, res) => {
        try {
            if (!req.file) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'No certificate file provided' 
                });
            }

            const { type } = req.body;
            if (!type || (type !== 'public' && type !== 'private')) {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid certificate type. Must be "public" or "private"' 
                });
            }

            logger.info(`Certificate uploaded: ${req.file.filename} (${type})`);
            
            res.json({ 
                success: true, 
                message: `${type} certificate uploaded successfully`,
                filename: req.file.filename,
                path: req.file.path
            });

        } catch (error) {
            logger.error('Error uploading certificate:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to upload certificate: ' + error.message 
            });
        }
    });

    // Get certificate status endpoint
    router.get('/api/certificates/status', (req, res) => {
        try {
            const config = readConfig();
            const certDir = path.resolve(config.certificates.directory);
            const publicKeyPath = path.join(certDir, config.certificates.publicKeyFilename);
            const privateKeyPath = path.join(certDir, config.certificates.privateKeyFilename);

            // Check if certificates exist
            const publicKeyExists = fs.existsSync(publicKeyPath);
            const privateKeyExists = fs.existsSync(privateKeyPath);

            // Check if it's a default certificate (check file creation time or a marker)
            let isDefaultPublicKey = false;
            if (publicKeyExists) {
                // Consider it default if it's the original filename and wasn't recently modified
                // This is a simple heuristic - you might want to implement a better tracking mechanism
                const stats = fs.statSync(publicKeyPath);
                const hoursSinceModification = (Date.now() - stats.mtime.getTime()) / (1000 * 60 * 60);
                isDefaultPublicKey = hoursSinceModification > 24; // Consider default if older than 24 hours
            }

            res.json({
                success: true,
                certificates: {
                    publicKey: publicKeyExists,
                    privateKey: privateKeyExists,
                    isDefault: isDefaultPublicKey,
                    directory: certDir,
                    publicKeyFilename: config.certificates.publicKeyFilename,
                    privateKeyFilename: config.certificates.privateKeyFilename
                }
            });

        } catch (error) {
            logger.error('Error checking certificate status:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to check certificate status: ' + error.message 
            });
        }
    });

    // Delete certificate endpoint
    router.delete('/api/certificates/:type', (req, res) => {
        try {
            const { type } = req.params;
            
            if (type !== 'public' && type !== 'private') {
                return res.status(400).json({ 
                    success: false, 
                    error: 'Invalid certificate type. Must be "public" or "private"' 
                });
            }

            const config = readConfig();
            const certDir = path.resolve(config.certificates.directory);
            const filename = type === 'public' 
                ? config.certificates.publicKeyFilename 
                : config.certificates.privateKeyFilename;
            const certPath = path.join(certDir, filename);

            if (!fs.existsSync(certPath)) {
                return res.status(404).json({ 
                    success: false, 
                    error: `${type} certificate not found` 
                });
            }

            fs.unlinkSync(certPath);
            logger.info(`Certificate deleted: ${filename} (${type})`);

            res.json({ 
                success: true, 
                message: `${type} certificate deleted successfully` 
            });

        } catch (error) {
            logger.error('Error deleting certificate:', error);
            res.status(500).json({ 
                success: false, 
                error: 'Failed to delete certificate: ' + error.message 
            });
        }
    });

    return router;
}

module.exports = { createMainConfigRouter };
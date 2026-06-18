const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Pool } = require('pg');
const Redis = require('ioredis');
const cors = require('cors');
const winston = require('winston');
require('winston-daily-rotate-file');
const fs = require('fs-extra');
const path = require('path');
const bodyParser = require('body-parser');
const nunjucks = require('nunjucks');
// const securos = require('securos');

// Load environment variables
require('dotenv').config();

// Log environment configuration on startup
console.log('🔧 Loading configuration from environment variables...');
console.log(`📁 ROOT_DIR: ${process.env.ROOT_DIR || 'D:\\ISS\\SA\\6_Tahakom\\DataTransferPlugin\\data_transfer_v2'} (${process.env.ROOT_DIR ? 'env' : 'default'})`);
console.log(`📂 EXPORT_DIR: ${process.env.EXPORT_DIR || 'C:\\export'} (${process.env.EXPORT_DIR ? 'env' : 'default'})`);
console.log(`🚀 PORT: ${process.env.PORT || 8454} (${process.env.PORT ? 'env' : 'default'})`);
console.log(`🗃️  DATABASE: ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'tahakom_transfer'}`);
console.log(`📊 REDIS: ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
console.log(`📝 LOG_LEVEL: ${process.env.LOG_LEVEL || 'info'} (${process.env.LOG_LEVEL ? 'env' : 'default'})`);
console.log('✅ Environment configuration loaded successfully\n');

const createDashboardRouter = require('./routes/dashboardRoutes');
const { createProcessMonitorRouter, setupProcessMonitorListeners } = require('./routes/processMonitorRoutes');
const { createMainControlRouter, setupMainControlListeners } = require('./routes/mainControlRoutes');
const { createManualTransferRouter, startManualFileTransferProcess } = require('./routes/manualTransferRoutes');
const { createConnectedDevicesRouter, setupConnectedDevicesListeners } = require('./routes/connectedDevicesRoutes');
const { createAutoTransferRouter, setupAutoTransferListeners, startAutoTransferProcess } = require('./routes/autoTransferRoutes');
const { createMainConfigRouter } = require('./routes/mainConfigRoutes');
const { createFtpTransferRouter } = require('./routes/ftpTransferRoutes');
const { createMediaFilesRouter } = require('./routes/mediaFilesRoutes');
const { createDriveRouter } = require('./routes/driveRoutes');
const { PROCESS_MONITOR_KEY, PROCESS_MONITOR_UPDATE, CONNECTED_DRIVE_LIST_UPDATE, CONFIG_STATE_KEY, CONNECTED_DRIVE_STATE } = require('./redisKeyStore');

// --- Main Configuration from Environment Variables ---
const ROOT_DIR = process.env.ROOT_DIR || "D:\\ISS\\SA\\6_Tahakom\\DataTransferPlugin\\data_transfer_v2";
const EXPORT_DIR = process.env.EXPORT_DIR || "C:\\export";
const CONFIG_FILE_NAME = process.env.CONFIG_FILE_NAME || 'dataTransferConfig.json';
const CONFIG_FILE_PATH = path.join(ROOT_DIR, CONFIG_FILE_NAME);
const port = process.env.PORT || 8454;

const DB_USER = process.env.DB_USER || "postgres";
const DB_PASSWORD = process.env.DB_PASSWORD || "postgres";
const DB_HOST = process.env.DB_HOST || "localhost";
const DB_PORT = process.env.DB_PORT || 5432;
const DB_APP = process.env.DB_NAME || "tahakom_transfer";

// Additional environment configurations
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_DIRECTORY = process.env.LOG_DIRECTORY || 'logs';
const CERTIFICATES_DIR = process.env.CERTIFICATES_DIR || 'certs';

const DEFAULT_CONFIG = {
    storage: { 
        directory: process.env.DEFAULT_STORAGE_DIRECTORY || EXPORT_DIR, 
        maxCapacity: parseInt(process.env.DEFAULT_STORAGE_MAX_CAPACITY) || 200, 
        retentionPolicy: process.env.DEFAULT_STORAGE_RETENTION_POLICY || "fifo", 
        siteId: process.env.DEFAULT_SITE_ID || "" 
    },
    encryption: { 
        enabled: process.env.DEFAULT_ENCRYPTION_ENABLED === 'true' || false, 
        algorithm: process.env.DEFAULT_ENCRYPTION_ALGORITHM || "aes-256-cbc", 
        keyManagement: process.env.DEFAULT_ENCRYPTION_KEY_MANAGEMENT || "manual", 
        encryptMetadata: process.env.DEFAULT_ENCRYPTION_METADATA === 'true' || true 
    },
    pathStructure: { 
        components: (process.env.DEFAULT_PATH_COMPONENTS || "SITE_ID,DATE,TIME").split(','), 
        separators: { SITE_ID: "\\", DATE: "_", TIME: "_" }, 
        formats: { 
            DATE: process.env.DEFAULT_DATE_FORMAT || "YYYY_MM_DD", 
            TIME: process.env.DEFAULT_TIME_FORMAT || "HH_mm_ss" 
        } 
    },
    autoTransfer: { 
        drive: process.env.DEFAULT_AUTO_TRANSFER_DRIVE || "", 
        encryption: { 
            enabled: process.env.DEFAULT_ENCRYPTION_ENABLED === 'true' || false, 
            algorithm: process.env.DEFAULT_ENCRYPTION_ALGORITHM || "aes-256-cbc", 
            keyManagement: process.env.DEFAULT_ENCRYPTION_KEY_MANAGEMENT || "manual", 
            encryptMetadata: process.env.DEFAULT_ENCRYPTION_METADATA === 'true' || true 
        }, 
        isActive: process.env.DEFAULT_AUTO_TRANSFER_ACTIVE === 'true' || false 
    },
    ftpTransfer: { 
        protocol: process.env.DEFAULT_FTP_PROTOCOL || "ftp", 
        host: process.env.DEFAULT_FTP_HOST || "", 
        port: parseInt(process.env.DEFAULT_FTP_PORT) || 21, 
        username: process.env.DEFAULT_FTP_USERNAME || "", 
        password: process.env.DEFAULT_FTP_PASSWORD || "", 
        remoteDirectory: process.env.DEFAULT_FTP_REMOTE_DIRECTORY || "" 
    },
    certificates: {
        directory: CERTIFICATES_DIR,
        publicKeyFilename: process.env.PUBLIC_KEY_FILENAME || 'public_key.pem',
        privateKeyFilename: process.env.PRIVATE_KEY_FILENAME || 'private_key.pem'
    }
};

// --- Logger Configuration ---
const logger = winston.createLogger({
    level: LOG_LEVEL,
    format: winston.format.combine(winston.format.timestamp(), winston.format.json()),
    transports: [
        new winston.transports.DailyRotateFile({ 
            filename: `${LOG_DIRECTORY}/MainBackend-error-%DATE%.log`, 
            datePattern: 'YYYY-MM-DD', 
            level: 'error', 
            maxSize: process.env.LOG_MAX_SIZE || '20m', 
            maxFiles: process.env.LOG_MAX_FILES || '14d', 
            zippedArchive: true 
        }),
        new winston.transports.DailyRotateFile({ 
            filename: `${LOG_DIRECTORY}/MainBackend-combined-%DATE%.log`, 
            datePattern: 'YYYY-MM-DD', 
            maxSize: process.env.LOG_MAX_SIZE || '20m', 
            maxFiles: process.env.LOG_MAX_FILES || '14d', 
            zippedArchive: true 
        }),
        new winston.transports.Console({ 
            format: winston.format.combine(winston.format.colorize(), winston.format.simple()) 
        })
    ]
});
if (!fs.existsSync(LOG_DIRECTORY)) fs.mkdirSync(LOG_DIRECTORY);

// --- Application Setup ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Database & Redis ---
const pool = new Pool({ user: DB_USER, host: DB_HOST, database: DB_APP, port: DB_PORT, password: DB_PASSWORD });
const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: process.env.REDIS_PORT || 6379, retryStrategy: (times) => Math.min(times * 50, 2000) });
const redisPubSub = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: process.env.REDIS_PORT || 6379, retryStrategy: (times) => Math.min(times * 50, 2000) });

// --- View Engine & Middleware ---
app.set('views', path.join(ROOT_DIR, 'views'));
app.use(express.static(path.join(ROOT_DIR, 'public')));
app.use('/export', express.static(EXPORT_DIR));
nunjucks.configure(path.join(ROOT_DIR, 'views'), { autoescape: true, express: app, watch: true });
app.set('view engine', 'njk');
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.url}`);
    next();
});

// --- Configuration Management ---
function readConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
            return { ...DEFAULT_CONFIG, ...config };
        }
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
        return DEFAULT_CONFIG;
    } catch (error) {
        logger.error('Error reading config:', error);
        return DEFAULT_CONFIG;
    }
}
function writeConfig(config) {
    try {
        const mergedConfig = { ...DEFAULT_CONFIG, ...config };
        fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(mergedConfig, null, 2));
        return true;
    } catch (error) {
        logger.error('Error writing config:', error);
        return false;
    }
}

// --- WebSocket Handling ---
const clients = new Set();
wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info(`[${clients.size}] Client connected`);
    ws.on('close', () => {
        clients.delete(ws);
        logger.info('Client disconnected');
    });
    ws.on('message', (message) => logger.info(`Received message: ${message.toString()}`));
});
function broadcastUpdate(event, data) {
    const message = JSON.stringify({ event, data });
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    }
}
function emitEventToClients(event, data) {
    const message = JSON.stringify({ event, data });
    clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) client.send(message);
    });
}

// --- Securos Integration ---
let SECUROS_CORE = null;
// securos.connect((core) => {
//     SECUROS_CORE = core;
//     logger.info('Securos Core connected.');
//     // Listeners that depend on Securos core can be initialized here
//     setupMainControlListeners({ wss, logger, pool, emitEventToClients, EXPORT_DIR, SECUROS_CORE });
// });

// Listeners that depend on Securos core can be initialized here
setupMainControlListeners({ wss, logger, pool, emitEventToClients, EXPORT_DIR, SECUROS_CORE });

// --- Initialize & Mount Routers ---
const { sendProcessUpdates } = setupProcessMonitorListeners({ wss, logger, redis, redisPubSub, clients });
const { sendDeviceUpdates } = setupConnectedDevicesListeners({ wss, logger, pool, redisPubSub, clients });
setupAutoTransferListeners({ wss, logger, redisPubSub, emitEventToClients, readConfig });

app.use('/', createDashboardRouter({ logger, pool, broadcastUpdate, redis }));
app.use('/', createProcessMonitorRouter({ logger, redis, sendProcessUpdates }));
app.use('/', createMainConfigRouter({ logger, redis, writeConfig, emitEventToClients, readConfig }));
app.use('/', createMainControlRouter({ logger, pool, readConfig, writeConfig, EXPORT_DIR }));
app.use('/', createManualTransferRouter({ logger, pool, redis, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR }));
app.use('/', createConnectedDevicesRouter({ logger, pool, sendDeviceUpdates }));
app.use('/', createDriveRouter({ logger, redis }));
app.use('/', createAutoTransferRouter({ logger, redis, writeConfig, emitEventToClients, readConfig }));
app.use('/', createFtpTransferRouter({ logger, redis, emitEventToClients }));
app.use('/', createMediaFilesRouter({ logger, pool }));

// --- Start Background Processes ---
startManualFileTransferProcess({ logger, pool, emitEventToClients, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR });
// startAutoTransferProcess({ logger, pool, redis, emitEventToClients });

// --- Dashboard Materialized View Refresh ---
// Refreshes all six rollup MVs on a configurable interval so chart queries stay fast
// without scanning the full files table. CONCURRENT refresh keeps the MVs readable
// during the refresh, so there is zero downtime.
const DASHBOARD_MV_REFRESH_INTERVAL_MS = parseInt(process.env.DASHBOARD_MV_REFRESH_INTERVAL_MS) || 5 * 60 * 1000;
const DASHBOARD_MVS = [
    'mv_files_daily', 'mv_files_daily_agg',
    'mv_files_monthly', 'mv_files_monthly_agg',
    'mv_files_yearly', 'mv_files_yearly_agg'
];

async function refreshDashboardMVs() {
    for (const mv of DASHBOARD_MVS) {
        try {
            await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv}`);
            logger.info(`[Dashboard MV] Refreshed ${mv}`);
        } catch (err) {
            logger.error(`[Dashboard MV] Error refreshing ${mv}:`, err.message);
        }
    }
}

// Initial refresh on startup (non-blocking)
refreshDashboardMVs().catch(err => logger.error('[Dashboard MV] Initial refresh error:', err.message));

// Periodic refresh
setInterval(() => {
    refreshDashboardMVs().catch(err => logger.error('[Dashboard MV] Scheduled refresh error:', err.message));
}, DASHBOARD_MV_REFRESH_INTERVAL_MS);

// --- Server Start ---
server.listen(port, () => {
    logger.info(`Main Backend running on port ${port}`);
    logger.info(`WebSocket server is running`);
});

// --- Graceful Shutdown ---
async function gracefulShutdown() {
    console.log('Gracefully shutting down...'); // Use console during shutdown to avoid stream conflicts
    
    try {
        // Close external connections first
        await redis.quit();
        await redisPubSub.quit();
        await pool.end();
        // if (SECUROS_CORE) SECUROS_CORE.disconnect();
        
        // Close server
        server.close(() => {
            console.log('Server closed.');
            
            // Properly close winston logger transports before exit
            logger.close(() => {
                process.exit(0);
            });
        });
    } catch (error) {
        console.error('Error during graceful shutdown:', error);
        // Force close logger and exit on error
        logger.close(() => {
            process.exit(1);
        });
    }
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    gracefulShutdown();
});
process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error); 
    gracefulShutdown();
}); 

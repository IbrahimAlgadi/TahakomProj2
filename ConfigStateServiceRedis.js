const Redis = require('ioredis');
const path = require('path');
const fs = require('fs-extra');
const chokidar = require('chokidar');
const { exec } = require('child_process');
const { CONFIG_STATE_KEY, CONFIG_FTP_STATE_KEY } = require('./redisKeyStore');
const { createLogger } = require('./utils/logger');

const logger = createLogger({ service: 'ConfigStateServiceRedis' });

// Load environment variables
require('dotenv').config();

const ROOT_DIR = process.env.ROOT_DIR || "D:\\ISS\\SA\\6_Tahakom\\DataTransferPlugin\\data_transfer_v2";
const CONFIG_FILE_PATH = path.join(ROOT_DIR, process.env.CONFIG_FILE_NAME || 'dataTransferConfig.json');
const CONFIG_FTP_FILE_PATH = path.join(process.env.CONFIG_FTP_FILE_PATH || 'dataTransferConfig.json');

// Initialize Redis client
const redis = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

// Initialize Redis client
const redisPubSub = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


function readConfig(filePath) {
    try {
        if (!fs.existsSync(filePath)) {
            logger.warn('Config file not found:', { path: filePath });
            return {};
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        logger.error('Error reading config:', { error: error.message });
        return null;
    }
}

chokidar.watch(CONFIG_FILE_PATH).on('all', async (event, filePath) => {
    logger.info('Config file event', { event, path: filePath });
    logger.info('Config info loaded');
    const config = readConfig(CONFIG_FILE_PATH);
    redis.set(CONFIG_STATE_KEY, JSON.stringify(config));
    redisPubSub.publish(CONFIG_STATE_KEY + '_update', JSON.stringify(config));
});

chokidar.watch(CONFIG_FTP_FILE_PATH).on('all', async (event, filePath) => {
    logger.info('FTP config file event', { event, path: filePath });
    logger.info('FTP config info loaded');
    const config = readConfig(CONFIG_FTP_FILE_PATH);
    redis.set(CONFIG_FTP_STATE_KEY, JSON.stringify(config));
    redisPubSub.publish(CONFIG_FTP_STATE_KEY + '_update', JSON.stringify(config));
});

async function runSimulation() {
    while (true) {
        try {
            const mainConfig = readConfig(CONFIG_FILE_PATH);
            redisPubSub.publish(CONFIG_STATE_KEY + '_update', JSON.stringify(mainConfig));

            const ftpConfig = readConfig(CONFIG_FTP_FILE_PATH);
            redisPubSub.publish(CONFIG_FTP_STATE_KEY + '_update', JSON.stringify(ftpConfig));
            logger.info('Config info published');
            await sleep(500);
        } catch (error) {
            await sleep(1000);
        }
    }
}

runSimulation();

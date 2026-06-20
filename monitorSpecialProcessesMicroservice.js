const Redis = require('ioredis');
const si = require('systeminformation');
const { sleep } = require('./utils.js');
const { PROCESS_MONITOR_KEY, PROCESS_MONITOR_UPDATE } = require('./redisKeyStore.js');
const { createLogger } = require('./utils/logger');

const logger = createLogger({ service: 'monitorSpecialProcesses', logFile: 'monitor' });

// Initialize Redis client
const config = require('./utils/envConfig');

const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

// List of processes to monitor
const MONITORED_PROCESSES = [
    'image_export.exe',
    'node.exe',
    'nodejs.exe',
    'redis-server.exe',
    'vms_server.exe',
    'postgres.exe',
    'OpenVINOServer.exe',
    'QtWebEngineProcess.exe',
    'lpr_gui.exe',
    'lpr_logic.exe',
    'autoi.exe',
    'monitor.exe',
    'video.exe',
    'securos.exe'
].join(', ');

// Run process monitor
async function runProcessMonitor() {
    // Clear existing data
    redis.set(PROCESS_MONITOR_KEY, JSON.stringify([]));

    while (true) {
        try {
            si.processLoad(MONITORED_PROCESSES, (data) => {
                const processData = data.map(process => ({
                    name: process.proc,
                    mainPid: process.pid,
                    cpuUsage: process.cpu.toFixed(2),
                    memoryUsage: process.mem.toFixed(2),
                    allPids: process.pids
                }));

                // console.log(processData);

                const processDataString = JSON.stringify(processData);
                
                // Update Redis with new data
                redis.set(PROCESS_MONITOR_KEY, processDataString);
                redis.publish(PROCESS_MONITOR_UPDATE, processDataString);

                logger.info('Process load status', { processes: processData });
            });

            await sleep(5000);
        } catch (error) {
            logger.error('Process monitor error:', { error: error.message });
            await sleep(5000);
            continue;
        }
    }
}

runProcessMonitor();

process.on('SIGINT', async () => {
    logger.info('Cleaning up process monitor...');
    await redis.quit();
    process.exit(0);
});

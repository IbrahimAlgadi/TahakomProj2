const Redis = require('ioredis');
const si = require('systeminformation');
const { sleep } = require('./utils.js');
const { PROCESS_MONITOR_KEY, PROCESS_MONITOR_UPDATE } = require('./redisKeyStore.js');

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

                // Log for monitoring
                console.log('\n=== Process Load Status ===');
                processData.forEach(process => {
                    console.log(`\nProcess: ${process.name}`);
                    console.log(`- Main PID: ${process.mainPid}`);
                    console.log(`- CPU Usage: ${process.cpuUsage}%`);
                    console.log(`- Memory Usage: ${process.memoryUsage}%`);
                    console.log(`- All PIDs: ${process.allPids.join(', ')}`);
                });
                console.log('\n===================\n');
            });

            await sleep(5000); // Update every second
        } catch (error) {
            console.error('Process monitor error:', error);
            await sleep(5000);
            continue;
        }
    }
}

// Run the process monitor
runProcessMonitor();

// Keep the process running
process.on('SIGINT', async () => {
    console.log('Cleaning up...');
    await redis.quit();
    process.exit(0);
});

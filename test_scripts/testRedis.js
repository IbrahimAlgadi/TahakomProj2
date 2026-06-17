const Redis = require('ioredis');


// Initialize Redis client
const config = require('../utils/envConfig');

const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    }
});

// Queue names
const QUEUE_NAMES = {
    COPY_QUEUE: 'copy_queue',
    RESULT_QUEUE: 'result_queue'
};

// Simulate a producer (AutoTransferBackend)
async function producer() {
    console.log('Producer (AutoTransferBackend) started...');
    
    // Generate test files to copy
    const files = [
        {
            ids: [1, 2],
            file_paths: ['/export/file1.txt', '/export/file2.txt']
        },
        {
            ids: [3, 4],
            file_paths: ['/export/file3.txt', '/export/file4.txt']
        }
    ];

    for (const batch of files) {
        // Push copy job to queue
        await redis.lpush(QUEUE_NAMES.COPY_QUEUE, JSON.stringify({
            files: batch,
            exportDir: '/export',
            drivePath: 'F:/'
        }));
        console.log(`Produced copy job: ${JSON.stringify(batch)}`);
        
        // Simulate some delay between batches
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

// Simulate a consumer (CopyService)
async function consumer() {
    console.log('Consumer (CopyService) started...');
    
    while (true) {
        try {
            // Blocking pop from queue with timeout
            const result = await redis.brpop(QUEUE_NAMES.COPY_QUEUE, 0);
            
            if (result) {
                const job = JSON.parse(result[1]);
                console.log(`Processing copy job: ${JSON.stringify(job)}`);
                
                // Process each file in the batch
                for (let i = 0; i < job.files.ids.length; i++) {
                    const id = job.files.ids[i];
                    const filePath = job.files.file_paths[i];
                    
                    // Simulate file copy
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    
                    // Push success result to result queue
                    await redis.lpush(QUEUE_NAMES.RESULT_QUEUE, JSON.stringify({
                        type: 'COPY_SUCCESS',
                        payload: {
                            id,
                            filePath,
                            destinationPath: filePath.replace(job.exportDir, job.drivePath)
                        }
                    }));
                    
                    console.log(`Copied file: ${filePath}`);
                }
            }
        } catch (error) {
            console.error('Error processing copy job:', error);
            // Push error to result queue
            await redis.lpush(QUEUE_NAMES.RESULT_QUEUE, JSON.stringify({
                type: 'COPY_ERROR',
                payload: {
                    error: error.message
                }
            }));
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Simulate a result monitor (AutoTransferBackend event handler)
async function resultMonitor() {
    console.log('Result monitor (AutoTransferBackend) started...');
    
    while (true) {
        try {
            // Blocking pop from result queue
            const result = await redis.brpop(QUEUE_NAMES.RESULT_QUEUE, 0);
            
            if (result) {
                const message = JSON.parse(result[1]);
                console.log(`Received result: ${JSON.stringify(message)}`);
                
                // Simulate event emission
                if (message.type === 'COPY_SUCCESS') {
                    console.log(`Would emit event: handleAutoTransfer with COPY_SUCCESS for ${message.payload.filePath}`);
                } else if (message.type === 'COPY_ERROR') {
                    console.log(`Would emit event: handleAutoTransfer with COPY_ERROR: ${message.payload.error}`);
                }
            }
        } catch (error) {
            console.error('Error monitoring results:', error);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Run the simulation
async function runSimulation() {
    try {
        // Clear existing queues
        await redis.del(QUEUE_NAMES.COPY_QUEUE);
        await redis.del(QUEUE_NAMES.RESULT_QUEUE);
        
        // Start all components
        producer();
        consumer();
        resultMonitor();
        
        // Keep the process running
        process.on('SIGINT', async () => {
            console.log('Cleaning up...');
            await redis.quit();
            process.exit(0);
        });
    } catch (error) {
        console.error('Simulation error:', error);
        process.exit(1);
    }
}

// Start the simulation
runSimulation();


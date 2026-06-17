const securos = require('securos');
const { Pool } = require("pg");
const fs = require('fs-extra');

let DB_USER = "postgres";
let DB_PASSWORD = "postgres";
let DB_HOST = "localhost";
let DB_APP = "tahakom_transfer";

const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD,
    max: 10, // Limit concurrent connections
    idleTimeoutMillis: 30000,
});

// Batch processing queue
const updateQueue = new Map();
const BATCH_SIZE = 100; // Process in batches of 100
const BATCH_TIMEOUT = 5000; // 5 seconds timeout

console.log("\n\r");

// Removed updateFileWithSize - now using only batching for all updates

// Optimized batch processor 
async function processBatch(updates) {
    if (updates.length === 0) return;
    
    const client = await pool.connect();
    const now = new Date();
    
    try {
        await client.query('BEGIN');
        
        // Get all file info in a single query
        const tids = updates.map(u => u.tid);
        const placeholders = tids.map((_, i) => `$${i + 1}`).join(',');
        
        const selectResult = await client.query(
            `SELECT id, tid, file_path FROM files WHERE file_size=0 AND tid IN (${placeholders})`,
            tids
        );
        
        let processedCount = 0;
        const filesToUpdate = [];
        
        // Get file sizes for all files
        for (const row of selectResult.rows) {
            try {
                const stats = await fs.stat(row.file_path);
                filesToUpdate.push({
                    id: row.id,
                    tid: row.tid,
                    file_path: row.file_path,
                    size: stats.size
                });
            } catch (e) {
                console.error(`[!] Cannot stat file ${row.file_path} for tid=${row.tid}:`, e.message);
            }
        }
        
        // Update all files in batch
        if (filesToUpdate.length > 0) {
            const updateQuery = `
                UPDATE files 
                SET file_size = data.size::bigint,
                    image_export_done_date_time = $1
                FROM (VALUES ${filesToUpdate.map((_, i) => `($${i * 2 + 2}, $${i * 2 + 3})`).join(',')}) 
                AS data(id, size) 
                WHERE files.id = data.id::integer
            `;
            
            const params = [now, ...filesToUpdate.flatMap(f => [f.id, f.size])];
            await client.query(updateQuery, params);
            
            processedCount = filesToUpdate.length;
            
            // Log successful updates
            filesToUpdate.forEach(f => {
                console.log(`[*] Updated ${f.file_path}: tid=${f.tid}, size=${f.size}`);
            });
        }
        
        await client.query('COMMIT');
        console.log(`[*] Batch processed ${processedCount}/${updates.length} files successfully`);
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[!] Batch transaction failed:', error.message);
    } finally {
        client.release();
    }
}

// Smart queue management
function addToQueue(tid) {
    updateQueue.set(tid, { tid, timestamp: Date.now() });
    
    if (updateQueue.size >= BATCH_SIZE) {
        processBatchQueue();
    }
}

async function processBatchQueue() {
    if (updateQueue.size === 0) return;
    
    const updates = Array.from(updateQueue.values());
    updateQueue.clear();
    
    console.log(`[*] Processing batch of ${updates.length} files`);
    await processBatch(updates);
}

// Process queue periodically
setInterval(processBatchQueue, BATCH_TIMEOUT);

securos.connect(async core => {
    core.registerEventHandler(
        "IMAGE_EXPORT",
        "*", 
        "*",
        async (e) => {
            if (e.action == "EXPORT_DONE") {
                console.log(
                    "Image Export Event:",
                    e.sourceType,
                    e.sourceId, 
                    e.action,
                    e.params.request_id,
                    e.params.queue_size,
                    new Date()
                );
                
                // Always add to queue for batching - reduces DB load
                addToQueue(e.params.request_id);
            }
        }
    );
});

// Graceful shutdown - process remaining queue items
process.on('SIGINT', async () => {
    console.log('[*] Shutting down gracefully...');
    await processBatchQueue();
    await pool.end();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('[*] Shutting down gracefully...');
    await processBatchQueue();
    await pool.end();
    process.exit(0);
});
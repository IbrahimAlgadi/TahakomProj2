const { Pool } = require('pg');
const { getActiveBatchesInfo, getBatchHistory, getBatchDetails, formatFileSize } = require('../../utils/batchUtils');

const pool = new Pool({
    user: "postgres",
    host: "localhost",
    database: "tahakom_transfer",
    port: 5432,
    password: "postgres"
});

// Utility functions to monitor transfer queue
class TransferQueueMonitor {
    
    // Get summary of transfer queue status
    async getQueueSummary() {
        const query = `
            SELECT 
                status,
                file_origin,
                COUNT(*) as count,
                SUM(file_size) as total_size
            FROM transfer_queue 
            GROUP BY status, file_origin
            ORDER BY status, file_origin;
        `;
        
        const result = await pool.query(query);
        return result.rows;
    }
    
    // Get active batches using batch utilities
    async getActiveBatches() {
        return await getActiveBatchesInfo(pool);
    }
    
    // Get batch history with completion status using batch utilities
    async getBatchHistory(limit = 10) {
        return await getBatchHistory(pool, limit);
    }
    
    // Get detailed batch information using batch utilities
    async getBatchDetails(batchId) {
        return await getBatchDetails(pool, batchId);
    }
    
    // Get failed transfers
    async getFailedTransfers() {
        const query = `
            SELECT 
                id,
                file_path,
                file_size,
                batch_id,
                retry_count,
                max_retries,
                error_message,
                updated_at
            FROM transfer_queue 
            WHERE status = 'failed'
            ORDER BY updated_at DESC
            LIMIT 50;
        `;
        
        const result = await pool.query(query);
        return result.rows;
    }
    
    // Retry failed transfers
    async retryFailedTransfers(batchId = null) {
        let query = `
            UPDATE transfer_queue 
            SET status = 'pending', retry_count = 0, error_message = NULL, updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'failed'
        `;
        let params = [];
        
        if (batchId) {
            query += ` AND batch_id = $1`;
            params = [batchId];
        }
        
        const result = await pool.query(query, params);
        return result.rowCount;
    }
    
    // Clear completed transfers older than specified days
    async clearOldTransfers(days = 7) {
        const query = `
            DELETE FROM transfer_queue 
            WHERE status = 'transferred' 
            AND transferred_at < CURRENT_TIMESTAMP - INTERVAL '${days} days';
        `;
        
        const result = await pool.query(query);
        return result.rowCount;
    }
    
    // Get transfer statistics
    async getTransferStats() {
        const query = `
            SELECT 
                DATE(created_at) as date,
                file_origin,
                COUNT(*) as files_processed,
                SUM(CASE WHEN status = 'transferred' THEN 1 ELSE 0 END) as successful,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(file_size) as total_size,
                AVG(EXTRACT(EPOCH FROM (COALESCE(transferred_at, updated_at) - created_at))) as avg_processing_time_seconds
            FROM transfer_queue 
            WHERE created_at >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY DATE(created_at), file_origin
            ORDER BY date DESC, file_origin;
        `;
        
        const result = await pool.query(query);
        return result.rows;
    }
}

// CLI interface for monitoring
async function main() {
    const monitor = new TransferQueueMonitor();
    
    const command = process.argv[2];
    
    try {
        switch(command) {
            case 'summary':
                console.log('\n=== Transfer Queue Summary ===');
                const summary = await monitor.getQueueSummary();
                console.table(summary);
                break;
                
            case 'active':
                console.log('\n=== Active Batches ===');
                const activeBatches = await monitor.getActiveBatches();
                if (activeBatches.length === 0) {
                    console.log('No active batches found.');
                } else {
                    console.table(activeBatches);
                }
                break;
                
            case 'history':
                const limit = parseInt(process.argv[3]) || 10;
                console.log(`\n=== Batch History (Last ${limit}) ===`);
                const history = await monitor.getBatchHistory(limit);
                console.table(history);
                break;
                
            case 'details':
                const batchId = process.argv[3];
                if (!batchId) {
                    console.log('Please provide a batch ID: node transferQueueMonitor.js details <batch-id>');
                    break;
                }
                console.log(`\n=== Batch Details: ${batchId} ===`);
                const details = await monitor.getBatchDetails(batchId);
                console.table(details);
                break;
                
            case 'failed':
                console.log('\n=== Failed Transfers ===');
                const failed = await monitor.getFailedTransfers();
                console.table(failed.slice(0, 10)); // Show first 10
                break;
                
            case 'stats':
                console.log('\n=== Transfer Statistics (Last 7 Days) ===');
                const stats = await monitor.getTransferStats();
                console.table(stats);
                break;
                
            case 'retry':
                const retryBatchId = process.argv[3];
                const retried = await monitor.retryFailedTransfers(retryBatchId);
                console.log(`Retried ${retried} failed transfers${retryBatchId ? ` for batch ${retryBatchId}` : ''}`);
                break;
                
            case 'cleanup':
                const days = parseInt(process.argv[3]) || 7;
                const cleaned = await monitor.clearOldTransfers(days);
                console.log(`Cleaned up ${cleaned} old transfer records (older than ${days} days)`);
                break;
                
            default:
                console.log(`
Usage: node transferQueueMonitor.js <command>

Commands:
  summary  - Show transfer queue summary by status and origin
  active   - Show currently active batches
  history [limit] - Show batch history (default: 10)
  details <batch_id> - Show detailed files in a specific batch
  failed   - Show failed transfers
  stats    - Show transfer statistics for last 7 days
  retry [batch_id] - Retry failed transfers (optionally for specific batch)
  cleanup [days] - Clean up old transferred records (default: 7 days)

Examples:
  node transferQueueMonitor.js summary
  node transferQueueMonitor.js active
  node transferQueueMonitor.js history 20
  node transferQueueMonitor.js details 123e4567-e89b-12d3-a456-426614174000
  node transferQueueMonitor.js retry
  node transferQueueMonitor.js retry 123e4567-e89b-12d3-a456-426614174000
  node transferQueueMonitor.js cleanup 30
                `);
        }
    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main();
}

module.exports = TransferQueueMonitor;
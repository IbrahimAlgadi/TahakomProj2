#!/usr/bin/env node

/**
 * Manual cleanup script to fix corrupted video processing state
 * 
 * This script will:
 * 1. Clean up corrupted buffer entries (files marked as converted but missing from disk)
 * 2. Remove old failed jobs
 * 3. Clear temp directories
 * 4. Show current system status
 */

const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');
const config = require('./utils/envConfig.js');

// Database connection
const pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
});

const VIDEO_TEMP_DIR = path.join(__dirname, 'temp_video_processing');

/**
 * Mark buffer entry as failed
 */
async function markBufferEntryAsFailed(bufferId, errorMessage) {
    try {
        await pool.query(`
            UPDATE video_converted_buffer 
            SET status = 'failed', 
                updated_at = CURRENT_TIMESTAMP,
                error_message = $2
            WHERE id = $1
        `, [bufferId, errorMessage]);
    } catch (error) {
        console.error(`[ERROR] Failed to mark buffer entry ${bufferId} as failed:`, error.message);
    }
}

/**
 * Clean up corrupted buffer entries
 */
async function cleanupCorruptedBufferEntries() {
    console.log('\n🧹 [CLEANUP] Checking for corrupted buffer entries...');
    
    try {
        // Get all converted entries
        const result = await pool.query(`
            SELECT id, converted_file_path, source_file_id, camera_id, status
            FROM video_converted_buffer 
            WHERE status = 'converted'
        `);
        
        console.log(`   Found ${result.rows.length} entries marked as 'converted'`);
        
        let cleanedCount = 0;
        
        for (const entry of result.rows) {
            // Check if file exists on disk
            if (!await fs.pathExists(entry.converted_file_path)) {
                console.log(`   ✗ Missing file: ${entry.converted_file_path}`);
                
                // Mark as failed and clean up
                await markBufferEntryAsFailed(entry.id, 'File no longer exists on disk');
                cleanedCount++;
            }
        }
        
        if (cleanedCount > 0) {
            console.log(`   ✅ Marked ${cleanedCount} corrupted buffer entries as failed`);
        } else {
            console.log(`   ✅ No corrupted entries found`);
        }
    } catch (error) {
        console.error('   ❌ Failed to cleanup corrupted buffer entries:', error.message);
    }
}

/**
 * Clean up old failed jobs
 */
async function cleanupOldFailedJobs() {
    console.log('\n🗑️  [CLEANUP] Removing old failed jobs...');
    
    try {
        const result = await pool.query(`
            DELETE FROM video_transfer_queue_job 
            WHERE status = 'failed' 
            AND created_at < NOW() - INTERVAL '1 hour'
            RETURNING id, batch_id, created_at
        `);
        
        if (result.rows.length > 0) {
            console.log(`   ✅ Removed ${result.rows.length} old failed jobs`);
            for (const job of result.rows) {
                console.log(`      - Job ${job.batch_id} (created: ${job.created_at})`);
            }
        } else {
            console.log(`   ✅ No old failed jobs to remove`);
        }
    } catch (error) {
        console.error('   ❌ Failed to cleanup old failed jobs:', error.message);
    }
}

/**
 * Clean up temp directories
 */
async function cleanupTempDirectories() {
    console.log('\n📁 [CLEANUP] Cleaning temp directories...');
    
    try {
        if (await fs.pathExists(VIDEO_TEMP_DIR)) {
            const dirs = await fs.readdir(VIDEO_TEMP_DIR);
            let removedCount = 0;
            
            for (const dir of dirs) {
                const fullPath = path.join(VIDEO_TEMP_DIR, dir);
                const stats = await fs.stat(fullPath);
                
                // Remove directories older than 1 hour
                if (stats.isDirectory() && (Date.now() - stats.mtime.getTime()) > (60 * 60 * 1000)) {
                    try {
                        await fs.remove(fullPath);
                        console.log(`   ✗ Removed old temp dir: ${dir}`);
                        removedCount++;
                    } catch (error) {
                        console.log(`   ❌ Failed to remove ${dir}: ${error.message}`);
                    }
                }
            }
            
            if (removedCount > 0) {
                console.log(`   ✅ Removed ${removedCount} old temp directories`);
            } else {
                console.log(`   ✅ No old temp directories to remove`);
            }
        } else {
            console.log(`   ✅ Temp directory doesn't exist`);
        }
    } catch (error) {
        console.error('   ❌ Failed to cleanup temp directories:', error.message);
    }
}

/**
 * Show current system status
 */
async function showSystemStatus() {
    console.log('\n📊 [STATUS] Current system status:');
    
    try {
        // Video transfer jobs
        const jobsResult = await pool.query(`
            SELECT status, COUNT(*) as count 
            FROM video_transfer_queue_job 
            GROUP BY status 
            ORDER BY status
        `);
        
        console.log('\n   📋 Video Transfer Jobs:');
        if (jobsResult.rows.length > 0) {
            for (const row of jobsResult.rows) {
                console.log(`      ${row.status}: ${row.count}`);
            }
        } else {
            console.log(`      No jobs found`);
        }
        
        // Buffer entries
        const bufferResult = await pool.query(`
            SELECT status, COUNT(*) as count 
            FROM video_converted_buffer 
            GROUP BY status 
            ORDER BY status
        `);
        
        console.log('\n   🔄 Buffer Entries:');
        if (bufferResult.rows.length > 0) {
            for (const row of bufferResult.rows) {
                console.log(`      ${row.status}: ${row.count}`);
            }
        } else {
            console.log(`      No buffer entries found`);
        }
        
        // Recent unprocessed files
        const filesResult = await pool.query(`
            SELECT camera_id, COUNT(*) as count
            FROM iss_media_files 
            WHERE deleted = false 
              AND is_auto_transferred = false
              AND recording_date >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY camera_id 
            ORDER BY camera_id
        `);
        
        console.log('\n   📹 Unprocessed Files (last 7 days):');
        if (filesResult.rows.length > 0) {
            for (const row of filesResult.rows) {
                console.log(`      Camera ${row.camera_id}: ${row.count} files`);
            }
        } else {
            console.log(`      No unprocessed files found`);
        }
        
    } catch (error) {
        console.error('   ❌ Failed to get system status:', error.message);
    }
}

/**
 * Main cleanup function
 */
async function main() {
    console.log('🚀 Starting system cleanup and status check...\n');
    
    try {
        // Run all cleanup operations
        await cleanupCorruptedBufferEntries();
        await cleanupOldFailedJobs();
        await cleanupTempDirectories();
        
        // Show current status
        await showSystemStatus();
        
        console.log('\n✅ Cleanup completed successfully!');
        console.log('\n💡 The system should now be ready to use the new file accumulation approach.');
        
    } catch (error) {
        console.error('\n❌ Cleanup failed:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

// Run the cleanup
if (require.main === module) {
    main().catch(console.error);
}

module.exports = { 
    cleanupCorruptedBufferEntries, 
    cleanupOldFailedJobs, 
    cleanupTempDirectories,
    showSystemStatus 
};

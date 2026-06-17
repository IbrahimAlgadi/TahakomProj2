#!/usr/bin/env node

/**
 * Debug script to check current buffer status
 */

const { Pool } = require('pg');
const config = require('./utils/envConfig.js');

// Database connection
const pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
});

async function checkBufferStatus() {
    try {
        console.log('🔍 Checking video_converted_buffer status...\n');

        // Get overall status counts
        const statusResult = await pool.query(`
            SELECT status, COUNT(*) as count 
            FROM video_converted_buffer 
            GROUP BY status 
            ORDER BY status
        `);

        console.log('📊 Buffer Status Overview:');
        for (const row of statusResult.rows) {
            console.log(`   ${row.status}: ${row.count} entries`);
        }

        // Get recent entries by camera
        const recentResult = await pool.query(`
            SELECT camera_id, group_key, recording_date, status, COUNT(*) as count,
                   MIN(created_at) as first_created, MAX(updated_at) as last_updated
            FROM video_converted_buffer 
            WHERE created_at >= NOW() - INTERVAL '2 hours'
            GROUP BY camera_id, group_key, recording_date, status
            ORDER BY camera_id, recording_date DESC, group_key
        `);

        console.log('\n📅 Recent Buffer Entries (last 2 hours):');
        for (const row of recentResult.rows) {
            console.log(`   Camera ${row.camera_id}: ${row.group_key} | ${row.status} | Count: ${row.count}`);
            console.log(`      Created: ${row.first_created} | Updated: ${row.last_updated}`);
        }

        // Check for potential issues
        const issuesResult = await pool.query(`
            SELECT camera_id, group_key, status, COUNT(*) as count
            FROM video_converted_buffer 
            WHERE created_at >= NOW() - INTERVAL '1 hour'
            GROUP BY camera_id, group_key, status
            HAVING COUNT(*) > 0
            ORDER BY camera_id, group_key, status
        `);

        console.log('\n⚠️  Groups with files in last hour:');
        const groupStatus = {};
        for (const row of issuesResult.rows) {
            const key = `${row.camera_id}_${row.group_key}`;
            if (!groupStatus[key]) groupStatus[key] = {};
            groupStatus[key][row.status] = row.count;
        }

        for (const [groupKey, statuses] of Object.entries(groupStatus)) {
            console.log(`   ${groupKey}:`);
            for (const [status, count] of Object.entries(statuses)) {
                console.log(`      ${status}: ${count}`);
            }
        }

    } catch (error) {
        console.error('❌ Error checking buffer status:', error.message);
    } finally {
        await pool.end();
    }
}

checkBufferStatus().catch(console.error);

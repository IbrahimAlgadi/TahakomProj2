#!/usr/bin/env node

/**
 * Test script to check specific buffer queries
 */

const { Pool } = require('pg');
const config = require('../utils/envConfig.js');

// Database connection
const pool = new Pool({
    host: config.DB_HOST,
    port: config.DB_PORT,
    database: config.DB_NAME,
    user: config.DB_USER,
    password: config.DB_PASSWORD,
});

async function testBufferQuery() {
    try {
        // Test parameters from the error logs
        const cameraId = 1;
        const date = '2025-08-10';
        const groupKey = 'cam_1_2025-08-10_748-808';

        console.log(`🔍 Testing buffer query with:`);
        console.log(`   Camera ID: ${cameraId}`);
        console.log(`   Date: ${date}`);
        console.log(`   Group Key: ${groupKey}`);
        console.log();

        // Check what's in the buffer for this camera and group
        const allResult = await pool.query(`
            SELECT id, source_file_id, converted_file_name, status, group_key, recording_date, 
                   created_at, updated_at
            FROM video_converted_buffer 
            WHERE camera_id = $1 
            AND group_key = $2
            ORDER BY precise_time
        `, [cameraId, groupKey]);

        console.log(`📄 All entries for camera ${cameraId} with group key '${groupKey}':`);
        console.log(`   Found ${allResult.rows.length} entries`);
        
        for (const row of allResult.rows) {
            console.log(`   ID: ${row.id} | Status: ${row.status} | Date: ${row.recording_date} | File: ${row.converted_file_name}`);
            console.log(`      Created: ${row.created_at} | Updated: ${row.updated_at}`);
        }

        // Test the exact query that's failing
        const exactResult = await pool.query(`
            SELECT * FROM video_converted_buffer 
            WHERE camera_id = $1 
            AND recording_date = $2 
            AND group_key = $3 
            AND status = 'converted'
            ORDER BY precise_time
            LIMIT 38
        `, [cameraId, date, groupKey]);

        console.log(`\n🎯 Exact query result (looking for 'converted' status):`);
        console.log(`   Found ${exactResult.rows.length} converted files`);

        if (exactResult.rows.length === 0) {
            // Check different statuses for this group
            const statusResult = await pool.query(`
                SELECT status, COUNT(*) as count 
                FROM video_converted_buffer 
                WHERE camera_id = $1 
                AND group_key = $2
                GROUP BY status
            `, [cameraId, groupKey]);

            console.log(`\n📊 Status breakdown for this group:`);
            for (const row of statusResult.rows) {
                console.log(`   ${row.status}: ${row.count} files`);
            }
        }

        // Check recent activity
        const recentResult = await pool.query(`
            SELECT camera_id, group_key, status, COUNT(*) as count, 
                   MAX(updated_at) as last_updated
            FROM video_converted_buffer 
            WHERE camera_id = $1 
            AND created_at >= NOW() - INTERVAL '30 minutes'
            GROUP BY camera_id, group_key, status
            ORDER BY last_updated DESC
        `, [cameraId]);

        console.log(`\n⏰ Recent activity for camera ${cameraId} (last 30 minutes):`);
        for (const row of recentResult.rows) {
            console.log(`   Group: ${row.group_key} | Status: ${row.status} | Count: ${row.count} | Updated: ${row.last_updated}`);
        }

    } catch (error) {
        console.error('❌ Error testing buffer query:', error.message);
    } finally {
        await pool.end();
    }
}

testBufferQuery().catch(console.error);

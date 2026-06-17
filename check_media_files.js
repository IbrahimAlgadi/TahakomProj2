const { Pool } = require('pg');
const config = require('./utils/envConfig');

// Initialize PostgreSQL pool
const pool = new Pool({
    user: config.database.user,
    host: config.database.host,
    database: config.database.database,
    port: 5432,
    password: config.database.password
});

async function checkMediaFiles() {
    try {
        console.log('🔍 Checking iss_media_files table status...\n');
        
        // 1. Total count
        const totalResult = await pool.query('SELECT COUNT(*) as total FROM iss_media_files');
        const totalFiles = parseInt(totalResult.rows[0].total);
        console.log(`📊 Total files in database: ${totalFiles}`);
        
        if (totalFiles === 0) {
            console.log('⚠️  No files found in iss_media_files table!');
            console.log('💡 This is why video processing finds no files to process.');
            console.log('💡 Make sure the ISS Media Indexing Service is running and indexing .issvd files.');
            await pool.end();
            return;
        }
        
        // 2. Camera breakdown
        console.log('\n📷 Files by camera:');
        const cameraResult = await pool.query(`
            SELECT 
                camera_id,
                COUNT(*) as total,
                COUNT(CASE WHEN is_auto_transferred = false AND deleted = false THEN 1 END) as unprocessed,
                COUNT(CASE WHEN deleted = true THEN 1 END) as deleted
            FROM iss_media_files 
            GROUP BY camera_id 
            ORDER BY camera_id
        `);
        
        for (const row of cameraResult.rows) {
            console.log(`  Camera ${row.camera_id}: ${row.total} total, ${row.unprocessed} unprocessed, ${row.deleted} deleted`);
        }
        
        // 3. Recent files (last 7 days)
        console.log('\n📅 Files from last 7 days:');
        const recentResult = await pool.query(`
            SELECT 
                camera_id,
                COUNT(*) as total,
                COUNT(CASE WHEN is_auto_transferred = false AND deleted = false THEN 1 END) as unprocessed
            FROM iss_media_files 
            WHERE recording_date >= CURRENT_DATE - INTERVAL '7 days'
            GROUP BY camera_id 
            ORDER BY camera_id
        `);
        
        if (recentResult.rows.length === 0) {
            console.log('⚠️  No files from last 7 days found!');
            console.log('💡 Video processing only looks at files from the last 7 days.');
        } else {
            for (const row of recentResult.rows) {
                console.log(`  Camera ${row.camera_id}: ${row.total} total, ${row.unprocessed} unprocessed (last 7 days)`);
            }
        }
        
        // 4. Sample files
        console.log('\n📝 Sample unprocessed files:');
        const sampleResult = await pool.query(`
            SELECT 
                camera_id,
                file_name,
                recording_date,
                precise_time
            FROM iss_media_files 
            WHERE 
                recording_date >= CURRENT_DATE - INTERVAL '7 days'
                AND deleted = false 
                AND is_auto_transferred = false
            ORDER BY camera_id, recording_date DESC, precise_time DESC
            LIMIT 10
        `);
        
        if (sampleResult.rows.length === 0) {
            console.log('⚠️  No unprocessed files found!');
        } else {
            for (const row of sampleResult.rows) {
                console.log(`  📹 Camera ${row.camera_id}: ${row.file_name} (${row.recording_date} ${row.precise_time})`);
            }
        }
        
        console.log('\n✅ Media files check complete!');
        
    } catch (error) {
        console.error('❌ Error checking media files:', error);
    } finally {
        await pool.end();
    }
}

checkMediaFiles();

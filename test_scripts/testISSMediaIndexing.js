const Redis = require('ioredis');
const { Pool } = require('pg');
const fs = require('fs-extra');
const path = require('path');

// Configuration
const config = require('../utils/envConfig');
const { MEDIA_INDEX_STATUS, CONFIG_STATE_KEY } = require('../redisKeyStore');

// Initialize Redis and DB connections
const redis = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

const pool = new Pool({
    user: config.database.user,
    host: config.database.host,
    database: config.database.database,
    port: 5432,
    password: config.database.password
});

async function testConfiguration() {
    console.log('🔧 Testing Configuration...');
    console.log(`ISS_MEDIA_DIR: ${config.ISS_MEDIA_DIR}`);
    console.log(`ISS_MEDIA_CAMERAS: ${config.ISS_MEDIA_CAMERAS.join(', ')}`);
    console.log(`ISS_MEDIA_FILE_SIZE: ${config.ISS_MEDIA_FILE_SIZE} KB`);
    console.log(`ISS_MEDIA_RETENTION: ${config.ISS_MEDIA_RETENTION} days`);
    
    // Test directory access
    try {
        const exists = await fs.pathExists(config.ISS_MEDIA_DIR);
        console.log(`📁 ISS_MEDIA_DIR exists: ${exists ? '✅' : '❌'}`);
        
        if (exists) {
            const stats = await fs.stat(config.ISS_MEDIA_DIR);
            console.log(`📁 ISS_MEDIA_DIR is directory: ${stats.isDirectory() ? '✅' : '❌'}`);
        }
    } catch (error) {
        console.log(`📁 Error accessing ISS_MEDIA_DIR: ❌ ${error.message}`);
    }
}

async function testDatabaseConnection() {
    console.log('\n💾 Testing Database Connection...');
    try {
        const result = await pool.query('SELECT NOW()');
        console.log(`💾 Database connection: ✅ ${result.rows[0].now}`);
        
        // Check if iss_media_files table exists
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = 'public' 
                AND table_name = 'iss_media_files'
            );
        `);
        console.log(`💾 ISS Media Files table exists: ${tableCheck.rows[0].exists ? '✅' : '❌'}`);
        
        // Count existing media files
        const fileCount = await pool.query(`
            SELECT COUNT(*) as count 
            FROM iss_media_files 
            WHERE deleted = false
        `);
        console.log(`💾 Existing ISS media files in DB: ${fileCount.rows[0].count}`);
        
    } catch (error) {
        console.log(`💾 Database connection failed: ❌ ${error.message}`);
    }
}

async function testRedisConnection() {
    console.log('\n🔴 Testing Redis Connection...');
    try {
        const pong = await redis.ping();
        console.log(`🔴 Redis connection: ${pong === 'PONG' ? '✅' : '❌'}`);
        
        // Check config state
        const configStr = await redis.get(CONFIG_STATE_KEY);
        if (configStr) {
            const configData = JSON.parse(configStr);
            const siteId = configData && configData.storage && configData.storage.siteId;
            console.log(`🔴 Current site_id: ${siteId || 'Not set'}`);
        } else {
            console.log(`🔴 Configuration not found in Redis`);
        }
        
        // Check indexing status
        const statusStr = await redis.get(MEDIA_INDEX_STATUS);
        if (statusStr) {
            const status = JSON.parse(statusStr);
            console.log(`🔴 Last indexing status:`, status);
        } else {
            console.log(`🔴 No indexing status found (service may not have run yet)`);
        }
        
    } catch (error) {
        console.log(`🔴 Redis connection failed: ❌ ${error.message}`);
    }
}

async function testDirectoryStructure() {
    console.log('\n📁 Testing Directory Structure...');
    
    for (const cameraId of config.ISS_MEDIA_CAMERAS) {
        const cameraPath = path.join(config.ISS_MEDIA_DIR, cameraId);
        
        try {
            const exists = await fs.pathExists(cameraPath);
            console.log(`📹 ${cameraId}: ${exists ? '✅' : '❌'}`);
            
            if (exists) {
                const dirs = await fs.readdir(cameraPath);
                const dateDirs = dirs.filter(dir => 
                    /^\d{4}-\d{2}-\d{2}T\d{2}\+\d{4}$/.test(dir)
                );
                console.log(`   📅 Date directories found: ${dateDirs.length}`);
                
                if (dateDirs.length > 0) {
                    // Check first directory for .issvd files
                    const firstDir = dateDirs[0];
                    const firstDirPath = path.join(cameraPath, firstDir);
                    const files = await fs.readdir(firstDirPath);
                    const issvdFiles = files.filter(f => f.endsWith('.issvd'));
                    console.log(`   📄 ISSVD files in ${firstDir}: ${issvdFiles.length}`);
                    
                    if (issvdFiles.length > 0) {
                        console.log(`   📄 Sample file: ${issvdFiles[0]}`);
                    }
                }
            }
        } catch (error) {
            console.log(`📹 ${cameraId}: ❌ ${error.message}`);
        }
    }
}

async function testFilenameParsing() {
    console.log('\n🔍 Testing Filename Parsing...');
    
    const testFiles = [
        '2025-07-14T09+0300_00-02-360_1.issvd',
        '2025-07-14T15+0300_15-30-500_2.issvd', 
        '2025-12-31T23+0500_59-59-999_3.issvd',
        'invalid-file.issvd',
        '2025-07-14T09+0300_00-02-360_invalid.issvd'
    ];
    
    for (const filename of testFiles) {
        const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})\+(\d{4})_(\d{2})-(\d{2})-(\d{3})_(\d+)\.issvd$/);
        if (match) {
            const [, year, month, day, hour, timezone, minutes, seconds, milliseconds, cameraId] = match;
            console.log(`✅ ${filename} -> Date:${year}-${month}-${day}, Time:${hour}:00:00+${timezone}, Offset:${minutes}:${seconds}.${milliseconds}, Cam:${cameraId}`);
        } else {
            console.log(`❌ ${filename} -> Invalid format`);
        }
    }
}

async function testDateTimeParsing() {
    console.log('\n📅 Testing Complete Filename Parsing...');
    
    const testFiles = [
        '2025-07-14T09+0300_00-02-360_1.issvd',
        '2025-01-01T00+0000_10-15-250_2.issvd',
        '2025-12-31T23+0500_45-30-999_3.issvd'
    ];
    
    for (const filename of testFiles) {
        const match = filename.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})\+(\d{4})_(\d{2})-(\d{2})-(\d{3})_(\d+)\.issvd$/);
        if (match) {
            const [, year, month, day, hour, timezone, minutes, seconds, milliseconds, cameraId] = match;
            
            // Calculate precise time
            const baseHour = parseInt(hour);
            const offsetMinutes = parseInt(minutes);
            const offsetSeconds = parseInt(seconds);
            const offsetMs = parseInt(milliseconds);
            
            const totalSeconds = offsetSeconds + Math.floor(offsetMs / 1000);
            const remainingMs = offsetMs % 1000;
            const finalMinutes = offsetMinutes + Math.floor(totalSeconds / 60);
            const finalSeconds = totalSeconds % 60;
            const finalHours = baseHour + Math.floor(finalMinutes / 60);
            const normalizedMinutes = finalMinutes % 60;
            
            const preciseTime = `${String(finalHours).padStart(2, '0')}:${String(normalizedMinutes).padStart(2, '0')}:${String(finalSeconds).padStart(2, '0')}.${String(remainingMs).padStart(3, '0')}`;
            
            console.log(`✅ ${filename}`);
            console.log(`   Date: ${year}-${month}-${day}, Base Time: ${hour}:00:00+${timezone}`);
            console.log(`   Precise Time: ${preciseTime}, Camera: ${cameraId}`);
        } else {
            console.log(`❌ ${filename} -> Invalid format`);
        }
    }
}

async function runAllTests() {
    console.log('🧪 ISS Media Indexing Service Test Suite\n');
    
    try {
        await testConfiguration();
        await testDatabaseConnection();
        await testRedisConnection();
        await testDirectoryStructure();
        await testFilenameParsing();
        await testDateTimeParsing();
        
        console.log('\n🎉 Test suite completed!');
        console.log('\n💡 Next steps:');
        console.log('  1. Fix any ❌ issues shown above');
        console.log('  2. Start the service: pm2 start ecosystem.config.js --only monitorISSMediaFilesMicroservice');
        console.log('  3. Monitor logs: pm2 logs monitorISSMediaFilesMicroservice');
        console.log('  4. Check status: redis-cli GET media_index_status');
        console.log('  5. Query ISS media files: SELECT COUNT(*) FROM iss_media_files;');
        
    } catch (error) {
        console.error('🚨 Test suite error:', error);
    } finally {
        await redis.quit();
        await pool.end();
    }
}

// Run if called directly
if (require.main === module) {
    runAllTests();
}

module.exports = {
    testConfiguration,
    testDatabaseConnection,
    testRedisConnection,
    testDirectoryStructure,
    testFilenameParsing,
    testDateTimeParsing,
    runAllTests
}; 
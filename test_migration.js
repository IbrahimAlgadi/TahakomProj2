// Test script to verify database migration
const { Client } = require('pg');

async function testMigration() {
    console.log('🧪 Testing Database Migration Order...');
    
    const client = new Client({
        user: "postgres",
        host: "localhost",
        database: "tahakom_transfer",
        password: "postgres",
        port: 5432,
    });

    try {
        await client.connect();
        console.log('✅ Connected to database');
        
        // Check if all required tables exist
        const tableQuery = `
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name IN (
                'iss_media_files',
                'video_transfer_queue_job', 
                'video_converted_buffer',
                'video_transfer_queue'
            )
            ORDER BY table_name;
        `;
        
        const result = await client.query(tableQuery);
        const tables = result.rows.map(row => row.table_name);
        
        console.log('📋 Found tables:', tables);
        
        // Check foreign key constraints
        const fkQuery = `
            SELECT 
                tc.table_name, 
                tc.constraint_name, 
                ccu.table_name AS foreign_table_name,
                ccu.column_name AS foreign_column_name
            FROM 
                information_schema.table_constraints AS tc 
                JOIN information_schema.constraint_column_usage AS ccu
                  ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY' 
            AND tc.table_name IN ('video_converted_buffer', 'video_transfer_queue')
            ORDER BY tc.table_name;
        `;
        
        const fkResult = await client.query(fkQuery);
        console.log('🔗 Foreign key constraints:');
        fkResult.rows.forEach(row => {
            console.log(`  ${row.table_name}.${row.constraint_name} → ${row.foreign_table_name}.${row.foreign_column_name}`);
        });
        
        // Test job_id column in video_converted_buffer
        const columnQuery = `
            SELECT column_name, data_type, is_nullable
            FROM information_schema.columns 
            WHERE table_name = 'video_converted_buffer' 
            AND column_name = 'job_id';
        `;
        
        const columnResult = await client.query(columnQuery);
        if (columnResult.rows.length > 0) {
            console.log('✅ job_id column exists in video_converted_buffer:', columnResult.rows[0]);
        } else {
            console.log('❌ job_id column missing in video_converted_buffer');
        }
        
        console.log('🎉 Migration test completed successfully!');
        
    } catch (error) {
        console.error('❌ Migration test failed:', error.message);
    } finally {
        await client.end();
    }
}

// Run the test
testMigration().catch(console.error);

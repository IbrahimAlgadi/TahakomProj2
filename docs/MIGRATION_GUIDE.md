# Database Migration Guide

## 🔧 Steps to Run Migration

### 1. Run the Main Migration
```bash
node DatabaseMigration.js
```

### 2. Test the Migration (Optional)
```bash
node test_migration.js
```

### 3. Run Additional job_id Migration (If Needed)
If you have existing data in `video_converted_buffer`, run:
```bash
psql -h localhost -U postgres -d tahakom_transfer -f sql/add_job_id_to_video_converted_buffer.sql
```

## 📋 What the Migration Does

### Table Creation Order (Fixed):
1. ✅ `iss_media_files` (no dependencies)
2. ✅ `video_transfer_queue_job` (no dependencies) 
3. ✅ `video_converted_buffer` (depends on both above tables)
4. ✅ `video_transfer_queue` (depends on video_transfer_queue_job)

### Key Changes:
- **Added `job_id` column** to `video_converted_buffer` with foreign key to `video_transfer_queue_job`
- **Enhanced indices** for better job-specific queries
- **Proper foreign key constraints** for data integrity

## 🚨 Error Resolution

### If you see "relation does not exist" errors:
1. Check table creation order in `DatabaseMigration.js`
2. Ensure parent tables are created before child tables
3. Run `node test_migration.js` to verify table structure

### For existing data:
1. Run the main migration first
2. Then run the job_id migration script if you have existing video_converted_buffer records

## ✅ Verification

After migration, you should see:
- All tables created successfully
- Foreign key constraints working
- `job_id` column in `video_converted_buffer` 
- Proper indices created

## 🔄 Rollback (If Needed)

To rollback the migration:
```bash
# The DatabaseMigration.js already has dropTables() function
# Just set CREATE_DB = false and uncomment the dropTables() call
```

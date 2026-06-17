# ISS Media Files - Separate Table Migration

## Summary of Changes

The ISS Media File Indexing Service has been updated to use a dedicated `iss_media_files` table instead of the shared `files` table for better organization and performance.

## What Changed

### 1. New Database Table
- **Table Name**: `iss_media_files`
- **Purpose**: Dedicated storage for ISS media files (.issvd)
- **Schema**: Optimized for video file metadata with proper indexing

### 2. Enhanced Data Structure
- **Precise Timing**: Stores exact recording time with millisecond precision
- **Timezone Awareness**: Separate timezone offset storage
- **Better Types**: Uses `BIGINT` for file sizes, `INTEGER` for camera IDs
- **Audit Trail**: Includes `created_at`, `updated_at`, `deleted_at` timestamps
- **Optimized Indexes**: Fast queries by camera, date, and transfer status

### 3. Service Updates
- Updated all database queries to use new table
- Enhanced data parsing for better granularity
- Improved error handling and logging

## Migration Process

### Automatic Migration
The new table will be created automatically when running:
```bash
node DatabaseMigration.js
```

### Manual Migration
If you prefer to create the table manually:
```bash
psql -d tahakom_transfer -f sql/create_iss_media_table.sql
```

## Key Benefits

1. **Better Performance**: Dedicated table with optimized indexes
2. **Enhanced Metadata**: Stores precise timing with timezone awareness
3. **Cleaner Architecture**: Separates ISS media files from regular files
4. **Transfer Compatibility**: Maintains compatibility with existing transfer workflows
5. **Better Queries**: Optimized for video file specific operations

## Database Schema Comparison

### Old (files table)
```sql
-- Mixed usage with image and video files
-- Generic cam_id field
-- Basic date/time without precision
-- No timezone awareness
```

### New (iss_media_files table)
```sql
CREATE TABLE iss_media_files (
    id SERIAL PRIMARY KEY,
    file_path TEXT UNIQUE NOT NULL,
    file_name TEXT NOT NULL,
    file_size BIGINT NOT NULL,
    camera_id INTEGER NOT NULL,     -- Camera ID from filename
    site_id TEXT,
    recording_date DATE NOT NULL,
    recording_time TIME NOT NULL,   -- Base time from filename
    timezone_offset TEXT NOT NULL, -- Timezone (+0300, +0500, etc.)
    precise_time TIME NOT NULL,     -- Exact time including offset
    is_auto_transferred BOOLEAN DEFAULT FALSE,
    is_ftp_transferred BOOLEAN DEFAULT FALSE,
    deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP DEFAULT NULL
);
```

## Testing

Run the updated test suite:
```bash
npm run test-iss-media
```

## Verification

After migration, verify the setup:

1. **Check table exists**:
   ```sql
   SELECT COUNT(*) FROM iss_media_files;
   ```

2. **Check service status**:
   ```bash
   pm2 status monitorISSMediaFilesMicroservice
   ```

3. **Monitor indexing**:
   ```bash
   redis-cli GET media_index_status
   ```

## Rollback Plan

If needed, you can temporarily disable the service:
```bash
pm2 stop monitorISSMediaFilesMicroservice
```

The original `files` table remains unchanged, so existing functionality is preserved.

## Files Modified

1. `DatabaseMigration.js` - Added new table creation
2. `monitorISSMediaFilesMicroservice.js` - Updated to use new table
3. `test_scripts/testISSMediaIndexing.js` - Updated tests
4. `ISS_MEDIA_INDEXING_SERVICE.md` - Updated documentation
5. `package.json` - Added test script
6. `sql/create_iss_media_table.sql` - Manual table creation script

## Next Steps

1. Run database migration to create the new table
2. Test the service with the new table structure
3. Start the updated service via PM2
4. Monitor indexing progress through Redis and logs 
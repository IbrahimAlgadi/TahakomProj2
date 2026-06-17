# ISS Media File Indexing Service

## Overview

The ISS Media File Indexing Service is a microservice that automatically indexes `.issvd` files from the ISS_MEDIA directory structure into the database. It monitors camera directories, processes files in date-time folders, and maintains an up-to-date index of all media files while respecting retention policies.

## Features

- **Automatic Indexing**: Scans ISS_MEDIA directory structure for new files
- **Retention Policy**: Only indexes files within the configured retention period (default: 7 days)
- **Incremental Processing**: Continues from last processed files for each camera
- **Site ID Integration**: Automatically uses site_id from configuration and handles changes
- **Performance Optimized**: Processes files with minimal system impact
- **Transaction Safety**: Uses database transactions for data integrity
- **Real-time Status**: Publishes indexing status via Redis

## Directory Structure

The service expects the following directory structure:

```
D:\ISS_MEDIA\
├── CAM_1\
│   ├── 2025-07-14T09+0300_00-02-360_1.issvd
│   ├── 2025-07-14T09+0300_00-02-361_1.issvd
│   ├── 2025-07-14T15+0300_15-30-500_1.issvd
│   └── ...
├── CAM_2\
│   ├── 2025-07-14T09+0300_00-02-360_2.issvd
│   └── ...
├── CAM_3\
└── ...
```

## Environment Variables

Add these variables to your `.env` file:

```bash
# ISS Media Configuration
ISS_MEDIA_DIR=D:\ISS_MEDIA
ISS_MEDIA_CAMERAS=CAM_1,CAM_2,CAM_3
ISS_MEDIA_FILE_SIZE=8192
ISS_MEDIA_RETENTION=7
```

### Variable Details

- **ISS_MEDIA_DIR**: Root directory containing camera folders
- **ISS_MEDIA_CAMERAS**: Comma-separated list of camera IDs to monitor
- **ISS_MEDIA_FILE_SIZE**: Default file size in KB (used when actual size can't be determined)
- **ISS_MEDIA_RETENTION**: Number of days to retain files in the index

## File Naming Convention

The service parses ISSVD files following this format:
- **Format**: `YYYY-MM-DDTHH+ZZZZ_MM-SS-MMM_C.issvd`
- **Example**: `2025-07-14T09+0300_00-02-360_1.issvd`
  - `2025-07-14`: Recording date
  - `T09+0300`: Base time (9 AM) with timezone offset (+0300)
  - `00-02-360`: Time offset (0 minutes, 2 seconds, 360 milliseconds)
  - `1`: Camera ID
  - **Final Time**: 09:02:02.360 (base time + offset)

## Database Schema

ISS Media files are stored in a dedicated `iss_media_files` table:

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

### Key Features of the Schema

- **Dedicated table**: Separate from regular files for better organization
- **Precise timing**: Stores exact recording time including millisecond precision
- **Timezone aware**: Stores timezone offset separately from time
- **Optimized indexes**: For fast queries by camera, date, and transfer status
- **Transfer tracking**: Compatible with existing auto and FTP transfer workflows
- **Soft delete**: Uses `deleted` flag instead of hard deletion

## Installation & Setup

### 1. Update Environment Configuration

Add the ISS Media variables to your `.env` file (see Environment Variables section above).

### 2. Start the Service

The service is included in the PM2 ecosystem configuration:

```bash
# Start all services including the media indexing service
pm2 start ecosystem.config.js

# Or start just this service
pm2 start ecosystem.config.js --only monitorISSMediaFilesMicroservice
```

### 3. Verify Service Status

```bash
# Check if the service is running
pm2 status

# View service logs
pm2 logs monitorISSMediaFilesMicroservice

# Monitor real-time logs
pm2 logs monitorISSMediaFilesMicroservice --lines 50 -f
```

## Service Behavior

### Initial Indexing

On first startup, the service:
1. Scans all camera directories
2. Processes all date-time folders within retention period
3. Indexes all `.issvd` files found
4. Stores metadata in the database

### Continuous Monitoring

After initial indexing:
1. Checks for new files every 5 minutes
2. Processes only new files since last run
3. Monitors for site_id configuration changes
4. Updates Redis status regularly

### Performance Considerations

- Processes files in small batches with delays
- Uses database transactions for consistency
- Skips already indexed files
- Implements error handling and retry logic

## Monitoring & Status

### Redis Status Keys

The service publishes status information to Redis:

- **Key**: `media_index_status`
- **Update Channel**: `media_index_update`

### Status Information

```json
{
    "totalFiles": 0,
    "processedFiles": 1250,
    "lastProcessedTime": "2025-01-15T10:30:00Z",
    "camerasProcessed": 3,
    "errorsCount": 2
}
```

### Monitoring Commands

```bash
# Check Redis status
redis-cli GET media_index_status

# Monitor real-time updates
redis-cli SUBSCRIBE media_index_update

# Check database records count
psql -d tahakom_transfer -c "SELECT COUNT(*) FROM iss_media_files WHERE deleted = false;"

# Check latest indexed files per camera
psql -d tahakom_transfer -c "SELECT camera_id, COUNT(*), MAX(recording_date) FROM iss_media_files GROUP BY camera_id;"
```

## Troubleshooting

### Common Issues

1. **Service won't start**
   - Check environment variables are set correctly
   - Verify ISS_MEDIA_DIR exists and is accessible
   - Check database connection

2. **No files being indexed**
   - Verify directory structure matches expected format
   - Check file permissions on ISS_MEDIA_DIR
   - Verify retention period allows current dates

3. **High error count**
   - Check logs for specific error messages
   - Verify file naming convention compliance
   - Check disk space and permissions

### Log Analysis

```bash
# View recent errors
pm2 logs monitorISSMediaFilesMicroservice --err

# Search for specific patterns
pm2 logs monitorISSMediaFilesMicroservice | grep -i error

# Monitor performance
pm2 logs monitorISSMediaFilesMicroservice | grep "Statistics"
```

## Integration with Existing Services

### Configuration Updates

The service automatically detects changes to `site_id` in the configuration:

1. Monitors Redis `config_state` key
2. Updates site_id for new files when configuration changes
3. Maintains backward compatibility with existing records

### File Transfer Integration

Indexed files integrate seamlessly with existing transfer services:

- Files marked with `is_auto_transferred` and `is_ftp_transferred` flags
- Compatible with auto transfer and manual transfer workflows
- Maintains consistent data structure with existing file records

## Performance Metrics

Expected performance characteristics:

- **Initial indexing**: ~1000 files per minute
- **Memory usage**: ~50-100MB
- **CPU usage**: <5% during active indexing
- **Database impact**: Minimal (uses efficient queries)

## Maintenance

### Regular Tasks

1. **Log rotation**: PM2 handles log rotation automatically
2. **Database cleanup**: Old records cleaned by retention policy
3. **Performance monitoring**: Check error rates and processing speed

### Backup Considerations

The service stores data in the dedicated `iss_media_files` table, which should be included in regular database backups. The table is separate from the main `files` table for better organization and performance.

## API Integration

While this is a background service, status information is available via:

1. **Redis**: Real-time status updates
2. **Database**: Query `iss_media_files` table for indexed media files
3. **PM2**: Service health and performance metrics

### Example Database Queries

```sql
-- Get files by camera and date
SELECT * FROM iss_media_files 
WHERE camera_id = 1 AND recording_date = '2025-01-15'
ORDER BY precise_time;

-- Get transfer statistics
SELECT 
    camera_id,
    COUNT(*) as total_files,
    COUNT(CASE WHEN is_auto_transferred THEN 1 END) as auto_transferred,
    COUNT(CASE WHEN is_ftp_transferred THEN 1 END) as ftp_transferred
FROM iss_media_files 
WHERE deleted = false 
GROUP BY camera_id;

-- Get files ready for transfer
SELECT * FROM iss_media_files 
WHERE deleted = false 
AND is_auto_transferred = false 
ORDER BY recording_date DESC, recording_time DESC;
```

## Future Enhancements

Potential improvements for future versions:

- Real-time file system watching instead of polling
- Parallel processing of multiple cameras
- Advanced error recovery and retry mechanisms
- Web dashboard for monitoring indexing status
- Integration with video transcoding workflows 
# Files Table Reports - Detailed Analysis Guide

This document provides detailed explanations and SQL queries for key reports from the `files` table in the tahakom_transfer database.

## Table of Contents
- [Camera Performance Report](#camera-performance-report)
- [Export Failure Analysis](#export-failure-analysis)
- [File Size Distribution Report](#file-size-distribution-report)
- [Deletion Audit Report](#deletion-audit-report)
- [File Generation Patterns Report](#file-generation-patterns-report)
- [Export Retry Analysis Report](#export-retry-analysis-report)
- [Data Retention Compliance Report](#data-retention-compliance-report)

---

## Camera Performance Report

### Purpose
Monitor individual camera health and productivity by analyzing file generation statistics per camera ID.

### Business Value
- Identify cameras requiring maintenance or replacement
- Optimize camera placement and configuration
- Track camera utilization across different sites
- Support preventive maintenance scheduling

### Key Metrics
- Total files generated per camera
- File generation trends over time
- Average file size per camera
- Camera activity by time periods
- Site-wise camera performance comparison

### SQL Queries

#### Basic Camera Performance Summary
```sql
SELECT 
    cam_id,
    site_id,
    COUNT(*) as total_files,
    AVG(file_size) as avg_file_size,
    SUM(file_size) as total_data_size,
    MIN(date) as first_file_date,
    MAX(date) as last_file_date,
    COUNT(CASE WHEN deleted = true THEN 1 END) as deleted_files,
    COUNT(CASE WHEN is_auto_transferred = true THEN 1 END) as auto_transferred_files,
    COUNT(CASE WHEN is_ftp_transferred = true THEN 1 END) as ftp_transferred_files
FROM files 
WHERE cam_id IS NOT NULL
GROUP BY cam_id, site_id
ORDER BY total_files DESC;
```

#### Camera Performance by Date Range
```sql
SELECT 
    cam_id,
    site_id,
    DATE(date) as file_date,
    COUNT(*) as daily_files,
    AVG(file_size) as avg_daily_file_size,
    SUM(file_size) as daily_data_volume
FROM files 
WHERE cam_id IS NOT NULL 
    AND date BETWEEN '2024-01-01' AND '2024-12-31'
    AND deleted = false
GROUP BY cam_id, site_id, DATE(date)
ORDER BY cam_id, file_date;
```

#### Top Performing Cameras
```sql
SELECT 
    cam_id,
    site_id,
    COUNT(*) as total_files,
    ROUND(AVG(file_size)::numeric, 2) as avg_file_size_bytes,
    ROUND((SUM(file_size) / 1024.0 / 1024.0)::numeric, 2) as total_size_mb,
    COUNT(DISTINCT date) as active_days
FROM files 
WHERE cam_id IS NOT NULL 
    AND deleted = false
    AND date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY cam_id, site_id
HAVING COUNT(*) > 10
ORDER BY total_files DESC
LIMIT 20;
```

#### Camera Activity Heatmap (Hourly)
```sql
SELECT 
    cam_id,
    EXTRACT(HOUR FROM time) as hour_of_day,
    COUNT(*) as files_count,
    AVG(file_size) as avg_file_size
FROM files 
WHERE cam_id IS NOT NULL 
    AND time IS NOT NULL
    AND date >= CURRENT_DATE - INTERVAL '7 days'
GROUP BY cam_id, EXTRACT(HOUR FROM time)
ORDER BY cam_id, hour_of_day;
```

---

## Export Failure Analysis

### Purpose
Analyze files with export retry attempts and detailed failure logs to identify and resolve export process issues.

### Business Value
- Troubleshoot export process bottlenecks
- Improve system reliability through error pattern analysis
- Optimize retry logic and parameters
- Reduce data loss and ensure complete transfers

### Key Metrics
- Files with export failures
- Retry attempt patterns
- Failure reasons and frequency
- Export success rates over time
- Impact on different file types/sizes

### SQL Queries

#### Files with Export Failures
```sql
SELECT 
    id,
    file_name,
    file_path,
    file_size,
    site_id,
    cam_id,
    export_retry_count,
    export_retry_log_object,
    image_export_done_date_time,
    is_auto_transferred,
    is_ftp_transferred
FROM files 
WHERE export_retry_count > 0
ORDER BY export_retry_count DESC, id DESC;
```

#### Export Failure Summary Statistics
```sql
SELECT 
    CASE 
        WHEN export_retry_count = 0 THEN 'No Retries'
        WHEN export_retry_count BETWEEN 1 AND 3 THEN '1-3 Retries'
        WHEN export_retry_count BETWEEN 4 AND 10 THEN '4-10 Retries'
        ELSE '10+ Retries'
    END as retry_category,
    COUNT(*) as file_count,
    ROUND(AVG(file_size)::numeric, 2) as avg_file_size,
    COUNT(CASE WHEN is_auto_transferred = true THEN 1 END) as eventually_auto_transferred,
    COUNT(CASE WHEN is_ftp_transferred = true THEN 1 END) as eventually_ftp_transferred
FROM files 
GROUP BY 
    CASE 
        WHEN export_retry_count = 0 THEN 'No Retries'
        WHEN export_retry_count BETWEEN 1 AND 3 THEN '1-3 Retries'
        WHEN export_retry_count BETWEEN 4 AND 10 THEN '4-10 Retries'
        ELSE '10+ Retries'
    END
ORDER BY 
    CASE 
        CASE 
            WHEN export_retry_count = 0 THEN 'No Retries'
            WHEN export_retry_count BETWEEN 1 AND 3 THEN '1-3 Retries'
            WHEN export_retry_count BETWEEN 4 AND 10 THEN '4-10 Retries'
            ELSE '10+ Retries'
        END
        WHEN 'No Retries' THEN 1
        WHEN '1-3 Retries' THEN 2
        WHEN '4-10 Retries' THEN 3
        ELSE 4
    END;
```

#### Export Failures by Site and Camera
```sql
SELECT 
    site_id,
    cam_id,
    COUNT(*) as total_files,
    COUNT(CASE WHEN export_retry_count > 0 THEN 1 END) as files_with_retries,
    ROUND((COUNT(CASE WHEN export_retry_count > 0 THEN 1 END) * 100.0 / COUNT(*))::numeric, 2) as failure_rate_percent,
    AVG(export_retry_count) as avg_retry_count,
    MAX(export_retry_count) as max_retry_count
FROM files 
WHERE site_id IS NOT NULL AND cam_id IS NOT NULL
GROUP BY site_id, cam_id
HAVING COUNT(*) > 5
ORDER BY failure_rate_percent DESC;
```

#### Recent Export Failures (Last 7 Days)
```sql
SELECT 
    file_name,
    file_path,
    site_id,
    cam_id,
    export_retry_count,
    export_retry_log_object,
    date,
    time,
    CASE 
        WHEN is_auto_transferred = true THEN 'Auto Transferred'
        WHEN is_ftp_transferred = true THEN 'FTP Transferred'
        ELSE 'Not Transferred'
    END as transfer_status
FROM files 
WHERE export_retry_count > 0
    AND date >= CURRENT_DATE - INTERVAL '7 days'
ORDER BY export_retry_count DESC, date DESC, time DESC;
```

---

## File Size Distribution Report

### Purpose
Analyze file sizes and storage usage patterns to optimize storage allocation and identify anomalies.

### Business Value
- Storage optimization and capacity planning
- Identify unusual file size patterns that may indicate issues
- Support compression and archival strategies
- Cost optimization for storage infrastructure

### Key Metrics
- File size distribution across different ranges
- Average file sizes by camera/site
- Storage usage trends over time
- Outlier detection for unusually large/small files

### SQL Queries

#### File Size Distribution Analysis
```sql
SELECT 
    CASE 
        WHEN file_size < 1024 THEN '< 1 KB'
        WHEN file_size < 1024 * 1024 THEN '1 KB - 1 MB'
        WHEN file_size < 10 * 1024 * 1024 THEN '1 MB - 10 MB'
        WHEN file_size < 100 * 1024 * 1024 THEN '10 MB - 100 MB'
        WHEN file_size < 1024 * 1024 * 1024 THEN '100 MB - 1 GB'
        ELSE '> 1 GB'
    END as size_range,
    COUNT(*) as file_count,
    ROUND((SUM(file_size) / 1024.0 / 1024.0)::numeric, 2) as total_size_mb,
    ROUND(AVG(file_size)::numeric, 2) as avg_size_bytes,
    ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM files WHERE deleted = false))::numeric, 2) as percentage_of_total
FROM files 
WHERE deleted = false AND file_size IS NOT NULL
GROUP BY 
    CASE 
        WHEN file_size < 1024 THEN '< 1 KB'
        WHEN file_size < 1024 * 1024 THEN '1 KB - 1 MB'
        WHEN file_size < 10 * 1024 * 1024 THEN '1 MB - 10 MB'
        WHEN file_size < 100 * 1024 * 1024 THEN '10 MB - 100 MB'
        WHEN file_size < 1024 * 1024 * 1024 THEN '100 MB - 1 GB'
        ELSE '> 1 GB'
    END
ORDER BY 
    CASE 
        WHEN CASE 
            WHEN file_size < 1024 THEN '< 1 KB'
            WHEN file_size < 1024 * 1024 THEN '1 KB - 1 MB'
            WHEN file_size < 10 * 1024 * 1024 THEN '1 MB - 10 MB'
            WHEN file_size < 100 * 1024 * 1024 THEN '10 MB - 100 MB'
            WHEN file_size < 1024 * 1024 * 1024 THEN '100 MB - 1 GB'
            ELSE '> 1 GB'
        END = '< 1 KB' THEN 1
        WHEN CASE 
            WHEN file_size < 1024 THEN '< 1 KB'
            WHEN file_size < 1024 * 1024 THEN '1 KB - 1 MB'
            WHEN file_size < 10 * 1024 * 1024 THEN '1 MB - 10 MB'
            WHEN file_size < 100 * 1024 * 1024 THEN '10 MB - 100 MB'
            WHEN file_size < 1024 * 1024 * 1024 THEN '100 MB - 1 GB'
            ELSE '> 1 GB'
        END = '1 KB - 1 MB' THEN 2
        WHEN CASE 
            WHEN file_size < 1024 THEN '< 1 KB'
            WHEN file_size < 1024 * 1024 THEN '1 KB - 1 MB'
            WHEN file_size < 10 * 1024 * 1024 THEN '1 MB - 10 MB'
            WHEN file_size < 100 * 1024 * 1024 THEN '10 MB - 100 MB'
            WHEN file_size < 1024 * 1024 * 1024 THEN '100 MB - 1 GB'
            ELSE '> 1 GB'
        END = '1 MB - 10 MB' THEN 3
        WHEN CASE 
            WHEN file_size < 1024 THEN '< 1 KB'
            WHEN file_size < 1024 * 1024 THEN '1 KB - 1 MB'
            WHEN file_size < 10 * 1024 * 1024 THEN '1 MB - 10 MB'
            WHEN file_size < 100 * 1024 * 1024 THEN '10 MB - 100 MB'
            WHEN file_size < 1024 * 1024 * 1024 THEN '100 MB - 1 GB'
            ELSE '> 1 GB'
        END = '10 MB - 100 MB' THEN 4
        WHEN CASE 
            WHEN file_size < 1024 THEN '< 1 KB'
            WHEN file_size < 1024 * 1024 THEN '1 KB - 1 MB'
            WHEN file_size < 10 * 1024 * 1024 THEN '1 MB - 10 MB'
            WHEN file_size < 100 * 1024 * 1024 THEN '10 MB - 100 MB'
            WHEN file_size < 1024 * 1024 * 1024 THEN '100 MB - 1 GB'
            ELSE '> 1 GB'
        END = '100 MB - 1 GB' THEN 5
        ELSE 6
    END;
```

#### File Size Statistics by Site
```sql
SELECT 
    site_id,
    COUNT(*) as total_files,
    ROUND(AVG(file_size)::numeric, 2) as avg_file_size_bytes,
    ROUND((AVG(file_size) / 1024.0 / 1024.0)::numeric, 2) as avg_file_size_mb,
    MIN(file_size) as min_file_size,
    MAX(file_size) as max_file_size,
    ROUND((SUM(file_size) / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as total_size_gb,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY file_size) as median_file_size
FROM files 
WHERE deleted = false 
    AND file_size IS NOT NULL 
    AND site_id IS NOT NULL
GROUP BY site_id
ORDER BY total_size_gb DESC;
```

#### Large Files Detection (Outliers)
```sql
WITH file_stats AS (
    SELECT 
        AVG(file_size) as mean_size,
        STDDEV(file_size) as std_dev
    FROM files 
    WHERE deleted = false AND file_size IS NOT NULL
)
SELECT 
    f.id,
    f.file_name,
    f.file_path,
    f.site_id,
    f.cam_id,
    f.file_size,
    ROUND((f.file_size / 1024.0 / 1024.0)::numeric, 2) as size_mb,
    f.date,
    f.time,
    ROUND(((f.file_size - fs.mean_size) / fs.std_dev)::numeric, 2) as z_score
FROM files f, file_stats fs
WHERE f.deleted = false 
    AND f.file_size IS NOT NULL
    AND ABS(f.file_size - fs.mean_size) > 2 * fs.std_dev
ORDER BY f.file_size DESC;
```

#### Storage Growth Trend
```sql
SELECT 
    DATE(date) as file_date,
    COUNT(*) as daily_files,
    ROUND((SUM(file_size) / 1024.0 / 1024.0)::numeric, 2) as daily_storage_mb,
    ROUND(AVG(file_size)::numeric, 2) as avg_daily_file_size,
    SUM(COUNT(*)) OVER (ORDER BY DATE(date)) as cumulative_files,
    ROUND((SUM(SUM(file_size)) OVER (ORDER BY DATE(date)) / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as cumulative_storage_gb
FROM files 
WHERE deleted = false 
    AND file_size IS NOT NULL 
    AND date IS NOT NULL
    AND date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY DATE(date)
ORDER BY file_date;
```

---

## Deletion Audit Report

### Purpose
Track deleted files with timestamps for compliance auditing and recovery planning.

### Business Value
- Data retention compliance auditing
- Recovery planning for accidentally deleted files
- Storage cleanup verification
- Audit trail for data governance

### Key Metrics
- Total deleted files over time
- Deletion patterns by site/camera
- Time between file creation and deletion
- Recovery opportunities for recently deleted files

### SQL Queries

#### Deleted Files Summary
```sql
SELECT 
    COUNT(*) as total_deleted_files,
    ROUND((SUM(file_size) / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as total_deleted_size_gb,
    MIN(deleted_date_time) as first_deletion,
    MAX(deleted_date_time) as last_deletion,
    COUNT(CASE WHEN deleted_date_time >= CURRENT_DATE - INTERVAL '7 days' THEN 1 END) as deleted_last_7_days,
    COUNT(CASE WHEN deleted_date_time >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as deleted_last_30_days
FROM files 
WHERE deleted = true;
```

#### Deletion Activity by Date
```sql
SELECT 
    DATE(deleted_date_time) as deletion_date,
    COUNT(*) as files_deleted,
    ROUND((SUM(file_size) / 1024.0 / 1024.0)::numeric, 2) as size_deleted_mb,
    COUNT(DISTINCT site_id) as sites_affected,
    COUNT(DISTINCT cam_id) as cameras_affected
FROM files 
WHERE deleted = true 
    AND deleted_date_time IS NOT NULL
    AND deleted_date_time >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY DATE(deleted_date_time)
ORDER BY deletion_date DESC;
```

#### File Lifecycle Analysis (Creation to Deletion)
```sql
SELECT 
    id,
    file_name,
    site_id,
    cam_id,
    date as creation_date,
    deleted_date_time,
    EXTRACT(DAYS FROM (deleted_date_time - date)) as days_before_deletion,
    ROUND((file_size / 1024.0 / 1024.0)::numeric, 2) as size_mb,
    CASE 
        WHEN is_auto_transferred = true THEN 'Auto Transferred'
        WHEN is_ftp_transferred = true THEN 'FTP Transferred'
        ELSE 'Not Transferred'
    END as transfer_status_before_deletion
FROM files 
WHERE deleted = true 
    AND deleted_date_time IS NOT NULL 
    AND date IS NOT NULL
ORDER BY deleted_date_time DESC
LIMIT 100;
```

#### Deletion Patterns by Site
```sql
SELECT 
    site_id,
    COUNT(*) as total_deleted,
    ROUND(AVG(EXTRACT(DAYS FROM (deleted_date_time - date)))::numeric, 1) as avg_days_before_deletion,
    COUNT(CASE WHEN is_auto_transferred = true THEN 1 END) as deleted_after_auto_transfer,
    COUNT(CASE WHEN is_ftp_transferred = true THEN 1 END) as deleted_after_ftp_transfer,
    COUNT(CASE WHEN is_auto_transferred = false AND is_ftp_transferred = false THEN 1 END) as deleted_without_transfer,
    ROUND((SUM(file_size) / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as total_deleted_size_gb
FROM files 
WHERE deleted = true 
    AND deleted_date_time IS NOT NULL 
    AND site_id IS NOT NULL
GROUP BY site_id
ORDER BY total_deleted DESC;
```

---

## File Generation Patterns Report

### Purpose
Analyze file creation trends by time to optimize system resources and plan maintenance windows.

### Business Value
- Optimize system resources based on usage patterns
- Plan maintenance during low-activity periods
- Capacity planning for peak usage times
- Understand operational patterns

### Key Metrics
- Hourly file generation patterns
- Daily/weekly/monthly trends
- Peak usage identification
- Seasonal patterns

### SQL Queries

#### Hourly File Generation Pattern
```sql
SELECT 
    EXTRACT(HOUR FROM time) as hour_of_day,
    COUNT(*) as total_files,
    ROUND(AVG(file_size)::numeric, 2) as avg_file_size,
    ROUND((SUM(file_size) / 1024.0 / 1024.0)::numeric, 2) as total_size_mb,
    COUNT(DISTINCT site_id) as active_sites,
    COUNT(DISTINCT cam_id) as active_cameras
FROM files 
WHERE time IS NOT NULL 
    AND deleted = false
    AND date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY EXTRACT(HOUR FROM time)
ORDER BY hour_of_day;
```

#### Daily File Generation Trend
```sql
SELECT 
    date,
    COUNT(*) as daily_files,
    ROUND((SUM(file_size) / 1024.0 / 1024.0)::numeric, 2) as daily_size_mb,
    COUNT(DISTINCT site_id) as active_sites,
    COUNT(DISTINCT cam_id) as active_cameras,
    ROUND(AVG(file_size)::numeric, 2) as avg_file_size
FROM files 
WHERE date IS NOT NULL 
    AND deleted = false
    AND date >= CURRENT_DATE - INTERVAL '90 days'
GROUP BY date
ORDER BY date DESC;
```

#### Weekly Pattern Analysis
```sql
SELECT 
    EXTRACT(DOW FROM date) as day_of_week,
    CASE EXTRACT(DOW FROM date)
        WHEN 0 THEN 'Sunday'
        WHEN 1 THEN 'Monday'
        WHEN 2 THEN 'Tuesday'
        WHEN 3 THEN 'Wednesday'
        WHEN 4 THEN 'Thursday'
        WHEN 5 THEN 'Friday'
        WHEN 6 THEN 'Saturday'
    END as day_name,
    COUNT(*) as total_files,
    ROUND(AVG(COUNT(*)) OVER (), 2) as avg_daily_files,
    ROUND((COUNT(*) * 100.0 / SUM(COUNT(*)) OVER ())::numeric, 2) as percentage_of_week,
    ROUND((SUM(file_size) / 1024.0 / 1024.0)::numeric, 2) as total_size_mb
FROM files 
WHERE date IS NOT NULL 
    AND deleted = false
    AND date >= CURRENT_DATE - INTERVAL '30 days'
GROUP BY EXTRACT(DOW FROM date)
ORDER BY day_of_week;
```

#### Peak Hours Analysis
```sql
WITH hourly_stats AS (
    SELECT 
        EXTRACT(HOUR FROM time) as hour_of_day,
        COUNT(*) as file_count,
        RANK() OVER (ORDER BY COUNT(*) DESC) as hour_rank
    FROM files 
    WHERE time IS NOT NULL 
        AND deleted = false
        AND date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY EXTRACT(HOUR FROM time)
)
SELECT 
    hour_of_day,
    file_count,
    CASE 
        WHEN hour_rank <= 3 THEN 'Peak Hours'
        WHEN hour_rank <= 8 THEN 'High Activity'
        WHEN hour_rank <= 16 THEN 'Medium Activity'
        ELSE 'Low Activity'
    END as activity_level
FROM hourly_stats
ORDER BY hour_of_day;
```

---

## Export Retry Analysis Report

### Purpose
Identify files requiring multiple export attempts to optimize retry logic and improve system reliability.

### Business Value
- Identify systemic export issues
- Optimize retry logic and thresholds
- Improve overall system reliability
- Reduce resource waste from excessive retries

### Key Metrics
- Retry attempt distribution
- Success rates after retries
- Files with persistent failures
- Retry patterns by file characteristics

### SQL Queries

#### Retry Distribution Analysis
```sql
SELECT 
    export_retry_count,
    COUNT(*) as file_count,
    ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM files))::numeric, 2) as percentage,
    COUNT(CASE WHEN is_auto_transferred = true THEN 1 END) as eventually_auto_transferred,
    COUNT(CASE WHEN is_ftp_transferred = true THEN 1 END) as eventually_ftp_transferred,
    ROUND(AVG(file_size)::numeric, 2) as avg_file_size
FROM files 
GROUP BY export_retry_count
ORDER BY export_retry_count;
```

#### High Retry Files Analysis
```sql
SELECT 
    id,
    file_name,
    file_path,
    site_id,
    cam_id,
    export_retry_count,
    file_size,
    ROUND((file_size / 1024.0 / 1024.0)::numeric, 2) as size_mb,
    export_retry_log_object,
    is_auto_transferred,
    is_ftp_transferred,
    image_export_done_date_time,
    date,
    time
FROM files 
WHERE export_retry_count >= 5
ORDER BY export_retry_count DESC, file_size DESC;
```

#### Retry Success Rate Analysis
```sql
SELECT 
    CASE 
        WHEN export_retry_count = 0 THEN 'No Retries Needed'
        WHEN export_retry_count BETWEEN 1 AND 2 THEN '1-2 Retries'
        WHEN export_retry_count BETWEEN 3 AND 5 THEN '3-5 Retries'
        ELSE '6+ Retries'
    END as retry_category,
    COUNT(*) as total_files,
    COUNT(CASE WHEN is_auto_transferred = true OR is_ftp_transferred = true THEN 1 END) as eventually_transferred,
    ROUND((COUNT(CASE WHEN is_auto_transferred = true OR is_ftp_transferred = true THEN 1 END) * 100.0 / COUNT(*))::numeric, 2) as success_rate_percent
FROM files 
GROUP BY 
    CASE 
        WHEN export_retry_count = 0 THEN 'No Retries Needed'
        WHEN export_retry_count BETWEEN 1 AND 2 THEN '1-2 Retries'
        WHEN export_retry_count BETWEEN 3 AND 5 THEN '3-5 Retries'
        ELSE '6+ Retries'
    END
ORDER BY 
    CASE 
        WHEN retry_category = 'No Retries Needed' THEN 1
        WHEN retry_category = '1-2 Retries' THEN 2
        WHEN retry_category = '3-5 Retries' THEN 3
        ELSE 4
    END;
```

#### Retry Patterns by File Size
```sql
SELECT 
    CASE 
        WHEN file_size < 1024 * 1024 THEN '< 1 MB'
        WHEN file_size < 10 * 1024 * 1024 THEN '1-10 MB'
        WHEN file_size < 100 * 1024 * 1024 THEN '10-100 MB'
        ELSE '> 100 MB'
    END as size_category,
    COUNT(*) as total_files,
    ROUND(AVG(export_retry_count)::numeric, 2) as avg_retry_count,
    MAX(export_retry_count) as max_retry_count,
    COUNT(CASE WHEN export_retry_count > 0 THEN 1 END) as files_with_retries,
    ROUND((COUNT(CASE WHEN export_retry_count > 0 THEN 1 END) * 100.0 / COUNT(*))::numeric, 2) as retry_rate_percent
FROM files 
WHERE file_size IS NOT NULL
GROUP BY 
    CASE 
        WHEN file_size < 1024 * 1024 THEN '< 1 MB'
        WHEN file_size < 10 * 1024 * 1024 THEN '1-10 MB'
        WHEN file_size < 100 * 1024 * 1024 THEN '10-100 MB'
        ELSE '> 100 MB'
    END
ORDER BY 
    CASE 
        WHEN size_category = '< 1 MB' THEN 1
        WHEN size_category = '1-10 MB' THEN 2
        WHEN size_category = '10-100 MB' THEN 3
        ELSE 4
    END;
```

---

## Data Retention Compliance Report

### Purpose
Ensure compliance with data retention policies by analyzing files by age and deletion status.

### Business Value
- Ensure compliance with data retention policies
- Automate cleanup processes
- Support legal and regulatory requirements
- Optimize storage costs through proper data lifecycle management

### Key Metrics
- Files by age categories
- Compliance with retention policies
- Files eligible for deletion
- Storage impact of retention policies

### SQL Queries

#### File Age Distribution
```sql
SELECT 
    CASE 
        WHEN date >= CURRENT_DATE - INTERVAL '7 days' THEN '0-7 days'
        WHEN date >= CURRENT_DATE - INTERVAL '30 days' THEN '8-30 days'
        WHEN date >= CURRENT_DATE - INTERVAL '90 days' THEN '31-90 days'
        WHEN date >= CURRENT_DATE - INTERVAL '180 days' THEN '91-180 days'
        WHEN date >= CURRENT_DATE - INTERVAL '365 days' THEN '181-365 days'
        ELSE '> 1 year'
    END as age_category,
    COUNT(*) as file_count,
    COUNT(CASE WHEN deleted = true THEN 1 END) as deleted_count,
    COUNT(CASE WHEN deleted = false THEN 1 END) as active_count,
    ROUND((SUM(file_size) / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as total_size_gb,
    ROUND((SUM(CASE WHEN deleted = false THEN file_size ELSE 0 END) / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as active_size_gb
FROM files 
WHERE date IS NOT NULL
GROUP BY 
    CASE 
        WHEN date >= CURRENT_DATE - INTERVAL '7 days' THEN '0-7 days'
        WHEN date >= CURRENT_DATE - INTERVAL '30 days' THEN '8-30 days'
        WHEN date >= CURRENT_DATE - INTERVAL '90 days' THEN '31-90 days'
        WHEN date >= CURRENT_DATE - INTERVAL '180 days' THEN '91-180 days'
        WHEN date >= CURRENT_DATE - INTERVAL '365 days' THEN '181-365 days'
        ELSE '> 1 year'
    END
ORDER BY 
    CASE 
        WHEN age_category = '0-7 days' THEN 1
        WHEN age_category = '8-30 days' THEN 2
        WHEN age_category = '31-90 days' THEN 3
        WHEN age_category = '91-180 days' THEN 4
        WHEN age_category = '181-365 days' THEN 5
        ELSE 6
    END;
```

#### Files Eligible for Deletion (Example: 90-day retention)
```sql
SELECT 
    id,
    file_name,
    file_path,
    site_id,
    cam_id,
    date,
    CURRENT_DATE - date as days_old,
    ROUND((file_size / 1024.0 / 1024.0)::numeric, 2) as size_mb,
    is_auto_transferred,
    is_ftp_transferred,
    CASE 
        WHEN is_auto_transferred = true OR is_ftp_transferred = true THEN 'Safe to Delete'
        ELSE 'Check Transfer Status'
    END as deletion_recommendation
FROM files 
WHERE deleted = false 
    AND date < CURRENT_DATE - INTERVAL '90 days'
    AND date IS NOT NULL
ORDER BY date ASC;
```

#### Retention Compliance Summary
```sql
WITH retention_analysis AS (
    SELECT 
        COUNT(*) as total_files,
        COUNT(CASE WHEN date < CURRENT_DATE - INTERVAL '90 days' AND deleted = false THEN 1 END) as files_past_retention,
        COUNT(CASE WHEN date < CURRENT_DATE - INTERVAL '90 days' AND deleted = true THEN 1 END) as files_properly_deleted,
        SUM(CASE WHEN date < CURRENT_DATE - INTERVAL '90 days' AND deleted = false THEN file_size ELSE 0 END) as storage_past_retention
    FROM files 
    WHERE date IS NOT NULL
)
SELECT 
    total_files,
    files_past_retention,
    files_properly_deleted,
    ROUND((files_past_retention * 100.0 / NULLIF(files_past_retention + files_properly_deleted, 0))::numeric, 2) as non_compliance_rate_percent,
    ROUND((storage_past_retention / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as storage_past_retention_gb,
    CASE 
        WHEN files_past_retention = 0 THEN 'Fully Compliant'
        WHEN files_past_retention < 100 THEN 'Minor Issues'
        WHEN files_past_retention < 1000 THEN 'Moderate Issues'
        ELSE 'Major Compliance Issues'
    END as compliance_status
FROM retention_analysis;
```

#### Monthly Cleanup Recommendations
```sql
SELECT 
    DATE_TRUNC('month', date) as month,
    COUNT(*) as files_eligible_for_deletion,
    ROUND((SUM(file_size) / 1024.0 / 1024.0 / 1024.0)::numeric, 3) as storage_to_free_gb,
    COUNT(CASE WHEN is_auto_transferred = true OR is_ftp_transferred = true THEN 1 END) as safely_deletable,
    COUNT(CASE WHEN is_auto_transferred = false AND is_ftp_transferred = false THEN 1 END) as requires_review
FROM files 
WHERE deleted = false 
    AND date < CURRENT_DATE - INTERVAL '90 days'
    AND date IS NOT NULL
GROUP BY DATE_TRUNC('month', date)
ORDER BY month DESC;
```

---

## Query Optimization Tips

### Indexing Recommendations
For optimal performance of these queries, consider creating the following indexes:

```sql
-- For camera performance queries
CREATE INDEX idx_files_cam_id_date ON files(cam_id, date) WHERE deleted = false;

-- For export failure analysis
CREATE INDEX idx_files_export_retry ON files(export_retry_count) WHERE export_retry_count > 0;

-- For file size analysis
CREATE INDEX idx_files_size_deleted ON files(file_size, deleted);

-- For deletion audit
CREATE INDEX idx_files_deleted_date ON files(deleted_date_time) WHERE deleted = true;

-- For time-based patterns
CREATE INDEX idx_files_date_time ON files(date, time) WHERE deleted = false;

-- For retention compliance
CREATE INDEX idx_files_date_deleted ON files(date, deleted);
```

### Performance Considerations
- Use date range filters to limit query scope
- Consider partitioning the files table by date for large datasets
- Use LIMIT clauses for exploratory queries
- Monitor query execution plans for optimization opportunities

### Data Quality Notes
- Some queries filter out NULL values - adjust based on your data quality requirements
- Consider the impact of timezone settings on time-based queries
- Validate file_size values for accuracy in storage calculations 
# Database Schema Reference

**Database: `tahakom_transfer`** (localhost:5432)  
**Schema source**: `scripts/migration/DatabaseMigration.js`  
Last updated: 2026-06-25

> The `auto` database (also on localhost:5432) is accessed only by the `postgresql-securos_auto-mcp` Cursor tool. No application code connects to it. Its schema is not documented here — inspect via MCP if needed.

---

## Running the migration

```powershell
# Create-only / idempotent (default) — safe to run on a live DB with existing data.
# Uses CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / DROP TRIGGER IF EXISTS + CREATE TRIGGER.
# NOTE: the CREATE MATERIALIZED VIEW IF NOT EXISTS statements need a momentary exclusive lock on `files`;
# stop PM2 services first to avoid lock contention.
node scripts/migration/DatabaseMigration.js

# Clean from-scratch rebuild — DESTROYS ALL DATA.
# Runs DROP SCHEMA public CASCADE, then recreates all objects.
# Also wipes any unmanaged tables (e.g. config_* orphans).
node scripts/migration/DatabaseMigration.js --drop
```

> **Warning**: `--drop` is irreversible. The current dev DB holds ~252 k `files` rows, ~85 k `iss_media_files` rows, and ~38 k `file_transfer_queue` rows. Stop all PM2 services before running either mode.

---

## Table Index

| Table | Lines (migration) | Owner (writes) | Primary consumers |
|---|---|---|---|
| `files` | L86–107 + ALTER L180 | SecurOS scripts | All transfer services, dashboard |
| `device_connections` | L109–123 + ALTER L170 | monitorConnectedExternalDrives | connectedDevicesRoutes |
| `transfer_job` | L125–136 + ALTER L854 | mainControlRoutes / manualTransferRoutes | manualTransferRoutes |
| `transfer_job_log` | L138–149 + ALTER L849 | mainControlRoutes / manualTransferRoutes | manualTransferRoutes |
| `auto_transfer_device` | L151–155 | Migration only — **ORPHAN** | None |
| `auto_transfer_job` | L157–167 | Migration only — **ORPHAN** | None |
| `iss_media_files` | L305–321 | monitorISSMediaFilesOptimized | Video transfer services |
| `transfer_queue_job` | L218–232 | autoUSBImageTransferService | ImageJobManager, autoTransferRoutes |
| `transfer_queue` | L235–262 | autoUSBImageTransferService | ImageJobManager |
| `video_transfer_queue_job` | L328–347 | autoVideoTransferEDA | JobManager |
| `video_converted_buffer` | L350–379 | autoVideoTransferEDA | CompleteBufferManager |
| `video_transfer_queue` | L382–406 | autoVideoTransferEDA | QueueProcessor |
| `ftp_image_transfer_queue_job` | L487–502 | autoFTPImageTransferService | FtpImageJobManager |
| `ftp_image_transfer_queue` | L505–536 | autoFTPImageTransferService | FtpImageJobManager |
| `ftp_video_transfer_queue_job` | L541–561 | autoFtpVideoTransferService | FtpJobManager |
| `ftp_video_converted_buffer` | L564–593 | autoFtpVideoTransferService | FtpCompleteBufferManager |
| `ftp_video_transfer_queue` | L596–624 | autoFtpVideoTransferService | FtpJobManager |
| `manual_video_group_queue` | L858–873 | manualTransferRoutes | manualTransferRoutes |
| `file_transfer_queue` | L876–903 | FileTransferQueueService | manualTransferRoutes |

**Unmanaged tables** (exist in live DB, not created by this migration — removed by `--drop`):  
`config_audit_log`, `config_backup_snapshots`, `config_conflict_log`, `config_lock_history`, `config_performance_metrics`, `config_schema_versions`, `config_validation_errors` — zero references in application code; created by an external/legacy tool.

---

## Core Table: `files`

The central source of truth for all ALPR plate images. Written by SecurOS scripts; consumed by all transfer services and the dashboard.

```sql
CREATE TABLE files (
  id                          SERIAL PRIMARY KEY,
  tid                         TEXT,                         -- SecurOS request ID (plate_tid + camera_id)
  file_path                   TEXT UNIQUE,                  -- Full absolute path on disk
  file_size                   INTEGER,                      -- Bytes; 0 until EXPORT_DONE; must be > 0 for transfer
  file_name                   TEXT,
  site_id                     TEXT,
  date_folder                 TEXT,                         -- Directory component: MM_DD_YYYY
  time_folder                 TEXT,                         -- Directory component: HH_mm_ss
  plate_num                   VARCHAR(255),                 -- License plate string
  cam_id                      INTEGER,                      -- Camera identifier
  deleted                     BOOLEAN DEFAULT FALSE,        -- Soft delete flag
  is_auto_transferred         BOOLEAN DEFAULT FALSE,        -- USB transfer completed
  is_ftp_transferred          BOOLEAN DEFAULT FALSE,        -- FTP transfer completed
  image_export_done_date_time TIMESTAMP,                    -- Set by ImageExportSuccessOptimized; NULL = not yet exported
  export_retry_count          INTEGER DEFAULT 0,
  export_retry_log_object     JSONB DEFAULT '[]',           -- Inline retry history array
  deleted_date_time           TIMESTAMP,
  export_params               JSONB,                        -- SecurOS IMAGE_EXPORT params for re-export
  date                        DATE,
  time                        TIME,
  ts                          TIMESTAMP GENERATED ALWAYS AS (date + time) STORED   -- L180-181
);
```

**Runtime-added columns** (added by `ExportDirectoryControlV3.js` L587–628 if missing):

```sql
ALTER TABLE files ADD COLUMN pending_deletion BOOLEAN DEFAULT FALSE;
ALTER TABLE files ADD COLUMN updated_at TIMESTAMP DEFAULT NOW();
-- Also adds update trigger for updated_at
```

**Indexes** (active — migration L187-196):

```sql
-- Covering partial index: enables index-only scans for all dashboard date-range,
-- hourly, monthly, and yearly GROUP BY / FILTER patterns on non-deleted rows.
CREATE INDEX IF NOT EXISTS idx_files_dashboard_date
  ON public.files (date)
  INCLUDE (cam_id, plate_num, file_size, image_export_done_date_time, time)
  WHERE deleted = false;

-- Supplemental index for the dashboard "Per Camera" daily path.
CREATE INDEX IF NOT EXISTS idx_files_dashboard_cam_date
  ON public.files (cam_id, date)
  INCLUDE (plate_num, file_size, image_export_done_date_time)
  WHERE deleted = false;
```

> **Note on live-DB upgrades**: when adding these indexes to a production table that already has data, run the two `CREATE INDEX` statements manually using `CONCURRENTLY` (outside of any transaction) instead of re-running the full migration.

**`export_retry_log_object` schema** (each element in the JSONB array):

```json
{
  "retryOn": "<IMAGE_EXPORT object ID>",
  "imageExportId": "<IMAGE_EXPORT object ID>",
  "retry_count": 1,
  "comment": "EXPORT_FAILED — re-dispatched",
  "timestamp": "2026-06-17T10:00:00.000Z",
  "tid": "<original tid>"
}
```

---

## `device_connections`

Tracks USB and external drive connection history.

```sql
CREATE TABLE device_connections (
  id                   SERIAL PRIMARY KEY,
  drive_letter         VARCHAR(2) NOT NULL,
  label                TEXT,
  filesystem_type      TEXT,
  total_space          DECIMAL(10,2),        -- GB
  used_space           DECIMAL(10,2),
  remaining_space      DECIMAL(10,2),
  used_percentage      DECIMAL(5,2),
  is_read_write        BOOLEAN,
  connected_at         TIMESTAMP DEFAULT NOW(),
  disconnected_at      TIMESTAMP,
  status               TEXT DEFAULT 'connected',   -- 'connected' | 'disconnected'
  last_updated         TIMESTAMP DEFAULT NOW(),
  current_uptime_minutes  INTEGER,
  total_uptime_minutes    INTEGER
);

CREATE INDEX idx_device_connections_status_connected
  ON device_connections(status) WHERE status = 'connected';
```

---

## `transfer_job` / `transfer_job_log` / `manual_video_group_queue` (Manual Flow)

Used by `routes/mainControlRoutes.js` and `routes/manualTransferRoutes.js` for both image and video manual USB transfers.

```sql
CREATE TABLE transfer_job (
  id         SERIAL PRIMARY KEY,
  start_date DATE,  start_time TIME,
  end_date   DATE,  end_time   TIME,
  car_plate  TEXT,
  usb_path   TEXT,
  status     TEXT,                        -- 'pending' | 'running' | 'done' | 'failed'
  date       DATE,  time TIME,
  data_type  VARCHAR(10) DEFAULT 'images' -- ALTER L854: 'images' | 'videos' | 'both'
);

CREATE TABLE transfer_job_log (
  id              SERIAL PRIMARY KEY,
  file_id         INT,                    -- nullable (ALTER L849); NULL for video rows
  transfer_job_id INT NOT NULL REFERENCES transfer_job(id),
  transferred     BOOLEAN DEFAULT false,
  media_file_id   INT REFERENCES iss_media_files(id), -- ALTER L850; set for video rows
  CONSTRAINT fk_file FOREIGN KEY (file_id) REFERENCES files(id)
);

-- One row per camera batch for manual video transfers (N segments → 1 .mp4).
CREATE TABLE manual_video_group_queue (
  id                   SERIAL PRIMARY KEY,
  transfer_job_id      INT NOT NULL REFERENCES transfer_job(id),
  camera_id            INT NOT NULL,
  group_key            TEXT NOT NULL,
  source_file_ids      INT[] NOT NULL,
  segment_count        INT NOT NULL,
  status               VARCHAR(20) NOT NULL DEFAULT 'pending',
  -- status lifecycle: pending → converting → converted → copying → transferred | failed
  converted_video_path TEXT,
  converted_video_name TEXT,
  error_message        TEXT,
  created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mvgq_job_status
  ON manual_video_group_queue(transfer_job_id, status);
```

---

## `auto_transfer_device` / `auto_transfer_job` — ORPHAN

Created in migration (L151–167) but **no runtime JavaScript reads or writes these tables**. Likely a legacy design artifact from an earlier auto-transfer concept.

---

## `file_transfer_queue`

Unified low-level copy queue for all manual and auto USB transfers. Written and read exclusively by [`utils/FileTransferQueueService.js`](../../utils/FileTransferQueueService.js); consumed by `routes/manualTransferRoutes.js`.

**No FK constraints by design**: video rows carry `file_id = NULL` (their source is `iss_media_files`, not `files`). The service sets `updated_at` in code — no trigger needed.

```sql
CREATE TABLE file_transfer_queue (
  id               SERIAL PRIMARY KEY,
  service_type     VARCHAR(20) NOT NULL,          -- 'auto' | 'manual' | 'video'
  file_id          INTEGER,                       -- NULL for video rows
  file_path        TEXT NOT NULL,
  file_size        BIGINT DEFAULT 0,
  file_name        TEXT,
  destination_path TEXT NOT NULL,
  priority         INTEGER NOT NULL,              -- 1=image auto, 2=video, 3=manual
  batch_id         VARCHAR(36) NOT NULL,          -- UUID v4 per batch
  transfer_job_id  INTEGER,                       -- soft reference to transfer_job.id
  metadata         JSONB,
  -- image rows: {plate_num, site_id, date_folder, time_folder, cam_id}
  -- video rows: {video_group_id, camera_id}
  status           VARCHAR(20) DEFAULT 'pending', -- pending|processing|transferred|failed|cancelled
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  transferred_at   TIMESTAMP,
  error_message    TEXT,
  retry_count      INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_status          ON file_transfer_queue(status);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_priority        ON file_transfer_queue(priority DESC);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_batch_id        ON file_transfer_queue(batch_id);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_service_type    ON file_transfer_queue(service_type);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_transfer_job_id ON file_transfer_queue(transfer_job_id);
CREATE INDEX IF NOT EXISTS idx_file_transfer_queue_created_at      ON file_transfer_queue(created_at);
```

---

## `iss_media_files`

Index of ISS NVR video MP4 segments. Written by `monitorISSMediaFilesOptimizedMicroservice`.

```sql
CREATE TABLE iss_media_files (
  id                  SERIAL PRIMARY KEY,
  file_path           TEXT UNIQUE NOT NULL,
  file_name           TEXT NOT NULL,
  file_size           BIGINT NOT NULL,
  camera_id           INTEGER NOT NULL,
  site_id             TEXT,
  recording_date      DATE NOT NULL,
  recording_time      TIME NOT NULL,
  timezone_offset     TEXT,
  precise_time        TIME NOT NULL,
  is_auto_transferred BOOLEAN DEFAULT FALSE,
  is_ftp_transferred  BOOLEAN DEFAULT FALSE,
  deleted             BOOLEAN DEFAULT FALSE,
  created_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Partial indexes — fast scans for transfer services and cleanup
CREATE INDEX IF NOT EXISTS idx_iss_media_files_auto_transferred
  ON iss_media_files(is_auto_transferred) WHERE is_auto_transferred = false;
CREATE INDEX IF NOT EXISTS idx_iss_media_files_camera_date
  ON iss_media_files(camera_id, recording_date);
CREATE INDEX IF NOT EXISTS idx_iss_media_files_deleted
  ON iss_media_files(deleted) WHERE deleted = false;
```

---

## USB Image Transfer Queue

### `transfer_queue_job`

```sql
CREATE TABLE transfer_queue_job (
  id            SERIAL PRIMARY KEY,
  batch_id      UUID UNIQUE,
  batch_origin  TEXT CHECK (batch_origin IN ('auto', 'manual')),
  status        TEXT CHECK (status IN ('pending','transferring','paused','transferred','failed')),
  total_files   INTEGER DEFAULT 0,
  transferred_files INTEGER DEFAULT 0,
  total_size    BIGINT DEFAULT 0,
  transferred_size BIGINT DEFAULT 0,
  error_message TEXT,
  created_at    TIMESTAMP DEFAULT NOW(),
  updated_at    TIMESTAMP DEFAULT NOW()
);
```

### `transfer_queue`

```sql
CREATE TABLE transfer_queue (
  id              SERIAL PRIMARY KEY,
  file_id         INTEGER REFERENCES files(id) ON DELETE CASCADE,
  job_id          INTEGER REFERENCES transfer_queue_job(id) ON DELETE CASCADE,
  file_type       TEXT DEFAULT 'image',
  file_origin     TEXT,
  status          TEXT CHECK (status IN ('pending','transferring','transferred','failed')),
  retry_count     INTEGER DEFAULT 0,
  max_retries     INTEGER DEFAULT 3,
  source_path     TEXT,
  destination_path TEXT,
  error_message   TEXT,
  created_at      TIMESTAMP DEFAULT NOW(),
  updated_at      TIMESTAMP DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_transfer_queue_job_status ON transfer_queue_job(status);
CREATE INDEX idx_transfer_queue_status     ON transfer_queue(status);
CREATE INDEX idx_transfer_queue_job_id     ON transfer_queue(job_id);

-- Triggers
CREATE TRIGGER update_transfer_queue_updated_at
  BEFORE UPDATE ON transfer_queue
  FOR EACH ROW EXECUTE FUNCTION update_transfer_queue_updated_at();

CREATE TRIGGER update_transfer_queue_job_updated_at
  BEFORE UPDATE ON transfer_queue_job
  FOR EACH ROW EXECUTE FUNCTION update_transfer_queue_job_updated_at();
```

---

## FTP Image Transfer Queue

Mirrors USB image queue structure with FTP-specific columns.

### `ftp_image_transfer_queue_job`

Same structure as `transfer_queue_job` plus `ftp_server_config JSONB`.

### `ftp_image_transfer_queue`

Same structure as `transfer_queue` plus `ftp_remote_path TEXT`, `ftp_server_host TEXT`, `ftp_upload_time TIMESTAMP`.

---

## USB Video Transfer Queue

### `video_transfer_queue_job`

```sql
CREATE TABLE video_transfer_queue_job (
  id            SERIAL PRIMARY KEY,
  -- Same base columns as transfer_queue_job
  camera_id     INTEGER,    -- Camera-scoped jobs
  group_key     TEXT,       -- Grouping key for batched camera segments
  ...
);
```

### `video_converted_buffer`

Staging table for per-camera video segments before queue insertion.

```sql
CREATE TABLE video_converted_buffer (
  id              SERIAL PRIMARY KEY,
  source_file_id  INTEGER REFERENCES iss_media_files(id),
  job_id          INTEGER REFERENCES video_transfer_queue_job(id),
  camera_id       INTEGER NOT NULL,
  -- UNIQUE (camera_id, source_file_id, job_id) prevents duplicates
  ...
);
```

### `video_transfer_queue`

```sql
CREATE TABLE video_transfer_queue (
  id          SERIAL PRIMARY KEY,
  job_id      INTEGER REFERENCES video_transfer_queue_job(id),
  camera_id   INTEGER,
  status      TEXT CHECK (status IN ('pending','transferring','transferred','failed')),
  group_key   TEXT,
  ...
);
```

---

## FTP Video Transfer Queue

Mirrors the USB video queue structure:
- `ftp_video_transfer_queue_job`
- `ftp_video_converted_buffer`
- `ftp_video_transfer_queue`

Each adds `ftp_server_config JSONB` (on the job table) and `ftp_remote_path`, `ftp_server_host`, `ftp_upload_time` (on the queue table).

---

## Database Functions and Triggers

**4 functions:**

```sql
-- Human-readable uptime from minutes (L200-215)
CREATE OR REPLACE FUNCTION get_readable_uptime(minutes INTEGER) RETURNS TEXT ...

-- Generic updated_at setter reused by all video + FTP triggers (L457-463)
CREATE OR REPLACE FUNCTION update_updated_at_column() RETURNS TRIGGER ...

-- USB image queue-specific updated_at setters (L276-291)
CREATE OR REPLACE FUNCTION update_transfer_queue_updated_at() RETURNS TRIGGER ...
CREATE OR REPLACE FUNCTION update_transfer_queue_job_updated_at() RETURNS TRIGGER ...
```

**10 triggers** (all `BEFORE UPDATE ... FOR EACH ROW`; all guarded with `DROP TRIGGER IF EXISTS` for idempotency):

| Trigger | Table |
|---|---|
| `trigger_transfer_queue_updated_at` | `transfer_queue` |
| `trigger_transfer_queue_job_updated_at` | `transfer_queue_job` |
| `update_video_converted_buffer_updated_at` | `video_converted_buffer` |
| `update_video_transfer_queue_job_updated_at` | `video_transfer_queue_job` |
| `update_video_transfer_queue_updated_at` | `video_transfer_queue` |
| `update_ftp_image_transfer_queue_job_updated_at` | `ftp_image_transfer_queue_job` |
| `update_ftp_image_transfer_queue_updated_at` | `ftp_image_transfer_queue` |
| `update_ftp_video_converted_buffer_updated_at` | `ftp_video_converted_buffer` |
| `update_ftp_video_transfer_queue_job_updated_at` | `ftp_video_transfer_queue_job` |
| `update_ftp_video_transfer_queue_updated_at` | `ftp_video_transfer_queue` |

> `file_transfer_queue` has no trigger — `FileTransferQueueService.js` sets `updated_at` in every UPDATE query directly.

---

## Dashboard Materialized Views

Six pre-aggregation views introduced in the 2026-06-18 performance overhaul. They are refreshed concurrently by `DashboardReportingBackend.js` on a timer (default every 5 minutes, configurable via `DASHBOARD_MV_REFRESH_INTERVAL_MS`) and on every `POST /dashboard/refresh` call.

| View | Group key | Unique index | Used by |
|---|---|---|---|
| `mv_files_daily` | `(date, cam_id)` | `idx_mv_files_daily_pk` | Dashboard daily Per-Camera view |
| `mv_files_daily_agg` | `(date)` | `idx_mv_files_daily_agg_pk` | Dashboard daily All-Cameras view |
| `mv_files_monthly` | `(period='YYYY-MM', cam_id)` | `idx_mv_files_monthly_pk` | Dashboard monthly Per-Camera view |
| `mv_files_monthly_agg` | `(period='YYYY-MM')` | `idx_mv_files_monthly_agg_pk` | Dashboard monthly All-Cameras view |
| `mv_files_yearly` | `(period='YYYY', cam_id)` | `idx_mv_files_yearly_pk` | Dashboard yearly Per-Camera view |
| `mv_files_yearly_agg` | `(period='YYYY')` | `idx_mv_files_yearly_agg_pk` | Dashboard yearly All-Cameras view |

Each view exposes: `total_vehicles_count`, `total_files_count`, `success_produced_count`, `failed_produce_count`, `failed_produced_percentage`, `total_file_size_in_gb`.

> Hourly dashboard data is never pre-aggregated — it always hits the `files` table directly via the covering index.

**Concurrent refresh** (run manually or called from backend):

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_files_daily;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_files_daily_agg;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_files_monthly;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_files_monthly_agg;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_files_yearly;
REFRESH MATERIALIZED VIEW CONCURRENTLY mv_files_yearly_agg;
```

---

## Key Query Patterns

### Find stuck exports (file_size=0, not yet exported)

```sql
SELECT id, tid, plate_num, cam_id, site_id, file_path, export_retry_count,
       image_export_done_date_time, date, time
FROM files
WHERE file_size = 0
  AND deleted = false
  AND image_export_done_date_time IS NULL
ORDER BY date DESC, time DESC;
```

### Find images ready for USB transfer

```sql
SELECT id, file_path, file_size, plate_num, cam_id, site_id
FROM files
WHERE file_size > 0
  AND deleted = false
  AND is_auto_transferred = false
ORDER BY date ASC, time ASC;
```

### Storage used (active files only)

```sql
SELECT
  COUNT(*) AS total_files,
  SUM(file_size) AS total_bytes,
  ROUND(SUM(file_size) / 1024.0 / 1024.0, 2) AS total_mb
FROM files
WHERE deleted = false
  AND pending_deletion = false;
```

### Dashboard daily summary (all cameras — uses MV)

```sql
SELECT date, total_vehicles_count, total_files_count,
       success_produced_count, failed_produce_count,
       failed_produced_percentage, total_file_size_in_gb
FROM mv_files_daily_agg
WHERE date BETWEEN $1 AND $2
ORDER BY date;
```

### Dashboard daily summary (per camera — uses MV)

```sql
SELECT date, cam_id, total_vehicles_count, total_files_count,
       success_produced_count, failed_produce_count,
       failed_produced_percentage, total_file_size_in_gb
FROM mv_files_daily
WHERE cam_id = $1
  AND date BETWEEN $2 AND $3
ORDER BY date;
```

### Retry backlog summary

```sql
SELECT
  export_retry_count,
  COUNT(*) AS files,
  SUM(CASE WHEN deleted THEN 1 ELSE 0 END) AS deleted_count
FROM files
WHERE export_retry_count > 0
GROUP BY export_retry_count
ORDER BY export_retry_count;
```

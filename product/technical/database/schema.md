# Database Schema Reference

**Database: `tahakom_transfer`** (localhost:5432)  
**Schema source**: `scripts/migration/DatabaseMigration.js`  
Last updated: 2026-06-17

> The `auto` database (also on localhost:5432) is accessed only by the `postgresql-securos_auto-mcp` Cursor tool. No application code connects to it. Its schema is not documented here — inspect via MCP if needed.

---

## Table Index

| Table | Lines (migration) | Owner (writes) | Primary consumers |
|---|---|---|---|
| `files` | L86–107 | SecurOS scripts | All transfer services, dashboard |
| `device_connections` | L109–178 | monitorConnectedExternalDrives | connectedDevicesRoutes |
| `transfer_job` | L125–136 | mainControlRoutes (legacy manual) | manualTransferRoutes |
| `transfer_job_log` | L138–149 | mainControlRoutes | manualTransferRoutes |
| `auto_transfer_device` | L151–160 | Migration only — **ORPHAN** | None |
| `auto_transfer_job` | L162–167 | Migration only — **ORPHAN** | None |
| `iss_media_files` | L400–445 | monitorISSMediaFiles | Video transfer services |
| `transfer_queue_job` | L209–223 | autoUSBImageTransferService | ImageJobManager, autoTransferRoutes |
| `transfer_queue` | L226–253 | autoUSBImageTransferService | ImageJobManager |
| `ftp_image_transfer_queue_job` | L478–493 | autoFTPImageTransferService | FtpImageJobManager |
| `ftp_image_transfer_queue` | L496–527 | autoFTPImageTransferService | FtpImageJobManager |
| `video_transfer_queue_job` | L319–338 | autoVideoTransferEDA | JobManager |
| `video_converted_buffer` | L341–370 | autoVideoTransferEDA | CompleteBufferManager |
| `video_transfer_queue` | L373–397 | autoVideoTransferEDA | QueueProcessor |
| `ftp_video_transfer_queue_job` | L532–552 | autoFtpVideoTransferService | FtpJobManager |
| `ftp_video_converted_buffer` | L555–584 | autoFtpVideoTransferService | FtpCompleteBufferManager |
| `ftp_video_transfer_queue` | L587–615 | autoFtpVideoTransferService | FtpJobManager |

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

**Indexes** (commented out in migration — not currently active):

```sql
-- CREATE INDEX idx_files_ts ON files(ts);            -- L183-184 (commented out)
-- CREATE INDEX idx_files_grouping ON files(...);      -- L185-187 (commented out)
```

> **Tech debt T-1**: These indexes are disabled. At high plate-volume, queries that scan by `ts`, `deleted`, `file_size` will do sequential scans. Recommend enabling or tuning indexes.

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

## `transfer_job` / `transfer_job_log` (Legacy Manual Flow)

Used by the manual transfer UI (`routes/mainControlRoutes.js`, `routes/manualTransferRoutes.js`). May be superseded by `transfer_queue_job` — see tech debt T-4.

```sql
CREATE TABLE transfer_job (
  id          SERIAL PRIMARY KEY,
  start_date  TEXT,
  start_time  TEXT,
  end_date    TEXT,
  end_time    TEXT,
  car_plate   TEXT,
  usb_path    TEXT,
  status      TEXT,       -- 'pending' | 'running' | 'done' | 'failed'
  date        DATE,
  time        TIME
);

CREATE TABLE transfer_job_log (
  id               SERIAL PRIMARY KEY,
  file_id          INTEGER REFERENCES files(id),
  transfer_job_id  INTEGER REFERENCES transfer_job(id),
  transferred      BOOLEAN
);
```

---

## `auto_transfer_device` / `auto_transfer_job` — ORPHAN

Created in migration (L151–167) but **no runtime JavaScript reads or writes these tables**. Likely a legacy design artifact from an earlier auto-transfer concept.

---

## `iss_media_files`

Index of ISS NVR video MP4 segments. Written by `monitorISSMediaFilesOptimizedMicroservice`.

```sql
CREATE TABLE iss_media_files (
  id               SERIAL PRIMARY KEY,
  file_path        TEXT UNIQUE NOT NULL,
  file_name        TEXT,
  site_id          TEXT,
  file_size        BIGINT NOT NULL,
  camera_id        INTEGER NOT NULL,
  recording_date   DATE,
  recording_time   TIME,
  precise_time     TEXT,           -- High-precision timestamp string
  timezone_offset  TEXT,
  is_auto_transferred  BOOLEAN DEFAULT FALSE,
  is_ftp_transferred   BOOLEAN DEFAULT FALSE,
  deleted              BOOLEAN DEFAULT FALSE,
  created_at           TIMESTAMP DEFAULT NOW(),
  updated_at           TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_iss_media_files_auto_transferred ON iss_media_files(is_auto_transferred);
CREATE INDEX idx_iss_media_files_camera_date      ON iss_media_files(camera_id, recording_date);
CREATE INDEX idx_iss_media_files_deleted          ON iss_media_files(deleted);
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

## Database Functions

```sql
-- Human-readable uptime from minutes (L191-206)
CREATE FUNCTION get_readable_uptime(minutes INTEGER) RETURNS TEXT ...

-- Generic updated_at trigger (L448-454)
CREATE FUNCTION update_updated_at_column() RETURNS TRIGGER ...

-- Queue-specific updated_at triggers (L267-282)
CREATE FUNCTION update_transfer_queue_updated_at() RETURNS TRIGGER ...
CREATE FUNCTION update_transfer_queue_job_updated_at() RETURNS TRIGGER ...
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

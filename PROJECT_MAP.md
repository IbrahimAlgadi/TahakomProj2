# PROJECT_MAP.md

**Tahakom Data Transfer System** — Live external-memory map.  
_Update this file whenever a service is added, a table changes, or a decision is superseded._

> **For AI agents**: load this file at the start of every session. It is the canonical context for all architecture, data flow, and service decisions. Do not rely on parametric memory — trust this map.

---

## [TECH_STACK]

| Layer | Technology | Version | Notes |
|---|---|---|---|
| Runtime (app services) | Node.js | 18.x (system) | PM2-managed services under `ecosystem.config.js` |
| Runtime (SecurOS scripts) | Node.js (SecurOS-bundled) | `C:\Program Files (x86)\ISS\SecurOS\bin64\node.js\bin\node.exe` | Injected `securos` module — cannot run standalone |
| Process manager | PM2 | bundled with SecurOS Node | Service lifecycle, restart policy, log rotation |
| Web framework | Express | ^4.18.2 | REST API + WebSocket server (`DashboardReportingBackend.js`) |
| Template engine | Nunjucks | ^3.2.4 | Server-rendered dashboard pages under `data_transfer_v2/views/` |
| Primary database | PostgreSQL | 14+ (localhost:5432) | Database: `tahakom_transfer` — source of truth |
| DB client | pg | ^8.16.2 | Used by all Node services; Pool pattern throughout |
| State / queue bus | Redis (ioredis) | ^5.6.1 | Config state, drive state, pub/sub channels, task queues |
| Logging | Winston + winston-daily-rotate-file | ^3.17.0 / ^5.0.0 | Async file-based logs under `logs/`; per-service out/error files |
| Real-time (UI) | ws (WebSocket) | ^8.18.2 | Dashboard live updates via `ws://localhost:8454` |
| Charts | Apache ECharts | 5.4.3 (vendored) | Dashboard statistics, vendored in `data_transfer_v2/public/vendors/echarts/` |
| Date handling | Moment.js + moment-timezone | ^2.30.1 / ^0.5.48 | Transfer scheduling, timestamp formatting |
| Encryption | Node.js `crypto` (built-in) | — | AES-256-CBC file encryption; RSA key management via `certs/` |
| FTP client | basic-ftp | ^5.0.5 | FTP/FTPS image and video upload |
| File watching | chokidar | ^3.6.0 | ISS media directory monitoring |
| HTTP client | axios | ^1.9.0 | Internal service calls |
| Embedded DB (config) | NeDB | ^1.8.0 | Lightweight local config store (secondary to Redis) |
| PDF generation | pdfkit | ^0.12.3 | Dashboard export reports |
| System info | systeminformation | ^5.22.11 | Drive/system metrics |
| MCP tooling | @henkey/postgres-mcp-server | npx (latest) | Cursor agent DB access (read-only SELECT) |
| SecurOS host | ISS SecurOS Script Integration Engine | Site-specific | Hosts securos-scripts; provides `securos` module + event bus |

---

## [SYSTEM_FLOW]

### 1. Image Capture Pipeline (SecurOS → PostgreSQL)

```
SecurOS ALPR (LPR_CAM object)
  │  event: CAR_LP_RECOGNIZED  (plate_num, cam_id, tid, timestamp)
  ▼
OptimizedImageCapture.js
  ├─ Resolves target directory: BASE_PATH / SITE_ID / DATE / TIME
  │    (reads dataTransferConfig.json: storage.directory, storage.siteId)
  ├─ INSERT files (tid, plate_num, cam_id, site_id, file_path, file_name,
  │                date_folder, time_folder, date, time, export_params,
  │                file_size=0, deleted=false, is_auto_transferred=false)
  └─ Dispatches IMAGE_EXPORT → EXPORT reaction (load-balanced to least-busy IMAGE_EXPORT object)

SecurOS IMAGE_EXPORT Engine
  ├─ EXPORT_DONE  ──► ImageExportSuccessOptimized.js
  │    UPDATE files SET file_size=<actual>, image_export_done_date_time=NOW
  │    (batched updates for performance)
  │
  └─ EXPORT_FAILED  ──► Image Export Errors.js
       SELECT files WHERE tid matches
       IF retry_count < MAX_RETRIES:
         UPDATE export_retry_count++, export_retry_log_object (JSONB append)
         re-issue IMAGE_EXPORT via core.doReact
       ELSE:
         UPDATE deleted=true, deleted_date_time=NOW
         (image unrecoverable)

Export Fixer Microservice.js  [periodic safety net]
  SELECT files WHERE file_size=0
    AND image_export_done_date_time IS NULL
    AND export_retry_count < 1
    AND deleted=false
    AND within today's time window
  → re-dispatch IMAGE_EXPORT for each stale row

ExportDirectoryControlV3.js  [continuous governance loop]
  ├─ Adds columns pending_deletion, updated_at at startup if missing
  ├─ Retention: DELETE physical files older than retentionDays
  │              UPDATE files SET deleted=true WHERE old rows
  ├─ Capacity: FIFO deletion when total file_size > maxCapacity
  │             UPDATE files SET pending_deletion=true (preview)
  │             DELETE files from disk, UPDATE deleted=true
  └─ Preserves directories listed in storage.preserveRootDirs
```

### 2. Image Transfer Pipeline (PostgreSQL → USB / FTP)

```
autoUSBImageTransferService.js
  ├─ ImageJobManager: SELECT files WHERE file_size > 0
  │                            AND is_auto_transferred = false
  │                            AND deleted = false
  ├─ Creates transfer_queue_job (batch_origin='auto')
  ├─ Populates transfer_queue (per file)
  ├─ ImageTransferManager: copies files to USB drive (config: autoTransfer.drive)
  └─ UPDATE files.is_auto_transferred = true  (via TransferUtils)

autoFTPImageTransferService.js
  ├─ FtpImageJobManager: SELECT files WHERE file_size > 0
  │                               AND is_ftp_transferred = false
  │                               AND deleted = false
  ├─ Creates ftp_image_transfer_queue_job
  ├─ Populates ftp_image_transfer_queue
  ├─ FtpImageTransferManager: uploads files via FTP (config: ftpTransfer)
  └─ UPDATE files.is_ftp_transferred = true
```

### 3. Video Monitoring & Transfer Pipeline

```
ISS Media NVR Directories  (disk paths from config)
  ▼
monitorISSMediaFilesOptimizedMicroservice.js  (chokidar watcher)
  INSERT / UPDATE iss_media_files
    (file_path UNIQUE, file_name, site_id, camera_id,
     file_size, recording_date, recording_time, precise_time,
     is_auto_transferred=false, is_ftp_transferred=false)

  ┌──► refactored_autoVideoTransferEDAMicroservice.js  [USB]
  │    ├─ JobManager: selects untransferred iss_media_files by camera batch
  │    ├─ CompleteBufferManager → video_converted_buffer (per-camera staging)
  │    ├─ FileTransferManager: copies MP4 segments to USB drive
  │    ├─ QueueProcessor: manages video_transfer_queue / video_transfer_queue_job
  │    └─ UPDATE iss_media_files.is_auto_transferred = true
  │
  └──► autoFtpVideoTransferService.js  [FTP]
       ├─ FtpJobManager + FtpCompleteBufferManager
       ├─ FtpTransferManager: uploads MP4 to FTP server
       ├─ Manages ftp_video_transfer_queue_job / ftp_video_transfer_queue
       └─ UPDATE iss_media_files.is_ftp_transferred = true
```

### 4. Configuration & State Bus

```
dataTransferConfig.json  (disk: C:\Proj\app\data_transfer_v2\dataTransferConfig.json)
  ▼
ConfigStateServiceRedis.js
  WRITE → Redis key: CONFIG_STATE_KEY
  PUBLISH → Redis channel: CONFIG_STATE_KEY_update
  ← All services subscribe and reload config on change

monitorConnectedExternalDrivesMicroservice.js
  Detects USB/external drives (systeminformation)
  WRITE → Redis: CONNECTED_DRIVE_STATE, CONNECTED_DRIVE_LIST
  PUBLISH → Redis channel: CONNECTED_DRIVE_LIST_UPDATE
  INSERT → device_connections (PostgreSQL)

DashboardReportingBackend.js  [Express, port 8454]
  Serves Nunjucks pages + REST JSON API + WebSocket
  Reads from: all PostgreSQL tables (via routes)
  WebSocket events: handleAutoTransfer, devices, deviceHistory,
                    handleAutoVideoTransfer, processes, startStorageTransfer
```

### 5. Health Monitoring

```
ClusterStatusMonitorScript.js  [SecurOS, runs every 10 minutes]
  Uses SecurOS-bundled PM2 binary
  Lists online PM2 processes
  IF count < expected (from ecosystem.config.js):
    pm2 start ecosystem.config.js --env production
  Logs health status (file path: `C:\ProgramData\ISS\logs\nodejs.1.console.log` — see securos-log-registry)
```

---

## [ARCHITECTURE]

### Service Topology

```
┌─────────────────────────────────────────────────────────────────────┐
│  SecurOS Script Integration Engine  (isolated runtime)              │
│                                                                     │
│  OptimizedImageCapture.js          ┐                               │
│  ImageExportSuccessOptimized.js    │ ALPR capture + export lifecycle│
│  Image Export Errors.js            │                               │
│  Export Fixer Microservice.js      │                               │
│  ExportDirectoryControlV3.js       ┘ storage governance            │
│  ClusterStatusMonitorScript.js       PM2 health watchdog            │
└─────────────────────────┬───────────────────────────────────────────┘
                          │ pg (tahakom_transfer)
┌─────────────────────────▼───────────────────────────────────────────┐
│  PostgreSQL  localhost:5432                                         │
│  DB: tahakom_transfer   (all runtime tables — see schema.md)       │
│  DB: auto               (MCP tooling only — no app code)           │
└────┬────────────────────────────────────────────────────────────────┘
     │ pg Pool
┌────▼────────────────────────────────────────────────────────────────┐
│  PM2 Microservices  (ecosystem.config.js)                           │
│                                                                     │
│  ConfigStateServiceRedis       ◄──► Redis (CONFIG_STATE_KEY)        │
│  monitorConnectedExternalDrives ◄──► Redis (DRIVE_STATE)            │
│  monitorSpecialProcessesMicro  ◄──► Redis (PROCESS_MONITOR)        │
│  monitorISSMediaFiles          → iss_media_files                   │
│                                                                     │
│  autoVideoTransferEDAMicroservice → video_transfer_queue_*          │
│  autoFtpVideoTransferService   → ftp_video_transfer_queue_*        │
│  autoUSBImageTransferService   → transfer_queue_*                  │
│  autoFTPImageTransferService   → ftp_image_transfer_queue_*        │
│                                                                     │
│  DashboardReportingBackend     → :8454  (Express + WS + Nunjucks)  │
└─────────────────────────────────────────────────────────────────────┘
```

### PM2 Services (Active in ecosystem.config.js)

| Service name | Entry point | Dependencies | Log files |
|---|---|---|---|
| ConfigStateServiceRedis | ConfigStateServiceRedis.js | — | logs/ConfigStateServiceRedis-{out,error}.log |
| monitorConnectedExternalDrivesMicroservice | monitorConnectedExternalDrivesMicroservice.js | — | logs/monitorConnectedExternalDrivesMicroservice-{out,error}.log |
| monitorSpecialProcessesMicroservice | monitorSpecialProcessesMicroservice.js | — | logs/monitorSpecialProcessesMicroservice-{out,error}.log |
| monitorISSMediaFilesOptimizedMicroservice | monitorISSMediaFilesOptimizedMicroservice.js | ConfigStateServiceRedis, monitorConnectedExternalDrives | logs/monitorISSMediaFilesOptimizedMicroservice-{out,error}.log |
| autoVideoTransferEDAMicroservice | refactored_autoVideoTransferEDAMicroservice.js | ConfigStateServiceRedis, monitorISSMediaFiles | logs/refactored_autoVideoTransferEDAMicroservice-{out,error}.log |
| autoFtpVideoTransferService | autoFtpVideoTransferService.js | ConfigStateServiceRedis, monitorISSMediaFiles | logs/autoFtpVideoTransferService-{out,error}.log |
| autoUSBImageTransferService | autoUSBImageTransferService.js | ConfigStateServiceRedis, monitorConnectedExternalDrives | logs/autoUSBImageTransferService-{out,error}.log |
| autoFTPImageTransferService | autoFTPImageTransferService.js | ConfigStateServiceRedis, monitorConnectedExternalDrives | logs/autoFTPImageTransferService-{out,error}.log |
| DashboardReportingBackend | DashboardReportingBackend.js | monitorConnectedExternalDrives | logs/DashboardReportingBackend-{out,error}.log |

### SecurOS Scripts (run inside SecurOS, not PM2)

| Script | Trigger mechanism | Runs every |
|---|---|---|
| OptimizedImageCapture.js | LPR_CAM → CAR_LP_RECOGNIZED event | On every plate recognition |
| ImageExportSuccessOptimized.js | IMAGE_EXPORT → EXPORT_DONE event | On every successful export |
| Image Export Errors.js | IMAGE_EXPORT → EXPORT_FAILED event | On every failed export |
| Export Fixer Microservice.js | Internal timer + DB poll | Periodic (configured interval) |
| ExportDirectoryControlV3.js | Internal loop | Continuous |
| ClusterStatusMonitorScript.js | Internal timer | Every 10 minutes |

### Shared Services Layer

```
services/
├── shared/
│   ├── TransferUtils.js       — DB helpers: mark transferred, query eligible files
│   └── CleanupService.js      — Post-transfer cleanup (queue rows, temp files)
├── image-transfer/
│   ├── state/
│   │   ├── ImageJobManager.js     — Selects & batches image files for USB transfer
│   │   └── FtpImageJobManager.js  — Selects & batches image files for FTP transfer
│   ├── transfer/
│   │   ├── ImageTransferManager.js     — Executes USB file copy + DB update
│   │   └── FtpImageTransferManager.js  — Executes FTP upload + DB update
│   ├── processors/
│   │   └── ImageProcessor.js    — Per-image processing steps
│   └── validators/
│       └── ImageSpaceValidator.js — Pre-transfer USB space check
└── video-transfer/
    ├── state/
    │   ├── JobManager.js            — Selects & batches video segments for USB
    │   ├── FtpJobManager.js         — Selects & batches video segments for FTP
    │   └── ProcessingStateManager.js — In-memory processing state
    ├── transfer/
    │   ├── FileTransferManager.js   — USB video copy + DB update
    │   └── FtpTransferManager.js    — FTP video upload + DB update
    ├── processors/
    │   ├── VideoProcessor.js        — Per-segment processing steps
    │   ├── QueueProcessor.js        — Queue management for video jobs
    │   ├── CompleteBufferManager.js      — Tracks completed per-camera USB buffers
    │   └── FtpCompleteBufferManager.js   — Tracks completed per-camera FTP buffers
    └── validators/
        └── SpaceValidator.js        — Pre-transfer USB space check (video)
```

### Route Map (DashboardReportingBackend, port 8454)

| Base path | File | Key tables / WS events |
|---|---|---|
| `/` (pages + `/api/config`, `/files/*`, `/transfer/*`) | routes/mainControlRoutes.js | files, transfer_job, transfer_job_log; WS: startStorageTransfer |
| `/auto-transfer` | routes/autoTransferRoutes.js | transfer_queue_job, transfer_queue; WS: handleAutoTransfer |
| `/ftp-transfer` | routes/ftpTransferRoutes.js | ftp_image_transfer_queue_*; WS: handleFtpTransfer |
| `/manual-transfer` | routes/manualTransferRoutes.js | files, transfer_job, transfer_job_log |
| `/dashboard` | routes/dashboardRoutes.js | files (read), iss_media_files (read) |
| `/devices` | routes/connectedDevicesRoutes.js | device_connections; WS: devices, deviceHistory |
| `/media-files` | routes/mediaFilesRoutes.js | iss_media_files |
| `/processes` | routes/processMonitorRoutes.js | PM2 state (Redis); WS: processes |
| `/main-config` | routes/mainConfigRoutes.js | dataTransferConfig.json |

### Redis Key Space

| Key / Channel | Owner | Consumers |
|---|---|---|
| `CONFIG_STATE_KEY` | ConfigStateServiceRedis | All services |
| `CONFIG_STATE_KEY_update` (pub/sub) | ConfigStateServiceRedis | All services (config reload) |
| `CONNECTED_DRIVE_STATE` | monitorConnectedExternalDrives | DashboardReportingBackend, transfer services |
| `CONNECTED_DRIVE_LIST` | monitorConnectedExternalDrives | DashboardReportingBackend |
| `CONNECTED_DRIVE_LIST_UPDATE` (pub/sub) | monitorConnectedExternalDrives | Transfer services |
| `PROCESS_MONITOR_UPDATE` (pub/sub) | monitorSpecialProcesses | DashboardReportingBackend |
| `image_file_transfer_queue` | (legacy FileTransferRedisService — archived) | Archived |
| `image_file_transfer_result_queue` | (legacy — archived) | Archived |

### Database Summary

| Database | Connection | Purpose |
|---|---|---|
| `tahakom_transfer` | postgres:postgres@localhost:5432 | All runtime application tables — source of truth |
| `auto` | postgres:postgres@localhost:5432 | MCP tooling access only (postgresql-securos_auto-mcp) — zero app code connects here |

> See `product/technical/database/schema.md` for full table definitions.

### MCP Servers (Cursor AI tooling, not application dependencies)

| MCP server name | Database | Usage |
|---|---|---|
| `postgresql-tahakom_transfer-mcp` | `tahakom_transfer` | AI agent SELECT queries — DB health, stuck exports, retry analysis |
| `postgresql-securos_auto-mcp` | `auto` | AI agent access — purpose of this DB is pending investigation |

### Encryption Subsystem

- Algorithm: AES-256-CBC (`utils/encryptionService.js`)
- Key management: RSA certificate pair (`certs/public_key.pem` + `certs/private_key.pem`)
- Config: `encryption.enabled`, `encryption.encryptMetadata` in `dataTransferConfig.json`
- USB decryption: `scripts/maintenance/decryptUSBFiles.js`
- RSA key generation: `scripts/maintenance/generateRSAKeys.js`

---

## [ORPHANS & PENDING]

### Legacy — Safe to Ignore or Remove

| Item | Location | Reason |
|---|---|---|
| `auto_transfer_device` + `auto_transfer_job` tables | `scripts/migration/DatabaseMigration.js` L151–167 | Created in migration; zero runtime JS touches them — likely legacy from an older auto-transfer design |
| `FileTransferRedisService` | `archived/FileTransferRedisService.js` | Commented out in `ecosystem.config.js`; superseded by `ImageJobManager` |
| `autoVideoTransferMicroservice` | `archived/autoVideoTransferMicroservice.js` | Replaced by `refactored_autoVideoTransferEDAMicroservice.js` |
| `autoVideoTransferEDAMicroservice` | `archived/autoVideoTransferEDAMicroservice.js` | Replaced by the refactored variant |
| `FileVideoTransferRedisService` | `archived/FileVideoTransferRedisService.js` | Archived — not referenced anywhere active |

### Open Items (require user action)

| # | Item | Blocking | Action required |
|---|---|---|---|
| O-1 | ~~SecurOS log file paths~~ | ~~engineering-ops-agent log tailing~~ | **Resolved** — all paths registered in `.cursor/skills/securos-log-registry/SKILL.md`. Base dir: `C:\ProgramData\ISS\logs\`, files `nodejs.1–6.console.log` |
| O-2 | `auto` / `securos_auto` DB content | architecture-data-agent DB queries | Inspect via `postgresql-securos_auto-mcp` MCP — clarify what this DB stores and whether any scripting depends on it |
| O-3 | FTP credentials | FTP transfer services | `ftpTransfer` section in `dataTransferConfig.json` has empty host/user/password |
| O-4 | `DriveStateServiceRedis` file | Service dependency graph | Referenced in `ecosystem.config.js` deps but not confirmed present in workspace — verify |
| O-5 | Active `retentionDays` + `maxCapacity` values | ExportDirectoryControlV3 behavior | Current config shows `maxCapacity: 1000` and no `retentionDays` — confirm live production values |

### Technical Debt

| # | Item | Location | Priority |
|---|---|---|---|
| T-1 | `files` table indexes commented out | `DatabaseMigration.js` L183–187 | Medium — `idx_files_ts`, `idx_files_grouping` not active; may hurt transfer query performance at scale |
| T-2 | `pending_deletion` + `updated_at` added at runtime | `ExportDirectoryControlV3.js` L587–628 | Low — schema alterations should be in migration, not in a script loop |
| T-3 | Inline JSONB retry log on `files` | `files.export_retry_log_object` | Low — bloat risk at high plate-volume; consider extracting to a dedicated `export_retry_log` table |
| T-4 | `transfer_job` / `transfer_job_log` (legacy manual flow) | `routes/mainControlRoutes.js`, `manualTransferRoutes.js` | Low — assess whether this flow is still used or fully superseded by `transfer_queue_job` |
| T-5 | No automated tests for SecurOS scripts | `securos-scripts/` | Low — not possible without the SecurOS runtime injection; consider a mock harness |

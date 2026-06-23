# PROJECT_MAP.md

**Tahakom Data Transfer System** — Live external-memory map.  
_Update this file whenever a service is added, a table changes, or a decision is superseded._

> **For AI agents**: load this file at the start of every session. It is the canonical context for all architecture, data flow, and service decisions. Do not rely on parametric memory — trust this map.

> **Related maps**: `FILES_VIDEOS_AUTO_TRANSFER_MAP.md` — deep dive on auto-transfer timing, ordering (oldest vs. newest per pipeline), and unhandled cases that can stall image/video transfer.

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
| Logging | Winston + winston-daily-rotate-file | ^3.17.0 / ^5.0.0 | Shared factory `utils/logger.js` — per-service daily-rotate files under `logs/` (`<service>-app-%DATE%.log` + `<service>-error-%DATE%.log`); TTY-aware console (colorized in dev, plain under PM2). AsyncLocalStorage trace IDs: wrap any job/request in `runWithTrace({traceId, jobId, camera})` and every log line inside stamps those fields automatically. Express `traceMiddleware` seeds a per-request `traceId` and echoes it in the `X-Trace-Id` response header. **Full rollout complete (2026-06-18)** — all 23 PM2 entry services and `services/**` helper modules migrated; zero raw `console.*` calls remain in production code. |
| Real-time (UI) | ws (WebSocket) | ^8.18.2 | Dashboard live updates via `ws://localhost:8454` |
| Charts | Apache ECharts | 5.4.3 (vendored) | Dashboard statistics, vendored in `data_transfer_v2/public/vendors/echarts/` |
| Date handling | Moment.js + moment-timezone | ^2.30.1 / ^0.5.48 | Transfer scheduling, timestamp formatting |
| Encryption | Node.js `crypto` (built-in) | — | AES-256-CBC file encryption; RSA key management via `certs/` |
| **Test runner** | **Jest** | **latest (devDependency)** | **Unit test suite — `npm test`; config: `jest.config.js`; suites: `tests/`** |
| FTP client | basic-ftp | ^5.0.5 | FTP/FTPS image and video upload |
| File watching | chokidar | ^3.6.0 | ISS media directory monitoring |
| HTTP client | axios | ^1.9.0 | Internal service calls |
| Embedded DB (config) | NeDB | ^1.8.0 | Lightweight local config store (secondary to Redis) |
| PDF generation | pdfkit | ^0.12.3 | Dashboard export reports |
| System info | systeminformation | ^5.22.11 | Drive/system metrics |
| USB hotplug | usb | ^3.0.0 (NAPI-rs) | WebUSB `connect`/`disconnect` events for instant drive detection; prebuilt `@node-usb/usb-win32-x64-msvc` (no build step); falls back to 1s polling if native load fails. See ADR-0007 |
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
  └─ Dispatches IMAGE_EXPORT → EXPORT reaction
       Load-balancer: prefers least-busy non-OVER exporter;
       falls back to globally least-loaded when ALL exporters are OVER.
       Each capture wrapped in try/catch — no single event can crash the process.

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
  Detects USB/external drives — event-driven via usb@3 WebUSB hotplug (near-instant) + 15s safety-net + 1s poll fallback
  WRITE → Redis: CONNECTED_DRIVE_STATE, CONNECTED_DRIVE_LIST
  PUBLISH → Redis channel: CONNECTED_DRIVE_LIST_UPDATE, CONNECTED_DRIVE_STATE_update
  INSERT/UPDATE → device_connections (PostgreSQL)

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
| `/` (pages + `/api/config`, `/files/*`, `/transfer/*`) | routes/mainControlRoutes.js | files, transfer_job, transfer_job_log; WS: startStorageTransfer. `/files/data` uses a single-pass `GROUP BY LEFT(tid, LENGTH(tid)-LENGTH(cam_id::text)), plate_num, site_id, date_folder, time_folder` — no CTE/self-join. |
| `/auto-transfer` | routes/autoTransferRoutes.js | transfer_queue_job, transfer_queue; WS: handleAutoTransfer |
| `/ftp-transfer` | routes/ftpTransferRoutes.js | ftp_image_transfer_queue_*; WS: handleFtpTransfer |
| `/manual-transfer` | routes/manualTransferRoutes.js | files, transfer_job, transfer_job_log |
| `/dashboard` | routes/dashboardRoutes.js | `files` (live queries via covering indexes), `mv_files_daily/monthly/yearly[_agg]` (pre-aggregated chart data); `GET /dashboard/data` Redis-cached (TTL 60 s), `GET /dashboard/table` paginated detail rows, `POST /dashboard/refresh` busts cache + triggers concurrent MV refresh |
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
| `dashboard:data:<hash>` | DashboardReportingBackend (`/dashboard/data`) | Browser dashboard chart load — TTL 60 s; busted on `POST /dashboard/refresh` |

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

## [TESTING]

> See `TEST_MAP.md` (workspace root) for the full per-suite index and coverage table.

### Test Stack

| Tool | Role |
|---|---|
| Jest (devDependency) | Test runner, assertion library, mock framework, coverage |
| `jest.config.js` | Config: node env, `tests/**/*.test.js` pattern, `silent: true`, excludes `data_transfer_v2/` and `archived/` |
| `tests/helpers/mocks.js` | Shared factories: `createMockPool`, `createMockRedis`, `createMockEncryption`, fixture rows |

### Commands

```bash
npm test              # Run all suites (silent)
npm run test:watch    # Watch mode
npm run test:coverage # Coverage report
```

### Suite Index

| Suite | File | Tests | What is verified |
|---|---|---|---|
| FileTransferManager | `tests/video-transfer/FileTransferManager.test.js` | 24 | `transferFile`, `copyWithRetry`, `handleTransferError`, `processEncryptedVideoBatch`, `markSourceFilesAsTransferred`, `getPendingTransferFileForJob` |
| SpaceValidator | `tests/video-transfer/SpaceValidator.test.js` | 12 | Drive-ready check, free-space estimation, processing-space validation |
| Schedule helpers | `tests/video-transfer/UnifiedVideoTransferService.schedule.test.js` | 14 | `_calculateNextScheduledRun` (daily/weekly), `_isInScheduledWindow`, `_updateScheduleStatus` |
| ImageTransferManager | `tests/image-transfer/ImageTransferManager.test.js` | 28 | Grouping, normal/encrypted paths, retry, job completion |
| ImageSpaceValidator | `tests/image-transfer/ImageSpaceValidator.test.js` | 13 | Free-space in MB, per-file/batch checks, drive-near-full threshold |
| TransferUtils | `tests/shared/TransferUtils.test.js` | 32 | All static DB helpers, error detectors, path generators, file validators |
| encryptionService | `tests/encryptionService.test.js` | 8 | Real AES-256-CBC and RSA-OAEP round-trips using OS temp dir |
| logger | `tests/logger.test.js` | 16 | `createLogger`, `newTraceId`, `runWithTrace`, `getTraceId`, `addTraceField`, `traceMiddleware` — ALS trace injection verified end-to-end |
| **Total** | | **131 unit + 8 real-crypto + 16 logger = 155** | |

### Coverage (as of Jun 2026)

| Module | Statements | Functions | Lines |
|---|---|---|---|
| `services/image-transfer/transfer/ImageTransferManager.js` | 89% | 87% | 88% |
| `services/video-transfer/transfer/FileTransferManager.js` | 81% | 77% | 81% |
| `services/video-transfer/validators/SpaceValidator.js` | 85% | 88% | 85% |
| `services/image-transfer/validators/ImageSpaceValidator.js` | 66% | 90% | 66% |
| `services/shared/TransferUtils.js` | 51% | 63% | 51% |
| `utils/encryptionService.js` | 79% | 57% | 91% |

### What Is NOT Unit-Tested

| Item | Reason | Path |
|---|---|---|
| SecurOS scripts | Cannot run without the SecurOS runtime injected `securos` module | `securos-scripts/` |
| `autoUSBImageTransferService.js` entry | Self-executes at module load (opens real Redis/PG); tests target `ImageTransferManager` directly | — |
| FTP transfer managers | No FTP test suite yet | `services/*/transfer/Ftp*.js` |
| `JobManager`, `ProcessingStateManager`, `CompleteBufferManager` | Complex state machines; integration tests planned (T-5) | `services/video-transfer/state/`, `processors/` |
| Dashboard routes | No API test suite yet | `routes/` |
| DB integration | Tests use mock pool; no real-DB integration tests exist | — |

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
| Legacy docs (`docs/`, `development-guides/`, `user-stories/`) | `archived/legacy-docs/` | **Consolidated 2026-06-17** — unique content folded into `product/`; redundant/legacy files moved to `archived/legacy-docs/`; original folders removed. See `product/README.md` for full index. |

### Documentation Reconciliation Follow-ups

These archived files contain detail that should eventually be verified and lifted into `product/technical/services.md` (tracked here, not yet done):

| # | Item | Archived file | Action required |
|---|---|---|---|
| D-1 | `monitorISSMediaFilesOptimizedMicroservice` env vars, Redis keys, and SQL patterns may be more complete in legacy doc than in `services.md` | `archived/legacy-docs/ISS_MEDIA_INDEXING_SERVICE.md` | Cross-check env vars and Redis keys against live code; update `product/technical/services.md` with anything missing |
| D-2 | `job-function.md` captured scheduler intent (38-file phases, status branches) as an unfinished draft | `archived/legacy-docs/job-function.md` | Reconcile against `refactored_autoVideoTransferEDAMicroservice.js` actual behavior; document confirmed logic in `services.md` |
| D-3 | `sow.md` may contain QA/timeline tables not copied into the PRD | `archived/legacy-docs/sow.md` | Scan for QA criteria or delivery timelines not already in `product/prd/PRD-tahakom-data-transfer.md`; lift if useful |

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
| ~~T-1~~ | ~~`files` table indexes commented out~~ | ~~`DatabaseMigration.js`~~ | **Resolved** (Jun 2026) — two covering partial indexes `idx_files_dashboard_date` + `idx_files_dashboard_cam_date` are active; six dashboard materialized views (`mv_files_daily/monthly/yearly[_agg]`) added for pre-aggregated chart queries |
| T-2 | `pending_deletion` + `updated_at` added at runtime | `ExportDirectoryControlV3.js` L587–628 | Low — schema alterations should be in migration, not in a script loop |
| T-3 | Inline JSONB retry log on `files` | `files.export_retry_log_object` | Low — bloat risk at high plate-volume; consider extracting to a dedicated `export_retry_log` table |
| T-4 | `transfer_job` / `transfer_job_log` (legacy manual flow) | `routes/mainControlRoutes.js`, `manualTransferRoutes.js` | Low — assess whether this flow is still used or fully superseded by `transfer_queue_job` |
| ~~MI-A~~ | ~~**No queue consumer** — `FileTransferQueueService.getNextFilesToTransfer()` never called; `/manual_usb` queues files into `file_transfer_queue` but nothing copies them~~ | ~~`utils/FileTransferQueueService.js`~~ | **Fixed 2026-06-23** — inline consumer loop added to `startManualFileTransferProcess`; `markFilesAsTransferred` also now updates `transfer_job_log.transferred` (MI-D) |
| ~~MI-B~~ | ~~**Missing `getDriveInfo` import** — `manualTransferRoutes.js` calls `getDriveInfo()` without importing it; throws `ReferenceError` every 5 s while a job is active, crashing the loop~~ | ~~`routes/manualTransferRoutes.js:201`~~ | **Fixed 2026-06-23** — `const { getDriveInfo } = require('../utils/driveUtils')` added |
| ~~MI-C~~ | ~~**API endpoint mismatch** — UI `pauseJob`/`resumeJob`/`cancelJob` called `/manual-transfer/pause|resume|cancel`; none existed~~ | ~~`data_transfer_v2/views/manual_usb.njk`~~ | **Fixed 2026-06-23** — all three functions now call `/manual-transfer/control` with `action` param |
| ~~MI-D~~ | ~~**`transfer_job_log` not updated by queue path**~~ | ~~`utils/FileTransferQueueService.js`~~ | **Fixed 2026-06-23** — resolved as part of MI-A; see above |
| ~~MI-E~~ | ~~**Completion false-positive** — empty queue returns `isCompleted=true`, job instantly marked completed~~ | ~~`routes/manualTransferRoutes.js`~~ | **Fixed 2026-06-23** — completion check now guards `totalFiles > 0` |
| ~~MI-F~~ | ~~**Encryption field silently ignored** — `encryption` sent by UI, never read by backend~~ | ~~`routes/manualTransferRoutes.js`~~ | **Fixed 2026-06-23** — destructured, stored in config, warns if enabled |
| ~~MI-G~~ | ~~**Stuck cancelled job in config** — stale `manualTransfer` block with `isCancelled:true` emitted to all UI clients~~ | ~~`data_transfer_v2/dataTransferConfig.json`~~ | **Fixed 2026-06-23** — stale entry cleared; cancel handler now nullifies `config.manualTransfer` |
| ~~MI-H~~ | ~~**Docs vs code drift** — `transfer_feature.md` documented car-plate filter and WebSocket events absent from current path~~ | ~~`data_transfer_v2/features/transfer_feature.md`~~ | **Fixed 2026-06-23** — rewritten to accurately document both current and legacy paths |
| ~~MI-I~~ | ~~**`EPERM: mkdir 'G:\\'`** — `fs.ensureDir` fails with EPERM on Windows drive roots; normalization produced `G:\filename.jpg` → `path.dirname` = `G:\` → `mkdir G:\` → EPERM~~ | ~~`routes/manualTransferRoutes.js` consumer loop~~ | **Fixed 2026-06-23** — added drive-root guard: skip `ensureDir` when `destDir` matches `^[A-Za-z]:[/\\]$`; always present, cannot be mkdir'd |
| ~~MI-J~~ | ~~**History table never reloads** — `loadTransferHistory()` only called on page load; job creation and finalization never triggered a re-fetch~~ | ~~`data_transfer_v2/views/manual_usb.njk` WS handler~~ | **Fixed 2026-06-23** — WS handler tracks `currentJobId`; reloads history when a new job first appears AND when job goes to null (finalized) |
| ~~MI-K~~ | ~~**UTC date in destination display** — summary box showed `drive\transfer\<UTC date>` via `toISOString().split('T')[0]`; wrong date in UTC+3 near midnight~~ | ~~`data_transfer_v2/views/manual_usb.njk:436`~~ | **Fixed 2026-06-23** — replaced with local `getFullYear/getMonth/getDate` getters |
| ~~MI-L~~ | ~~**Destination path mismatch** — UI summary displays `G:\transfer\YYYY-MM-DD` but backend passed bare `G:` to `addFilesToQueue`; files copied to drive root instead of the dated subfolder~~ | ~~`routes/manualTransferRoutes.js:280`~~ | **Fixed 2026-06-23** — backend now computes `G:\transfer\<localDate>` from drive + `path.sep` + `'transfer'` + local date string, matching UI |
| ~~MI-M~~ | ~~**No final WebSocket event on job finalization** — after `cfg.manualTransfer = null`, no event was emitted; active card stayed on screen until page reload~~ | ~~`routes/manualTransferRoutes.js:333`~~ | **Fixed 2026-06-23** — `emitEventToClients('manualTransferConfig', { config: null, finalStatus })` added immediately after config clear |
| ~~MI-N~~ | ~~**O(N) INSERT loop in `addFilesToQueue`** — 977 individual `await INSERT` calls in a for-loop inside one transaction; each round-trip ~5 ms → 977 × 5 ms ≈ **5 s** per queue operation~~ | ~~`utils/FileTransferQueueService.js:addFilesToQueue`~~ | **Fixed 2026-06-23** — replaced with single `unnest` bulk INSERT (one query, parallel arrays); now < 100 ms |
| ~~MI-O~~ | ~~**Consumer loop too slow** — 5 s sleep + 50-file batch + no mid-batch pause check; UI update only at next iteration start; overall cycle 12–16 s; pause took up to 14 s to respond~~ | ~~`routes/manualTransferRoutes.js:startManualFileTransferProcess`~~ | **Fixed 2026-06-23** — sleep reduced to 1 s; batch capped at 10 files; pause/cancel flag checked before each file; progress emitted immediately after each batch; `ensureDir` results cached per-iteration |
| ~~MI-P~~ | ~~**Summary/create queries did full table scan** — `TO_TIMESTAMP(date::text \|\| ' ' \|\| time::text, ...)` does not match `idx_files_date_time` index (`(date + "time"::interval)`); every query scanned the whole `files` table; no loading feedback on buttons~~ | ~~`routes/manualTransferRoutes.js`, `data_transfer_v2/views/manual_usb.njk`~~ | **Fixed 2026-06-23** — queries rewritten to use `(date + time::interval) >= $1::timestamp`; spinner added to both Show Summary and Create Job buttons |
| MV-A | ~~**`dataType` silently ignored (summary)** — summary always queried `files` regardless of selection~~ / **Create still blocked for videos/both** — `transfer_job_log.file_id` is NOT NULL FK to `files`; video files from `iss_media_files` need a schema migration + ffmpeg conversion pipeline (MV-B, MV-C) | `routes/manualTransferRoutes.js`, `data_transfer_v2/views/manual_usb.njk` | **Partially fixed 2026-06-23** — summary now queries `files` for images, `iss_media_files` for videos, both for both; create route returns 400 for video/both with clear error; UI shows warning notice and disables Create button; default selection changed from `both` to `images` |
| MV-B | **No `iss_media_files` query path** — ISS video source files are completely unreachable via manual transfer routes | `routes/manualTransferRoutes.js` | **Critical** — required for manual video to work |
| MV-C | **No conversion pipeline** — ISS `.issvd` files need ffmpeg processing (5-phase like auto video); manual transfer has none | Manual transfer stack | **Critical** — required for manual video to work |
| ~~T-5a~~ | ~~No unit tests for Node transfer services~~ | ~~`services/`~~ | **Resolved** (Jun 2026) — 139 Jest unit tests added. See `TEST_MAP.md`. |
| T-5b | No unit tests for SecurOS scripts | `securos-scripts/` | Low — not possible without the SecurOS runtime injection; consider a mock harness |
| T-5c | No tests for FTP transfer managers, JobManager, CompleteBufferManager, dashboard routes | `services/*/Ftp*.js`, `state/`, `routes/` | Medium — integration test suite planned; see `TEST_MAP.md` §Gaps |
| ~~T-6~~ | ~~`/files/data` used a CTE + self-JOIN on `SUBSTRING(tid,1,LENGTH(tid)-1)` — cross-plate file aggregation bug + perf~~ | ~~`routes/mainControlRoutes.js`~~ | **Fixed** (Jun 2026) — replaced with single-pass GROUP BY on event_tid + plate_num; countQuery also aligned |
| ~~T-7~~ | ~~`OptimizedImageCapture.js` crashed (TypeError: Cannot read properties of undefined, 'queue_size') when all IMAGE_EXPORT queues flipped OVER — load balancer returned null; unguarded dereference exited the SecurOS node process (exit code 1), stopping all ALPR capture~~ | ~~`securos-scripts/OptimizedImageCapture.js`, `securos-scripts/Export Fixer Microservice.js`~~ | **Fixed 2026-06-21** — load balancer falls back to least-loaded when all OVER; NaN→0 for missing queue_size; null guard + outer try/catch in `processCameraCapture`; `await loadImageExports` at startup; matching NaN + null guard added to Export Fixer |
| ~~T-8~~ | ~~`Export Fixer Microservice.js` crashed (PostgreSQL 40P01 deadlock + unhandled Promise rejection, exit code 1) — `pool.query(updateRetryCountQuery)` was not awaited, firing 8 concurrent UPDATEs on `files` that deadlocked each other; Node.js 22 treats unhandled rejections as fatal~~ | ~~`securos-scripts/Export Fixer Microservice.js` line 238~~ | **Fixed 2026-06-21** — added `await` to `pool.query(updateRetryCountQuery)`; UPDATEs are now serialised; any transient deadlock propagates to the surrounding try/catch instead of killing the process |
| ~~T-9~~ | ~~`Image Export Errors.js` crashed (PostgreSQL 40P01 deadlock + unhandled Promise rejection, exit code 1) — three stacked bugs: (A) SELECT filter `AND file_size = 0 AND export_retry_count < 4` was commented out, returning 3,562 rows for `tid='-16'`; (B) `rowCount !== 1` triggered the `else` branch which mass-soft-deleted thousands of rows; (C) `await sleep(7000)` allowed multiple EXPORT_FAILED handlers to overlap and race on the same rows, deadlocking PostgreSQL; no outer try/catch meant the unhandled rejection killed the process~~ | ~~`securos-scripts/Image Export Errors.js` lines 118, 84, 144~~ | **Fixed 2026-06-23** — restored SELECT filter (`file_size = 0 AND export_retry_count < 4`); wrapped handler body in try/catch; removed `await sleep(7000)` |

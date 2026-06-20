# Technical Architecture

**Tahakom Data Transfer System**  
Last updated: 2026-06-20 (event-driven USB detection — monitorConnectedExternalDrivesMicroservice refactored to usb@3 WebUSB hotplug + 15s safety-net + polling fallback; ADR-0007 added)

> For a living service/table map, see [PROJECT_MAP.md](../../PROJECT_MAP.md).  
> For database schema details, see [database/schema.md](database/schema.md).  
> For ADRs explaining why these choices were made, see [../decisions/](../decisions/).

---

## Overview

The Tahakom Data Transfer System is a **Node.js multi-service application** deployed on Windows via PM2. It serves as the middleware between an ISS SecurOS ALPR (Automatic License Plate Recognition) system and several downstream distribution targets (USB drives, FTP servers). A browser-based dashboard provides real-time monitoring and manual control.

The system has **two distinct runtime boundaries**:

1. **SecurOS Script Integration Engine** — runs scripts inside the SecurOS process space with an injected `securos` event-bus module. These scripts own the ALPR image capture lifecycle and write the primary database table (`files`).
2. **PM2 process group** — standard Node.js services managed by PM2, consuming the database records produced by the SecurOS scripts and distributing files outward.

---

## High-Level Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│  SECUROS RUNTIME BOUNDARY                                                         │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │  LPR_CAM  →  CAR_LP_RECOGNIZED  →  OptimizedImageCapture.js                │  │
│  │                                          │                                  │  │
│  │                             INSERT files (file_size=0)                      │  │
│  │                             dispatch IMAGE_EXPORT                           │  │
│  │                                          │                                  │  │
│  │       SecurOS IMAGE_EXPORT engine (load-balanced, N exporters)              │  │
│  │              │                           │                                  │  │
│  │     EXPORT_DONE                   EXPORT_FAILED                            │  │
│  │         │                              │                                    │  │
│  │  ImageExportSuccess.js      Image Export Errors.js                         │  │
│  │  UPDATE file_size            retry / soft-delete                            │  │
│  │                                                                             │  │
│  │  Export Fixer Microservice.js ──── periodic re-export of stale rows        │  │
│  │  ExportDirectoryControlV3.js  ──── retention + FIFO disk governance        │  │
│  │  ClusterStatusMonitorScript.js ─── PM2 health watchdog (every 10 min)      │  │
│  └─────────────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────┬───────────────────────────────────────┘
                                            │ PostgreSQL pg (tahakom_transfer)
┌───────────────────────────────────────────▼───────────────────────────────────────┐
│  DATABASE LAYER                                                                   │
│                                                                                   │
│  PostgreSQL localhost:5432                                                        │
│  ├── DB: tahakom_transfer  ──  all runtime tables                                │
│  └── DB: auto              ──  MCP tooling only (no app code)                    │
└───────────────────────────────────────────┬───────────────────────────────────────┘
                                            │ pg Pool
┌───────────────────────────────────────────▼───────────────────────────────────────┐
│  PM2 APPLICATION LAYER                                                            │
│                                                                                   │
│  State & Config                     Transfer Services                             │
│  ─────────────                      ─────────────────                             │
│  ConfigStateServiceRedis  ◄──►      autoUSBImageTransferService                  │
│  monitorConnectedDrives   ◄──►      autoFTPImageTransferService                  │
│  monitorSpecialProcesses            autoVideoTransferEDAMicroservice              │
│  monitorISSMediaFiles               autoFtpVideoTransferService                  │
│                                                                                   │
│  ◄──── Redis pub/sub for all state changes ────────────────────────────────►     │
│                                                                                   │
│  Dashboard                                                                        │
│  DashboardReportingBackend  :8454  (Express + Nunjucks + WebSocket)               │
└───────────────────────────────────────────────────────────────────────────────────┘
                                            │ WebSocket / REST
┌───────────────────────────────────────────▼───────────────────────────────────────┐
│  BROWSER DASHBOARD                                                                │
│  Bootstrap 5 + ECharts + jQuery + Moment.js                                      │
│  Pages: dashboard, index, auto_transfer, auto_transfer_video,                     │
│         manual_usb, devices, process_monitor, ftp_transfer                        │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## Event-Driven Architecture (SecurOS Boundary)

SecurOS uses an **object-event reaction model** where scripts register handlers for specific `(ObjectType, EventName)` tuples. The `securos` module injects the `core` object with methods:
- `core.connect(callback)` — entry point
- `core.doReact(objectId, eventName, params)` — dispatch a reaction
- `core.getObjectsIds(type)` — enumerate objects of a type

The image capture pipeline is purely event-driven inside SecurOS:

```
LPR_CAM  ──(CAR_LP_RECOGNIZED)──► OptimizedImageCapture.js
  │
  └─ core.doReact(imageExportId, 'EXPORT', params)  ──► IMAGE_EXPORT object
       │
       ├─ (EXPORT_DONE)  ──► ImageExportSuccessOptimized.js
       └─ (EXPORT_FAILED) ──► Image Export Errors.js
```

Load balancing is achieved by iterating over all `IMAGE_EXPORT` objects and selecting the one with the smallest current queue depth (`core.getObjectsIds('IMAGE_EXPORT')`).

---

## State Management Architecture

### Configuration State (Redis + disk)

```
dataTransferConfig.json (disk)
        │  readConfig()
        ▼
ConfigStateServiceRedis.js
        │  SET Redis: CONFIG_STATE_KEY
        │  PUBLISH: CONFIG_STATE_KEY_update
        ▼
All PM2 services subscribe and hold config in memory.
On change: re-read from Redis, restart relevant internal loops.
```

### Drive State (Redis + PostgreSQL)

```
USB plug/unplug
        │  usb@3 WebUSB connect/disconnect event (near-instant, ~400ms latency)
        │  [fallback: systeminformation.blockDevices() 1s polling loop]
        ▼
monitorConnectedExternalDrivesMicroservice.js  (reconcileDrives)
        │  systeminformation.blockDevices() + fsSize()
        │  SET Redis: CONNECTED_DRIVE_STATE, CONNECTED_DRIVE_LIST
        │  PUBLISH: CONNECTED_DRIVE_LIST_UPDATE, CONNECTED_DRIVE_STATE_update
        │  INSERT/UPDATE: device_connections (PostgreSQL)
        ▼
Transfer services: read drive state before starting a transfer batch.
DashboardReportingBackend: reads via Redis for real-time UI updates.

Safety-net: 15s setInterval re-runs reconcileDrives() regardless of events
(covers non-USB removable media, missed events, and space/uptime refresh).
Config change: CONFIG_STATE_KEY_update subscription triggers an immediate
reconcile to refresh the specific auto-transfer drive state.
```

See **ADR-0007** for the decision to use event-driven detection.

### Process State (Redis)

```
monitorSpecialProcessesMicroservice.js
        │  Polls PM2 process list
        │  PUBLISH: PROCESS_MONITOR_UPDATE
        ▼
DashboardReportingBackend: exposes via /processes route + WebSocket.
```

---

## Transfer Pipeline Architecture

Both image and video transfer follow the same **job-queue-worker** pattern:

```
1. JobManager.selectEligibleFiles()
     SELECT from files/iss_media_files WHERE not transferred, not deleted, file_size > 0
     
2. Create job record
     INSERT transfer_queue_job / video_transfer_queue_job (status='pending', batch_id=UUID)
     
3. Populate queue
     INSERT transfer_queue rows (one per file, status='pending')
     
4. Process queue
     For each item in queue:
       SpaceValidator.check()       → abort if insufficient USB space
       TransferManager.transfer()   → copy file to USB or upload to FTP
       UPDATE queue item status     → 'transferred' or 'failed'
       UPDATE source file flag      → is_auto_transferred / is_ftp_transferred = true
       
5. Finalize job
     UPDATE transfer_queue_job status → 'transferred' or 'failed'
     CleanupService.cleanup()         → remove queue rows, clean temp files
```

For video transfers, the pipeline adds a **buffer stage** (`video_converted_buffer`) that groups segments per camera before queuing them for transfer.

---

## Security Architecture

### Encryption

- Files on disk and during USB transfer can be AES-256-CBC encrypted.
- Each file gets a unique AES key; the AES key is RSA-encrypted with the public key and stored alongside the file.
- The private key (`certs/private_key.pem`) is required for USB decryption via `scripts/maintenance/decryptUSBFiles.js`.
- When `encryption.encryptMetadata = true`, the `files` DB record's metadata fields are also encrypted.

### Authentication

- The dashboard (`DashboardReportingBackend.js`) uses `express-basic-auth` for HTTP basic authentication.
- No inter-service authentication — all services communicate via localhost Redis and PostgreSQL with a shared local password.
- No external network exposure by design; the system is intended for on-premises deployment.

---

## Logging Architecture

### Shared Logger (`utils/logger.js`)

All PM2 services share a single logger factory built on **Winston** + `winston-daily-rotate-file`. Create a logger for any service with:

```js
const { createLogger } = require('./utils/logger');
const logger = createLogger({ service: 'MyServiceName' });
```

**Log files written per service:**

```
logs/
├── <service>-app-%DATE%.log    — combined (all levels), JSON, daily rotated, zipped
├── <service>-error-%DATE%.log  — error level only, daily rotated, zipped
├── <service>-out.log           — PM2 stdout capture (plain text)
└── <service>-error.log         — PM2 stderr capture (plain text)
```

`maxSize` and `maxFiles` are controlled by `LOG_MAX_SIZE` (default `20m`) and `LOG_MAX_FILES` (default `14d`) in `.env`.  
The Console transport is **TTY-aware**: colorized in a developer terminal, plain text under PM2 so `-out.log` capture files stay clean.

### Correlation / Trace IDs (AsyncLocalStorage)

Trace IDs let you follow one HTTP request or background job across all log lines it produces — including inside shared `services/**` helpers — without threading an ID argument through every function call.

The mechanism uses Node's built-in `AsyncLocalStorage` (`async_hooks`). Any field stored in the current async context (e.g. `traceId`, `jobId`, `camera`) is merged automatically into every log entry emitted within that context.

**Usage in background jobs** (`refactored_autoVideoTransferEDAMicroservice.js`, `autoFtpVideoTransferService.js`, `autoUSBImageTransferService.js`, `autoFTPImageTransferService.js`, `monitorISSMediaFilesOptimizedMicroservice.js` and all remaining PM2 entry services — full rollout complete as of 2026-06-18):

```js
const { runWithTrace, newTraceId } = require('./utils/logger');

await runWithTrace({ traceId: newTraceId(), jobId: job.batch_id, camera: cameraId }, async () => {
    logger.info('Processing job');         // → { traceId, jobId, camera, message, ... }
    await fileTransferManager.transferFile(...);   // logs inside also carry same traceId
});
```

**Usage in HTTP services** (`DashboardReportingBackend.js`):

```js
const { traceMiddleware } = require('./utils/logger');
app.use(traceMiddleware);   // reads X-Trace-Id request header or generates UUID v4
                            // echoes it in X-Trace-Id response header
                            // all logs during that request carry traceId
```

**Exported helpers from `utils/logger.js`:**

| Export | Description |
|---|---|
| `createLogger({ service })` | Winston logger factory — daily-rotate + console transports |
| `newTraceId()` | Generates a UUID v4 |
| `runWithTrace(context, fn)` | Runs `fn` inside ALS context carrying `context` fields |
| `getTraceContext()` | Returns current ALS store (or `{}` outside scope) |
| `getTraceId()` | Returns `traceId` from current ALS store |
| `addTraceField(key, value)` | Adds a field to the current ALS context in-place |
| `traceMiddleware` | Express middleware for per-request trace ID injection |

### SecurOS Scripts

SecurOS scripts log through the SecurOS Script Integration Engine's own log mechanism. They do **not** use `utils/logger.js` (separate runtime). Paths are registered in `.cursor/skills/securos-log-registry/SKILL.md`.

---

## Deployment Architecture

```
Windows Server / Windows 10+
│
├── ISS SecurOS (installed service)
│   └── Script Integration Engine
│       ├── OptimizedImageCapture.js
│       ├── ImageExportSuccessOptimized.js
│       ├── Image Export Errors.js
│       ├── Export Fixer Microservice.js
│       ├── ExportDirectoryControlV3.js
│       └── ClusterStatusMonitorScript.js
│
├── PostgreSQL 14+ (localhost:5432)
│   ├── tahakom_transfer  (runtime DB)
│   └── auto              (MCP tooling)
│
├── Redis (localhost, default port 6379)
│
└── PM2 (managed by ecosystem.config.js)
    ├── Node.js runtime: C:\Program Files (x86)\ISS\SecurOS\bin64\node.js\bin\node.exe
    ├── App root: C:\Proj\app\data_transfer_v2\ (or workspace root)
    └── 9 services (see PROJECT_MAP.md [ARCHITECTURE] → Service Topology)
```

### startup.js

PM2 services are started with `--require startup.js` (see `ecosystem.config.js` line 26). This file runs before each service entry point and sets up any global bootstrapping (env var loading, etc.).

---

## Scalability & Bottlenecks

| Bottleneck | Current Approach | Mitigation if Needed |
|---|---|---|
| PostgreSQL connections | pg Pool per service | Add PgBouncer connection pooler |
| Redis connections | ioredis, one client per service | Redis Cluster or increase maxmemory |
| File I/O during transfer | Sequential copy per queue item | Increase `p-limit` concurrency in transfer managers |
| IMAGE_EXPORT queue depth | Load-balanced across N exporters | Add more IMAGE_EXPORT objects in SecurOS config |
| Disk capacity | FIFO + retention via ExportDirectoryControlV3 | Tune `maxCapacity` and `retentionDays` in dataTransferConfig.json |
| Dashboard chart query latency at high `files` volume | Six materialized views (`mv_files_daily/monthly/yearly[_agg]`) pre-aggregate data; `GET /dashboard/data` Redis-cached (TTL 60 s); covering partial indexes for live hourly queries | Decrease MV refresh interval (`DASHBOARD_MV_REFRESH_INTERVAL_MS`); add `pg_cron` for finer scheduling |

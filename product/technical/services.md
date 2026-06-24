# Service Reference

**Tahakom Data Transfer System**  
Last updated: 2026-06-24 (ISS_MEDIA indexer: replaced chokidar with 3-tier polling loop; manual USB transfer: full video+image concurrent pipeline, USB folder structure transfer/{job_id}/videos|images, in-place UI progress, recovery phase)

> Summary view. For data-flow diagrams, see [architecture.md](architecture.md).  
> For full table definitions, see [database/schema.md](database/schema.md).

---

## SecurOS Scripts

Executed by the **ISS SecurOS Script Integration Engine**. They share the same SecurOS-bundled Node.js runtime and cannot be run standalone. Changes are made in `securos-scripts/` and manually copied to the SecurOS machine.

### OptimizedImageCapture.js

| Attribute | Value |
|---|---|
| Trigger | `LPR_CAM` object → `CAR_LP_RECOGNIZED` event |
| File | `securos-scripts/OptimizedImageCapture.js` |
| Config reads | `dataTransferConfig.json`: `storage.directory`, `storage.siteId` |
| DB writes | INSERT `files` (plate, camera, path, export_params; `file_size=0`) |
| Key logic | Builds target path `BASE_PATH/SITE_ID/DATE/TIME`; dispatches `IMAGE_EXPORT` to the least-busy non-`OVER` exporter. **When all exporters are `OVER`, falls back to the globally least-loaded one** so capture never stops under burst load. `NaN` queue sizes (missing event params) are treated as 0. Initial exporter map load is `await`ed to avoid a startup race. |
| Error handling | Each `processCameraCapture` call is wrapped in a top-level `try/catch` so no single capture failure can throw to the SecurOS runtime and crash the script process. Logs DB insert failures and null-exporter warnings; does not retry capture (relies on Export Fixer). |

### ImageExportSuccessOptimized.js

| Attribute | Value |
|---|---|
| Trigger | `IMAGE_EXPORT` object → `EXPORT_DONE` event |
| File | `securos-scripts/ImageExportSuccessOptimized.js` |
| DB writes | UPDATE `files` SET `file_size` (reads actual size from disk), `image_export_done_date_time=NOW()` |
| Key logic | Batched updates keyed on `tid` to reduce DB round-trips |

### Image Export Errors.js

| Attribute | Value |
|---|---|
| Trigger | `IMAGE_EXPORT` object → `EXPORT_FAILED` event |
| File | `securos-scripts/Image Export Errors.js` |
| DB writes | UPDATE `files`: increments `export_retry_count`, appends to `export_retry_log_object` (JSONB); on max retries or "Image obtain error" sets `deleted=true` |
| Key logic | SELECT uses `WHERE tid = $1 AND file_size = 0 AND export_retry_count < 4` — ensures exactly one row is returned for the specific failed export (unexported, still within retry budget). If `rowCount === 1`: retries by calling `core.doReact(IMAGE_EXPORT, EXPORT)` up to 4 times; distinguishes "Image obtain error" (instant soft-delete) from transient failures (retry). On max retries sets `deleted=true`. Entire handler body is wrapped in a top-level `try/catch` — any DB error (including PostgreSQL 40P01 deadlock) is caught and logged, never propagates as an unhandled rejection. |
| Error handling | Outer `try/catch` on the event handler body prevents unhandled Promise rejections and fatal process exits. No `sleep` delay — concurrent handlers on different `tid` values operate on independent rows. |

### Export Fixer Microservice.js

| Attribute | Value |
|---|---|
| Trigger | Internal timer (periodic DB poll) |
| File | `securos-scripts/Export Fixer Microservice.js` |
| DB reads | SELECT `files` WHERE `file_size=0` AND `image_export_done_date_time IS NULL` AND `deleted=false` AND `export_retry_count < 1` AND within today's time window |
| DB writes | UPDATE `export_retry_count`, `export_retry_log_object` |
| Key logic | Safety net for exports that never fired EXPORT_DONE or EXPORT_FAILED; re-dispatches IMAGE_EXPORT. `NaN` queue sizes are treated as 0 in the load balancer. **Null guard** before `queue_size += 1` — empty map skips with a warning. **`await pool.query`** on the retry-count UPDATE — previously unawaited, causing concurrent UPDATEs that deadlocked PostgreSQL (40P01) and crashed the process via unhandled Promise rejection. |

### ExportDirectoryControlV3.js

| Attribute | Value |
|---|---|
| Trigger | Continuous loop |
| File | `securos-scripts/ExportDirectoryControlV3.js` |
| Config reads | `retentionDays`, `maxCapacity`, `preserveRootDirs`, `storage.directory` from `dataTransferConfig.json` |
| DB writes | UPDATE `files`: `pending_deletion`, `deleted`, `deleted_date_time`; also alters schema at startup (adds `pending_deletion`, `updated_at` columns + triggers if missing) |
| Key logic | Two passes: (1) age-based retention — deletes files older than `retentionDays`, (2) FIFO capacity — removes oldest files when total `file_size` exceeds `maxCapacity`; never deletes directories listed in `preserveRootDirs` |

### ClusterStatusMonitorScript.js

| Attribute | Value |
|---|---|
| Trigger | Internal timer — runs every 10 minutes |
| File | `securos-scripts/ClusterStatusMonitorScript.js` |
| DB reads | None |
| Key logic | Uses SecurOS-bundled PM2 binary to list online processes; compares against expected count from `ecosystem.config.js`; runs `pm2 start ecosystem.config.js --env production` if any process is offline |

---

## PM2 Services

All PM2 services use the SecurOS-bundled Node.js interpreter (`C:\Program Files (x86)\ISS\SecurOS\bin64\node.js\bin\node.exe`) and are started with `--require startup.js`. Max 5 restarts, 100ms min uptime, 3s restart delay.

### ConfigStateServiceRedis.js

| Attribute | Value |
|---|---|
| PM2 name | `ConfigStateServiceRedis` |
| Dependencies | None |
| Redis keys | `CONFIG_STATE_KEY` |
| Redis channels | `CONFIG_STATE_KEY_update` (publish on change) |
| Logging | `utils/logger.js` `createLogger({ service: 'ConfigStateServiceRedis' })` |
| Purpose | Reads `dataTransferConfig.json` from disk, writes to Redis, publishes change notifications. Acts as the single source of config truth for all other services. |

### monitorConnectedExternalDrivesMicroservice.js

| Attribute | Value |
|---|---|
| PM2 name | `monitorConnectedExternalDrivesMicroservice` |
| Dependencies | None |
| Redis keys | `CONNECTED_DRIVE_STATE`, `CONNECTED_DRIVE_LIST` |
| Redis channels | `CONNECTED_DRIVE_LIST_UPDATE`, `CONNECTED_DRIVE_STATE_update` |
| DB writes | `device_connections` (INSERT on connect, UPDATE space on each reconcile, UPDATE status/disconnected_at on disconnect, UPDATE uptime every 60s) |
| Logging | `utils/logger.js` `createLogger({ service: 'monitorConnectedExternalDrives' })` |
| Detection mode | **Event-driven** (primary): `usb@3.0.0` WebUSB `connect`/`disconnect` events via `addEventListener`. USB hotplug fires immediately on plug/unplug; 3 staggered reconciles at 400 ms / 1200 ms / 3000 ms handle Windows drive-letter assignment delay. **Safety-net** (secondary): 15-second `setInterval` catches non-USB removable media, missed events, and refreshes drive space/uptime. **Polling fallback** (tertiary): if the `usb` native module fails to load, the original 1-second `systeminformation` poll loop runs unchanged, so the service is never worse than before. |
| Key lib | `usb@3.0.0` (NAPI-rs prebuilt, `@node-usb/usb-win32-x64-msvc`); `systeminformation@^5.22.11` |
| Config reactivity | Subscribes to `CONFIG_STATE_KEY_update`; on config change immediately triggers a reconcile to refresh the auto-transfer specific-drive state. |
| See ADR | ADR-0007 — Event-driven USB detection |

### monitorSpecialProcessesMicroservice.js

| Attribute | Value |
|---|---|
| PM2 name | `monitorSpecialProcessesMicroservice` |
| Dependencies | None |
| Redis channels | `PROCESS_MONITOR_UPDATE` (publish) |
| Logging | `utils/logger.js` `createLogger({ service: 'monitorSpecialProcesses' })` |
| Purpose | Monitors PM2 process health; publishes state for the dashboard process monitor page |

### monitorISSMediaFilesOptimizedMicroservice.js

| Attribute | Value |
|---|---|
| PM2 name | `monitorISSMediaFilesOptimizedMicroservice` |
| Dependencies | ConfigStateServiceRedis, monitorConnectedExternalDrivesMicroservice |
| DB writes | `iss_media_files` — INSERT new files; slow-tier diff marks `deleted=true` for records whose path is no longer on disk |
| Key lib | **Tiered polling loop** (chokidar removed 2026-06-24) — `Map<folderPath, Set<fileName>>` in-memory cache; diff per folder on each tick |
| Logging | `utils/logger.js` `createLogger({ service: 'monitorISSMediaFilesOptimized' })`; per-camera scans wrapped in `runWithTrace({ traceId, camera })`; tier ticks logged under `[FAST]`, `[NORMAL]`, `[SLOW]` prefixes |
| Purpose | Indexes ISS NVR media directories into `iss_media_files` so video transfer services can discover `.issvd` segments |
| Polling tiers | **Fast** (every 1 min): scans only the current hour's folder per camera — catches new files near-real-time. **Normal** (every 5 min): scans all of today's hourly folders — catches files written to earlier hours. **Slow** (every 30 min): scans previous days — reconciles deletions (SecuROS per-file purge) by diffing DB vs. disk and batch-marking `deleted=true` for missing paths. |
| In-memory cache | `Map<folderPath, Set<fileName>>` — last known file set per folder. Each tier diffs current disk listing against the cache: new files → INSERT; removed files (slow tier only) → `deleted=true`. O(n) per folder where n = files in that folder. |
| Windows reliability | Replaces chokidar which had blind spots for new hourly folder creation and missed SecuROS individual-file purges on Windows. Polling is deterministic and folder-scoped. |

### refactored_autoVideoTransferEDAMicroservice.js

| Attribute | Value |
|---|---|
| PM2 name | `autoVideoTransferEDAMicroservice` |
| Dependencies | ConfigStateServiceRedis, monitorISSMediaFilesOptimizedMicroservice |
| DB reads | `iss_media_files` |
| DB writes | `video_transfer_queue_job`, `video_transfer_queue`, `video_converted_buffer`; UPDATE `iss_media_files.is_auto_transferred` |
| Key services | `services/video-transfer/state/JobManager.js`, `transfer/FileTransferManager.js`, `processors/CompleteBufferManager.js` |
| Logging | `utils/logger.js` `createLogger({ service: 'autoVideoTransferEDAMicroservice' })`; each job cycle and file transfer wrapped in `runWithTrace({ traceId, jobId, camera })` so all logs for a batch share one `traceId` |
| Purpose | Transfers ISS video MP4 segments to a configured USB drive in batches; manages per-camera buffering to ensure complete segment groups before transfer |

### autoFtpVideoTransferService.js

| Attribute | Value |
|---|---|
| PM2 name | `autoFtpVideoTransferService` |
| Dependencies | ConfigStateServiceRedis, monitorISSMediaFilesOptimizedMicroservice |
| DB reads | `iss_media_files` |
| DB writes | `ftp_video_transfer_queue_job`, `ftp_video_transfer_queue`, `ftp_video_converted_buffer`; UPDATE `iss_media_files.is_ftp_transferred` |
| Key services | `services/video-transfer/state/FtpJobManager.js`, `transfer/FtpTransferManager.js` |
| Logging | `utils/logger.js` `createLogger({ service: 'autoFtpVideoTransferService' })`; job cycles wrapped in `runWithTrace({ traceId, jobId, camera })` |
| Purpose | Uploads ISS video segments to a configured FTP/FTPS server |

### autoUSBImageTransferService.js

| Attribute | Value |
|---|---|
| PM2 name | `autoUSBImageTransferService` |
| Dependencies | ConfigStateServiceRedis, monitorConnectedExternalDrivesMicroservice |
| DB reads | `files` |
| DB writes | `transfer_queue_job`, `transfer_queue`; UPDATE `files.is_auto_transferred` |
| Key services | `services/image-transfer/state/ImageJobManager.js`, `transfer/ImageTransferManager.js` |
| Logging | `utils/logger.js` `createLogger({ service: 'autoUSBImageTransferService' })`; per-batch cycle wrapped in `runWithTrace({ traceId, jobId })` |
| Purpose | Transfers ALPR plate images to a connected USB drive; picks up files where `file_size > 0` and `is_auto_transferred = false` |

### autoFTPImageTransferService.js

| Attribute | Value |
|---|---|
| PM2 name | `autoFTPImageTransferService` |
| Dependencies | ConfigStateServiceRedis, monitorConnectedExternalDrivesMicroservice |
| DB reads | `files` |
| DB writes | `ftp_image_transfer_queue_job`, `ftp_image_transfer_queue`; UPDATE `files.is_ftp_transferred` |
| Key services | `services/image-transfer/state/FtpImageJobManager.js`, `transfer/FtpImageTransferManager.js` |
| Logging | `utils/logger.js` `createLogger({ service: 'autoFTPImageTransferService' })`; per-batch cycle wrapped in `runWithTrace({ traceId, jobId })` |
| Purpose | Uploads ALPR plate images to a configured FTP/FTPS server |

### DashboardReportingBackend.js

| Attribute | Value |
|---|---|
| PM2 name | `DashboardReportingBackend` |
| Port | `8454` |
| Dependencies | monitorConnectedExternalDrivesMicroservice, Redis |
| DB reads | All tables (via route handlers); dashboard chart queries use `mv_files_daily/monthly/yearly[_agg]` materialized views; hourly view queries `files` directly via covering indexes |
| Redis keys (write) | `dashboard:data:<hash>` — chart aggregate cache (TTL 60 s); busted on `POST /dashboard/refresh` |
| Template engine | Nunjucks (views in `data_transfer_v2/views/`) |
| WebSocket | `ws://localhost:8454` — events: handleAutoTransfer, devices, deviceHistory, handleAutoVideoTransfer, processes, startStorageTransfer, manualTransferConfig |
| Key endpoints | `GET /dashboard/data` (chart aggregates, Redis-cached), `GET /dashboard/table` (paginated detail rows, uncached), `POST /dashboard/refresh` (cache bust + concurrent MV refresh) |
| Background task | Refreshes all 6 dashboard MVs concurrently on startup and on a timer (`DASHBOARD_MV_REFRESH_INTERVAL_MS`, default 5 min); also runs `startManualFileTransferProcess` (5 s poll loop for manual transfer job management) |
| Logging | `utils/logger.js` `createLogger({ service: 'DashboardReportingBackend' })`; `traceMiddleware` registered before routes — every HTTP request carries a `traceId` in `X-Trace-Id` header and all related log lines |
| Purpose | Main web UI — Express server serving the operator dashboard; provides REST API + WebSocket for real-time monitoring, config management, and manual transfer control |

#### Manual Transfer sub-system (inline, hosted inside DashboardReportingBackend)

| Attribute | Value |
|---|---|
| Route module | `routes/manualTransferRoutes.js` |
| UI view | `data_transfer_v2/views/manual_usb.njk` |
| Source tables | `files` (ALPR images, dataType=images/both); `iss_media_files` (ISS video segments, dataType=videos/both) |
| Queue table | `file_transfer_queue` (via `utils/FileTransferQueueService.js`) — **active consumer** in `startManualFileTransferProcess` |
| Video queue table | `manual_video_group_queue` — one row per camera/group of `.issvd` segments; tracks conversion status (`pending` → `converting` → `converted` → `transferred`) |
| Job tables | `transfer_job`, `transfer_job_log` — `transfer_job_log` is the **authoritative source** for image completion; `manual_video_group_queue` is authoritative for video completion |
| Copy mechanism | Inline consumer loop: 10 files per tick, 1 s sleep, pause/cancel checked per file; `fs.copy` to USB |
| Video conversion | `VideoProcessor` (FFmpeg) converts per-camera groups of `.issvd` → `.mp4`; runs as a **non-blocking background promise** (`activeConversionPromise`) so images copy concurrently during conversion |
| USB folder structure | `transfer/{job_id}/images/` and `transfer/{job_id}/videos/` |
| Temp directory | `ISS_MEDIA_MANUAL_BUFFER_DIR` env var (default: `temp_video_manual_transfer/`) — isolated from auto-transfer temp dir |
| Recovery phase | Runs **once per job** on server start (guarded by `lastRecoveryJobId`): (1) resets `converting` groups stuck mid-crash to `pending`; (2) re-queues `converted` groups whose `file_transfer_queue` entry was lost |
| Progress tracking | `refreshImageCounters()` and `refreshVideoGroupCounters()` query DB before every WebSocket emit; `sendFileTransferStatus()` emits on a 3 s timer; copy phase emits immediately after each batch |
| Completion check | Fires only when `!activeConversionPromise`; checks `manual_video_group_queue` (videos) AND `transfer_job_log` (images) — both must be complete |
| Config state | `dataTransferConfig.json` key `manualTransfer` (not Redis) |
| UI update strategy | In-place DOM updates for active job cards (no full container rebuild on each WebSocket message — eliminates progress flicker) |
| Known issues | All MI-A through MI-P and MV-A through MV-C resolved as of 2026-06-24 |

---

## Shared Service Modules

### services/shared/TransferUtils.js
DB helper functions used across all transfer services: query eligible files, mark files as transferred, build WHERE clauses.

### services/shared/CleanupService.js
Post-transfer cleanup: remove completed queue rows, delete temporary files, update job status.

### utils/configUtils.js
`readConfig(path)` / `writeConfig(path, data)` — synchronous JSON config file helpers.

### utils/encryptionService.js
AES-256-CBC file encryption/decryption + RSA key management functions:
`generateAESKey`, `encryptFileAES`, `decryptFileAES`, `encryptWithRSAPublicKey`, `decryptWithRSAPrivateKey`.

### utils/envConfig.js
Environment variable defaults — DB name defaults to `tahakom_transfer`, pg connection params.

| Key env vars | Purpose |
|---|---|
| `ISS_MEDIA_MANUAL_BUFFER_DIR` | Temp directory for manual USB video conversion output (default: `temp_video_manual_transfer/`). Isolated from the auto-transfer temp dir so auto-transfer cleanup cannot delete in-flight manual conversions. |
| `ISS_MEDIA_CAMERAS` | Comma-separated camera IDs monitored by `monitorISSMediaFilesOptimizedMicroservice` |
| `ISS_MEDIA_RETENTION` | Retention days for `ExportDirectoryControlV3` |

### utils/logger.js
Shared Winston logger factory + AsyncLocalStorage trace helpers. Every service uses `createLogger({ service })` for per-service daily-rotated log files. Trace IDs propagate automatically through async call chains via `runWithTrace` / `AsyncLocalStorage`. See `product/technical/architecture.md` → Logging Architecture for the full API reference.

### redisKeyStore.js
Central registry of all Redis key names used across the application.

---

## Maintenance Scripts

Located in `scripts/maintenance/`. Run manually, not via PM2.

| Script | Purpose |
|---|---|
| `DatabaseMigration.js` | Creates/migrates all tables in `tahakom_transfer` |
| `generateRSAKeys.js` | Generates RSA key pair into `certs/` |
| `decryptUSBFiles.js` | Decrypts AES-encrypted files from USB using the private key |
| `setup-env.js` | Initial environment setup |
| `cleanup_corrupted_system.js` | Repairs corrupted state (queue stuck jobs, etc.) |
| `transferQueueMonitor.js` | Ad-hoc queue health diagnostic |
| `check_media_files.js` | Checks ISS media file index consistency |
| `issivs_files_mp4_parallel_remove.js` | Bulk remove legacy MP4 files |

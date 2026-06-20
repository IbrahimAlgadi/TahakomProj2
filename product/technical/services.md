# Service Reference

**Tahakom Data Transfer System**  
Last updated: 2026-06-20 (event-driven USB detection — monitorConnectedExternalDrivesMicroservice refactored to usb@3 WebUSB hotplug + safety-net + polling fallback; ADR-0007 added)

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
| Key logic | Builds target path `BASE_PATH/SITE_ID/DATE/TIME`; dispatches `IMAGE_EXPORT` to the least-busy exporter via load-balanced queue depth check |
| Error handling | Logs DB insert failures; does not retry capture (relies on Export Fixer) |

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
| Key logic | Re-issues `IMAGE_EXPORT` via `core.doReact` for retry; distinguishes recoverable vs unrecoverable failures |

### Export Fixer Microservice.js

| Attribute | Value |
|---|---|
| Trigger | Internal timer (periodic DB poll) |
| File | `securos-scripts/Export Fixer Microservice.js` |
| DB reads | SELECT `files` WHERE `file_size=0` AND `image_export_done_date_time IS NULL` AND `deleted=false` AND `export_retry_count < 1` AND within today's time window |
| DB writes | UPDATE `export_retry_count`, `export_retry_log_object` |
| Key logic | Safety net for exports that never fired EXPORT_DONE or EXPORT_FAILED; re-dispatches IMAGE_EXPORT |

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
| DB writes | `iss_media_files` (INSERT new files, UPDATE sizes, soft-delete removed files) |
| Key lib | chokidar (file watcher) |
| Logging | `utils/logger.js` `createLogger({ service: 'monitorISSMediaFilesOptimized' })`; per-camera historical scans wrapped in `runWithTrace({ traceId, camera })` |
| Purpose | Watches ISS NVR media directories; indexes MP4 segments into `iss_media_files` table so video transfer services can discover them |

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
| WebSocket | `ws://localhost:8454` — events: handleAutoTransfer, devices, deviceHistory, handleAutoVideoTransfer, processes, startStorageTransfer |
| Key endpoints | `GET /dashboard/data` (chart aggregates, Redis-cached), `GET /dashboard/table` (paginated detail rows, uncached), `POST /dashboard/refresh` (cache bust + concurrent MV refresh) |
| Background task | Refreshes all 6 dashboard MVs concurrently on startup and on a timer (`DASHBOARD_MV_REFRESH_INTERVAL_MS`, default 5 min) |
| Logging | `utils/logger.js` `createLogger({ service: 'DashboardReportingBackend' })`; `traceMiddleware` registered before routes — every HTTP request carries a `traceId` in `X-Trace-Id` header and all related log lines |
| Purpose | Main web UI — Express server serving the operator dashboard; provides REST API + WebSocket for real-time monitoring, config management, and manual transfer control |

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

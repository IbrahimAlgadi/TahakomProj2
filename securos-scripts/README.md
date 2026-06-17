# SecurOS Scripts

These scripts run **inside the ISS SecurOS Script Integration Engine**. They are not standalone Node services; they are loaded and executed by SecurOS through its embedded scripting runtime, so they have direct access to the SecurOS object model and event bus via the bundled `securos` module (`securos.connect(core => { ... })`) and the SecurOS Node.js runtime shipped at `C:\Program Files (x86)\ISS\SecurOS\bin64\node.js\`.

## Purpose

The goal of these scripts is to drive the SecurOS platform to **capture license‑plate images and persist them for later transfer**:

1. **SecurOS ALPR (LPR)** detects a vehicle / reads a plate and raises an event.
2. The capture script reacts by taking snapshots from the configured cameras and asks the **SecurOS Image Exporters** to write the images to a specific directory on disk.
3. Every captured image is recorded as a row in the PostgreSQL database (`tahakom_transfer`, `files` table), along with its path, plate, camera, site, timestamps and export parameters.
4. Supporting scripts keep the exports healthy (success/error handling, retries, file‑size calculation) and keep the directory within its storage budget (retention + capacity cleanup).

The **data written to the database is the source of truth for the rest of the project**. The other application services (e.g. `autoFTPImageTransferService.js`, `autoUSBImageTransferService.js`, and the video/EDA transfer services) read the `files` table to know which images exist and then **copy / move them from one place to another** (USB drives, FTP, etc.). In other words: these SecurOS scripts *produce* the images and their database records; the rest of the app *consumes* those records to distribute the files.

## Architecture at a glance

```
SecurOS ALPR (LPR_CAM)
        │  CAR_LP_RECOGNIZED
        ▼
OptimizedImageCapture.js ──► SecurOS IMAGE_EXPORT (load balanced) ──► images on disk (BASE_PATH/SITE_ID/date/time)
        │                                   │
        │ INSERT file row                   │ EXPORT_DONE / EXPORT_FAILED
        ▼                                   ▼
   PostgreSQL  ◄──── ImageExportSuccessOptimized.js / "Image Export Errors.js" / "Export Fixer Microservice.js"
 (tahakom_transfer.files)
        │
        ▼
Rest of the project (autoFTP/USB image transfer services, etc.) → copy / move files elsewhere
```

## Scripts

| Script | Trigger | Responsibility |
| --- | --- | --- |
| `OptimizedImageCapture.js` | `LPR_CAM` → `CAR_LP_RECOGNIZED` | Core capture script. For each recognized plate it builds the target directory (`BASE_PATH/SITE_ID/<date>/<time>` from `dataTransferConfig.json`), snapshots the cameras mapped to each LPR in `LPR_CAM`, dispatches `IMAGE_EXPORT` → `EXPORT` reactions load‑balanced across the least‑busy exporter, and inserts the file record into `files`. |
| `ImageExportSuccessOptimized.js` | `IMAGE_EXPORT` → `EXPORT_DONE` | On successful export, batches database updates to stamp the real `file_size` (read from disk) and `image_export_done_date_time` on the matching `files` rows. |
| `Image Export Errors.js` | `IMAGE_EXPORT` → `EXPORT_FAILED` | Handles failed exports: re‑issues the export via `core.doReact`, records each attempt in `export_retry_log_object`, drops images on unrecoverable "Image obtain error", and marks rows deleted once the max retry count is reached. |
| `Export Fixer Microservice.js` | Periodic DB scan | Safety net for exports that never completed. Periodically selects `files` rows still at `file_size = 0` within a time window and re‑triggers their export on the least‑loaded image exporter. |
| `ExportDirectoryControlV3.js` | Continuous loop | Storage governor. Enforces retention (`retentionDays`) and capacity (FIFO above `maxCapacity`) by deleting old images, removing now‑empty directories (while preserving configured roots), and keeping the DB (`deleted`, `pending_deletion`) consistent. Also initializes required schema/indexes. |
| `ClusterStatusMonitorScript.js` | Every 10 minutes | Health monitor for the rest of the application. Checks that the expected number of PM2 processes (the transfer services) are online using the SecurOS‑bundled PM2/Node, and restarts the `ecosystem.config.js` apps if any are missing. |

## Configuration

- **Database** – all scripts connect to PostgreSQL (`postgres@localhost:5432`, database `tahakom_transfer`).
- **Runtime config** – capture and cleanup scripts read `C:\Proj\app\data_transfer_v2\dataTransferConfig.json` for `storage.siteId`, `storage.directory` (base image path), `storage.maxCapacity`, `storage.retentionDays`, `storage.preserveRootDirs`, and `processing.*` batch settings.
- **Cameras / exporters** – the LPR‑to‑camera mapping and per‑camera format/quality live in the `LPR_CAM` object inside `OptimizedImageCapture.js`; image exporters are discovered dynamically via `core.getObjectsIds('IMAGE_EXPORT')` and load‑balanced by queue size.

## Running

These files are registered as **SecurOS scripts** and started/stopped by the SecurOS Script Integration Engine. They rely on the `securos` module being injected by the host runtime, so they cannot be executed with a plain `node script.js` outside of SecurOS.

Remember to commit 🎯

```bash
git add securos-scripts/README.md && git commit -m "Docs(securos-scripts): document SecurOS script integration engine scripts"
```

# Manual Image USB Pipeline — Context

## 2026-06-23 — Full pipeline investigation + doc written

### What was produced

- `product/technical/diagrams/manualUSBImageTransferService-activity.md` — comprehensive activity & behaviour map (13 sections, 2 Mermaid flowcharts, state machines, error table, 8 open issues MI-A through MI-H).
- `context/manual-image-usb-pipeline.md` — this file.
- `PROJECT_MAP.md` [ORPHANS & PENDING] — MI-A, MI-B entries added as critical blockers.

### Key findings (non-obvious, took code tracing to establish)

#### Two parallel flows, only one works

`/manual_usb` (current UI) and `/transfer` (legacy UI) share the same `transfer_job` and `transfer_job_log` tables but use completely different copy mechanisms:

- **Current flow** (`manualTransferRoutes.js`): creates a job, writes to config, then the background loop calls `FileTransferQueueService.addFilesToQueue()` → inserts into `file_transfer_queue`. No worker ever calls `getNextFilesToTransfer()`. Files are permanently queued but never copied.
- **Legacy flow** (`mainControlRoutes.js` + `startStorageTransfer()`): operator triggers WebSocket `startStorageTransfer`; backend does `fs.copy` file-by-file and updates `transfer_job_log.transferred=true`. This is the **only path that actually copies files**.

#### Queue without a consumer

`FileTransferQueueService` was designed to be a general-purpose queue (priorities 1/2/3 for auto/video/manual). The consumer (`FileTransferRedisService.js`) was archived and its PM2 entry commented out. What remains is a well-designed queue with no dequeue side. Every manual transfer created via `/manual_usb` is effectively a no-op at the file-copy level.

#### Why `getDriveInfo` crashes the loop

`manualTransferRoutes.js` calls `getDriveInfo(drive)` inside `sendFileTransferStatus()` — which runs every 5 seconds. The function is defined in `utils/driveUtils.js` but is not imported in `manualTransferRoutes.js`. This throws `ReferenceError: getDriveInfo is not defined` on every tick when a `config.manualTransfer` entry exists. The outer `catch` block restarts the loop, which immediately hits the same error again. Any active or previously cancelled job entry in `dataTransferConfig.json` keeps this crash-restart cycle running indefinitely.

#### Config-state coupling

Unlike the auto transfer pipeline (which reads from Redis), manual transfer state lives entirely in `dataTransferConfig.json` under `config.manualTransfer`. The background loop reads this file on every iteration. This means:
- There is no pub/sub — control actions (pause/resume/cancel) take effect on the next 5s poll tick.
- A stale `config.manualTransfer` entry (e.g. from a prior `isCancelled: true` job) keeps driving the loop and triggering `getDriveInfo` crashes.
- No Redis key is used; monitoring via Redis is not possible.

#### Completion false-positive

`getServiceTransferStatus('manual', jobId)` returns `isCompleted: true` when `file_transfer_queue` has zero rows for the job. This happens immediately after the queue-fill step if no rows were added (e.g. all `transfer_job_log` rows were already marked `transferred=true` from a prior legacy run). The job is then marked `completed` without having transferred anything in the current session.

---

### Open code issues

Full detail in `product/technical/diagrams/manualUSBImageTransferService-activity.md` §11.

| ID | Location | Status | Issue |
|---|---|---|---|
| MI-A | `utils/FileTransferQueueService.js`, `routes/manualTransferRoutes.js` | **Open** | No queue consumer — `getNextFilesToTransfer()` never called; files queued but never copied |
| MI-B | `routes/manualTransferRoutes.js:201` | **Open** | `getDriveInfo` called without import → `ReferenceError` crashes loop every 5s while a job is in config |
| MI-C | `data_transfer_v2/views/manual_usb.njk` | **Open** | UI calls `/manual-transfer/pause`, `/resume`, `/cancel`; only `/control` exists — 404s silently |
| MI-D | `utils/FileTransferQueueService.js` | **Open** | `markFilesAsTransferred()` does not update `transfer_job_log` — history/progress stays at 0 in queue path |
| MI-E | `routes/manualTransferRoutes.js:270-276` | **Open** | Completion false-positive — empty queue at check time → job marked `completed` with 0 files transferred |
| MI-F | `routes/manualTransferRoutes.js:16` | **Open** | `encryption` field sent by UI but never destructured or applied |
| MI-G | `data_transfer_v2/dataTransferConfig.json` | **Open** | Stale `isCancelled: true` job with 1 680 files emitted to all UI clients on connect |
| MI-H | `data_transfer_v2/features/transfer_feature.md` | **Open** | Feature doc describes car-plate filter and WebSocket progress events; current `/manual_usb` has neither |

---

### Relevant file map (traced during investigation)

| File | Role |
|---|---|
| `routes/manualTransferRoutes.js` | Current: job creation, pause/resume/cancel control, 5s background loop, queue fill |
| `routes/mainControlRoutes.js` | Legacy: `/transfer` page routes, `startStorageTransfer()` WebSocket handler, actual `fs.copy` |
| `utils/FileTransferQueueService.js` | Queue insert (`addFilesToQueue`), status check (`getServiceTransferStatus`), cancel — no consumer |
| `DashboardReportingBackend.js` | Mounts `createManualTransferRouter`, starts `startManualFileTransferProcess` |
| `data_transfer_v2/views/manual_usb.njk` | Current operator UI — date picker, drive select, dataType radio, job controls |
| `data_transfer_v2/views/transfer.njk` | Legacy operator UI — date picker, car-plate field, WebSocket-based copy trigger |
| `data_transfer_v2/public/transfer.js` | Legacy frontend — WebSocket client for `startStorageTransfer` / `startStorageTransferDone` |
| `archived/FileTransferRedisService.js` | Archived queue consumer — was the intended worker for `file_transfer_queue` |
| `ecosystem.config.js` | PM2 config — `FileTransferRedisService` entry commented out |
| `product/technical/database/schema.md` | `transfer_job`, `transfer_job_log`, `file_transfer_queue` table definitions |

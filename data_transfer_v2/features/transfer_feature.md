# Manual Transfer Page (USB/SSD)

This document describes the features of the two manual-transfer flows that exist in the codebase.
They share a UI theme but differ significantly in implementation.

---

## Active path vs legacy path — quick reference

| Feature | Current path (`/manual_usb`) | Legacy path (`/transfer`) |
|---|---|---|
| Route file | `routes/manualTransferRoutes.js` | `routes/mainControlRoutes.js` |
| View | `data_transfer_v2/views/manual_usb.njk` | `data_transfer_v2/views/transfer.njk` |
| Date-range filter | Yes | Yes |
| Car-plate filter | **No** *(legacy only)* | Yes |
| File copy method | Queue consumer via `fs.copy` | Direct `fs.copy` in WebSocket handler |
| Progress events | `manualTransferConfig` Socket.IO event | `startStorageTransferProgress` / `startStorageTransferDone` *(legacy only)* |
| Progress table | Custom HTML progress display | Tabulator table *(legacy only)* |
| Job record | `transfer_job` + `transfer_job_log` | `transfer_job` + `transfer_job_log` |
| Pause / Resume / Cancel | Yes — `POST /manual-transfer/control` | Not implemented |
| Batch copy mechanism | Queue-based (50 files per loop tick) | Direct loop in WebSocket handler *(legacy only)* |

---

## 1. Current path — `/manual_usb`

Implemented in `routes/manualTransferRoutes.js` and `DashboardReportingBackend.js`.

### 1.1 Create Transfer Job (`POST /manual-transfer/create`)

The form allows the user to define the data to be transferred and the destination.

**Fields sent:**
- `startDateTime` / `endDateTime` — ISO datetime strings for the file date-range
- `usbPath` — full path to the destination USB drive (e.g. `G:\`)
- `dataType` — radio value (`images` / `videos` / `both`); currently ignored by the backend
- `encryption.enabled` — boolean; stored in config but not yet applied during copy

**What the route does:**
1. Queries the `files` table filtered by the date range.
2. Inserts a `transfer_job` row (`status = 'in_progress'`).
3. Inserts one `transfer_job_log` row per file (`transferred = false`).
4. Writes job metadata to `data_transfer_v2/dataTransferConfig.json`.
5. Returns `{ jobId, summary: { total_files, total_size } }`.

### 1.2 Transfer loop (`startManualFileTransferProcess`)

A long-running background loop (5-second poll) that:
1. Broadcasts current drive state and queue progress via the `manualTransferConfig` Socket.IO event.
2. Skips if job is finished, cancelled, or paused.
3. Queues un-transferred files into `file_transfer_queue` when the queue is empty.
4. Runs an inline consumer — fetches up to 50 pending rows, marks them `processing`, copies each file via `fs.copy`, then marks each `transferred` and updates `transfer_job_log.transferred = true`.
5. Marks the `transfer_job` `completed` in the DB when all queue rows are transferred or failed.

### 1.3 Job control (`POST /manual-transfer/control`)

Accepts `{ jobId, action }` where `action` is `pause`, `resume`, or `cancel`.

On `cancel`: cancels all pending queue rows, updates the DB, then clears `config.manualTransfer` to `null` so the loop stops emitting stale events.

### 1.4 History (`GET /manual-transfer/history`)

Returns paginated `transfer_job` rows with transferred/total file counts from `transfer_job_log`.

---

## 2. Legacy path — `/transfer`

Implemented in `routes/mainControlRoutes.js` and `data_transfer_v2/views/transfer.njk`.

> **Note:** This path is still functional. It copies files directly in a WebSocket handler rather than using the queue service.

### Features (legacy-only)

- **Car-plate filter** — the create form accepts a plate number; files are filtered from the `files` table by `plate_num`.
- **`startStorageTransferProgress` WebSocket event** — emitted per file as it is copied; the front end uses it to drive a Tabulator table showing live per-file progress.
- **`startStorageTransferDone` WebSocket event** — emitted when the batch is complete.
- **Batch copy mechanism** — a `for` loop inside the WebSocket handler calls `fs.copy` for each file sequentially; progress is emitted per file.

---

## How to use (current path)

1. Open **Transfer to USB/SSD** (`/manual_usb`).
2. Select the date range for the files to transfer.
3. Choose the destination USB drive from the dropdown.
4. Click **Create Transfer Job**. The job appears in the active-job card.
5. Monitor progress via the progress bar and file count. Pause, resume, or cancel with the control buttons.
6. When complete the job moves to the **History** tab.

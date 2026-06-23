# Video USB Pipeline — Context

## 2026-06-22 — Full pipeline investigation + doc written

### What was produced
- `product/technical/diagrams/refactored_autoVideoTransferEDAMicroservice-activity.md` — comprehensive activity & behaviour map (16 sections, 4 mermaid diagrams, 5-phase pipeline table, state machines for 3 tables, error tables, and V-A through V-F observations).

---

### Key findings (non-obvious, took code tracing to establish)

#### Architecture pattern: EventEmitter + setTimeout (not while loop)
The video service (`refactored_autoVideoTransferEDAMicroservice.js`) is structured as an `EventEmitter` class, not a `while(true)` loop like the image service. Three loops are started on the `'start'` event via `setTimeout` re-queuing:
- `_runProcessingLoop` (5 s) — **active**
- `_runCleanupLoop` (5 min) — **active** (guards removed 2026-06-22; CleanupService now job-aware — see V-A)
- `_runBufferMonitoringLoop` (30 s) — **active** (guards removed 2026-06-22; checkReadyGroupsInBuffer fixed — see V-A)

Transfer to USB is triggered via `emit('startTransferToStorage')`, not inside the processing loop.

#### 5-phase pipeline per camera per job
Every job requires collecting enough raw segments from `iss_media_files` for each configured camera (`ISS_MEDIA_CAMERAS`), converting them individually from `.issvd` to `.mp4` via ffmpeg, grouping them in `video_converted_buffer`, concatenating into a single final `.mp4`, then copying it to the USB drive. The phases:

1. **Fetch** — `requestAdditionalFilesForCamera` selects from `iss_media_files` (last 7 days, oldest first)
2. **Convert** — `bufferManager.convertSingleFile` → ffmpeg → temp `.mp4` in `temp_video_processing/temp_cam_N/`
3. **Group** — `processingStateManager.groupFilesByCamera` → transaction UPDATE → `status='grouped'`, `group_key=filename`
4. **Concat** — `bufferManager.createVideoFromBuffer` → ffmpeg concat → 1 final `.mp4` (segments deleted)
5. **Transfer** — `fileTransferManager.transferFile` → copy to USB `/videos/`; `iss_media_files.is_auto_transferred=true`

#### File selection: 7-day window, oldest first, double de-duplication
Unlike the image pipeline (full backlog, newest first), this service only processes recordings from the last 7 days, ordered by `recording_date ASC, precise_time ASC`. Files already in `video_transfer_queue` or `video_converted_buffer` are excluded by NOT IN sub-queries. Missing files on disk are marked `deleted=true` in bulk.

#### Cameras run in parallel via Promise.all
`_handleJobProcessing` fans out `_processSingleCameraJob` per camera concurrently. Each camera has its own independent buffer state tracked in `video_converted_buffer` (filtered by `camera_id AND job_id`). This means camera 1 and camera 2 fill their buffers, convert, group, concat, and transfer independently within the same job.

#### Resume is job-level (not file-level)
`getExistingUncompletedJobs` finds any `video_transfer_queue_job` not in `('failed','completed')`. On reconnect or restart, the job is resumed automatically. Buffer rows (`video_converted_buffer`) survive across restarts and are picked up by the next loop iteration. Videos already in `video_transfer_queue` with `status='pending'` are re-triggered via `emit('startTransferToStorage')`.

#### Config propagation path
Same as image service: UI POST → `writeConfig()` → `dataTransferConfig.json` → `ConfigStateServiceRedis.js` (chokidar + 500ms poll) → Redis `config_state_update` → `redisSub.on('message')` → `emit('configChanged')` → `_updateServiceConfig()`. Latency ≤ 1 s.

---

### Open code issues

These are documented fully in `product/technical/diagrams/refactored_autoVideoTransferEDAMicroservice-activity.md` §14.

| ID | Location | Status | Issue |
|---|---|---|---|
| V-A | `_runCleanupLoop`, `_runBufferMonitoringLoop` | **Fixed (2026-06-22)** | `if(true) return` guards removed from both loops. `CleanupService.cleanupStaleBufferEntries` and `cleanupTempVideoFiles` made job-aware (active-job exclusion + pending-transfer guard). `cleanupStaleProcessingMarkers` skips markers for files still active in buffer. `checkReadyGroupsInBuffer` fixed: queries active job before loop, passes real `jobId`, emits `startTransferToStorage` instead of broken `getOrCreateActiveJob`. Reschedule bug in `_runBufferMonitoringLoop` (called `_runCleanupLoop` at 300 s) corrected to self-reschedule at 30 s. |
| V-B | `_runProcessingLoop` gate G6, `_updateDriveInfo` | **Fixed (2026-06-23)** | Added `pauseActiveJobs(reason)` and `resumeActiveJobs()` to `JobManager`. Gate G6 now calls `pauseActiveJobs('USB drive disconnected')` every 5 s while drive is absent. Drive reconnect in `_updateDriveInfo` calls `resumeActiveJobs()` → status restored to `created` for the next processing loop iteration. |
| V-C | `_startTransferToStorageAsync` (lines ~798–810) | **Fixed (2026-06-23)** | `isTransferringToStorageRunning = true` was set before two early-return guards that never reset it: the drive-not-ready path and the `!fileToTransfer` path. Added `isTransferringToStorageRunning = false` before both returns. Flag is now correctly released on every exit path of the method. |
| V-D | `JobManager.checkJobVideoTransferCompletion` | **Fixed (2026-06-23)** | Method was defined twice (lines ~166 and ~614). Second definition (buffer file count check) silently overwrote the correct first definition (transferred + failed count vs camera count). Second definition deleted; correct first definition is now the sole surviving implementation. Both call sites (`getOrCreateActiveJob` and `_handlePendingProcessingJobStatus`) remain dead code — no call-site changes required. |
| V-E | `CompleteBufferManager.processFilesToBuffer` | **Fixed (2026-06-23)** | `camera_id`, `date`, `group_key`, `interval_start`, `interval_end` were used as bare variables without destructuring `group`. Added `const { camera_id, date, group_key, interval_start, interval_end } = group;` at the top of the `try` block. Downstream call signatures are correct: `checkCameraGroupReady(cameraId, date, groupKey)` matches; `createVideoFromBuffer(jobId, cameraId)` silently ignores the 4 extra args. Note: V-F (`videoCreated` → `updateJobStats` crash) remains open on this path. |
| V-F | `_handleVideoCreated` | **Fixed (2026-06-23)** | Called `this.jobManager.updateJobStats(jobId)` which does not exist (`JobManager` only has `updateJobStatsToTransfered`). Renaming was wrong — at the point `_handleVideoCreated` fires the video is queued but not yet transferred, so a transferred-stats update would be meaningless. The parallel `JobManager.videoGrouppingCompleted` had this same call already commented out. Removed the three lines (`// Update job stats` comment + call + blank line) from `_handleVideoCreated`. |

---

### Relevant file map (traced during investigation)

| File | Role |
|---|---|
| `refactored_autoVideoTransferEDAMicroservice.js` | Main service class, processing/cleanup/transfer loops, Redis pub/sub, config/drive state |
| `services/video-transfer/state/JobManager.js` | Job lifecycle (`video_transfer_queue_job`), file selection, camera file counts, buffer queries |
| `services/video-transfer/transfer/FileTransferManager.js` | Phase-5 transfer: copy or encrypt to USB, `markSourceFilesAsTransferred`, error classification |
| `services/video-transfer/validators/SpaceValidator.js` | Drive ready check, space estimation for processing batch |
| `services/video-transfer/processors/CompleteBufferManager.js` | Phase-2/3/4: `convertSingleFile`, `groupFilesByCamera`, `createVideoFromBuffer`, buffer table management |
| `services/video-transfer/processors/VideoProcessor.js` | ffmpeg wrappers: `convertToMp4`, `concatenateMp4Files`, `waitForFileAccess` |
| `services/video-transfer/state/ProcessingStateManager.js` | Redis processing markers (`video_processing_in_progress:<id>`), `groupFilesByCamera` (DB transaction) |
| `monitorConnectedExternalDrivesMicroservice.js` | USB hotplug (usb@3 + 15s safety-net); publishes `connected_drive_list_update` |
| `ConfigStateServiceRedis.js` | chokidar watch + 500ms poll on `dataTransferConfig.json`; publishes `config_state_update` |
| `redisKeyStore.js` | All Redis key/channel constants |
| `routes/mainConfigRoutes.js` | `POST /auto-transfer/save-config` and `/toggle` handlers |
| `data_transfer_v2/views/auto_transfer.njk` | UI — "Continuous Loop" radio, toggle, dataType, schedule config |

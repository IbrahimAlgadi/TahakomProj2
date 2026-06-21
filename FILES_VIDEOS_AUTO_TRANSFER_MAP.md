# FILES_VIDEOS_AUTO_TRANSFER_MAP.md

**Tahakom Data Transfer System — Auto-Transfer Behaviour Map**
_Companion to `PROJECT_MAP.md`. Describes exactly when and how files (ALPR images) and videos (NVR segments) move in auto-transfer, the ordering, and the unhandled cases that can stall a transfer._

> Scope: the four PM2 auto-transfer services and their shared state/transfer managers. Manual transfer (`/manual-transfer`, `transfer_job`) is out of scope.

---

## 1. The four auto-transfer pipelines

| # | Service (entry point) | Source table | Destination | Queue tables | Source-done flag |
|---|---|---|---|---|---|
| 1 | `autoUSBImageTransferService.js` | `files` | USB drive | `transfer_queue_job` / `transfer_queue` | `files.is_auto_transferred` |
| 2 | `autoFTPImageTransferService.js` | `files` | FTP server | `ftp_image_transfer_queue_job` / `ftp_image_transfer_queue` | `files.is_ftp_transferred`* |
| 3 | `refactored_autoVideoTransferEDAMicroservice.js` | `iss_media_files` | USB drive | `video_transfer_queue_job` / `video_transfer_queue` (+ `video_converted_buffer`) | `iss_media_files.is_auto_transferred` |
| 4 | `autoFtpVideoTransferService.js` | `iss_media_files` | FTP server | `ftp_video_transfer_queue_job` / `ftp_video_transfer_queue` (+ `ftp_video_converted_buffer`) | `iss_media_files.is_ftp_transferred` |

\* FTP image service uses `ImageJobManager.getFilesToTransfer` (inherited), which filters on `is_auto_transferred`, not `is_ftp_transferred` — see Issue I-9.

---

## 2. Key constants (`utils/envConfig.js`)

| Constant | Default | Meaning |
|---|---|---|
| `ISS_MEDIA_CAMERAS` | `['CAM_1','CAM_2','CAM_3']` | Cameras expected per video job (3) |
| `ISS_VIDEO_TRANSFER_CONVERSION_COUNT` | `38` | Segments that must be converted+grouped per camera before one video is built |
| `ISS_VIDEO_TRANSFER_SIZE` | `5` (min) | Length represented by each NVR segment |
| `ISS_MEDIA_RETENTION` | `7` (days) | Drives the USB-video 7-day selection window |
| `ISS_MEDIA_FILE_SIZE` | `8192` KB | Avg segment size, used for space estimates |
| `minRequiredSpaceMB` | `500` | USB free-space floor |

Live config (`data_transfer_v2/dataTransferConfig.json`): `autoTransfer.isActive = false`, `dataType = "videos"`, `drive = "J"`, `encryption.enabled = true`, `schedule.type = "continuous"`, `siteId = "HQ1232"`. FTP `host/username/password` are empty.

---

## 3. When does auto-transfer start?

Each service is a long-running PM2 process with an internal loop (`consumer()` for images, `_runProcessingLoop()` for video). It does **not** start "on an event"; it polls. A batch only proceeds when **all** gates pass:

1. **Master switch** — `autoTransfer.isActive` (images) / `transfer.startTransfer` (FTP video). When off, active jobs are flipped to `paused`.
2. **Data-type gate** — `dataType ∈ {images|both}` for image services, `{videos|both}`/`{video|both}` for video services.
3. **Schedule gate**
   - `continuous` / `immediate` → always in-window.
   - `scheduled daily` → fires at `hour:00`, valid for a **2-hour** window.
   - `scheduled weekly` → fires on `dayOfWeek` at `hour:00`, valid for a **4-hour** window (FTP video uses `transferTime ± 60 min` instead).
4. **Destination gate** — USB: configured drive present + free space above floor; FTP: live connection test passes (re-tested every 30 s; video also polls every 10 s).

Loop cadence: USB image `~1 s`; FTP image `~2–5 s`; USB/FTP video processing loop `~5 s` (`2 s` when paused), buffer monitor `30 s`, cleanup `300 s`.

---

## 4. Ordering — beginning vs. end (per pipeline)

| Pipeline | Selection query | Order | Date window | Batch unit |
|---|---|---|---|---|
| USB video | `JobManager.requestAdditionalFilesForCamera` | `recording_date ASC, precise_time ASC` → **oldest first** | `recording_date >= CURRENT_DATE - 7 days` | per camera, 38 segments |
| FTP video | `FtpJobManager.requestAdditionalFilesForCamera` | `recording_date DESC, recording_time DESC` → **newest first** | none | per camera, 38 segments |
| USB image | `ImageJobManager.getFilesToTransfer` | `MIN(date+time) DESC` → **newest first** | none (active query) | plate-group of **exactly 3** |
| FTP image | inherited `getFilesToTransfer` | `MIN(date+time) DESC` → **newest first** | none | plate-group of **exactly 3** |

> **USB video starts from the beginning (oldest); the other three start from the end (newest).** USB video additionally ignores anything older than 7 days.

---

## 5. Image transfer — step by step (USB; FTP differs only at the copy step)

1. `getOrCreateActiveJob('auto')` — reuse newest non-`transferred`/`failed` job; `paused` → resumed to `transferring`. Else, if files exist, create job.
2. `getFilesToTransfer(1000)` groups `files` by `(plate_num, site_id, date_folder, time_folder)`, requiring `deleted = false`, `BOOL_AND(file_size > 0)`, `BOOL_OR(NOT is_auto_transferred)`, and **`COUNT = 3`**. Newest groups first.
3. `createTransferBatch` explodes groups into `transfer_queue` rows (`status='pending'`); job → `transferring`.
4. `getPendingFiles(1000)` pulls `pending` rows oldest-first (`tq.created_at ASC`).
5. Per file:
   - **Plain**: rebuild path relative to `storage.directory`, mirror onto `USB:\…`, `fs.copy` with EBUSY retry (3×, 1 s).
   - **Encrypted**: group by directory, **batch of 3**, one AES-256-CBC key per batch, write `metadata.json` (AES file list + RSA-wrapped key). Dirs with `<3` files are errored out.
   - On success: `transfer_queue.status='transferred'` + `files.is_auto_transferred=true`.
6. `checkAndUpdateCompletedJobs` closes the job once no `pending` rows remain.
7. Per-file guards: re-checks `isActive`/drive/space each iteration; `hasSpaceForFile` before copy; drive error → stop batch.

FTP image: `processImageFile` uploads to `generateFtpRemotePath` (`/images/site/date/time/plate/file`, ASCII-sanitised); 100 ms throttle; no encryption.

---

## 6. Video transfer — step by step (USB; FTP nearly identical)

1. **Pick job** — `getExistingUncompletedJobs()` (newest non-completed) → take `[0]`; else `_createNewJobIfFilesAvailable()` probes each camera (`requestAdditionalFilesForCamera(cam,0,38,null)`); job created only if some camera has files. Cameras = `expected_cameras`.
2. **Per camera, in parallel** (`_processSingleCameraJob`):
   - If a video already sits in `video_transfer_queue` for this job+camera → if `pending`, emit `startTransferToStorage`; return.
   - Read buffer counts (`pending`/`converted`/`grouped`) from `video_converted_buffer`.
   - If `converted+grouped < 38`: pull more `iss_media_files` (oldest-first, 7-day window, excluding files already queued/buffered), `fs.pathExists` each (missing → `deleted=true`), insert as `pending` buffer rows, and convert each via FFmpeg (`.issvd → .mp4`) → `converted`.
   - When `converted ≥ 38` → group → `grouped`.
   - When `grouped ≥ 38` → `createVideoFromBuffer` concatenates the 38 MP4s into the final video, deletes segments, inserts one row into `video_transfer_queue` (`pending`), appends camera to `processed_cameras`, emits `startTransferToStorage`.
3. **Transfer** (`_startTransferToStorageAsync`): space check → `getPendingTransferFileForJob` → `transferFile` (plain copy or AES + `<name>_metadata.json`) → `markSourceFilesAsTransferred` (sets `iss_media_files.is_auto_transferred=true` for the 38 source IDs) → temp cleanup → `checkAndCompleteJob`.
4. **Completion**: job → `completed` when `transferred_videos ≥ ISS_MEDIA_CAMERAS.length` (3).

Encryption renames the video to its base name (no `.mp4`) plus a sidecar `*_metadata.json` (AES file list + RSA-wrapped AES key).

---

## 7. State machines

- **Image job**: `pending → transferring → transferred|failed`; `paused` when master switch off / outside window; `paused/pending → transferring` on resume.
- **Video job**: `created → pending → transferring → transferred → completed` (`failed` on hard error).
- **Buffer row**: `pending → converted → grouped` (`failed` if source missing/convert error).
- **Queue row**: `pending → transferred` (`failed` after retries; `paused` on `ENOSPC`).

---

## 8. Issues NOT yet handled / cases that can STOP a transfer

> Ordered roughly by impact. File:line references are approximate to current code.

### Design invariants (intentional, not bugs)

- **I-4 — Exactly-3 rule is intentional by design.** `getFilesToTransfer` uses `HAVING COUNT(f.id) = 3`. This matches the capture contract in `securos-scripts/OptimizedImageCapture.js`: each `LPR_CAM` object has exactly 3 camera IDs, and on every `CAR_LP_RECOGNIZED` event all 3 cameras are captured in sequence, writing one row each to `files`. Fewer than 3 rows means an IMAGE_EXPORT is still in flight or a camera export failed — the group is intentionally skipped until the next cycle when all 3 images are confirmed. Transferring a partial group would create an incomplete plate record at the destination. Groups with ≠ 3 rows are a signal of a capture-side issue; the operational check is `SELECT plate_num, date_folder, time_folder, COUNT(*) FROM files WHERE deleted=false AND is_auto_transferred=false GROUP BY 1,2,3 HAVING COUNT(*) != 3`. (`services/image-transfer/state/ImageJobManager.js`, `securos-scripts/OptimizedImageCapture.js`)

### Blockers that silently strand media

- **I-1 — USB video 7-day cutoff strands old recordings.** `requestAdditionalFilesForCamera` filters `recording_date >= CURRENT_DATE - 7 days`. If the USB drive is absent (or `isActive=false`) for more than 7 days, untransferred segments fall out of the window and are **never** picked up again. FTP video has no window, so the two destinations diverge. (`services/video-transfer/state/JobManager.js`)
- **I-2 — The "exactly 38 segments per camera" rule strands tails.** A video is only built when a camera reaches 38 converted+grouped segments. A camera with fewer untransferred segments (end of day, sparse data, near the 7-day edge) never produces a video, so those segments sit forever. (`refactored_autoVideoTransferEDAMicroservice.js`, `CompleteBufferManager.createVideoFromBuffer`)
- **I-3 — Head-of-line blocking on a stuck video job.** The loop always processes the newest uncompleted job (`existingJobs[0]`) and `return`s. If that job can never complete — e.g. one camera (`CAM_3`) is offline so it never gets 3 videos — no new job is created and the **entire USB-video pipeline stalls** behind it. Completion requires all `ISS_MEDIA_CAMERAS` to deliver a video. (`getExistingUncompletedJobs` + `checkAndCompleteJob`)
- **I-5 — Failed videos orphan their source segments.** When a video exhausts retries → `video_transfer_queue.status='failed'`, source files are not marked transferred, but their buffer rows stay `grouped`. `requestAdditionalFilesForCamera` excludes buffered (`pending/converted/grouped`) rows, so those segments are **excluded from future jobs yet never transferred**. (`FileTransferManager.handleTransferError` + selection query)

### Deadlock / logic bugs

- **I-6 — `isTransferringToStorageRunning` can stick `true` (USB video deadlock).** In `_startTransferToStorageAsync` the flag is set `true`, but the early returns for **drive-not-ready** and **no-file-found** return **without** resetting it. The method guards at the top with `if (isTransferringToStorageRunning) return;`, so once either path fires, **all** future video transfers are blocked until the service restarts. (`refactored_autoVideoTransferEDAMicroservice.js` ~L804–816)
- **I-7 — FTP video uses an inverted, mis-named flag.** `pauseVideoTransferFromConfig` is assigned `transfer.startTransfer`, then checked as `if (!pauseVideoTransferFromConfig) return;`. It works by accident, but if `serviceConfig.transfer` is undefined it defaults to `false` and the service **never transfers**, with no clear log. (`autoFtpVideoTransferService.js` ~L237, L455, L610)
- **I-8 — Cleanup & buffer-monitor loops are hard-disabled.** Both `_runCleanupLoop` and `_runBufferMonitoringLoop` start with `if (true) { …return; }`, so orphaned temp MP4s and stale buffer rows are never reclaimed by these loops. `checkReadyGroupsInBuffer` also references an undefined `jobId` (would throw), but is unreachable while disabled — latent bug if re-enabled. (`refactored_autoVideoTransferEDAMicroservice.js` ~L896, L917; `CompleteBufferManager.checkReadyGroupsInBuffer` ~L551)
- **I-9 — FTP image selection filters the wrong flag.** `FtpImageJobManager` inherits `getFilesToTransfer`, which filters on `is_auto_transferred`, not `is_ftp_transferred`. FTP image eligibility is therefore coupled to USB state instead of FTP state. (`ImageJobManager.getFilesToTransfer`)

### Environmental / config stops (expected, but worth monitoring)

- **I-10 — FTP credentials empty.** `ftpTransfer` host/user/password are blank, so both FTP services idle indefinitely (matches `PROJECT_MAP.md` O-3).
- **I-11 — Scheduled-window misses.** In `scheduled` mode, if the service/drive/FTP is unavailable for the whole 2 h (daily) / 4 h (weekly) window, that period's media isn't transferred until the window recurs. (Current config is `continuous`, so not active.)
- **I-12 — Drive-letter dependency.** USB video binds to the exact configured drive letter (`J`); a remount under a different letter pauses transfer (image service can fall back to "any"/first drive).
- **I-13 — Disk-full handling differs.** Video transfer treats `ENOSPC` as `paused` + stop-processing; image transfer breaks the batch. Neither auto-resumes until space frees and the loop re-evaluates.
- **I-14 — Single in-flight transfer flag.** Transfers are serialised per service via one boolean across all cameras; throughput is limited and any stuck transfer (I-6) blocks the rest.

---

## 9. Verification pointers

| Symptom | Where to look |
|---|---|
| Old recordings never reach USB | I-1 7-day window; `iss_media_files` with `is_auto_transferred=false`, `recording_date < now-7d` |
| Camera stuck below 38 | I-2/I-3; `video_converted_buffer` counts per `(job_id, camera_id)` |
| Images for a plate never move | I-4 (design invariant — look at the capture side, not the transfer service); `COUNT != 3` in `files` = IMAGE_EXPORT still in flight or camera export failure |
| USB video froze entirely | I-6 stuck flag, or I-3 head-of-line job |
| FTP idle | I-7 flag / I-10 empty credentials |

---

_Last updated: 2026-06-21 (I-4 reclassified as intentional design invariant — 3-camera capture contract from `securos-scripts/OptimizedImageCapture.js`). Source: `refactored_autoVideoTransferEDAMicroservice.js`, `autoFtpVideoTransferService.js`, `autoUSBImageTransferService.js`, `autoFTPImageTransferService.js`, `services/{video,image}-transfer/**`, `utils/envConfig.js`, `data_transfer_v2/dataTransferConfig.json`, `securos-scripts/OptimizedImageCapture.js`._

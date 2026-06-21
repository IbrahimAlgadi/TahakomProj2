# Image USB Pipeline — Context

## 2026-06-21 — Full pipeline investigation + doc written

### What was produced
- `product/technical/diagrams/autoUSBImageTransferService-activity.md` — comprehensive activity & behaviour map (13 sections, 2 mermaid diagrams, state machines, error table, stall risks).
- `FILES_VIDEOS_AUTO_TRANSFER_MAP.md` — I-4 reclassified from "blocker" to "design invariant"; I-4 moved to its own section above the blockers list.

### Key findings (non-obvious, took code tracing to establish)

#### Capture → transfer contract (the most important insight)
`securos-scripts/OptimizedImageCapture.js` is the source of the `COUNT = 3` rule.
- Each `LPR_CAM` object defines exactly **3 camera IDs** (`cam_ids` array).
- On every `CAR_LP_RECOGNIZED` event, `carReact()` iterates all 3 and calls `processCameraCapture` sequentially, inserting one row into `files` per camera.
- `getFilesToTransfer` (`ImageJobManager.js`) therefore uses `HAVING COUNT(f.id) = 3` — a complete plate group always has exactly 3 rows.
- **Fewer than 3 = IMAGE_EXPORT still in flight OR camera export failure** — the group is intentionally skipped until the next cycle. This is correct behaviour.
- **Not a transfer-service bug.** Point capture-related investigations at `OptimizedImageCapture.js` and the `IMAGE_EXPORT` SecurOS object, not at the transfer queue.

#### USB disconnect does NOT pause the DB job
When the USB drive is removed, `IS_DRIVE_CONNECTED = false` and the consumer loop sleeps — but `transfer_queue_job.status` stays `'transferring'`. Only the toggle-off or schedule-window-exit path calls `pauseActiveJobs()`. This is intentional for Continuous Loop mode so reconnect is automatic, but it means monitoring queries that look for `status='transferring'` will see a "live" job even when no transfer is happening.

#### Resume is file-level, not job-level
`transfer_queue` rows keep their `status='pending'` across any interruption (USB disconnect, toggle-off/on, process restart). `getOrCreateActiveJob()` auto-promotes a `paused` job to `transferring`; `resumeActiveJobs()` does the same in bulk. `getPendingFiles()` always orders by `created_at ASC` so the cursor advances monotonically.

#### Config propagation path
UI `POST /auto-transfer/save-config` (or `/toggle`) → `writeConfig()` → `dataTransferConfig.json` → `ConfigStateServiceRedis.js` (chokidar + 500ms poll) → Redis `config_state_update` publish → `autoUSBImageTransferService.js` `redisPubSub.on('message')`.
Latency: ≤ 1 s in normal conditions.
Edge-triggered side effect: `isActive` false→true calls `resumeActiveJobs()`; true→false calls `pauseActiveJobs()`. The loop also calls `pauseActiveJobs()` unconditionally each iteration while inactive.

#### Unused today-only query (`query2`)
`ImageJobManager.getFilesToTransfer` defines a second query (`query2`, lines 161–186) that filters `ts::date = CURRENT_DATE`. It is **never called** — line 188 always runs `query` (full backlog). This is the correct insertion point if a date-range or "today only" filter is ever needed.

---

### Open code issues

These are in `product/technical/diagrams/autoUSBImageTransferService-activity.md` §11 (O-B through O-E). Track here for discoverability.

| ID | Location | Status | Issue |
|---|---|---|---|
| ~~O-B~~ | `autoUSBImageTransferService.js` | **Fixed 2026-06-21** | `markUSBSourceFilesAsTransferred` now receives `successfulFileIds` (array of `file.file_id` values) built inside the per-file loop; call is guarded by `length > 0` and awaited. Early-break batches no longer mark uncopied files. |
| O-C | Consumer loop + DB job model | Open | USB disconnect leaves job `status='transferring'` — monitoring queries see a "live" job even when the loop is idling. |
| O-D | Source-marking inconsistency | Open | `processImageFile` calls `markSourceFilesAsTransferred` (updates `iss_media_files`); `markUSBSourceFilesAsTransferred` updates `files`. `getFilesToTransfer` filters on `files.is_auto_transferred`. If the two tables diverge, files could be re-queued. |
| O-E | Unused query | Open | `query2` in `getFilesToTransfer` (today-only filter) is defined but never called. |

---

### Relevant file map (traced during investigation)

| File | Role |
|---|---|
| `autoUSBImageTransferService.js` | Consumer loop, state flags, Redis pub/sub, metrics |
| `services/image-transfer/state/ImageJobManager.js` | Job lifecycle, `getFilesToTransfer` (COUNT=3), pause/resume |
| `services/image-transfer/transfer/ImageTransferManager.js` | `getPendingFiles`, copy/encrypt, `copyWithRetry` (EBUSY 3×/1s) |
| `services/image-transfer/validators/ImageSpaceValidator.js` | Space gates: 99% stop, 85% warn, 50MB floor |
| `services/shared/TransferUtils.js` | `isDriveRelatedError`, `isFileNotFoundError`, `handleImageTransferError`, source-marking |
| `monitorConnectedExternalDrivesMicroservice.js` | USB hotplug (usb@3 + 15s safety-net); publishes `connected_drive_list_update` |
| `ConfigStateServiceRedis.js` | chokidar watch + 500ms poll on `dataTransferConfig.json`; publishes `config_state_update` |
| `redisKeyStore.js` | All Redis key/channel constants |
| `routes/mainConfigRoutes.js` | `POST /auto-transfer/save-config` and `/toggle` handlers |
| `data_transfer_v2/views/auto_transfer.njk` | UI — "Continuous Loop" radio, toggle, dataType, schedule config |
| `securos-scripts/OptimizedImageCapture.js` | **Capture contract** — 3 cameras per LPR, one `files` row per camera per recognition event |

# Manual Video USB Pipeline — Context

## 2026-06-23 — Full pipeline investigation + gap analysis written

### What was produced

- `product/technical/diagrams/manualUSBVideoTransferService-activity.md` — gap-analysis document (9 sections, 2 architecture Mermaid diagrams, intended-vs-actual comparison, 4 open issues MV-A through MV-D, implementation path).
- `context/manual-video-usb-pipeline.md` — this file.
- `PROJECT_MAP.md` [ORPHANS & PENDING] — MV-A, MV-B, MV-C entries added as critical blockers.

### Key finding

**Manual USB video transfer does not exist.** The `/manual_usb` UI exposes "Videos Only" and "Both Images & Videos" radio buttons, but the backend (`routes/manualTransferRoutes.js`) ignores the `dataType` field entirely. Every manual transfer job — regardless of operator selection — queries only the `files` table (ALPR image captures) and queues those rows into `file_transfer_queue`. No ISS video file (`iss_media_files`) is ever selected, converted, or copied.

This means:
- An operator selecting "Videos Only" receives a transfer of ALPR images with no error or warning.
- An operator selecting "Both Images & Videos" receives only ALPR images.
- The history view shows file counts from `files`, not `iss_media_files`.

There is no silent fallback, partial implementation, or feature flag — the video path simply does not branch in the code.

### Why this differs from auto video transfer

Auto USB video (`refactored_autoVideoTransferEDAMicroservice.js`) is a completely separate PM2 process with its own source table (`iss_media_files`), its own queue tables (`video_transfer_queue`, `video_converted_buffer`), a 5-phase ffmpeg conversion pipeline, and per-camera batching logic. The manual transfer stack (`DashboardReportingBackend.js` + `manualTransferRoutes.js`) was built independently for ALPR image retrieval and was never extended to reach the video pipeline tables.

### What would be required to implement manual video transfer

Summarised from `manualUSBVideoTransferService-activity.md §8`:

1. Add `dataType` routing in `POST /manual-transfer/create` — branch to `iss_media_files` query when `dataType` is `'videos'` or `'both'`.
2. Add MP4 conversion step — reuse `BufferManager.convertSingleFile` or wrap ffmpeg directly.
3. Add a queue consumer that dequeues converted files and copies them to USB.
4. Mark `iss_media_files.is_auto_transferred = true` after successful copy.
5. Disable or label the "Videos Only" and "Both" UI options until implemented.

---

### Open code issues

Full detail in `product/technical/diagrams/manualUSBVideoTransferService-activity.md` §7.

| ID | Location | Status | Issue |
|---|---|---|---|
| MV-A | `routes/manualTransferRoutes.js:16` | **Open** | `dataType` field silently ignored — video and both selections transfer ALPR images only |
| MV-B | `routes/manualTransferRoutes.js` | **Open** | No `iss_media_files` query path — video source files are unreachable via manual transfer |
| MV-C | Manual transfer stack (all files) | **Open** | No conversion pipeline — ISS `.issvd` files require ffmpeg processing before transfer |
| MV-D | `data_transfer_v2/views/manual_usb.njk` | **Open** | "Videos Only" and "Both" radio buttons appear functional; no warning or disabled state |

---

### Relevant file map (traced during investigation)

| File | Role |
|---|---|
| `routes/manualTransferRoutes.js` | Manual transfer backend — `dataType` received but not used |
| `data_transfer_v2/views/manual_usb.njk` | UI — "Videos Only" / "Both" radios send `dataType`; no backend branch exists |
| `iss_media_files` (DB table) | ISS video source — never queried by manual transfer routes |
| `video_transfer_queue` (DB table) | Auto video queue — not used by manual transfer |
| `video_converted_buffer` (DB table) | Auto video conversion buffer — not used by manual transfer |
| `refactored_autoVideoTransferEDAMicroservice.js` | Auto video pipeline — the reference implementation for what manual video would need to replicate |
| `services/video-transfer/transfer/FileTransferManager.js` | Auto video copy step — potential reuse candidate |
| `services/video-transfer/state/JobManager.js` | Auto video job management — potential reuse candidate |
| `utils/FileTransferQueueService.js` | Generic queue — `serviceType='video'` is documented but unused for manual |
| `archived/FileTransferRedisService.js` | Archived queue consumer — was intended for `file_transfer_queue`; never completed for video |

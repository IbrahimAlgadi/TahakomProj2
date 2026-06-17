# File Accumulation Approach - Video Processing

## Overview

The video processing system now uses a **File Accumulation Approach** where files are continuously added to a buffer until all cameras have 38 files ready, then conversion begins simultaneously for all cameras.

## New Flow

### Phase 1: Job Management
- ✅ Check for existing jobs (`created`, `pending`)
- ✅ Wait if job is `pending` (being transferred)
- ✅ Continue if job is `created` but incomplete
- ✅ Create new job if none exists AND files are available

### Phase 2: File Accumulation & Processing
```
=== PHASE 2: CAMERA PROCESSING ===
[PHASE2] Checking for unprocessed files across all cameras...
[PHASE2] Camera 1: 29 unprocessed files available
[PHASE2] Camera 2: 29 unprocessed files available  
[PHASE2] Camera 3: 29 unprocessed files available
[PHASE2] Found 87 total unprocessed files. Creating new job for cameras: 1, 2, 3
[PHASE2] ✓ Created job: xxx-xxx-xxx (status: created)

=== FILE ACCUMULATION PHASE ===
[PHASE2] Adding files to buffer for camera 1...
[BUFFER] Added 29 files to buffer for camera 1
[PHASE2] Adding files to buffer for camera 2...
[BUFFER] Added 29 files to buffer for camera 2
[PHASE2] Adding files to buffer for camera 3...
[BUFFER] Added 29 files to buffer for camera 3

=== READINESS CHECK ===
[BUFFER] Camera buffer status:
[BUFFER]   Camera 1: 29/38 files ✗ Need 9 more
[BUFFER]   Camera 2: 29/38 files ✗ Need 9 more
[BUFFER]   Camera 3: 29/38 files ✗ Need 9 more
[PHASE2] ⏳ Not all cameras ready yet. Will continue accumulating files in next cycle...
[PHASE2]   Camera 1: 29/38 files (76% ready)
[PHASE2]   Camera 2: 29/38 files (76% ready)
[PHASE2]   Camera 3: 29/38 files (76% ready)
```

#### When All Cameras Ready:
```
=== READINESS CHECK ===
[BUFFER] Camera buffer status:
[BUFFER]   Camera 1: 38/38 files ✓ READY
[BUFFER]   Camera 2: 38/38 files ✓ READY
[BUFFER]   Camera 3: 38/38 files ✓ READY
[PHASE2] ✅ All cameras have 38+ files in buffer. Starting conversion...

[CONVERSION] Starting conversion for all ready cameras...
[CONVERSION] Processing camera 1...
[CONVERSION] Converting 38 files for camera 1
[CONVERSION] ✓ Converted: file1.issvd (1/38)
...
[CONVERSION] ✓ Successfully created and queued video for camera 1
[CONVERSION] Processing camera 2...
...
```

### Phase 3: Job Completion
- ✅ Check if all cameras processed
- ✅ Change job status to `pending` when complete
- ✅ Show progress if still accumulating

## Key Benefits

### 1. **Systematic Processing**
- No more continuous processing of camera 1
- Equal opportunity for all cameras
- Fair file distribution

### 2. **File Accumulation**
- Files added to `video_converted_buffer` as `pending`
- Waits until ALL cameras have 38 files
- Prevents incomplete video creation

### 3. **No Failed Jobs**
- Pre-checks for available files before creating jobs
- Automatic cleanup of old failed jobs
- Clear progress tracking

### 4. **Better Logging**
```
[PHASE2]   Camera 1: 29/38 files (76% ready)
[PHASE2]   Camera 2: 35/38 files (92% ready)
[PHASE2]   Camera 3: 38/38 files (100% ready)
```

## Database Schema

### video_converted_buffer
- `status`: `pending` → `converted` → `grouped`
- Tracks files through entire lifecycle
- Prevents duplicate processing

### video_transfer_queue_job
- `status`: `created` → `pending` → `transferring`
- `expected_cameras`: `[1, 2, 3]`
- `processed_cameras`: `[1, 2]` (progressive)

## Expected Behavior

1. **Cycle 1**: Add available files to buffer (Camera 1: 29, Camera 2: 29, Camera 3: 29)
2. **Cycle 2**: Add more files (Camera 1: 35, Camera 2: 32, Camera 3: 30)
3. **Cycle 3**: All ready (Camera 1: 38, Camera 2: 38, Camera 3: 38) → Start conversion
4. **Cycle 4**: Complete job → Status changes to `pending`

## Files Created

- `check_media_files.js` - Debug tool to check database content
- `FILE_ACCUMULATION_APPROACH.md` - This documentation

## Key Functions

- `addFilesToBuffer()` - Add files to buffer as pending
- `checkAllCamerasReady()` - Check if all cameras have 38+ files
- `processAllReadyCameras()` - Convert and create videos for all cameras
- `cleanupOldFailedJobs()` - Automatic cleanup of failed jobs

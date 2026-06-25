/**
 * autoUSBTransferService.js
 *
 * Unified time-cursor USB transfer service.
 *
 * Replaces autoUSBImageTransferService.js and refactored_autoVideoTransferEDAMicroservice.js
 * for the automatic USB (SSD) transfer path.
 *
 * Core design
 * -----------
 *  - Maintains a single "cursor" timestamp that advances in 5-minute steps.
 *  - For each step: transfer all images in [cursor, cursor+5min], then convert
 *    and transfer all video segments in the same window for each camera.
 *  - The cursor is persisted in dataTransferConfig.json (autoTransfer.lastTransferredAt)
 *    so the service resumes exactly where it stopped after a restart or USB reconnect.
 *  - If lastTransferredAt is missing or older than 7 days the service starts fresh at
 *    now − 1 hour.
 *  - When the cursor catches up with "now" the loop idles for 5 minutes then re-checks.
 */

'use strict';

const path   = require('path');
const fs     = require('fs-extra');
const Redis  = require('ioredis');
const { Pool } = require('pg');

const { CONFIG_STATE_KEY, CONNECTED_DRIVE_LIST } = require('./redisKeyStore');
const ImageJobManager  = require('./services/image-transfer/state/ImageJobManager');
const JobManager       = require('./services/video-transfer/state/JobManager');
const VideoProcessor   = require('./services/video-transfer/processors/VideoProcessor');
const ImageSpaceValidator = require('./services/image-transfer/validators/ImageSpaceValidator');
const encryptionService   = require('./utils/encryptionService');
const config              = require('./utils/envConfig');
const { createLogger }    = require('./utils/logger');

const logger = createLogger({ service: 'autoUSBTransferService', logFile: 'auto-usb-transfer' });

// ── Constants ────────────────────────────────────────────────────────────────

const WINDOW_MINUTES       = 5;
const WINDOW_MS            = WINDOW_MINUTES * 60 * 1000;
const IDLE_POLL_MS         = WINDOW_MS;          // poll every 5 min when caught up
const LOOP_SLEEP_MS        = 1_000;
const RESUME_MAX_AGE_DAYS  = 7;
const RESUME_MAX_AGE_MS    = RESUME_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
const COPY_MAX_RETRIES     = 3;
const COPY_RETRY_DELAY_MS  = 1_000;

// ── Helper ───────────────────────────────────────────────────────────────────

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Zero-pad a number to two digits. */
function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * Format a Date as YYYY-MM-DD_HHmm for use in video filenames / folder names.
 */
function formatWindowLabel(dt) {
    return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}_${pad2(dt.getHours())}${pad2(dt.getMinutes())}`;
}

/**
 * Copy a file with automatic retry on EBUSY.
 */
async function copyWithRetry(src, dest, retries = COPY_MAX_RETRIES, delayMs = COPY_RETRY_DELAY_MS) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await fs.copy(src, dest, { overwrite: true });
            return;
        } catch (err) {
            if (err.code === 'EBUSY' && attempt < retries) {
                logger.warn(`[COPY] EBUSY on attempt ${attempt}/${retries}, retrying: ${src}`);
                await sleep(delayMs);
            } else {
                throw err;
            }
        }
    }
}

// ── State ────────────────────────────────────────────────────────────────────

let CONFIG_STATE       = {};
let DRIVE_INFO         = null;
let IS_DRIVE_CONNECTED = false;
let IS_TRANSFER_ACTIVE = false;
let IS_VIDEO_ENABLED   = true;
let IS_IMAGE_ENABLED   = true;
let SHOULD_STOP        = false;   // set on ENOSPC
let IS_RUNNING         = true;

// Throttle drive-state logging: only emit when the drive key changes
let _lastDriveStateKey = null;
// Throttle config-update logging: only emit when meaningful values change
let _lastConfigKey = null;

// ── Redis clients ────────────────────────────────────────────────────────────

const redisOpts = {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
    retryStrategy: times => Math.min(times * 50, 2_000),
};

const redis       = new Redis(redisOpts);
const redisPubSub = new Redis(redisOpts);

// ── Database pool ────────────────────────────────────────────────────────────

const pool = new Pool({
    user:     process.env.DB_USER     || 'postgres',
    host:     process.env.DB_HOST     || 'localhost',
    database: process.env.DB_NAME     || 'tahakom_transfer',
    port:     process.env.DB_PORT     || 5432,
    password: process.env.DB_PASSWORD || 'postgres',
});

// ── Service instances ─────────────────────────────────────────────────────────

const imageJobManager  = new ImageJobManager(pool, redis, config);
const jobManager       = new JobManager(null, pool, redis, config, null);
const videoProcessor   = new VideoProcessor(null, {
    ...config,
    VIDEO_TEMP_DIR: config.ISS_MEDIA_CNVERSION_BUFFER_DIR || path.join(__dirname, 'temp_video_processing'),
});
const imageSpaceValidator = new ImageSpaceValidator(config);

// temp dir used by this service (shared with auto video service is fine)
const TEMP_DIR = videoProcessor.VIDEO_TEMP_DIR;

// ── Config file I/O ───────────────────────────────────────────────────────────

function readConfigFile() {
    try {
        if (fs.existsSync(config.CONFIG_FILE_PATH)) {
            return JSON.parse(fs.readFileSync(config.CONFIG_FILE_PATH, 'utf8'));
        }
    } catch (err) {
        logger.error(`[CONFIG] Failed to read config file: ${err.message}`);
    }
    return null;
}

// ── Config write mutex (prevents parallel loops overwriting each other) ─────────

let _configMutex = Promise.resolve();

function withConfigLock(fn) {
    _configMutex = _configMutex.then(fn).catch(err => {
        logger.error(`[CONFIG] Locked write failed: ${err.message}`);
    });
    return _configMutex;
}

async function saveImageCursor(cursorDate) {
    return withConfigLock(async () => {
        try {
            const current = readConfigFile();
            if (!current) return;
            if (!current.autoTransfer) current.autoTransfer = {};
            current.autoTransfer.lastImageTransferredAt = cursorDate.toISOString();
            current.autoTransfer.lastConnectedAt        = new Date().toISOString();
            await fs.writeFile(config.CONFIG_FILE_PATH, JSON.stringify(current, null, 2));
            logger.info(`[CONFIG] imgCursor saved: ${cursorDate.toISOString()}`);
        } catch (err) {
            logger.error(`[CONFIG] saveImageCursor failed: ${err.message}`);
        }
    });
}

async function saveVideoCursor(cursorDate) {
    return withConfigLock(async () => {
        try {
            const current = readConfigFile();
            if (!current) return;
            if (!current.autoTransfer) current.autoTransfer = {};
            current.autoTransfer.lastVideoTransferredAt = cursorDate.toISOString();
            await fs.writeFile(config.CONFIG_FILE_PATH, JSON.stringify(current, null, 2));
            logger.info(`[CONFIG] vidCursor saved: ${cursorDate.toISOString()}`);
        } catch (err) {
            logger.error(`[CONFIG] saveVideoCursor failed: ${err.message}`);
        }
    });
}

async function saveConnectedAt() {
    return withConfigLock(async () => {
        try {
            const current = readConfigFile();
            if (!current) return;
            if (!current.autoTransfer) current.autoTransfer = {};
            current.autoTransfer.lastConnectedAt = new Date().toISOString();
            await fs.writeFile(config.CONFIG_FILE_PATH, JSON.stringify(current, null, 2));
        } catch (err) {
            logger.error(`[CONFIG] saveConnectedAt failed: ${err.message}`);
        }
    });
}

// ── Cursor resolution ─────────────────────────────────────────────────────────

function _resolveOneCursor(label, primary, fallbackKey) {
    const fileConfig = readConfigFile();
    const autoT      = fileConfig && fileConfig.autoTransfer;
    const lastStr    = (autoT && autoT[primary]) || (autoT && autoT[fallbackKey]);

    if (lastStr) {
        const last  = new Date(lastStr);
        const ageMs = Date.now() - last.getTime();
        if (!isNaN(last.getTime()) && ageMs <= RESUME_MAX_AGE_MS) {
            logger.info(`[CURSOR] ${label}: Resuming from ${last.toISOString()} (age ${Math.round(ageMs / 60000)} min)`);
            return last;
        }
        logger.info(`[CURSOR] ${label}: Saved cursor too old (${Math.round(ageMs / 86400000)}d), fresh start`);
    } else {
        logger.info(`[CURSOR] ${label}: No saved cursor, fresh start`);
    }

    const fresh = new Date(Date.now() - 60 * 60 * 1000);
    logger.info(`[CURSOR] ${label}: Fresh cursor: ${fresh.toISOString()}`);
    return fresh;
}

function resolveImageCursor() {
    return _resolveOneCursor('IMG', 'lastImageTransferredAt', 'lastTransferredAt');
}

function resolveVideoCursor(imgCursor) {
    const fileConfig = readConfigFile();
    const autoT      = fileConfig && fileConfig.autoTransfer;
    const lastStr    = (autoT && autoT.lastVideoTransferredAt) || (autoT && autoT.lastTransferredAt);

    if (lastStr) {
        const last  = new Date(lastStr);
        const ageMs = Date.now() - last.getTime();
        if (!isNaN(last.getTime()) && ageMs <= RESUME_MAX_AGE_MS) {
            logger.info(`[CURSOR] VID: Resuming from ${last.toISOString()} (age ${Math.round(ageMs / 60000)} min)`);
            return last;
        }
    }

    logger.info(`[CURSOR] VID: No valid cursor — starting at imgCursor ${imgCursor.toISOString()}`);
    return new Date(imgCursor.getTime());
}

// ── Drive info ────────────────────────────────────────────────────────────────

async function updateDriveInfo() {
    try {
        const driveListStr = await redis.get(CONNECTED_DRIVE_LIST);
        if (!driveListStr) {
            if (_lastDriveStateKey !== 'none') { logger.info('[DRIVE] No drive list in Redis — disconnected'); _lastDriveStateKey = 'none'; }
            DRIVE_INFO = null; IS_DRIVE_CONNECTED = false; return;
        }

        const driveList    = JSON.parse(driveListStr);
        if (!driveList || driveList.length === 0) {
            if (_lastDriveStateKey !== 'none') { logger.info('[DRIVE] No drives connected'); _lastDriveStateKey = 'none'; }
            DRIVE_INFO = null; IS_DRIVE_CONNECTED = false; return;
        }

        const configuredDrive = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.drive;
        const transferMode    = CONFIG_STATE && CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.transferMode;

        let targetDrive = null;

        if (transferMode === 'any' || configuredDrive === 'ANY') {
            targetDrive = driveList.find(d =>
                d.drive === configuredDrive ||
                d.drive === `${configuredDrive}:`
            ) || driveList[0];

            if (targetDrive && configuredDrive !== targetDrive.drive.replace(':', '')) {
                const current = readConfigFile();
                if (current) {
                    current.autoTransfer.drive = targetDrive.drive.replace(':', '');
                    await fs.writeFile(config.CONFIG_FILE_PATH, JSON.stringify(current, null, 2));
                    CONFIG_STATE = current;
                }
            }
        } else if (configuredDrive) {
            targetDrive = driveList.find(d =>
                d.drive === configuredDrive ||
                d.drive === `${configuredDrive}:`
            );
        } else {
            targetDrive = driveList[0];
        }

        if (!targetDrive) {
            if (_lastDriveStateKey !== 'missing') {
                logger.warn(`[DRIVE] Target drive '${configuredDrive}' not found in connected drives`);
                _lastDriveStateKey = 'missing';
            }
            DRIVE_INFO = null; IS_DRIVE_CONNECTED = false; return;
        }

        DRIVE_INFO = targetDrive;
        IS_DRIVE_CONNECTED = true;
        imageSpaceValidator.updateDriveInfo(DRIVE_INFO, imageSpaceValidator.isDriveNearFull(99));
        SHOULD_STOP = imageSpaceValidator.isDriveNearFull(99);

        // Log only when drive identity or connection state changes to avoid log spam
        const driveStateKey = `${DRIVE_INFO.drive}-connected`;
        if (driveStateKey !== _lastDriveStateKey) {
            logger.info(`[DRIVE] Connected: ${DRIVE_INFO.drive}, free: ${imageSpaceValidator.getFreeSpaceMB().toFixed(0)} MB`);
            _lastDriveStateKey = driveStateKey;
        }
    } catch (err) {
        logger.error(`[DRIVE] updateDriveInfo error: ${err.message}`);
        DRIVE_INFO = null; IS_DRIVE_CONNECTED = false;
    }
}

/** Return the drive letter with colon, e.g. "G:" */
function driveRoot() {
    if (!DRIVE_INFO) return null;
    const d = DRIVE_INFO.drive || '';
    return d.endsWith(':') ? d : `${d}:`;
}

// ── Metrics helper ────────────────────────────────────────────────────────────

const METRICS_IMG_CHANNEL = 'usb_image_transfer_metrics';
const METRICS_VID_CHANNEL = 'usb_video_transfer_metrics';

/**
 * Fire-and-forget Redis publish for real-time UI progress.
 * DashboardReportingBackend subscribes to these channels and relays to WebSocket clients.
 */
function publishMetric(channel, type, data) {
    redis.publish(channel, JSON.stringify({ serviceType: 'auto-usb', type, data }))
        .catch(err => logger.warn(`[METRICS] publish ${type} failed: ${err.message}`));
}

// ── Image phase ───────────────────────────────────────────────────────────────

/**
 * Transfer all images in [windowStart, windowEnd) to the USB drive.
 * Images are placed under: {drive}:\images\{relative path from exportDir}
 */
async function transferImagesInWindow(windowStart, windowEnd) {
    const exportDir  = CONFIG_STATE.storage && CONFIG_STATE.storage.directory;
    const drive      = driveRoot();
    const usbImgRoot = path.join(drive, 'images');

    const images = await imageJobManager.getImagesInWindow(windowStart, windowEnd);

    if (images.length === 0) {
        logger.info(`[IMAGE_PHASE] No images in window [${windowStart.toISOString()} – ${windowEnd.toISOString()}]`);
        publishMetric(METRICS_IMG_CHANNEL, 'batch_start',    { jobId: `auto-usb-img-${Date.now()}`, totalFiles: 0 });
        publishMetric(METRICS_IMG_CHANNEL, 'batch_complete', { jobId: `auto-usb-img-${Date.now()}`, processedCount: 0, totalFiles: 0, successRate: 100, throughput: 0, duration: 0 });
        return;
    }

    logger.info(`[IMAGE_PHASE] Transferring ${images.length} images in window`);

    const jobId   = `auto-usb-img-${Date.now()}`;
    const startMs = Date.now();
    publishMetric(METRICS_IMG_CHANNEL, 'batch_start', { jobId, totalFiles: images.length });

    const successIds = [];
    let failCount    = 0;

    for (const img of images) {
        if (SHOULD_STOP) {
            logger.warn('[IMAGE_PHASE] USB full — stopping image phase');
            break;
        }

        try {
            let relPath;
            if (exportDir && img.file_path.startsWith(exportDir)) {
                relPath = path.relative(exportDir, img.file_path);
            } else {
                relPath = path.basename(img.file_path);
            }

            const destPath = path.join(usbImgRoot, relPath);
            await fs.ensureDir(path.dirname(destPath));
            await copyWithRetry(img.file_path, destPath);
            successIds.push(img.id);

        } catch (err) {
            failCount++;
            if (err.code === 'ENOSPC') {
                SHOULD_STOP = true;
                logger.error(`[IMAGE_PHASE] ENOSPC — USB drive is full`);
                break;
            }
            logger.error(`[IMAGE_PHASE] Failed to copy image id=${img.id} path=${img.file_path}: ${err.message}`);
        }

        // Emit progress every 50 files (and on the last file)
        const processed = successIds.length + failCount;
        if (processed % 50 === 0 || processed === images.length) {
            const elapsedSec = Math.max(1, (Date.now() - startMs) / 1000);
            publishMetric(METRICS_IMG_CHANNEL, 'batch_progress', {
                jobId,
                processedCount:     processed,
                totalFiles:         images.length,
                progressPercentage: Math.round((processed / images.length) * 100),
                currentFile:        path.basename(img.file_path),
                failedCount:        failCount,
                hasError:           failCount > 0,
                throughput:         +(processed / elapsedSec).toFixed(1),
            });
        }
    }

    if (successIds.length > 0) {
        await imageJobManager.markImagesTransferred(successIds);
    }

    const duration    = Date.now() - startMs;
    const successRate = images.length > 0 ? Math.round((successIds.length / images.length) * 100) : 100;
    const throughput  = +(successIds.length / Math.max(1, duration / 1000)).toFixed(1);
    publishMetric(METRICS_IMG_CHANNEL, 'batch_complete', {
        jobId, processedCount: successIds.length, totalFiles: images.length,
        successRate, throughput, duration,
    });

    logger.info(`[IMAGE_PHASE] Done: ${successIds.length} transferred, ${failCount} failed`);
}

// ── Video phase ───────────────────────────────────────────────────────────────

/**
 * For each camera: fetch .issvd segments in the window, convert to .mp4, concatenate,
 * copy to USB, mark transferred, clean up temp files.
 *
 * USB path: {drive}:\videos\{camera_id}\cam_{id}_{windowStart}--{windowEnd}.mp4
 */
async function transferVideosInWindow(windowStart, windowEnd) {
    const drive        = driveRoot();
    const usbVidRoot   = path.join(drive, 'videos');
    const cameras      = config.ISS_MEDIA_CAMERAS || [];
    const wStartLabel  = formatWindowLabel(windowStart);
    const wEndLabel    = formatWindowLabel(windowEnd);

    const vidJobId = `auto-usb-vid-${Date.now()}`;
    publishMetric(METRICS_VID_CHANNEL, 'job_start', {
        jobId:        vidJobId,
        totalCameras: cameras.length,
        windowStart:  windowStart.toISOString(),
        windowEnd:    windowEnd.toISOString(),
    });

    for (const cam of cameras) {
        if (SHOULD_STOP) {
            logger.warn('[VIDEO_PHASE] USB full — skipping remaining cameras');
            break;
        }

        const cameraId      = String(cam).replace('CAM_', '');
        const tempCameraDir = path.join(TEMP_DIR, `auto_usb_cam${cameraId}_${wStartLabel}`);

        try {
            const segments = await jobManager.getVideoSegmentsInWindow(windowStart, windowEnd, cam);

            if (segments.length === 0) {
                logger.info(`[VIDEO_PHASE] cam=${cameraId}: no segments in window`);
                // Mark camera complete with 0 segments so UI shows it as done
                publishMetric(METRICS_VID_CHANNEL, 'transfer_complete', {
                    cameraId, success: true, fileName: null, segmentsCount: 0,
                });
                continue;
            }

            logger.info(`[VIDEO_PHASE] cam=${cameraId}: converting ${segments.length} segments`);
            await fs.ensureDir(tempCameraDir);

            // Initial camera progress (includes totalCameras so UI can self-initialize if job_start was missed)
            publishMetric(METRICS_VID_CHANNEL, 'camera_progress', {
                cameraId,
                convertedGroupedCount: 0,
                targetCount:           segments.length,
                progressPercentage:    0,
                totalCameras:          cameras.length,
            });

            // 1. Convert each .issvd → .mp4
            const mp4Files     = [];
            const convertedIds = [];

            for (const seg of segments) {
                const mp4Name = `${path.basename(seg.file_name, path.extname(seg.file_name))}.mp4`;
                const mp4Path = path.join(tempCameraDir, mp4Name);

                try {
                    await videoProcessor.convertToMp4(seg.file_path, mp4Path);
                    mp4Files.push(mp4Path);
                    convertedIds.push(seg.id);
                } catch (err) {
                    logger.error(`[VIDEO_PHASE] cam=${cameraId}: FFmpeg failed for ${seg.file_path}: ${err.message}`);
                }

                // Update conversion progress after each segment (include totalCameras for grid self-init)
                publishMetric(METRICS_VID_CHANNEL, 'camera_progress', {
                    cameraId,
                    convertedGroupedCount: mp4Files.length,
                    targetCount:           segments.length,
                    progressPercentage:    Math.round((mp4Files.length / segments.length) * 100),
                    totalCameras:          cameras.length,
                });
            }

            if (mp4Files.length === 0) {
                logger.warn(`[VIDEO_PHASE] cam=${cameraId}: no segments converted successfully — skipping`);
                publishMetric(METRICS_VID_CHANNEL, 'transfer_complete', {
                    cameraId, success: false,
                    error: 'All FFmpeg conversions failed', segmentsCount: segments.length,
                });
                await fs.remove(tempCameraDir).catch(() => {});
                continue;
            }

            // 2. Concatenate into one final video
            const finalName = `cam_${cameraId}_${wStartLabel}--${wEndLabel}.mp4`;
            const finalPath = path.join(tempCameraDir, finalName);

            if (mp4Files.length === 1) {
                await fs.move(mp4Files[0], finalPath, { overwrite: true });
            } else {
                await videoProcessor.concatenateMp4Files(mp4Files, finalPath);
            }

            publishMetric(METRICS_VID_CHANNEL, 'video_created', {
                cameraId, videoName: finalName, segmentsCount: mp4Files.length,
            });

            // 3. Copy to USB
            const usbDestDir  = path.join(usbVidRoot, cameraId);
            const usbDestPath = path.join(usbDestDir, finalName);
            await fs.ensureDir(usbDestDir);

            publishMetric(METRICS_VID_CHANNEL, 'transfer_start', {
                cameraId, fileName: finalName,
            });

            try {
                await copyWithRetry(finalPath, usbDestPath);
            } catch (err) {
                if (err.code === 'ENOSPC') {
                    SHOULD_STOP = true;
                    logger.error(`[VIDEO_PHASE] cam=${cameraId}: ENOSPC — USB drive is full`);
                } else {
                    logger.error(`[VIDEO_PHASE] cam=${cameraId}: copy to USB failed: ${err.message}`);
                }
                publishMetric(METRICS_VID_CHANNEL, 'transfer_complete', {
                    cameraId, success: false, fileName: finalName, error: err.message,
                });
                await fs.remove(tempCameraDir).catch(() => {});
                continue;
            }

            // 4. Mark segments whose conversion succeeded as transferred
            await jobManager.markVideoSegmentsTransferred(convertedIds);
            logger.info(`[VIDEO_PHASE] cam=${cameraId}: transferred ${finalName} (${convertedIds.length}/${segments.length} segments)`);

            publishMetric(METRICS_VID_CHANNEL, 'transfer_complete', {
                cameraId, success: true, fileName: finalName,
                segmentsCount: convertedIds.length,
            });

        } catch (err) {
            logger.error(`[VIDEO_PHASE] cam=${cameraId}: unexpected error: ${err.message}`);
            publishMetric(METRICS_VID_CHANNEL, 'transfer_complete', {
                cameraId, success: false, error: err.message,
            });
        } finally {
            await fs.remove(tempCameraDir).catch(() => {});
        }
    }
}

// ── Shared cursor state (written by each loop, read cross-loop) ───────────────

let _imgCursor = null;   // image loop writes; video loop reads to gate itself
let _vidCursor = null;   // video loop writes

// Throttled drive update: only actually queries Redis once every 5 s
let _lastDriveUpdateMs = 0;
async function updateDriveInfoThrottled() {
    if (Date.now() - _lastDriveUpdateMs < 5_000) return;
    _lastDriveUpdateMs = Date.now();
    await updateDriveInfo();
}

// ── Image loop ────────────────────────────────────────────────────────────────
// Runs as fast as possible, one 5-min window at a time.
// Never waits for the video loop.

async function runImageLoop() {
    logger.info(`[IMAGE_LOOP] Started. imgCursor: ${_imgCursor.toISOString()}`);

    while (IS_RUNNING) {
        try {
            if (!IS_TRANSFER_ACTIVE || !IS_DRIVE_CONNECTED) {
                await sleep(LOOP_SLEEP_MS); continue;
            }
            if (SHOULD_STOP) {
                await sleep(LOOP_SLEEP_MS * 30); continue;
            }

            await updateDriveInfoThrottled();

            const now        = new Date();
            const windowEnd  = new Date(_imgCursor.getTime() + WINDOW_MS);

            if (windowEnd > now) {
                // Image cursor caught up — idle until the next window is ready
                await sleep(IDLE_POLL_MS);
                continue;
            }

            logger.info(`[IMAGE_LOOP] Window [${_imgCursor.toISOString()} – ${windowEnd.toISOString()}]`);

            if (IS_IMAGE_ENABLED) {
                await transferImagesInWindow(_imgCursor, windowEnd);
            }

            if (!SHOULD_STOP) {
                _imgCursor = windowEnd;
                await saveImageCursor(_imgCursor);
            }

        } catch (err) {
            logger.error(`[IMAGE_LOOP] Unhandled error: ${err.message}`, { stack: err.stack });
            await sleep(LOOP_SLEEP_MS * 5);
        }
    }

    logger.info('[IMAGE_LOOP] Stopped.');
}

// ── Video loop ────────────────────────────────────────────────────────────────
// Follows the image cursor — never overtakes it.
// Slower due to FFmpeg; image loop races ahead independently.

async function runVideoLoop() {
    logger.info(`[VIDEO_LOOP] Started. vidCursor: ${_vidCursor.toISOString()}`);

    while (IS_RUNNING) {
        try {
            if (!IS_TRANSFER_ACTIVE || !IS_DRIVE_CONNECTED) {
                await sleep(LOOP_SLEEP_MS); continue;
            }
            if (SHOULD_STOP) {
                await sleep(LOOP_SLEEP_MS * 30); continue;
            }

            const vidWindowEnd = new Date(_vidCursor.getTime() + WINDOW_MS);

            // Wait for image cursor to be at least one window ahead
            if (vidWindowEnd > _imgCursor) {
                await sleep(LOOP_SLEEP_MS);
                continue;
            }

            logger.info(`[VIDEO_LOOP] Window [${_vidCursor.toISOString()} – ${vidWindowEnd.toISOString()}]`);

            if (IS_VIDEO_ENABLED) {
                await transferVideosInWindow(_vidCursor, vidWindowEnd);
            }

            if (!SHOULD_STOP) {
                _vidCursor = vidWindowEnd;
                await saveVideoCursor(_vidCursor);
            }

        } catch (err) {
            logger.error(`[VIDEO_LOOP] Unhandled error: ${err.message}`, { stack: err.stack });
            await sleep(LOOP_SLEEP_MS * 5);
        }
    }

    logger.info('[VIDEO_LOOP] Stopped.');
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function runLoop() {
    await fs.ensureDir(TEMP_DIR);

    _imgCursor = resolveImageCursor();
    _vidCursor = resolveVideoCursor(_imgCursor);

    logger.info(`[LOOP] Service started. imgCursor: ${_imgCursor.toISOString()}, vidCursor: ${_vidCursor.toISOString()}`);

    // Run image and video loops truly in parallel — they never block each other.
    await Promise.all([runImageLoop(), runVideoLoop()]);

    logger.info('[LOOP] Service stopped.');
}

// ── Redis Pub/Sub ─────────────────────────────────────────────────────────────

redisPubSub.subscribe(
    CONNECTED_DRIVE_LIST + '_update',
    CONFIG_STATE_KEY + '_update',
    (err, count) => {
        if (err) logger.error(`[REDIS] Subscribe error: ${err.message}`);
        else logger.info(`[REDIS] Subscribed to ${count} channel(s)`);
    }
);

redisPubSub.on('message', async (channel, message) => {
    try {
        const parsed = JSON.parse(message);

        if (channel === CONNECTED_DRIVE_LIST + '_update') {
            await updateDriveInfo();
        }

        if (channel === CONFIG_STATE_KEY + '_update') {
            if (!parsed) {
                logger.warn('[REDIS] Received null config update, skipping');
                return;
            }
            CONFIG_STATE = parsed;

            IS_TRANSFER_ACTIVE = !!(CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.isActive);

            const dataType = (CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.dataType) || 'both';
            IS_IMAGE_ENABLED = ['images', 'both'].includes(dataType);
            IS_VIDEO_ENABLED = ['videos', 'both'].includes(dataType);

            // Recalculate drive/space from fresh config
            await updateDriveInfo();

            // Log only when meaningful values actually change (config is published every 500ms)
            const configKey = `${IS_TRANSFER_ACTIVE}-${dataType}`;
            if (configKey !== _lastConfigKey) {
                logger.info(`[REDIS] Config updated — active=${IS_TRANSFER_ACTIVE} images=${IS_IMAGE_ENABLED} videos=${IS_VIDEO_ENABLED}`);
                _lastConfigKey = configKey;
            }
        }
    } catch (err) {
        logger.error(`[REDIS] Message handler error: ${err.message}`);
    }
});

// ── Startup ───────────────────────────────────────────────────────────────────

async function runService() {
    logger.info('[STARTUP] autoUSBTransferService starting...');

    // Load initial config
    const fileConfig = readConfigFile();
    if (fileConfig) {
        CONFIG_STATE = fileConfig;
        logger.info('[STARTUP] Config loaded from file');
    } else {
        try {
            const redisConfig = await redis.get(CONFIG_STATE_KEY);
            if (redisConfig) {
                CONFIG_STATE = JSON.parse(redisConfig);
                logger.info('[STARTUP] Config loaded from Redis');
            }
        } catch (err) {
            logger.warn(`[STARTUP] Could not load config from Redis: ${err.message}`);
        }
    }

    IS_TRANSFER_ACTIVE = !!(CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.isActive);
    const dataType     = (CONFIG_STATE.autoTransfer && CONFIG_STATE.autoTransfer.dataType) || 'both';
    IS_IMAGE_ENABLED   = ['images', 'both'].includes(dataType);
    IS_VIDEO_ENABLED   = ['videos', 'both'].includes(dataType);

    await updateDriveInfo();
    await saveConnectedAt();

    logger.info(`[STARTUP] active=${IS_TRANSFER_ACTIVE} images=${IS_IMAGE_ENABLED} videos=${IS_VIDEO_ENABLED} drive=${IS_DRIVE_CONNECTED}`);

    runLoop().catch(err => {
        logger.error(`[FATAL] runLoop crashed: ${err.message}`, { stack: err.stack });
        process.exit(1);
    });
}

process.on('SIGINT', async () => {
    logger.info('[SHUTDOWN] SIGINT received — stopping service');
    IS_RUNNING = false;
    await pool.end().catch(() => {});
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('[SHUTDOWN] SIGTERM received — stopping service');
    IS_RUNNING = false;
    await pool.end().catch(() => {});
    process.exit(0);
});

runService();

const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const fileTransferQueue = require('../utils/FileTransferQueueService');
const { getDriveInfo } = require('../utils/driveUtils');
const envConfig = require('../utils/envConfig');
const VideoProcessor = require('../services/video-transfer/processors/VideoProcessor');

// Lazy-init VideoProcessor (needs no event emitter for manual use).
const videoProcessor = new VideoProcessor(null, {
    ...envConfig,
    VIDEO_TEMP_DIR: envConfig.ISS_MEDIA_MANUAL_BUFFER_DIR,
    waitFileAccessTimeout: 5000,
});

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Group an ordered array of iss_media_files rows by camera into complete groups
 * of `segmentsPerVideo` each.  Partial groups (< segmentsPerVideo) are included
 * with partial=true so the operator can see them in the summary but they are
 * still converted (ffmpeg handles variable-length concat).
 *
 * Returns [{camera_id, group_key, source_file_ids, segment_count, partial}]
 */
function buildCameraGroups(rows, segmentsPerVideo) {
    const byCamera = {};
    for (const row of rows) {
        const cid = String(row.camera_id);
        if (!byCamera[cid]) byCamera[cid] = [];
        byCamera[cid].push(row);
    }
    const groups = [];
    for (const [cid, files] of Object.entries(byCamera)) {
        // Slice into chunks of segmentsPerVideo
        for (let offset = 0; offset < files.length; offset += segmentsPerVideo) {
            const chunk = files.slice(offset, offset + segmentsPerVideo);
            const first = chunk[0];
            const last  = chunk[chunk.length - 1];
            const fmtTime = t => String(t).replace(/:/g, '_').replace('.', '__');
            const dateStr = first.recording_date instanceof Date
                ? first.recording_date.toISOString().split('T')[0]
                : String(first.recording_date).split('T')[0];
            const groupKey = `cam_${cid}_${dateStr}___${fmtTime(first.precise_time || '00_00_00__000')}--${fmtTime(last.precise_time || '00_00_00__000')}`;
            groups.push({
                camera_id:       parseInt(cid),
                group_key:       groupKey,
                source_file_ids: chunk.map(f => f.id),
                segment_count:   chunk.length,
                partial:         chunk.length < segmentsPerVideo,
                source_rows:     chunk,
            });
        }
    }
    return groups;
}

function createManualTransferRouter({ logger, pool, redis, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR, emitEventToClients }) {
    const router = express.Router();

    router.post('/manual-transfer/create', async (req, res) => {
        const { startDateTime, endDateTime, usbPath, encryption, dataType = 'images' } = req.body;

        try {
            const startDate = new Date(startDateTime);
            const endDate   = new Date(endDateTime);

            const padN = n => String(n).padStart(2, '0');
            const localDate = d => `${d.getFullYear()}-${padN(d.getMonth() + 1)}-${padN(d.getDate())}`;
            const startTS = `${localDate(startDate)} ${padN(startDate.getHours())}:${padN(startDate.getMinutes())}:00.000`;
            const endTS   = `${localDate(endDate)} ${padN(endDate.getHours())}:${padN(endDate.getMinutes())}:59.999`;

            // ── Fetch source files ────────────────────────────────────────────────
            let imageRows = [];
            let videoGroups = [];
            const SEGMENTS_PER_VIDEO = envConfig.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 38;

            if (dataType === 'images' || dataType === 'both') {
                const r = await pool.query(`
                    SELECT id, file_path, file_size, file_name
                    FROM files
                    WHERE (date + time::interval) >= $1::timestamp
                      AND (date + time::interval) <= $2::timestamp
                      AND deleted = false AND file_path IS NOT NULL AND file_size IS NOT NULL
                `, [startTS, endTS]);
                imageRows = r.rows;
            }

            if (dataType === 'videos' || dataType === 'both') {
                const r = await pool.query(`
                    SELECT id, file_path, file_name, file_size, camera_id,
                           recording_date, recording_time, precise_time
                    FROM iss_media_files
                    WHERE (recording_date + precise_time::interval) >= $1::timestamp
                      AND (recording_date + precise_time::interval) <= $2::timestamp
                      AND deleted = false AND file_path IS NOT NULL AND file_size IS NOT NULL
                    ORDER BY camera_id, recording_date, precise_time
                `, [startTS, endTS]);

                // Skip segments whose hourly folder no longer exists on disk.
                // SecuROS purges old folders within hours — DB records outlive physical files.
                const uniqueFolders = [...new Set(r.rows.map(row => path.dirname(row.file_path)))];
                const folderChecks = await Promise.all(
                    uniqueFolders.map(async folder => {
                        try { await fs.access(folder, fs.constants.F_OK); return [folder, true]; }
                        catch { return [folder, false]; }
                    })
                );
                const folderExistsMap = Object.fromEntries(folderChecks);
                const liveRows = r.rows.filter(row => folderExistsMap[path.dirname(row.file_path)]);
                if (liveRows.length < r.rows.length) {
                    logger.warn(`Manual transfer create: ${r.rows.length - liveRows.length} video segments skipped — source folders purged by SecuROS`);
                }
                videoGroups = buildCameraGroups(liveRows, SEGMENTS_PER_VIDEO);
            }

            const imageCount      = imageRows.length;
            const videoGroupCount = videoGroups.length;
            const totalFiles      = imageCount + videoGroupCount;

            if (totalFiles === 0) {
                return res.status(400).json({ success: false, error: 'No files found in the selected date range.' });
            }

            // ── Create transfer_job ───────────────────────────────────────────────
            const currentDate = new Date();
            const jobResult = await pool.query(`
                INSERT INTO transfer_job
                    (start_date, start_time, end_date, end_time, usb_path, status, date, time, data_type)
                VALUES ($1::date, $2::time, $3::date, $4::time, $5, $6, $7::date, $8::time, $9)
                RETURNING id
            `, [
                localDate(startDate), startDate.toTimeString().split(' ')[0],
                localDate(endDate),   endDate.toTimeString().split(' ')[0],
                usbPath, 'in_progress',
                localDate(currentDate), currentDate.toTimeString().split(' ')[0],
                dataType
            ]);
            const transferJobId = jobResult.rows[0].id;

            // ── Populate image log (transfer_job_log) ─────────────────────────────
            if (imageRows.length > 0) {
                const fileIds      = imageRows.map(f => f.id);
                const jobIdArr     = imageRows.map(() => transferJobId);
                const transferredArr = imageRows.map(() => false);
                await pool.query(`
                    INSERT INTO transfer_job_log (file_id, transfer_job_id, transferred)
                    SELECT unnest($1::int[]), unnest($2::int[]), unnest($3::bool[])
                `, [fileIds, jobIdArr, transferredArr]);
            }

            // ── Populate video group queue ─────────────────────────────────────────
            if (videoGroups.length > 0) {
                for (const g of videoGroups) {
                    await pool.query(`
                        INSERT INTO manual_video_group_queue
                            (transfer_job_id, camera_id, group_key, source_file_ids, segment_count)
                        VALUES ($1, $2, $3, $4, $5)
                    `, [transferJobId, g.camera_id, g.group_key, g.source_file_ids, g.segment_count]);
                }
            }

            // ── Write active config ───────────────────────────────────────────────
            const totalSize = imageRows.reduce((s, f) => s + parseInt(f.file_size || 0), 0);
            const encryptionConfig = encryption || { enabled: false };
            if (encryptionConfig.enabled) {
                logger.warn(`Manual transfer job ${transferJobId}: encryption requested but not implemented — files will be copied unencrypted`);
            }

            let config = readConfig();
            config.manualTransfer = {
                jobId: transferJobId, drive: usbPath, startDateTime, endDateTime,
                dataType,
                encryption: encryptionConfig,
                createdAt: new Date().toISOString(),
                status: {
                    isPaused: false, isCancelled: false, isFinished: false,
                    totalSize, totalFiles, transferredFiles: 0,
                    // Image counters — sourced from transfer_job_log at creation
                    // so the UI shows the correct denominator immediately.
                    imageTotalFiles:       imageCount,
                    imageTransferredFiles: 0,
                    // Video-specific counters
                    videoGroupsTotal:      videoGroupCount,
                    videoGroupsConverting: 0,
                    videoGroupsConverted:  0,
                }
            };
            writeConfig(config);

            if (emitEventToClients) {
                emitEventToClients('manualTransferConfig', {
                    driveResponse: { success: false, connected: false },
                    config: config.manualTransfer,
                    transferStatus: { totalFiles, transferredFiles: 0, failedFiles: 0, pendingFiles: totalFiles, processingFiles: 0, isCompleted: false }
                });
            }

            res.json({
                success: true,
                message: 'Manual transfer job created successfully',
                jobId: transferJobId,
                summary: { total_files: totalFiles, total_size: totalSize, image_count: imageCount, video_group_count: videoGroupCount }
            });
        } catch (error) {
            logger.error('Error creating manual transfer:', error);
            res.status(500).json({ success: false, error: 'Failed to create manual transfer' });
        }
    });

    router.post('/manual-transfer/summary', async (req, res) => {
        try {
            console.log('summary', req.body);
            const { startDateTime, endDateTime, dataType = 'images' } = req.body;
            const startDate = new Date(startDateTime);
            const endDate   = new Date(endDateTime);
            const padN = n => String(n).padStart(2, '0');
            const startTS = `${startDate.getFullYear()}-${padN(startDate.getMonth() + 1)}-${padN(startDate.getDate())} ${padN(startDate.getHours())}:${padN(startDate.getMinutes())}:00.000`;
            const endTS   = `${endDate.getFullYear()}-${padN(endDate.getMonth() + 1)}-${padN(endDate.getDate())} ${padN(endDate.getHours())}:${padN(endDate.getMinutes())}:59.999`;

            // Images query — uses idx_files_date_time (date + time::interval expression).
            const imageQuery = `
                SELECT COUNT(*)::int as total_files, COALESCE(SUM(file_size), 0)::bigint as total_size
                FROM files
                WHERE (date + time::interval) >= $1::timestamp
                  AND (date + time::interval) <= $2::timestamp
                  AND deleted = false AND file_path IS NOT NULL AND file_size IS NOT NULL`;

            const SEGMENTS_PER_VIDEO = envConfig.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 38;

            /**
             * Fetch all video segments for the date range then check folder existence on
             * disk (SecuROS purges hourly folders within a few hours of recording).
             * We check unique *parent directories* rather than individual files — one
             * fs.access per hourly folder is fast even for large date ranges.
             * Returns { groups, totalSize, totalSegments, staleSegments, availableSegments }.
             */
            async function getAvailableVideoSummary(startTS, endTS) {
                const result = await pool.query(`
                    SELECT id, file_path, camera_id, file_size,
                           recording_date, recording_time, precise_time
                    FROM iss_media_files
                    WHERE (recording_date + precise_time::interval) >= $1::timestamp
                      AND (recording_date + precise_time::interval) <= $2::timestamp
                      AND deleted = false AND file_path IS NOT NULL AND file_size IS NOT NULL
                    ORDER BY camera_id, recording_date, precise_time
                `, [startTS, endTS]);

                const allRows = result.rows;
                if (allRows.length === 0) {
                    return { groups: [], totalSize: 0, totalSegments: 0, staleSegments: 0, availableSegments: 0 };
                }

                // Folder-level existence check (one check per hourly folder)
                const uniqueFolders = [...new Set(allRows.map(r => path.dirname(r.file_path)))];
                const folderChecks = await Promise.all(
                    uniqueFolders.map(async folder => {
                        try { await fs.access(folder, fs.constants.F_OK); return [folder, true]; }
                        catch { return [folder, false]; }
                    })
                );
                const folderExistsMap = Object.fromEntries(folderChecks);
                const liveRows   = allRows.filter(r => folderExistsMap[path.dirname(r.file_path)]);
                const staleRows  = allRows.filter(r => !folderExistsMap[path.dirname(r.file_path)]);

                const groups    = buildCameraGroups(liveRows, SEGMENTS_PER_VIDEO);
                const totalSize = liveRows.reduce((s, r) => s + parseInt(r.file_size || 0), 0);

                return {
                    groups,
                    totalSize,
                    totalSegments:     allRows.length,
                    staleSegments:     staleRows.length,
                    availableSegments: liveRows.length,
                };
            }

            let total_files = 0;
            let total_size  = 0;
            let extra       = {};

            if (dataType === 'images') {
                const r = await pool.query(imageQuery, [startTS, endTS]);
                total_files = parseInt(r.rows[0].total_files);
                total_size  = parseInt(r.rows[0].total_size);
            } else if (dataType === 'videos') {
                const vid = await getAvailableVideoSummary(startTS, endTS);
                total_files = vid.groups.length;
                total_size  = vid.totalSize;
                extra = {
                    segment_count:      vid.totalSegments,
                    available_segments: vid.availableSegments,
                    stale_segments:     vid.staleSegments,
                    partial_segments:   vid.groups.filter(g => g.partial).length,
                    cameras_count:      [...new Set(vid.groups.map(g => g.camera_id))].length,
                    segments_per_video: SEGMENTS_PER_VIDEO,
                };
            } else {
                const [imgR, vid] = await Promise.all([
                    pool.query(imageQuery, [startTS, endTS]),
                    getAvailableVideoSummary(startTS, endTS),
                ]);
                const vidFiles = vid.groups.length;
                total_files = parseInt(imgR.rows[0].total_files) + vidFiles;
                total_size  = parseInt(imgR.rows[0].total_size)  + vid.totalSize;
                extra = {
                    segment_count:      vid.totalSegments,
                    available_segments: vid.availableSegments,
                    stale_segments:     vid.staleSegments,
                    partial_segments:   vid.groups.filter(g => g.partial).length,
                    cameras_count:      [...new Set(vid.groups.map(g => g.camera_id))].length,
                    segments_per_video: SEGMENTS_PER_VIDEO,
                    image_files:        parseInt(imgR.rows[0].total_files),
                    video_files:        vidFiles,
                };
            }

            res.json({ success: true, summary: { total_files, total_size, ...extra } });
        } catch (error) {
            logger.error('Error getting transfer summary:', error);
            res.status(500).json({ success: false, error: 'Failed to get transfer summary' });
        }
    });

    router.post('/manual-transfer/control', async (req, res) => {
        const { action } = req.body;
        // jobId can arrive as a string from the browser; normalise to int for DB queries
        const jobId = parseInt(req.body.jobId, 10);
        if (!jobId || !action) {
            return res.status(400).json({ success: false, error: 'jobId and action are required' });
        }
        try {
            let newStatus;
            let config = readConfig();
            // Determine if this job is the currently-active one in config.
            // Use loose equality so a numeric config value matches a stringified jobId.
            const isActiveJob = config.manualTransfer &&
                // eslint-disable-next-line eqeqeq
                config.manualTransfer.jobId == jobId;

            switch (action) {
                case 'pause':
                    if (!isActiveJob) {
                        return res.status(404).json({ success: false, error: 'Job not found or not active' });
                    }
                    newStatus = 'paused';
                    config.manualTransfer.status.isPaused = true;
                    await pool.query('UPDATE transfer_job SET status = $1 WHERE id = $2', [newStatus, jobId]);
                    writeConfig(config);
                    break;

                case 'resume':
                    if (!isActiveJob) {
                        return res.status(404).json({ success: false, error: 'Job not found or not active' });
                    }
                    newStatus = 'in_progress';
                    config.manualTransfer.status.isPaused = false;
                    await pool.query('UPDATE transfer_job SET status = $1 WHERE id = $2', [newStatus, jobId]);
                    writeConfig(config);
                    break;

                case 'cancel':
                    newStatus = 'cancelled';
                    // Always do the DB-side cancellation regardless of config state.
                    await fileTransferQueue.cancelTransfers(null, 'manual', jobId);
                    await pool.query(`
                        UPDATE manual_video_group_queue
                        SET status = 'failed', error_message = 'Job cancelled', updated_at = CURRENT_TIMESTAMP
                        WHERE transfer_job_id = $1 AND status NOT IN ('transferred', 'failed')
                    `, [jobId]);
                    await pool.query('UPDATE transfer_job SET status = $1 WHERE id = $2', [newStatus, jobId]);
                    // Clear config if this is (or was) the active job.
                    if (isActiveJob) {
                        config.manualTransfer.status.isCancelled = true;
                        writeConfig(config);
                    }
                    config.manualTransfer = null;
                    writeConfig(config);
                    break;

                default:
                    return res.status(400).json({ success: false, error: 'Invalid action' });
            }

            res.json({ success: true, message: `Job ${action}ed successfully`, newStatus });
        } catch (error) {
            logger.error(`Error ${action}ing job:`, error);
            res.status(500).json({ success: false, error: `Failed to ${action} job` });
        }
    });

    router.get('/manual-transfer/history', async (req, res) => {
        try {
            const { page = 1, limit = 50, status = 'all', search = '' } = req.query;
            const offset = (page - 1) * limit;

            let whereClause = [];
            let params = [];
            let paramCount = 1;

            if (status !== 'all') {
                whereClause.push(`tj.status = $${paramCount}`);
                params.push(status);
                paramCount++;
            }
            if (search) {
                whereClause.push(`(tj.usb_path ILIKE $${paramCount} OR CAST(tj.id as TEXT) ILIKE $${paramCount})`);
                params.push(`%${search}%`);
                paramCount++;
            }
            const whereStr = whereClause.length > 0 ? 'WHERE ' + whereClause.join(' AND ') : '';

            const countQuery = `SELECT COUNT(*) FROM transfer_job tj ${whereStr}`;
            const totalCount = await pool.query(countQuery, params);

            // Image files come from transfer_job_log → files.
            // Video groups come from manual_video_group_queue.
            // Combine both in a single query using LEFT JOINs and COALESCE.
            const query = `
                SELECT
                    tj.id, tj.start_date, tj.start_time, tj.end_date, tj.end_time,
                    tj.usb_path, tj.status, tj.date, tj.time,
                    tj.data_type,
                    COALESCE(img.total_files,  0) + COALESCE(vid.total_groups, 0) AS total_files,
                    COALESCE(img.xferred_files,0) + COALESCE(vid.xferred_groups,0) AS transferred_files,
                    COALESCE(img.total_size,   0) AS total_size
                FROM transfer_job tj
                LEFT JOIN (
                    SELECT tjl.transfer_job_id,
                           COUNT(tjl.id)                                  AS total_files,
                           COUNT(CASE WHEN tjl.transferred THEN 1 END)    AS xferred_files,
                           COALESCE(SUM(f.file_size), 0)                  AS total_size
                    FROM transfer_job_log tjl
                    LEFT JOIN files f ON tjl.file_id = f.id
                    GROUP BY tjl.transfer_job_id
                ) img ON img.transfer_job_id = tj.id
                LEFT JOIN (
                    SELECT mvgq.transfer_job_id,
                           COUNT(*)                                                    AS total_groups,
                           COUNT(CASE WHEN mvgq.status = 'transferred' THEN 1 END)    AS xferred_groups
                    FROM manual_video_group_queue mvgq
                    GROUP BY mvgq.transfer_job_id
                ) vid ON vid.transfer_job_id = tj.id
                ${whereStr}
                GROUP BY tj.id, tj.start_date, tj.start_time, tj.end_date, tj.end_time,
                         tj.usb_path, tj.status, tj.date, tj.time, tj.data_type,
                         img.total_files, img.xferred_files, img.total_size,
                         vid.total_groups, vid.xferred_groups
                ORDER BY tj.date DESC, tj.time DESC
                LIMIT $${paramCount} OFFSET $${paramCount + 1}
            `;
            params.push(limit, offset);
            const result = await pool.query(query, params);

            const jobs = result.rows.map(job => ({
                id: job.id,
                date: new Date(job.date).toISOString().replace('T', ' ').substring(0, 19),
                drive: job.usb_path,
                dataType: job.data_type || 'images',
                files: { total: parseInt(job.total_files), transferred: parseInt(job.transferred_files) },
                size: parseInt(job.total_size),
                duration: Math.floor((new Date(`${job.end_date} ${job.end_time}`) - new Date(`${job.start_date} ${job.start_time}`)) / 60000),
                status: job.status
            }));

            res.json({ success: true, data: { jobs, pagination: { total: parseInt(totalCount.rows[0].count), page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(parseInt(totalCount.rows[0].count) / limit) } } });
        } catch (error) {
            logger.error('Error fetching transfer history:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch transfer history' });
        }
    });

    return router;
}

// ──────────────────────────────────────────────────────────────────────────────
// Consumer loop
// ──────────────────────────────────────────────────────────────────────────────

async function startManualFileTransferProcess({ logger, pool, emitEventToClients, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR }) {

    /** Query transfer_job_log for image progress and merge into live config status. */
    async function refreshImageCounters(config) {
        const dt = config.manualTransfer.dataType || 'images';
        if (dt !== 'images' && dt !== 'both') return;

        const r = await pool.query(`
            SELECT
                COUNT(*)::int                                          AS total,
                COUNT(CASE WHEN transferred THEN 1 END)::int          AS transferred
            FROM transfer_job_log
            WHERE transfer_job_id = $1
        `, [config.manualTransfer.jobId]);

        config.manualTransfer.status.imageTotalFiles       = r.rows[0].total;
        config.manualTransfer.status.imageTransferredFiles = r.rows[0].transferred;
    }

    /** Query manual_video_group_queue for video-phase counters and merge into live config status. */
    async function refreshVideoGroupCounters(config) {
        const dt = config.manualTransfer.dataType || 'images';
        if (dt !== 'videos' && dt !== 'both') return;

        const r = await pool.query(`
            SELECT
                COUNT(*)::int                                                     AS total,
                COUNT(CASE WHEN status = 'transferred' THEN 1 END)::int          AS transferred,
                COUNT(CASE WHEN status = 'failed'      THEN 1 END)::int          AS failed,
                COUNT(CASE WHEN status IN ('pending','converting') THEN 1 END)::int AS pending,
                COUNT(CASE WHEN status = 'converted'   THEN 1 END)::int          AS converted
            FROM manual_video_group_queue
            WHERE transfer_job_id = $1
        `, [config.manualTransfer.jobId]);

        const row = r.rows[0];
        config.manualTransfer.status.videoGroupsTotal       = row.total;
        config.manualTransfer.status.videoGroupsTransferred = row.transferred;
        config.manualTransfer.status.videoGroupsFailed      = row.failed;
        // videoGroupsConverting / videoGroupsConverted come from the conversion
        // phase itself; don't overwrite them here to avoid resetting mid-conversion.
    }

    async function sendFileTransferStatus() {
        const config = readConfig();
        if (!config.manualTransfer) return;

        let driveResponse;
        try {
            const driveInfo = await getDriveInfo(`${config.manualTransfer.drive}`);
            driveResponse = { success: true, connected: true, message: 'Drive is connected', driveInfo };
        } catch (e) {
            driveResponse = { success: false, error: 'Drive not found or not accessible', connected: false };
        }

        const transferStatus = await fileTransferQueue.getServiceTransferStatus('manual', config.manualTransfer.jobId);
        // Image progress from transfer_job_log — the authoritative source.
        // file_transfer_queue can contain stale entries from previous runs with
        // wrong file_ids; transfer_job_log is always correct.
        const imageStatus = await pool.query(`
            SELECT
                COUNT(*)::int                                          AS total,
                COUNT(CASE WHEN transferred THEN 1 END)::int          AS transferred
            FROM transfer_job_log
            WHERE transfer_job_id = $1
        `, [config.manualTransfer.jobId]);
        config.manualTransfer.status.imageTotalFiles       = imageStatus.rows[0].total;
        config.manualTransfer.status.imageTransferredFiles = imageStatus.rows[0].transferred;

        // Legacy fields kept for backward compat (not used in progress calculation)
        config.manualTransfer.status.transferredFiles = transferStatus.transferredFiles;
        config.manualTransfer.status.totalFiles       = transferStatus.totalFiles;
        // isFinished is set exclusively by the completion check in the main loop,
        // which correctly checks both transfer_job_log (images) and
        // manual_video_group_queue (videos).  Do NOT override it with
        // file_transfer_queue.isCompleted — that field becomes true as soon as
        // all queued image files transfer, even though video groups may still be
        // pending conversion (no queue entry exists for them yet).

        // Video group progress from the authoritative source
        await refreshVideoGroupCounters(config);

        emitEventToClients('manualTransferConfig', { driveResponse, config: config.manualTransfer, transferStatus });
    }

    /**
     * Video-phase: pick one pending video group, convert all its segments to mp4,
     * concatenate into a single final.mp4, then enqueue it for the copy phase.
     * Returns true if a group was processed (caller should re-enter the loop quickly),
     * false if no pending groups exist.
     */
    async function processNextVideoGroup(jobId, usbDrive) {
        // Pick next pending group for this job
        const groupResult = await pool.query(`
            SELECT id, camera_id, group_key, source_file_ids, segment_count
            FROM manual_video_group_queue
            WHERE transfer_job_id = $1 AND status = 'pending'
            ORDER BY id
            LIMIT 1
        `, [jobId]);

        if (groupResult.rows.length === 0) return false;

        const group = groupResult.rows[0];
        logger.info(`[VIDEO_MANUAL] Starting conversion for group ${group.group_key} (${group.segment_count} segs, cam ${group.camera_id})`);

        // Mark as converting
        await pool.query(`
            UPDATE manual_video_group_queue
            SET status = 'converting', updated_at = CURRENT_TIMESTAMP
            WHERE id = $1
        `, [group.id]);

        // Update config converting counter, refreshing both image and video counters
        // from DB before emitting so the UI never shows stale 0-counts from disk.
        const liveConfig = readConfig();
        if (liveConfig.manualTransfer) {
            liveConfig.manualTransfer.status.videoGroupsConverting =
                (liveConfig.manualTransfer.status.videoGroupsConverting || 0) + 1;
            writeConfig(liveConfig);
            await refreshImageCounters(liveConfig);
            await refreshVideoGroupCounters(liveConfig);
            emitEventToClients('manualTransferConfig', {
                driveResponse: { success: true, connected: true, message: 'Drive is connected' },
                config: liveConfig.manualTransfer,
                transferStatus: await fileTransferQueue.getServiceTransferStatus('manual', jobId)
            });
        }

        try {
            // Fetch source rows from iss_media_files
            const segResult = await pool.query(`
                SELECT id, file_path, file_name, camera_id, recording_date, precise_time
                FROM iss_media_files
                WHERE id = ANY($1)
                ORDER BY recording_date, precise_time
            `, [group.source_file_ids]);

            const sourceFiles = segResult.rows;
            if (sourceFiles.length === 0) {
                throw new Error('No source files found for group (deleted?)');
            }

            // Preflight: check all unique hourly folders first (fast path).
            // SecuROS purges folders within hours — if the folder is gone the
            // whole group is stale; fail instantly rather than spawning FFmpeg 38×.
            const uniqueFoldersPreflight = [...new Set(sourceFiles.map(s => path.dirname(s.file_path)))];
            const missingFolders = (await Promise.all(
                uniqueFoldersPreflight.map(async folder => {
                    try { await fs.access(folder, fs.constants.F_OK); return null; }
                    catch { return folder; }
                })
            )).filter(Boolean);
            if (missingFolders.length > 0) {
                throw new Error(`Source folder(s) purged by SecuROS: ${missingFolders.join(', ')}`);
            }

            // Individual-file preflight: SecuROS sometimes deletes individual
            // .issvd files while keeping the folder, causing FFmpeg ENOENT on
            // every spawn.  Check all files up-front and skip missing ones.
            const fileChecks = await Promise.all(
                sourceFiles.map(async seg => {
                    try { await fs.access(seg.file_path, fs.constants.F_OK); return { seg, exists: true }; }
                    catch { return { seg, exists: false }; }
                })
            );
            const missingFiles = fileChecks.filter(r => !r.exists);
            if (missingFiles.length > 0) {
                logger.warn(`[VIDEO_MANUAL] ${missingFiles.length}/${sourceFiles.length} segments missing on disk for group ${group.group_key} — purged by SecuROS`, {
                    missingFiles: missingFiles.map(r => r.seg.file_name),
                });
            }
            const liveSourceFiles = fileChecks.filter(r => r.exists).map(r => r.seg);
            if (liveSourceFiles.length === 0) {
                throw new Error(`All ${sourceFiles.length} segments purged from disk by SecuROS — no files to convert`);
            }

            // Temp directory: {BUFFER_DIR}/manual_{jobId}/cam_{cameraId}/
            // Uses a dedicated directory so auto-transfer cleanup services cannot
            // delete in-progress manual conversion files.
            const BUFFER_DIR = envConfig.ISS_MEDIA_MANUAL_BUFFER_DIR;
            const tempDir = path.join(BUFFER_DIR, `manual_${jobId}`, `cam_${group.camera_id}`);
            await fs.ensureDir(tempDir);

            // Convert each surviving .issvd segment to .mp4
            const convertedPaths = [];
            for (const seg of liveSourceFiles) {
                // Honour pause / cancel inside the conversion loop
                const cfg = readConfig();
                if (!cfg.manualTransfer || cfg.manualTransfer.status.isPaused || cfg.manualTransfer.status.isCancelled) {
                    logger.info(`[VIDEO_MANUAL] Conversion paused/cancelled mid-group ${group.group_key}`);
                    await pool.query(`
                        UPDATE manual_video_group_queue
                        SET status = 'pending', updated_at = CURRENT_TIMESTAMP
                        WHERE id = $1
                    `, [group.id]);
                    return false;
                }
                try {
                    const bufferRecord = { converted_file_name: path.basename(seg.file_name, '.issvd') + '.mp4' };
                    const mp4Path = await videoProcessor.convertSingleFile(seg, bufferRecord, tempDir);
                    convertedPaths.push(mp4Path);
                    logger.info(`[VIDEO_MANUAL] Converted segment ${seg.file_name} → ${path.basename(mp4Path)}`);
                } catch (convErr) {
                    logger.error(`[VIDEO_MANUAL] Failed to convert segment ${seg.file_name}: ${convErr.message}`);
                    // Continue with remaining segments — partial group still transfers
                }
            }

            if (convertedPaths.length === 0) {
                throw new Error('All segments failed to convert');
            }

            // Concatenate into final .mp4
            const finalVideoName = group.group_key.endsWith('.mp4') ? group.group_key : `${group.group_key}.mp4`;
            const finalVideoPath = path.join(tempDir, finalVideoName);
            const videoResult = await videoProcessor.createFinalVideo(convertedPaths, finalVideoPath, finalVideoName, group.group_key);

            if (!videoResult) {
                throw new Error('Concatenation failed — createFinalVideo returned null');
            }

            // Clean up individual segment mp4 files (keep only the final)
            for (const p of convertedPaths) {
                try { await fs.unlink(p); } catch (_) {}
            }

            // Mark group as converted and save path
            await pool.query(`
                UPDATE manual_video_group_queue
                SET status = 'converted', converted_video_path = $2, converted_video_name = $3,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [group.id, videoResult.videoPath, finalVideoName]);

            // Destination: {drive}\transfer\{jobId}\videos
            const _driveBase = /^[A-Za-z]:$/.test(usbDrive) ? usbDrive + path.sep : usbDrive;
            const destinationPath = path.join(_driveBase, 'transfer', String(jobId), 'videos');

            // Add the final .mp4 to file_transfer_queue for the copy phase.
            // file_id is NULL because the source is iss_media_files, not files.
            await fileTransferQueue.addVideoToQueue({
                file_path:        videoResult.videoPath,
                file_size:        videoResult.fileSize,
                file_name:        finalVideoName,
                video_group_id:   group.id,
                camera_id:        group.camera_id,
            }, 'manual', 4, destinationPath, jobId);

            logger.info(`[VIDEO_MANUAL] Group ${group.group_key} converted and queued for copy (${(videoResult.fileSize / 1024 / 1024).toFixed(1)} MB)`);

            // Update config counters
            const afterCfg = readConfig();
            if (afterCfg.manualTransfer) {
                afterCfg.manualTransfer.status.videoGroupsConverting =
                    Math.max(0, (afterCfg.manualTransfer.status.videoGroupsConverting || 0) - 1);
                afterCfg.manualTransfer.status.videoGroupsConverted =
                    (afterCfg.manualTransfer.status.videoGroupsConverted || 0) + 1;
                writeConfig(afterCfg);
            }

            return true;

        } catch (err) {
            logger.error(`[VIDEO_MANUAL] Group ${group.group_key} failed: ${err.message}`);
            await pool.query(`
                UPDATE manual_video_group_queue
                SET status = 'failed', error_message = $2, updated_at = CURRENT_TIMESTAMP
                WHERE id = $1
            `, [group.id, err.message]);

            const errCfg = readConfig();
            if (errCfg.manualTransfer) {
                errCfg.manualTransfer.status.videoGroupsConverting =
                    Math.max(0, (errCfg.manualTransfer.status.videoGroupsConverting || 0) - 1);
                writeConfig(errCfg);
            }
            return true; // processed (failed), move on to next group
        }
    }

    // Tracks the currently running background video conversion so image
    // copying can proceed concurrently during FFmpeg execution.
    let activeConversionPromise = null;
    // Prevents the recovery phase from re-running on every 1-second tick.
    // It runs once when a new jobId is first seen (server start / new job).
    let lastRecoveryJobId = null;

    try {
        while (true) {
            await sendFileTransferStatus();
            const config = readConfig();

            if (!config.manualTransfer || !config.manualTransfer.jobId ||
                config.manualTransfer.status.isFinished || config.manualTransfer.status.isCancelled) {
                activeConversionPromise = null;
                await sleep(5000);
                continue;
            }

            if (config.manualTransfer.status.isPaused) {
                await sleep(5000);
                continue;
            }

            const { jobId, drive } = config.manualTransfer;

            // ── RECOVERY PHASE (once per job) ─────────────────────────────────────
            // Runs only when a new jobId is first seen (server start or new job).
            // Must NOT run every tick — it resets 'converting' rows to 'pending',
            // which would kill a background FFmpeg conversion mid-flight.
            if (jobId !== lastRecoveryJobId) {
                lastRecoveryJobId = jobId;

                // 0. Reset any groups stuck in 'converting' — these were left behind by
                //    a server restart that killed FFmpeg mid-run.  Reset them to 'pending'
                //    so the main loop will reconvert them.
                await pool.query(`
                    UPDATE manual_video_group_queue
                    SET status = 'pending', converted_video_path = NULL,
                        converted_video_name = NULL, error_message = NULL,
                        updated_at = NOW()
                    WHERE transfer_job_id = $1 AND status = 'converting'
                `, [jobId]);

                // 1. Re-queue groups that were converted but whose queue entry was never
                // created (e.g., the DB insert failed in a prior run, or the service
                // restarted after conversion but before the copy phase ran).
                // This is idempotent: the NOT EXISTS guard prevents double-queuing.
                const recoverableGroups = await pool.query(`
                    SELECT mvgq.*
                    FROM manual_video_group_queue mvgq
                    WHERE mvgq.transfer_job_id = $1
                      AND mvgq.status = 'converted'
                      AND mvgq.converted_video_path IS NOT NULL
                      AND NOT EXISTS (
                          SELECT 1 FROM file_transfer_queue ftq
                          WHERE ftq.transfer_job_id = $1
                            AND ftq.metadata->>'video_group_id' = mvgq.id::text
                            AND ftq.status NOT IN ('failed', 'cancelled')
                      )
                    ORDER BY mvgq.id
                    LIMIT 5
                `, [jobId]);

                for (const grp of recoverableGroups.rows) {
                    let fileExists = false;
                    try { await fs.access(grp.converted_video_path); fileExists = true; } catch (_) {}

                    if (fileExists) {
                        // File is on disk — re-queue for copy without reconversion.
                        try {
                            const stat = await fs.stat(grp.converted_video_path);
                            const _driveBase = /^[A-Za-z]:$/.test(drive) ? drive + path.sep : drive;
                            const destPath = path.join(_driveBase, 'transfer', String(jobId), 'videos');

                            await fileTransferQueue.addVideoToQueue({
                                file_path:      grp.converted_video_path,
                                file_size:      stat.size,
                                file_name:      grp.converted_video_name,
                                video_group_id: grp.id,
                                camera_id:      grp.camera_id,
                            }, 'manual', 4, destPath, jobId);

                            logger.info(`[VIDEO_MANUAL] Recovery: re-queued group ${grp.group_key} for copy`);
                        } catch (qErr) {
                            logger.warn(`[VIDEO_MANUAL] Recovery: failed to re-queue ${grp.group_key}: ${qErr.message}`);
                        }
                    } else {
                        // File was deleted by an external process — reset to pending so it
                        // gets reconverted using the dedicated manual buffer directory.
                        await pool.query(`
                            UPDATE manual_video_group_queue
                            SET status = 'pending', converted_video_path = NULL,
                                converted_video_name = NULL, error_message = NULL,
                                updated_at = NOW()
                            WHERE id = $1
                        `, [grp.id]);
                        logger.warn(`[VIDEO_MANUAL] Recovery: group ${grp.group_key} mp4 was deleted externally — resetting to pending for reconversion`);
                    }
                }
            }

            // ── VIDEO PHASE (non-blocking) ────────────────────────────────────────
            // Start the next pending video group conversion in the background so
            // image copying runs concurrently during FFmpeg execution.
            // Only one conversion runs at a time; activeConversionPromise gates it.
            if (!activeConversionPromise) {
                const hasPending = await pool.query(`
                    SELECT 1 FROM manual_video_group_queue
                    WHERE transfer_job_id = $1 AND status = 'pending'
                    LIMIT 1
                `, [jobId]);
                if (hasPending.rows.length > 0) {
                    activeConversionPromise = processNextVideoGroup(jobId, drive)
                        .catch(err => logger.error(`[VIDEO_MANUAL] Background conversion error: ${err.message}`))
                        .finally(() => { activeConversionPromise = null; });
                }
            }

            // ── IMAGE QUEUE POPULATION ────────────────────────────────────────────
            // Load any images from transfer_job_log that are not yet pending or
            // processing in file_transfer_queue.  Matching on file_id+job_id means
            // stale entries with wrong file_ids (from previous buggy runs) are
            // ignored — those images will be re-queued correctly.
            const dataType = config.manualTransfer.dataType || 'images';

            if (dataType === 'images' || dataType === 'both') {
                const result = await pool.query(`
                    SELECT f.id, f.file_path, f.file_size, f.file_name, tj.usb_path
                    FROM transfer_job tj
                    JOIN transfer_job_log tjl ON tj.id = tjl.transfer_job_id
                    JOIN files f ON tjl.file_id = f.id
                    WHERE tjl.transfer_job_id = $1
                      AND tjl.transferred = false
                      AND f.deleted = false
                      AND NOT EXISTS (
                          SELECT 1 FROM file_transfer_queue ftq
                          WHERE ftq.file_id = tjl.file_id
                            AND ftq.transfer_job_id = tjl.transfer_job_id
                            AND ftq.status IN ('pending', 'processing')
                      )
                    LIMIT 500
                `, [jobId]);

                if (result.rows.length > 0) {
                    const filesToQueue = result.rows.map(row => ({
                        id: row.id, file_path: row.file_path, file_size: row.file_size, file_name: row.file_name
                    }));
                    const _driveBase = /^[A-Za-z]:$/.test(result.rows[0].usb_path) ? result.rows[0].usb_path + path.sep : result.rows[0].usb_path;
                    const destinationPath = path.join(_driveBase, 'transfer', String(jobId), 'images');
                    await fileTransferQueue.addFilesToQueue(filesToQueue, 'manual', 3, destinationPath, jobId);
                    logger.info(`Queued ${filesToQueue.length} image files for manual transfer job ${jobId}`);
                }
            }

            // ── COPY PHASE ────────────────────────────────────────────────────────
            // Query pending files scoped to THIS job to avoid being blocked by
            // stale pending entries from previous/other jobs in the shared queue.
            const pendingResult = await pool.query(`
                SELECT id, service_type, file_id, file_path, file_size, file_name,
                       destination_path, priority, batch_id, transfer_job_id, metadata, created_at
                FROM file_transfer_queue
                WHERE status = 'pending'
                  AND service_type = 'manual'
                  AND transfer_job_id = $1
                ORDER BY priority DESC, created_at ASC
                LIMIT 10
            `, [jobId]);
            const jobPendingFiles = pendingResult.rows;

            if (jobPendingFiles.length > 0) {
                const batchIds = jobPendingFiles.map(f => f.id);
                await fileTransferQueue.markFilesAsProcessing(batchIds);
                const ensuredDirs = new Set();

                for (const file of jobPendingFiles) {
                    const liveConfig = readConfig();
                    if (!liveConfig.manualTransfer ||
                        liveConfig.manualTransfer.status.isPaused ||
                        liveConfig.manualTransfer.status.isCancelled) break;

                    try {
                        const destRoot = /^[A-Za-z]:$/.test(file.destination_path)
                            ? file.destination_path + path.sep
                            : file.destination_path;
                        const dest    = path.join(destRoot, file.file_name);
                        const destDir = path.dirname(dest);
                        if (!ensuredDirs.has(destDir) && !/^[A-Za-z]:[/\\]$/.test(destDir)) {
                            await fs.ensureDir(destDir);
                            ensuredDirs.add(destDir);
                        }
                        await fs.copy(file.file_path, dest);
                        await fileTransferQueue.markFilesAsTransferred([file.id]);

                        // If this was a video group entry, mark group as transferred
                        // and clean up the temp .mp4 file.
                        if (file.metadata) {
                            let meta;
                            try { meta = typeof file.metadata === 'string' ? JSON.parse(file.metadata) : file.metadata; } catch (_) {}
                            if (meta && meta.video_group_id) {
                                await pool.query(`
                                    UPDATE manual_video_group_queue
                                    SET status = 'transferred', updated_at = CURRENT_TIMESTAMP
                                    WHERE id = $1
                                `, [meta.video_group_id]);
                                try { await fs.unlink(file.file_path); } catch (_) {}
                                logger.info(`[VIDEO_MANUAL] Group ${meta.video_group_id} copied to USB — temp file removed`);
                            }
                        }

                        logger.info(`Copied ${file.file_name} -> ${dest}`);
                    } catch (copyErr) {
                        await fileTransferQueue.markFilesAsFailed([file.id], copyErr.message);
                        logger.error(`Failed to copy ${file.file_name}: ${copyErr.message}`);
                    }
                }

                // Emit updated progress immediately after the batch.
                // Refresh BOTH image and video counters from their authoritative
                // sources so this emit never contradicts the periodic timer emit.
                const batchStatus = await fileTransferQueue.getServiceTransferStatus('manual', jobId);
                const liveConfig = readConfig();
                if (liveConfig.manualTransfer) {
                    liveConfig.manualTransfer.status.transferredFiles = batchStatus.transferredFiles;
                    liveConfig.manualTransfer.status.totalFiles       = batchStatus.totalFiles;
                    await refreshImageCounters(liveConfig);
                    await refreshVideoGroupCounters(liveConfig);
                    emitEventToClients('manualTransferConfig', {
                        driveResponse: { success: true, connected: true, message: 'Drive is connected' },
                        config: liveConfig.manualTransfer,
                        transferStatus: batchStatus
                    });
                }
            }

            // ── COMPLETION CHECK ──────────────────────────────────────────────────
            // Skip while a background conversion is still running — the group is
            // 'converting' in the DB (counts as pending) but activeConversionPromise
            // not yet null means FFmpeg hasn't finished yet.
            // A job is done when:
            //  1. No video groups remain pending/converting
            //  2. All images in transfer_job_log are marked transferred (for image/both jobs)
            //     Using transfer_job_log as the authoritative source prevents false-complete
            //     triggered by stale file_transfer_queue entries from previous runs.
            if (!activeConversionPromise) {
                const pendingVideoGroups = await pool.query(`
                    SELECT COUNT(*) FROM manual_video_group_queue
                    WHERE transfer_job_id = $1 AND status NOT IN ('transferred', 'failed')
                `, [jobId]);
                const stillHasVideoWork = parseInt(pendingVideoGroups.rows[0].count) > 0;

                // Check image completion via transfer_job_log
                let imagesAllDone = true;
                if (dataType === 'images' || dataType === 'both') {
                    const imgRemaining = await pool.query(`
                        SELECT COUNT(*)::int AS cnt FROM transfer_job_log
                        WHERE transfer_job_id = $1 AND transferred = false
                    `, [jobId]);
                    imagesAllDone = imgRemaining.rows[0].cnt === 0;
                }

                if (!stillHasVideoWork && imagesAllDone) {
                    // Count what actually transferred to decide completed vs failed
                    const updatedStatus = await fileTransferQueue.getServiceTransferStatus('manual', jobId);
                    const imgXferred = await pool.query(`
                        SELECT COUNT(*)::int AS cnt FROM transfer_job_log
                        WHERE transfer_job_id = $1 AND transferred = true
                    `, [jobId]);
                    const anyTransferred = updatedStatus.transferredFiles > 0 || imgXferred.rows[0].cnt > 0;
                    const finalStatus = anyTransferred ? 'completed' : 'failed';
                    const cfg = readConfig();
                    cfg.manualTransfer.status.isFinished = true;
                    writeConfig(cfg);
                    await pool.query('UPDATE transfer_job SET status = $1 WHERE id = $2', [finalStatus, jobId]);
                    logger.info(`Manual transfer job ${jobId} ${finalStatus}: ${updatedStatus.transferredFiles} queue items + ${imgXferred.rows[0].cnt} images transferred`);
                    cfg.manualTransfer = null;
                    writeConfig(cfg);
                    emitEventToClients('manualTransferConfig', { driveResponse: null, config: null, finalStatus });
                }
            } // end if (!activeConversionPromise) completion-check guard

            await sleep(1000);
        }
    } catch (error) {
        logger.error('Error in manual file transfer process:', error);
        await sleep(5000);
        startManualFileTransferProcess({ logger, pool, emitEventToClients, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR });
    }
}

module.exports = { createManualTransferRouter, startManualFileTransferProcess };

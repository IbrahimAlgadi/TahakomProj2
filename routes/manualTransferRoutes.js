const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const fileTransferQueue = require('../utils/FileTransferQueueService');
const { getDriveInfo } = require('../utils/driveUtils');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function createManualTransferRouter({ logger, pool, redis, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR, emitEventToClients }) {
    const router = express.Router();



    router.post('/manual-transfer/create', async (req, res) => {
        const { startDateTime, endDateTime, usbPath, encryption } = req.body;
    
        try {
            await pool.query('BEGIN');
    
            const startDate = new Date(startDateTime);
            const endDate = new Date(endDateTime);
            
            const startTS = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')} ${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}:00.000`;
            const endTS = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')} ${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:59.999`;
            
            // Same indexed expression as the summary query — avoids full table scan.
            const filesResult = await pool.query(`
                SELECT id, file_path, file_size, file_name FROM files
                WHERE (date + time::interval) >= $1::timestamp
                  AND (date + time::interval) <= $2::timestamp
                  AND deleted = false AND file_path IS NOT NULL AND file_size IS NOT NULL
            `, [startTS, endTS]);
    
            const currentDate = new Date();
            const padN = n => String(n).padStart(2, '0');
            const localDate = d => `${d.getFullYear()}-${padN(d.getMonth() + 1)}-${padN(d.getDate())}`;
            const jobResult = await pool.query(`
                INSERT INTO transfer_job (start_date, start_time, end_date, end_time, usb_path, status, date, time) 
                VALUES ($1::date, $2::time, $3::date, $4::time, $5, $6, $7::date, $8::time) RETURNING id
            `, [
                localDate(startDate), startDate.toTimeString().split(' ')[0],
                localDate(endDate),   endDate.toTimeString().split(' ')[0],
                usbPath, 'in_progress',
                localDate(currentDate), currentDate.toTimeString().split(' ')[0]
            ]);
    
            const transferJobId = jobResult.rows[0].id;
            await pool.query('COMMIT');
    
            await pool.query('BEGIN');
            for (const file of filesResult.rows) {
                await pool.query(`INSERT INTO transfer_job_log (file_id, transfer_job_id, transferred) VALUES ($1, $2, false)`, [file.id, transferJobId]);
            }
            await pool.query('COMMIT');
    
            const totalFiles = filesResult.rows.length;
            const totalSize = filesResult.rows.reduce((sum, file) => sum + parseInt(file.file_size || 0), 0);
    
            const encryptionConfig = encryption || { enabled: false };
            if (encryptionConfig.enabled) {
                logger.warn(`Manual transfer job ${transferJobId}: encryption requested but not implemented in queue path — files will be copied unencrypted`);
            }

            let config = readConfig();
            config.manualTransfer = {
                jobId: transferJobId, drive: usbPath, startDateTime, endDateTime,
                encryption: encryptionConfig,
                createdAt: new Date().toISOString(),
                status: { isPaused: false, totalSize, transferredFiles: 0, totalFiles, isFinished: false, isCancelled: false }
            };
            writeConfig(config);

            // Immediately notify connected clients so the active job card appears
            // without waiting for the next 5-second loop iteration.
            if (emitEventToClients) {
                emitEventToClients('manualTransferConfig', {
                    driveResponse: { success: false, connected: false },
                    config: config.manualTransfer,
                    transferStatus: { totalFiles, transferredFiles: 0, failedFiles: 0, pendingFiles: totalFiles, processingFiles: 0, isCompleted: false }
                });
            }
    
            res.json({ success: true, message: 'Manual transfer job created successfully', jobId: transferJobId, summary: { total_files: totalFiles, total_size: totalSize } });
        } catch (error) {
            await pool.query('ROLLBACK');
            logger.error('Error creating manual transfer:', error);
            res.status(500).json({ success: false, error: 'Failed to create manual transfer' });
        }
    });

    router.post('/manual-transfer/summary', async (req, res) => {
        try {
            console.log('summary', req.body);
            const { startDateTime, endDateTime } = req.body;
            const startDate = new Date(startDateTime);
            const endDate = new Date(endDateTime);
            const startTS = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}-${String(startDate.getDate()).padStart(2, '0')} ${String(startDate.getHours()).padStart(2, '0')}:${String(startDate.getMinutes()).padStart(2, '0')}:00.000`;
            const endTS = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')} ${String(endDate.getHours()).padStart(2, '0')}:${String(endDate.getMinutes()).padStart(2, '0')}:59.999`;
            
            // Use the (date + time::interval) expression that matches idx_files_date_time
            // so PostgreSQL uses the index instead of a full table scan.
            const result = await pool.query(`
                SELECT COUNT(*) as total_files, SUM(file_size) as total_size FROM files
                WHERE (date + time::interval) >= $1::timestamp
                  AND (date + time::interval) <= $2::timestamp
                  AND deleted = false AND file_path IS NOT NULL AND file_size IS NOT NULL
            `, [startTS, endTS]);
            res.json({ success: true, summary: result.rows[0] });
        } catch (error) {
            logger.error('Error getting transfer summary:', error);
            res.status(500).json({ success: false, error: 'Failed to get transfer summary' });
        }
    });

    // Config route moved to mainConfigRoutes.js for centralized configuration management

    router.post('/manual-transfer/control', async (req, res) => {
        const { jobId, action } = req.body;
        console.log('control', jobId, action);
        try {
            let newStatus;
            let config = readConfig();
            if (config.manualTransfer && config.manualTransfer.jobId === jobId) {
                switch (action) {
                    case 'pause': 
                        newStatus = 'paused'; 
                        config.manualTransfer.status.isPaused = true; 
                        break;
                    case 'resume': 
                        newStatus = 'in_progress'; 
                        config.manualTransfer.status.isPaused = false; 
                        break;
                    case 'cancel': 
                        newStatus = 'cancelled'; 
                        config.manualTransfer.status.isCancelled = true;
                        // Cancel all pending transfers for this job
                        await fileTransferQueue.cancelTransfers(null, 'manual', jobId);
                        break;
                    default: 
                        throw new Error('Invalid action');
                }
                await pool.query('UPDATE transfer_job SET status = $1 WHERE id = $2', [newStatus, jobId]);
                writeConfig(config);
                if (action === 'cancel') {
                    config.manualTransfer = null;
                    writeConfig(config);
                }
                res.json({ success: true, message: `Job ${action}ed successfully`, newStatus });
            } else {
                res.status(404).json({ success: false, error: 'Job not found in config' });
            }
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

            const query = `
                SELECT tj.id, tj.start_date, tj.start_time, tj.end_date, tj.end_time, tj.usb_path, tj.status, tj.date, tj.time,
                       COUNT(tjl.id) as total_files, COUNT(CASE WHEN tjl.transferred THEN 1 END) as transferred_files,
                       COALESCE(SUM(f.file_size), 0) as total_size
                FROM transfer_job tj
                LEFT JOIN transfer_job_log tjl ON tj.id = tjl.transfer_job_id
                LEFT JOIN files f ON tjl.file_id = f.id
                ${whereStr}
                GROUP BY tj.id, tj.start_date, tj.start_time, tj.end_date, tj.end_time, tj.usb_path, tj.status, tj.date, tj.time
                ORDER BY tj.date DESC, tj.time DESC
                LIMIT $${paramCount} OFFSET $${paramCount + 1}
            `;
            params.push(limit, offset);
            const result = await pool.query(query, params);

            const jobs = result.rows.map(job => ({
                id: job.id,
                date: new Date(job.date).toISOString().replace('T', ' ').substring(0, 19),
                drive: job.usb_path,
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

async function startManualFileTransferProcess({ logger, pool, emitEventToClients, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR }) {
    
    async function sendFileTransferStatus() {
        const config = readConfig();
        if (!config.manualTransfer) return;
        
        let driveResponse;
        try {
            let driveInfo = await getDriveInfo(`${config.manualTransfer.drive}`);
            driveResponse = { success: true, connected: true, message: 'Drive is connected', driveInfo };
        } catch(e) {
            driveResponse = { success: false, error: 'Drive not found or not accessible', connected: false };
        }
        
        // Get transfer status from queue
        const transferStatus = await fileTransferQueue.getServiceTransferStatus('manual', config.manualTransfer.jobId);
        
        // Update config with current status
        config.manualTransfer.status.transferredFiles = transferStatus.transferredFiles;
        config.manualTransfer.status.totalFiles = transferStatus.totalFiles;
        config.manualTransfer.status.isFinished = transferStatus.isCompleted;
        
        emitEventToClients('manualTransferConfig', { driveResponse, config: config.manualTransfer, transferStatus });
    }

    try {
        while (true) {
            await sendFileTransferStatus();
            const config = readConfig();
            
            if (!config.manualTransfer || !config.manualTransfer.jobId || config.manualTransfer.status.isFinished || config.manualTransfer.status.isCancelled) {
                await sleep(5000);
                continue;
            }

            if (config.manualTransfer.status.isPaused) {
                await sleep(5000);
                continue;
            }

            const { jobId } = config.manualTransfer;

            // Check if files are already queued for this job
            const queueStatus = await fileTransferQueue.getServiceTransferStatus('manual', jobId);
            
            if (queueStatus.totalFiles === 0) {
                // Queue files for manual transfer
                const result = await pool.query(`
                    SELECT f.id, f.file_path, f.file_size, f.file_name, tj.usb_path
                    FROM transfer_job tj
                    LEFT JOIN transfer_job_log tjl ON tj.id = tjl.transfer_job_id  
                    LEFT JOIN files f ON tjl.file_id = f.id
                    WHERE tjl.transfer_job_id = $1 AND tjl.transferred = false AND f.deleted = false
                    LIMIT 1000
                `, [jobId]);

                if (result.rows.length > 0) {
                    const filesToQueue = result.rows.map(row => ({
                        id: row.id,
                        file_path: row.file_path,
                        file_size: row.file_size,
                        file_name: row.file_name
                    }));

                    // Build a dated subfolder that matches what the UI summary displays.
                    const _padDest = n => String(n).padStart(2, '0');
                    const _now = new Date();
                    const _localDateStr = `${_now.getFullYear()}-${_padDest(_now.getMonth() + 1)}-${_padDest(_now.getDate())}`;
                    const _driveBase = /^[A-Za-z]:$/.test(result.rows[0].usb_path)
                        ? result.rows[0].usb_path + path.sep
                        : result.rows[0].usb_path;
                    const destinationPath = path.join(_driveBase, 'transfer', _localDateStr);

                    await fileTransferQueue.addFilesToQueue(
                        filesToQueue,
                        'manual',
                        3,
                        destinationPath,
                        jobId
                    );

                    logger.info(`Queued ${filesToQueue.length} files for manual transfer job ${jobId}`);
                }
            }

            // Process pending files from the queue (MI-A: consumer that was missing).
            // Batch capped at 10 files so each iteration stays short (fast USB ≈ 1 s, slow ≈ 5 s).
            const pendingBatch = await fileTransferQueue.getNextFilesToTransfer(10);
            const jobPendingFiles = pendingBatch.filter(
                f => f.service_type === 'manual' && String(f.transfer_job_id) === String(jobId)
            );

            if (jobPendingFiles.length > 0) {
                const batchIds = jobPendingFiles.map(f => f.id);
                await fileTransferQueue.markFilesAsProcessing(batchIds);

                // Cache successfully ensured directories so we don't hit the OS on every file.
                const ensuredDirs = new Set();

                for (const file of jobPendingFiles) {
                    // Honour pause / cancel without waiting for the next loop iteration.
                    const liveConfig = readConfig();
                    if (
                        !liveConfig.manualTransfer ||
                        liveConfig.manualTransfer.status.isPaused ||
                        liveConfig.manualTransfer.status.isCancelled
                    ) break;

                    try {
                        // Normalize bare Windows drive letters ('G:' → 'G:\') so path.join
                        // produces an absolute root path, not a relative drive-cwd path.
                        const destRoot = /^[A-Za-z]:$/.test(file.destination_path)
                            ? file.destination_path + path.sep
                            : file.destination_path;
                        const dest = path.join(destRoot, file.file_name);
                        const destDir = path.dirname(dest);
                        // fs.ensureDir on a Windows drive root ('G:\') throws EPERM because
                        // drive roots always exist and cannot be mkdir'd.  Skip it for roots.
                        if (!ensuredDirs.has(destDir) && !/^[A-Za-z]:[/\\]$/.test(destDir)) {
                            await fs.ensureDir(destDir);
                            ensuredDirs.add(destDir);
                        }
                        await fs.copy(file.file_path, dest);
                        await fileTransferQueue.markFilesAsTransferred([file.id]);
                        logger.info(`Copied ${file.file_name} -> ${dest}`);
                    } catch (copyErr) {
                        await fileTransferQueue.markFilesAsFailed([file.id], copyErr.message);
                        logger.error(`Failed to copy ${file.file_name}: ${copyErr.message}`);
                    }
                }

                // Emit updated progress immediately after the batch so the UI reflects the
                // copies without waiting for the next iteration's sendFileTransferStatus().
                const batchStatus = await fileTransferQueue.getServiceTransferStatus('manual', jobId);
                const liveConfig = readConfig();
                if (liveConfig.manualTransfer) {
                    liveConfig.manualTransfer.status.transferredFiles = batchStatus.transferredFiles;
                    liveConfig.manualTransfer.status.totalFiles = batchStatus.totalFiles;
                    emitEventToClients('manualTransferConfig', {
                        driveResponse: { success: true, connected: true, message: 'Drive is connected' },
                        config: liveConfig.manualTransfer,
                        transferStatus: batchStatus
                    });
                }
            }

            // Check if transfer is complete (guard: totalFiles > 0 prevents false-positive when queue is empty)
            const updatedStatus = await fileTransferQueue.getServiceTransferStatus('manual', jobId);
            if (updatedStatus.isCompleted && updatedStatus.totalFiles > 0) {
                // If no files were actually transferred, the job failed (e.g. all copies errored).
                // Mark accordingly so history shows the real outcome, not a misleading 'completed'.
                const finalStatus = updatedStatus.transferredFiles > 0 ? 'completed' : 'failed';
                const cfg = readConfig();
                cfg.manualTransfer.status.isFinished = true;
                writeConfig(cfg);
                await pool.query('UPDATE transfer_job SET status = $1 WHERE id = $2', [finalStatus, jobId]);
                logger.info(`Manual transfer job ${jobId} ${finalStatus}: ${updatedStatus.transferredFiles}/${updatedStatus.totalFiles} transferred, ${updatedStatus.failedFiles} failed`);
                // Clear active job from config so the loop returns to idle and the UI active card disappears.
                cfg.manualTransfer = null;
                writeConfig(cfg);
                // Notify clients immediately — they will clear the active card and reload history.
                emitEventToClients('manualTransferConfig', { driveResponse: null, config: null, finalStatus });
            }

            await sleep(1000);
        }
    } catch (error) {
        logger.error('Error in manual file transfer process:', error);
        await sleep(5000);
        startManualFileTransferProcess({ logger, pool, emitEventToClients, readConfig, writeConfig, ROOT_DIR, EXPORT_DIR });
    }
}

module.exports = { createManualTransferRouter, startManualFileTransferProcess }; 
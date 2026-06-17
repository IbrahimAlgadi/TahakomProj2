const express = require('express');
const si = require('systeminformation');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { CONFIG_STATE_KEY, CONNECTED_DRIVE_STATE, CONNECTED_DRIVE_LIST_UPDATE } = require('../redisKeyStore.js');
const { checkActiveBatches, calculateBatchStats } = require('../utils/batchUtils.js');

// Job management functions
async function checkActiveJob(pool, origin = 'auto') {
    const result = await pool.query(`
        SELECT * FROM transfer_queue_job 
        WHERE batch_origin = $1 AND status IN ('pending', 'transferring', 'paused') 
        ORDER BY created_at DESC 
        LIMIT 1
    `, [origin]);
    
    return result.rows.length > 0 ? result.rows[0] : null;
}

async function createTransferJob(pool, origin = 'auto') {
    const batchId = uuidv4();
    const result = await pool.query(`
        INSERT INTO transfer_queue_job (batch_id, batch_origin, status) 
        VALUES ($1, $2, 'pending') 
        RETURNING *
    `, [batchId, origin]);
    
    return result.rows[0];
}

async function updateJobStats(pool, jobId) {
    await pool.query(`
        UPDATE transfer_queue_job 
        SET 
            total_files = (SELECT COUNT(*) FROM transfer_queue WHERE job_id = $1),
            total_size = (SELECT COALESCE(SUM(file_size), 0) FROM transfer_queue WHERE job_id = $1),
            transferred_files = (SELECT COUNT(*) FROM transfer_queue WHERE job_id = $1 AND status = 'transferred'),
            transferred_size = (SELECT COALESCE(SUM(file_size), 0) FROM transfer_queue WHERE job_id = $1 AND status = 'transferred'),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = $1
    `, [jobId]);
}

async function updateJobStatus(pool, jobId, status, errorMessage = null) {
    const updateFields = { status, updated_at: 'CURRENT_TIMESTAMP' };
    
    if (status === 'transferring' && !errorMessage) {
        updateFields.started_at = 'CURRENT_TIMESTAMP';
    } else if (status === 'transferred') {
        updateFields.completed_at = 'CURRENT_TIMESTAMP';
    }
    
    const setClause = Object.keys(updateFields).map((key, index) => 
        key === 'updated_at' || key === 'started_at' || key === 'completed_at' 
            ? `${key} = CURRENT_TIMESTAMP` 
            : `${key} = $${index + 2}`
    ).join(', ');
    
    const values = [jobId, ...Object.values(updateFields).filter(v => v !== 'CURRENT_TIMESTAMP')];
    
    if (errorMessage) {
        values.push(errorMessage);
        setClause += `, error_message = $${values.length}`;
    }
    
    await pool.query(`UPDATE transfer_queue_job SET ${setClause} WHERE id = $1`, values);
}

const QUEUE_NAMES = {
    IMAGE_FILE_TRANSFER_QUEUE: 'image_file_transfer_queue',
    IMAGE_FILE_TRANSFER_RESULT_QUEUE: 'image_file_transfer_result_queue',
};

const autoTransferStatus = {
    'COPY_PAUSE': 'COPY_PAUSE',
    'COPY_SUCCESS': 'COPY_SUCCESS',
    'COPY_ERROR': 'COPY_ERROR',
    'DRIVE_NOT_CONNECTED': 'DRIVE_NOT_CONNECTED',
    'TRANSFER_STOPPED': 'TRANSFER_STOPPED'
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getDriveInfo(driveLetter) {
    try {
        const data = await si.fsSize(driveLetter);
        if (!data || data.length === 0) {
            throw new Error(`Drive ${driveLetter} not found or not accessible.`);
        }
        const fs = data[0];
        return {
            drive: driveLetter,
            totalSpace: fs.size,
            usedSpace: fs.used,
            remainingSpace: fs.available,
            usedPercentage: fs.use,
            type: fs.type,
            readWrite: fs.rw
        };
    } catch (error) {
        throw error;
    }
}

function createAutoTransferRouter({ logger, redis, writeConfig, emitEventToClients, readConfig }) {
    console.log('createAutoTransferRouter');

    const router = express.Router();

    // All auto-transfer config routes moved to mainConfigRoutes.js for centralized configuration management
    // This router now only handles non-config auto-transfer functionality if needed in the future

    return router;
}

let state = {
    isDriveConnected: false,
    isAutoTransferActive: true,
    shouldStopTransfer: false,
    driveInfo: {},
    isWaitingResponse: false,
};

function setupAutoTransferListeners({ wss, logger, redisPubSub, emitEventToClients, readConfig }) {
    
    wss.on('connection', ws => {
        ws.on('message', message => {
            try {
                const data = JSON.parse(message);
                if (data.action === 'subscribe' && data.event === 'autoTransfer') {
                    // Could send initial state here if needed
                    logger.info('Client subscribed to autoTransfer updates');
                }
                if (data.action === 'subscribe' && data.event === 'transferMetrics') {
                    logger.info('Client subscribed to transfer metrics updates');
                }
            } catch (error) {
                logger.error('Error processing WebSocket message for auto-transfer:', error);
            }
        });
    });

    // Subscribe to existing channels plus transfer metrics
    redisPubSub.subscribe(
        CONNECTED_DRIVE_STATE + '_update', 
        CONFIG_STATE_KEY + '_update',
        'usb_image_transfer_metrics',
        'usb_video_transfer_metrics',
        'transfer_progress_update',
        (err, count) => {
            if (err) return logger.error('Failed to subscribe to auto-transfer channels: %s', err.message);
            logger.info(`Subscribed successfully to auto-transfer channels! Listening on ${count} channels.`);
        }
    );

    redisPubSub.on('message', async (channel, message) => {
        try {
            const parsedMessage = JSON.parse(message);
            
            if (channel === CONNECTED_DRIVE_STATE + '_update') {
                state.driveInfo = parsedMessage;
                state.isDriveConnected = parsedMessage.isConnected;
                const config = readConfig();
                const stopPercentage = config.autoTransfer.stopPercentage || 95;
                state.shouldStopTransfer = stopPercentage <= (parsedMessage.usedPercentage || 0);
            }
            else if (channel === CONFIG_STATE_KEY + '_update') {
                state.isAutoTransferActive = parsedMessage.autoTransfer.isActive;
            }
            else if (channel === 'usb_image_transfer_metrics') {
                // Relay image transfer metrics to WebSocket clients
                emitEventToClients('imageTransferMetrics', parsedMessage);
                logger.debug('Relayed image transfer metrics to clients');
            }
            else if (channel === 'usb_video_transfer_metrics') {
                // Relay video transfer metrics to WebSocket clients
                emitEventToClients('videoTransferMetrics', parsedMessage);
                logger.debug('Relayed video transfer metrics to clients');
            }
            else if (channel === 'transfer_progress_update') {
                // Relay general transfer progress to WebSocket clients
                emitEventToClients('transferProgress', parsedMessage);
                logger.debug('Relayed transfer progress to clients');
            }
        } catch (error) {
            logger.error(`Error processing Redis message on channel ${channel}:`, error);
        }
    });
}

async function startAutoTransferProcess({ logger, pool, redis, emitEventToClients }) {
    
    async function getFilesToTransfer() {
        let query = `
            SELECT 
                ARRAY_AGG(f.id) AS ids, 
                ARRAY_AGG(f.tid) AS tids, 
                plate_num, 
                site_id,
                date_folder, 
                time_folder, 
                ARRAY_AGG(f.file_path) AS file_paths,
                ARRAY_AGG(f.file_size) AS file_sizes, 
                ARRAY_AGG(f.file_name) AS file_names
            FROM public.files f
            WHERE f.deleted = false 
            GROUP BY f.plate_num, f.site_id, f.date_folder, f.time_folder
            HAVING 
                BOOL_AND(f.file_size > 0) 
                AND BOOL_OR(NOT COALESCE(f.is_auto_transferred, false))
            ORDER BY 
                TO_TIMESTAMP(MIN(f.date)::text || ' ' || MIN(f.time)::text, 'YYYY-MM-DD HH24:MI:SS') DESC
            LIMIT 1000;
        `;
        const result = await pool.query(query);
        return result.rows;
    }

    async function createTransferBatch(filesToCopy, job) {
        const insertPromises = [];
        
        for (const row of filesToCopy) {
            const { ids, file_paths, file_sizes, file_names } = row;
            
            for (let i = 0; i < file_paths.length; i++) {
                // const fileExtension = path.extname(file_names[i]).toLowerCase();
                const fileType = 'image';
                
                const insertQuery = `
                    INSERT INTO transfer_queue 
                    (file_id, file_path, file_size, file_type, file_origin, status, job_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7)
                    RETURNING id;
                `;
                
                insertPromises.push(
                    pool.query(insertQuery, [
                        ids[i],
                        file_paths[i],
                        file_sizes[i],
                        fileType,
                        'auto',
                        'pending',
                        job.id
                    ])
                );
            }
        }
        
        await Promise.all(insertPromises);
        
        // Update job statistics
        await updateJobStats(pool, job.id);
        
        return job.batch_id;
    }

    while (true) {
        // console.log(state);
        try {
            if (!state.isAutoTransferActive) {
                emitEventToClients('handleAutoTransfer', { success: false, response: { result: { return_event: autoTransferStatus.TRANSFER_STOPPED, msg: "Auto transfer is not active.", data: {} } } });
                await sleep(5000);
                continue;
            }

            if (!state.isDriveConnected) {
                emitEventToClients('handleAutoTransfer', { success: false, response: { result: { return_event: autoTransferStatus.DRIVE_NOT_CONNECTED, msg: "Drive is not connected.", data: {} } } });
                await sleep(5000);
                continue;
            }

            if (state.shouldStopTransfer) {
                emitEventToClients('handleAutoTransfer', { success: true, response: { result: { return_event: autoTransferStatus.COPY_PAUSE, msg: "Stop threshold reached.", data: { driveInfo: state.driveInfo } } } });
                await sleep(5000);
                continue;
            }

            // Check if there's an active transfer job
            const activeJob = await checkActiveJob(pool, 'auto');
            if (activeJob) {
                // Update job stats to get current progress
                await updateJobStats(pool, activeJob.id);
                
                const updatedJob = await pool.query('SELECT * FROM transfer_queue_job WHERE id = $1', [activeJob.id]);
                const jobData = updatedJob.rows[0];
                
                // Create appropriate message based on job status
                let message, returnEvent;
                if (jobData.status === 'paused') {
                    message = `Job ${jobData.batch_id} PAUSED (${jobData.error_message || 'Drive disconnected'}): ${jobData.transferred_files}/${jobData.total_files} files transferred.`;
                    returnEvent = autoTransferStatus.COPY_PAUSE;
                } else {
                    message = `Active job ${jobData.batch_id}: ${jobData.transferred_files}/${jobData.total_files} files transferred.`;
                    returnEvent = autoTransferStatus.COPY_PAUSE;
                }

                emitEventToClients('handleAutoTransfer', { 
                    success: true, 
                    response: { 
                        result: { 
                            return_event: returnEvent, 
                            msg: message, 
                            data: { 
                                driveInfo: state.driveInfo,
                                activeJob: jobData,
                                transferredFiles: jobData.transferred_files,
                                totalFiles: jobData.total_files,
                                transferredSize: jobData.transferred_size,
                                totalSize: jobData.total_size,
                                isPaused: jobData.status === 'paused'
                            } 
                        } 
                    } 
                });
                await sleep(5000); // Check again in 5 seconds
                continue;
            }

            const filesToCopy = await getFilesToTransfer();
            if (filesToCopy.length === 0) {
                emitEventToClients('handleAutoTransfer', { 
                    success: true, 
                    response: { 
                        result: { 
                            return_event: autoTransferStatus.COPY_PAUSE, 
                            msg: "No new files to transfer.", 
                            data: { driveInfo: state.driveInfo } 
                        } 
                    } 
                });
                await sleep(10000); // Wait longer if idle
                continue;
            }

            // Calculate batch statistics
            const { totalFiles, totalSize } = calculateBatchStats(filesToCopy);

            // Create new transfer job
            const job = await createTransferJob(pool, 'auto');

            // Create batch in database
            const batchId = await createTransferBatch(filesToCopy, job);

            // Update job status to 'transferring'
            await updateJobStatus(pool, job.id, 'transferring');

            emitEventToClients('handleAutoTransfer', { 
                success: true, 
                response: { 
                    result: { 
                        return_event: autoTransferStatus.COPY_SUCCESS, 
                        msg: `Created job ${batchId} with ${filesToCopy.length} groups (${totalFiles} files, ${(totalSize/1024/1024).toFixed(2)} MB).`, 
                        data: { 
                            driveInfo: state.driveInfo, 
                            jobId: job.id,
                            batchId,
                            totalFiles,
                            totalSize
                        } 
                    } 
                } 
            });

            logger.info(`Created transfer job ${job.id} (${batchId}) with ${filesToCopy.length} groups (${totalFiles} files).`);
            
            await sleep(2000);

        } catch (error) {
            logger.error('Error in auto-transfer process:', error);
            emitEventToClients('handleAutoTransfer', { success: false, response: { result: { return_event: autoTransferStatus.COPY_ERROR, msg: error.message, data: {} } } });
            await sleep(5000);
        }
    }
}


module.exports = { 
    createAutoTransferRouter, 
    setupAutoTransferListeners, 
    startAutoTransferProcess,
    checkActiveJob,
    createTransferJob,
    updateJobStats,
    updateJobStatus
};
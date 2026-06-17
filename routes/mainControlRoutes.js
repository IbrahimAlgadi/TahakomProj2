const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const si = require('systeminformation');

// Helper function to get drive info
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

function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const value = (bytes / Math.pow(1024, i)).toFixed(2);
    return `${value} ${sizes[i]}`;
}

async function getFileSystemSize(pool) {
    const query = `SELECT SUM(file_size) AS total_size_bytes FROM files WHERE deleted = false;`;
    const result = await pool.query(query);
    return result.rows[0].total_size_bytes;
}

function createMainControlRouter({ logger, pool, readConfig, writeConfig, EXPORT_DIR }) {
    const router = express.Router();

    // Page rendering routes
    router.get('/', async (req, res) => {
        let sizeInBytes = await getFileSystemSize(pool);
        let fileSystemSize = sizeInBytes ? formatFileSize(sizeInBytes) : "0KB";
        res.render('index', { req, fileSystemSize });
    });
    router.get('/transfer', (req, res) => res.render('transfer', { req }));
    router.get('/auto_transfer', (req, res) => res.render('auto_transfer', { req }));
    router.get('/auto_transfer_video', (req, res) => res.render('auto_transfer_video', { req }));
    router.get('/ftp_transfer', (req, res) => res.render('ftp_transfer', { req }));
    router.get('/manual_usb', (req, res) => res.render('manual_usb', { req }));
    router.get('/devices', (req, res) => res.render('devices', { req }));
    router.get('/process_monitor', (req, res) => res.render('process_monitor', { req }));
    router.get('/dashboard', (req, res) => res.render('dashboard', { req }));

    // Config routes moved to mainConfigRoutes.js for centralization

    router.get('/files/data', async (req, res) => {
        try {
            const pageSize = parseInt(req.query.pageSize) || 10;
            const pageNumber = parseInt(req.query.pageNumber) || 1;
            const searchQuery = req.query.search || '';
            const startDate = req.query.startDate || '1970-01-01 00:00:00';
            const endDate = req.query.endDate || '9999-12-31 23:59:59';
            const showMissing = (req.query.showMissing || '').toLowerCase() === 'true';
    
            const whereConditions = `
                ($1 = '' OR LOWER(plate_num) LIKE LOWER($1))
                AND TO_TIMESTAMP(date::text || ' ' || time::text, 'YYYY-MM-DD HH24:MI:SS') >= TO_TIMESTAMP($2, 'YYYY-MM-DD HH24:MI:SS')
                AND TO_TIMESTAMP(date::text || ' ' || time::text, 'YYYY-MM-DD HH24:MI:SS') <= TO_TIMESTAMP($3, 'YYYY-MM-DD HH24:MI:SS')
                AND deleted = false
            `;
            const havingClause = showMissing ? 'HAVING bool_or(file_size = 0)' : '';
            const dataQuery = `
                WITH grouped_files AS (
                    SELECT SUBSTRING(tid, 1, LENGTH(tid)-1) as base_tid, plate_num, site_id, date_folder, time_folder, MIN(date) as date, MIN(time) as time
                    FROM files WHERE ${whereConditions}
                    GROUP BY SUBSTRING(tid, 1, LENGTH(tid)-1), plate_num, site_id, date_folder, time_folder
                    ${havingClause}
                    ORDER BY MIN(date) DESC, MIN(time) DESC
                    LIMIT $4 OFFSET $5
                )
                SELECT gf.*, array_agg(f.tid) AS tid, array_agg(f.file_path) AS file_paths, array_agg(f.file_size) AS file_sizes, array_agg(f.file_name) AS file_names, array_agg(f.deleted) AS deletions, array_agg(f.is_auto_transferred) AS auto_transfers, array_agg(f.is_ftp_transferred) AS ftp_transfers
                FROM grouped_files gf JOIN files f ON SUBSTRING(f.tid, 1, LENGTH(f.tid)-1) = gf.base_tid
                GROUP BY gf.base_tid, gf.plate_num, gf.site_id, gf.date_folder, gf.time_folder, gf.date, gf.time
                ORDER BY gf.date DESC, gf.time DESC
            `;
            const countQuery = `
                SELECT COUNT(DISTINCT SUBSTRING(tid, 1, LENGTH(tid)-1)) as total
                FROM files WHERE ${whereConditions} ${showMissing ? 'AND file_size = 0' : ''}
            `;
    
            const [dataResult, countResult] = await Promise.all([
                pool.query(dataQuery, [searchQuery ? `%${searchQuery}%` : '', startDate, endDate, pageSize, (pageNumber - 1) * pageSize]),
                pool.query(countQuery, [searchQuery ? `%${searchQuery}%` : '', startDate, endDate])
            ]);
    
            const totalRecords = parseInt(countResult.rows[0].total, 10);
            res.json({
                data: dataResult.rows, pageSize: pageSize, pageNumber: pageNumber,
                recordsTotal: totalRecords, recordsFiltered: totalRecords
            });
        } catch (error) {
            logger.error('Error on /files/data endpoint:', error);
            res.status(500).send('Internal Server Error');
        }
    });

    router.get('/files/size', async (req, res) => {
        let sizeInBytes = await getFileSystemSize(pool);
        let fileSystemSize = sizeInBytes ? formatFileSize(sizeInBytes) : "0KB";
        const config = readConfig();
        const maxSize = config.storage.maxCapacity + " GB";
        res.json({ 'exportDirSize': fileSystemSize, 'maxExportDirSize': maxSize });
    });

    router.get('/transfer/list', async (req, res) => {
        try {
            const result = await pool.query(`
                SELECT tj.*, SUM(f.file_size) AS total_data_size, COUNT(tjl.id) AS total_files, COUNT(CASE WHEN tjl.transferred = true THEN 1 END) AS total_transferred_files
                FROM public.transfer_job tj
                LEFT JOIN public.transfer_job_log tjl ON tj.id = tjl.transfer_job_id
                LEFT JOIN public.files f ON tjl.file_id = f.id AND f.deleted = false
                GROUP BY tj.id
                ORDER BY tj.id DESC;
            `);
            res.json(result.rows);
        } catch (error) {
            logger.error('Error on /transfer/list endpoint:', error);
            res.status(500).send('Internal Server Error');
        }
    });

    router.post('/transfer/create/new', async (req, res) => {
        try {
            const { startDate, endDate, carPlate, usbPath } = req.body;
            let jobResult = await pool.query(
                'INSERT INTO transfer_job (start_date, start_time, end_date, end_time, car_plate, usb_path, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
                [startDate.split(" ")[0], startDate.split(" ")[1], endDate.split(" ")[0], endDate.split(" ")[1], carPlate, usbPath, "pending"]
            );
            const transferJobId = jobResult.rows[0].id;
            let query = `
                SELECT id FROM files
                WHERE ($1 = '' OR file_name ILIKE $1)
                AND TO_TIMESTAMP(date::text || ' ' || time::text, 'YYYY-MM-DD HH24:MI:SS') >= TO_TIMESTAMP($2, 'YYYY-MM-DD HH24:MI:SS')
                AND TO_TIMESTAMP(date::text || ' ' || time::text, 'YYYY-MM-DD HH24:MI:SS') <= TO_TIMESTAMP($3, 'YYYY-MM-DD HH24:MI:SS')
                AND deleted = false;
            `;
            const result = await pool.query(query, [carPlate ? `%${carPlate}%` : '', startDate, endDate]);
            await pool.query('BEGIN');
            const insertLogQuery = 'INSERT INTO transfer_job_log (file_id, transfer_job_id, transferred) VALUES ($1, $2, $3)';
            for (const row of result.rows) {
                await pool.query(insertLogQuery, [row.id, transferJobId, false]);
            }
            await pool.query('COMMIT');
            res.status(201).send({ "status": "success" });
        } catch (error) {
            logger.error('Error on /transfer/start endpoint:', error);
            res.status(500).send('Internal Server Error');
        }
    });

    // Auto-transfer routes moved to mainConfigRoutes.js for centralization

    return router;
}

async function startStorageTransfer(params, { pool, emitEventToClients, EXPORT_DIR, logger }) {
    try {
        const { transferJobId } = params;
        let query = `
            SELECT tjl.id, tj.usb_path, f.file_path
            FROM public.transfer_job tj
            LEFT JOIN public.transfer_job_log tjl on tj.id = tjl.transfer_job_id  
            LEFT JOIN public.files f ON tjl.file_id = f.id AND f.deleted = false
            WHERE tjl.transfer_job_id = $1 AND tjl.transferred = false
        `;
        let result = await pool.query(query, [transferJobId]);

        for (const row of result.rows) {
            const { id, file_path, usb_path } = row;
            const relativePath = path.relative(EXPORT_DIR, file_path);
            const destinationPath = path.join(usb_path, relativePath);

            try {
                await fs.ensureDir(path.dirname(destinationPath));
                await fs.copy(file_path, destinationPath);
                logger.info(`Copied: ${file_path} to ${destinationPath}`);
                await pool.query(`UPDATE public.transfer_job_log SET transferred=true WHERE id=$1;`, [id]);
                
                let progressResult = await pool.query(`
                    SELECT tj.*, SUM(f.file_size) AS total_data_size, COUNT(tjl.id) AS total_files, COUNT(CASE WHEN tjl.transferred = true THEN 1 END) AS total_transferred_files
                    FROM public.transfer_job tj
                    LEFT JOIN public.transfer_job_log tjl ON tj.id = tjl.transfer_job_id
                    LEFT JOIN public.files f ON tjl.file_id = f.id AND f.deleted = false
                    GROUP BY tj.id ORDER BY tj.id DESC;
                `);
                emitEventToClients('startStorageTransferProgress', { 'success': true, 'table': progressResult.rows });
            } catch (error) {
                logger.error(`Error copying file ${file_path}:`, error);
                emitEventToClients('startStorageTransferProgress', { 'success': false });
                break;
            }
        }
        emitEventToClients('startStorageTransferDone', { 'success': true });
    } catch (error) {
        logger.error('Error in startStorageTransfer:', error);
        emitEventToClients('startStorageTransferProgress', { 'success': false });
    }
}

function setupMainControlListeners({ wss, logger, pool, emitEventToClients, EXPORT_DIR, SECUROS_CORE }) {
    
    wss.on('connection', (ws) => {
        ws.on('message', (message) => {
            try {
                let receivedData = JSON.parse(message);
                const { action, params } = receivedData;
                if (action === 'startStorageTransfer') {
                    startStorageTransfer(params, { pool, emitEventToClients, EXPORT_DIR, logger });
                }
            } catch (error) {
                logger.error('Invalid WebSocket message format:', error);
            }
        });
    });

    // if (SECUROS_CORE) {
    //     const AUTO_TRANSFER_API_OBJECT_TYPE = 'AUTO_TRANSFER';
    //     const AUTO_TRANSFER_API_OBJECT_ID = 'AUTO_TRANSFER';
    //     const AUTO_TRANSFER_RETURN_EVENT = 'AUTO_TRANSFER_STATUS';
        
    //     SECUROS_CORE.registerEventHandler(AUTO_TRANSFER_API_OBJECT_TYPE, AUTO_TRANSFER_API_OBJECT_ID, AUTO_TRANSFER_RETURN_EVENT, (e) => {
    //         emitEventToClients('handleAutoTransfer', { 'success': true, 'response': e.params.api });
    //     });
    // }
}


module.exports = { createMainControlRouter, setupMainControlListeners }; 
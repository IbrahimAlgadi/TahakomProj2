/**
 * Take Screen Shot From Multiple Camera Streams
 * Configured by LPR_CAM id
 * Configure image_export_ids to load balance exporting functionality
 * BASE_PATH: Identify the base directory where the image files will be stored.
 */
const securos = require("securos");
const uuid = require('uuid');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

let ROOT_DIR = 'D:\\ISS\\SA\\6_Tahakom\\TahakomDataTransfer2026\\VideoTransferApp\\VideoTransferApp\\app';


let SECUROS_CORE = null;
let SITE_ID = '';
let BASE_PATH = '';

// Database configuration
const DB_USER = "postgres";
const DB_PASSWORD = "postgres";
const DB_HOST = "localhost";
const DB_APP = "tahakom_transfer";

// Database pool
const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD,

    // Connection pool settings
    max: 10,                    // Reduced from potential default of 10
    min: 2,                    // Minimum idle connections
    idleTimeoutMillis: 30000,  // Close idle connections after 30s
    connectionTimeoutMillis: 5000, // Fail fast on connection issues
    statement_timeout: 30000,   // 30s timeout for long queries
    query_timeout: 25000,      // 25s query timeout
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
});

// Function to read configuration
function readConfig() {
    const CONFIG_FILE_PATH = path.join(ROOT_DIR, 'data_transfer_v2', 'dataTransferConfig.json');
    console.log(CONFIG_FILE_PATH);
    try {
        if (fs.existsSync(CONFIG_FILE_PATH)) {
            const config = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
            return config;
        }
        return null;
    } catch (error) {
        console.error('Error reading config:', error);
        return null;
    }
}

// Load configuration
function loadConfig() {
    const config = readConfig();
    if (config) {
        SITE_ID = config.storage.siteId || '';
        BASE_PATH = config.storage.directory || '';
        console.log(`Loaded configuration - SITE_ID: ${SITE_ID}, BASE_PATH: ${BASE_PATH}`);
    } else {
        console.error('Failed to load configuration');
    }
}

/**
 * Direct Database Handler (replaces microservice communication)
 */
class DirectDatabaseHandler {
    async insertFileToDatabase(fileObject) {
        console.log('[*] Called insertFileToDatabase: ', fileObject);

        const client = await pool.connect();

        const fields = [
            'tid', 'date_folder', 'time_folder', 'plate_num', 'cam_id',
            'file_path', 'deleted', 'is_auto_transferred', 'file_size',
            'file_name', 'site_id', 'date', 'time', 'export_params'
        ];

        const values = fields.map(field => 
            fileObject[field] !== undefined ? fileObject[field] : 
            field === 'deleted' ? false : null
        );

        try {
            const query = `
                INSERT INTO files (${fields.join(', ')})
                VALUES (${fields.map((_, i) => `$${i + 1}`).join(', ')}) 
                ON CONFLICT (file_path) DO UPDATE SET 
                    file_size = EXCLUDED.file_size
                RETURNING ${fields.join(', ')}
            `;

            const res = await client.query(query, values);
            console.log('Inserted/Updated File:', res.rows[0]);
            return res.rows[0];

        } catch (error) {
            console.error('Error inserting file to database:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async setFileDeleted(fileObject) {
        const client = await pool.connect();
        try {
            const query = `
                UPDATE files 
                SET deleted = TRUE 
                WHERE file_path = $1 
                RETURNING *;
            `;
            const res = await client.query(query, [fileObject.file_path]);
            return { fileObjectResult: res.rows[0] };
        } catch (error) {
            console.error('Error setting file as deleted:', error);
            throw error;
        } finally {
            client.release();
        }
    }

    async getFileSystemSize() {
        const client = await pool.connect();
        try {
            const query = `
                SELECT 
                    SUM(file_size) AS total_size_bytes 
                FROM files WHERE deleted = false;
            `;
            const res = await client.query(query);
            const result = res.rows[0].total_size_bytes;
            
            const formatFileSize = (bytes) => {
                if (bytes === 0) return '0 Bytes';
                const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
                const i = Math.floor(Math.log(bytes) / Math.log(1024));
                const value = (bytes / Math.pow(1024, i)).toFixed(2);
                return `${value} ${sizes[i]}`;
            };

            const fileSystemSize = result ? formatFileSize(result) : "0KB";
            return { fileSystemSize };
        } catch (error) {
            console.error('Error getting file system size:', error);
            throw error;
        } finally {
            client.release();
        }
    }
}

/**
 * LPR Camera Configuration
 */
let LPR_CAM = {
    '1': {
        'cam_ids': [
            {
                id: '1',
                format: 'jpg',
                quality: 50
            },
            {
                id: '2',
                format: 'jpg',
                quality: 70
            },
            {
                id: '7',
                format: 'jpg',
                quality: 50
            }
        ]
    },
    '2': {
        'cam_ids': [
            {
                id: '3',
                format: 'jpg',
                quality: 50
            },
            {
                id: '4',
                format: 'jpg',
                quality: 70
            },
            {
                id: '7',
                format: 'jpg',
                quality: 50
            }
        ]
    },
    '3': {
        'cam_ids': [
            {
                id: '5',
                format: 'jpg',
                quality: 50
            },
            {
                id: '6',
                format: 'jpg',
                quality: 70
            },
            {
                id: '7',
                format: 'jpg',
                quality: 50
            }
        ]
    }
}

/**
 * Image Export Configuration
 */
let IMAGE_EXPORTS = {}

async function loadImageExports(core) {
    let IMAGE_EXPORT_IDS = await core.getObjectsIds('IMAGE_EXPORT');
    for (const id of IMAGE_EXPORT_IDS) {
        IMAGE_EXPORTS[id] = IMAGE_EXPORTS[id] || { queue_size: 0, queue_load: 'NORMAL' };
    }
    console.log("[*] Load image exports: ")
    console.log(IMAGE_EXPORTS);
}

/**
 * Find the smallest image export queue size source ID.
 * Prefers exporters whose queue_load is not 'OVER'. When all exporters are
 * OVER the function falls back to the least-loaded one so dispatching never
 * stops due to transient overload. NaN queue sizes (missing event params) are
 * treated as 0 so they are always selectable and never cause null to be returned.
 * @param {Object} imageExports - Image export configuration
 * @returns {string|null} Smallest queue size source ID, or null if map is empty
 */
function findSmallestImageExportQueueSizeSourceId(imageExports) {
    let best = { id: null, size: Infinity };      // prefers queue_load !== 'OVER'
    let fallback = { id: null, size: Infinity };   // any exporter, ignores OVER status

    Object.entries(imageExports).forEach(([sourceId, data]) => {
        let queueSize = parseInt(data.queue_size);
        if (Number.isNaN(queueSize)) queueSize = 0;
        if (queueSize < fallback.size) fallback = { id: sourceId, size: queueSize };
        if (data.queue_load !== 'OVER' && queueSize < best.size) best = { id: sourceId, size: queueSize };
    });

    // Use a healthy exporter if one exists; fall back to least-loaded when all are OVER
    return best.id ?? fallback.id;
}

/**
 * Get today's date in YYYY-MM-DD format
 * @returns {string} Today's date
 */
function getTodayDate() {
    const today = new Date();
    const year = today.getFullYear();
    const month = String(today.getMonth() + 1).padStart(2, '0');
    const day = String(today.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * Format date string
 * @param {string} dateStr - Date string
 * @returns {string} Formatted date string
 */
function formatDateString(dateStr) {
    // Split the input date string by the hyphen
    const [day, month, year] = dateStr.split('-');

    // Return the date in 'YYYY-MM-DD' format
    return `${year}-${month}-${day}`;
}

/**
 * Get the current time in HH-MM-SS-sss format
 * @returns {string} Current time
 */
function getCurrentTime() {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const milliseconds = String(now.getMilliseconds()).padStart(3, '0');
    return `${hours}-${minutes}-${seconds}-${milliseconds}`;
}

/**
 * Create directory if it does not exist
 * @param {string} dirPath - Directory path
 */
function createDirectoryIfNotExists(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
        console.log(`Directory created: ${dirPath}`);
    } else {
        console.log(`Directory already exists: ${dirPath}`);
    }
}

/**
 * Get today's directory
 * @returns {Array<string>} Directory path, today's date, and current time
 */
function getTodayDirectory() {
    const todayDate = getTodayDate();
    const currentTime = getCurrentTime();
    const directoryPath = path.join(BASE_PATH, SITE_ID, todayDate, currentTime);

    // Create the directory if it does not exist
    createDirectoryIfNotExists(directoryPath);

    // console.log(directoryPath);
    return [
        directoryPath,
        todayDate, 
        currentTime
    ];
}

/**
 * Sleep for a specified amount of time
 * @param {number} ms - Time in milliseconds
 * @returns {Promise<void>} Resolves after the specified time
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Transform date-time string
 * @param {string} dateTimeString - Date-time string
 * @returns {string} Transformed date-time string
 */
function transformDateTimeString(dateTimeString) {
    /**
     * This function will transform time 
     * from the format  24-05-2024 15:49:58.607
     * to the format    24_05_2024__15_49_58_607
    */
    // Replace characters to match the desired format
    const transformedString = dateTimeString.replace(/[-:. ]/g, '_').replace(/__/, '__');
    return transformedString;
}

/**
 * Replace ? with x in the license plate
 * @param {string} fileLicensePlate - License plate string
 * @returns {string} License plate string with ? replaced with x
 */
function replaceMissingLetters(fileLicensePlate) {
    /**
     * This function help to handle the following case:
     * Image:  1234__24_05_2024_16_13_41_480__LPR Cam2__2766-?-KWT.jpg
     * Image:  1234__24_05_2024_16_13_41_480__LPR Cam2__2766-x-KWT.jpg
     * Image:  1234__24_05_2024_16_13_45_934__LPR_CAM2_Dubai__75034-??-KWT.jpg
     * Image:  1234__24_05_2024_16_13_45_934__LPR_CAM2_Dubai__75034-xx-KWT.jpg
     */
    fileLicensePlate = fileLicensePlate.replace(/\?/g, 'x');
    fileLicensePlate = fileLicensePlate.replace('|', '__');
    return fileLicensePlate.replace(/\?/g, 'x');
}

/**
 * Handle image export events and update queue sizes
 * @param {Object} e - Event object
 */
async function handleImageExportEvent(e) {
    if (e.action === 'EXPORT_DONE') {
        IMAGE_EXPORTS[e.sourceId].queue_size = parseInt(e.params.queue_size);
    }

    if (e.action === 'TASK_QUEUE_OVERLOADED') {
        IMAGE_EXPORTS[e.sourceId].queue_load = 'OVER'
    } 

    if (e.action === 'TASK_QUEUE_UNDERLOADED') {
        IMAGE_EXPORTS[e.sourceId].queue_load = 'NORMAL'
    }
    // try {
    //     // e.sourceId,
    //     // e.action,
    //     IMAGE_EXPORTS[e.sourceId].queue_size = parseInt(e.params.queue_size);
    //     console.log(e.action)
    // } catch(err) {
    //     console.log(err);
    // }
}

/**
 * Create file name based on camera and plate information
 * @param {string} timestamp - Timestamp
 * @param {string} cameraName - Camera name
 * @param {string} plateNumber - Plate number
 * @param {string} format - Image format
 * @returns {string} File name
 */
function createFileName(timestamp, cameraName, plateNumber, format) {
    const date_time_folder = transformDateTimeString(timestamp);
    let file_name = `${SITE_ID}__${date_time_folder}__${cameraName}__${plateNumber}`;
    return replaceMissingLetters(file_name);
}

/**
 * Create export parameters for image capture
 * @param {string} tid - TID
 * @param {string} camera_id - Camera ID
 * @param {string} timestamp - Timestamp
 * @param {string} file_name - File name
 * @param {string} writeDir - Write directory
 * @param {Object} camConfig - Camera configuration
 * @returns {Object} Export parameters
 */
function createExportParams(tid, camera_id, timestamp, file_name, writeDir, camConfig) {
    return {
        request_id: tid + '' + camera_id,
        import: `cam$${camera_id};time$${timestamp}`,
        export_engine: "file",
        export: `filename$${file_name};dir$${writeDir}`,
        export_image: `format$${camConfig.format};quality$${camConfig.quality}`
    };
}

/**
 * Create database file object
 * @param {string} tid - TID
 * @param {string} camera_id - Camera ID
 * @param {Array<string>} folderInfo - Folder information
 * @param {string} car_number - Car number
 * @param {string} file_name - File name
 * @param {string} writeDir - Write directory
 * @param {string} timestamp - Timestamp
 * @param {string} format - Image format
 * @returns {Object} File object
 */
function createFileObject(tid, camera_id, folderInfo, car_number, file_name, writeDir, timestamp, format) {
    const [folderTodayDate, folderCurrentTime] = folderInfo;
    return {
        tid: tid + '' + camera_id,
        date_folder: folderTodayDate,
        time_folder: folderCurrentTime,
        plate_num: car_number,
        cam_id: camera_id,
        file_path: `${writeDir}\\${file_name}.${format}`,
        file_size: 0,
        file_name: `${file_name}.${format}`,
        site_id: SITE_ID,
        date: formatDateString(timestamp.split(" ")[0]),
        time: timestamp.split(" ")[1]
    };
}

/**
 * Process single camera capture
 * @param {Object} core - Core object
 * @param {Object} dbHandler - Direct database handler
 * @param {Object} camConfig - Camera configuration object
 * @param {Object} e - Event object
 * @param {string} writeDir - Write directory
 * @param {Array<string>} folderInfo - Folder information
 */
async function processCameraCapture(core, dbHandler, camConfig, e, writeDir, folderInfo) {
    try {
        const camera = await core.getObject("CAM", camConfig.id);
        const tid = e.params.tid;
        const car_number = e.params.number || "without_plate";
        
        // Create file name with specific format
        const file_name = createFileName(e.params.time_leave, camera.params.name, car_number, camConfig.format);
        // console.log("Image: ", file_name + "." + camConfig.format);

        // Get image export ID for load balancing
        const imageExportId = findSmallestImageExportQueueSizeSourceId(IMAGE_EXPORTS);
        console.log("Image Processor: ", imageExportId);

        // Guard: IMAGE_EXPORTS map is empty (no exporters loaded yet)
        if (imageExportId == null || !IMAGE_EXPORTS[imageExportId]) {
            console.warn(`[!] No IMAGE_EXPORT available for ${file_name}; IMAGE_EXPORTS map is empty. Skipping dispatch.`);
            return;
        }

        // Create and log export parameters with camera-specific format and quality
        const exportParams = createExportParams(tid, camConfig.id, e.params.time_leave, file_name, writeDir, camConfig);

        console.log(exportParams);

        // Trigger image export
        core.doReact("IMAGE_EXPORT", imageExportId, "EXPORT", exportParams);
        IMAGE_EXPORTS[imageExportId].queue_size += 1;

        // Create file object and insert to database directly
        const fileObject = createFileObject(tid, camConfig.id, folderInfo, car_number, file_name, writeDir, e.params.time_leave, camConfig.format);
        // Add export parameters to file object
        fileObject.export_params = exportParams;
        
        // Direct database call (no microservice)
        try {
            await dbHandler.insertFileToDatabase(fileObject);
        } catch (error) {
            console.error('Failed to insert file to database:', error);
        }
    } catch (err) {
        console.error('[!] processCameraCapture failed:', err);
    }
}

loadConfig();

securos.connect(async (core) => {
    SECUROS_CORE = core;
    await loadImageExports(core);

    // Create direct database handler instead of microservice sender
    const dbHandler = new DirectDatabaseHandler();

    // Reload configuration when connection is established
    loadConfig();

    // Register event handlers
    core.registerEventHandler("LPR_CAM", "*", "CAR_LP_RECOGNIZED", carReact);
    core.registerEventHandler("IMAGE_EXPORT", "*", "*", handleImageExportEvent);

    // Optional: Refresh image exports periodically instead of every event
    setInterval(() => {
        if (SECUROS_CORE) {
            loadImageExports(SECUROS_CORE);
        }
    }, 30000); // Refresh every 30 seconds

    async function carReact(e) {
        // Removed frequent loadImageExports call to reduce memory pressure
        
        const timestamp = e.params.time_leave;
        const lpr_id = e.sourceId;
        const lpr_obj = LPR_CAM[lpr_id];
        
        // Get directory information
        const [writeDir, folderTodayDate, folderCurrentTime] = getTodayDirectory();
        const folderInfo = [folderTodayDate, folderCurrentTime];

        // Add delay for synchronization
        const before = Date.now();
        // await sleep(7000);
        const after = Date.now();
        console.log(`For LPR ${lpr_id}, Executed after a delay of ${(after - before) / 1000} seconds.`);

        // Process each camera with its specific configuration
        for (let idx = 0; idx < lpr_obj['cam_ids'].length; idx++) {
            await processCameraCapture(core, dbHandler, lpr_obj['cam_ids'][idx], e, writeDir, folderInfo);
        }
    }

    // Memory monitoring for debugging potential leaks
    setInterval(() => {
        const memoryUsage = process.memoryUsage();
        const formatMemory = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

        console.log(`[ImageCaptureScript] Memory Usage:
        RSS: ${formatMemory(memoryUsage.rss)} (Total memory allocated)
        Heap Used: ${formatMemory(memoryUsage.heapUsed)} (Actual memory used)
        Heap Total: ${formatMemory(memoryUsage.heapTotal)} (Total heap size)
        External: ${formatMemory(memoryUsage.external)} (C++ objects memory)`);
    }, 60000); // Every minute
});
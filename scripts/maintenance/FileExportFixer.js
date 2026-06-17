const { Pool } = require("pg");
const securos = require('securos');
const fs = require('fs-extra');

let SECUROS_CORE = null;
let DB_USER = "postgres";
let DB_PASSWORD = "postgres";
let DB_HOST = "localhost";
let DB_APP = "tahakom_transfer";

const pool = new Pool({
    user: DB_USER,
    host: DB_HOST,
    database: DB_APP,
    port: 5432,
    password: DB_PASSWORD
});


async function calculateFileSize(id, filePath) {
    // 1) select files in the database without sizes

    try {
        // let recordId = filesRequireCalculations[0].id;
        // let filePath = filesRequireCalculations[0].file_path;
        const stats = await fs.stat(filePath);
        query = `
            UPDATE
                files
            SET file_size=$1 
            WHERE id=$2
            `;
        await pool.query(query, [stats.size, id]);
        console.log(`[*] Updated size of ${filePath} to be ${stats.size}`);
    } catch (e) {
        console.log("[!] Error ", e.message);
    }
}


function formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}.${String(date.getMilliseconds()).padStart(3, '0')}`;
}

function formatTimestampRemoveMillis(timestamp) {
    /**
     * Frame search is performed within one second interval to the left and right 
     * from specified time. A frame that is closest to the specified time is
     * exported. For example, if specified time is 10:56:02 (or 10:56:02.xxx),
     * then system will search frame within 10:56:02.000 (10:56:02.xxx) -
     * 10:56:02.999 interval.
     */
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

/**
 * Image Export Configuration
 */
let IMAGE_EXPORTS = {}

async function loadImageExports(core) {
    let IMAGE_EXPORT_IDS = await core.getObjectsIds('IMAGE_EXPORT');
    for (const id of IMAGE_EXPORT_IDS) {
        IMAGE_EXPORTS[id] = IMAGE_EXPORTS[id] || { queue_size: 0 };
        // let imageExportObject = await SECUROS_CORE.getObject('IMAGE_EXPORT', id);

        // if (id === '6')
        //     console.log(imageExportObject);

        // IMAGE_EXPORTS[id].name = imageExportObject.name;
        // IMAGE_EXPORTS[id].enabled = imageExportObject.enabled;
        // IMAGE_EXPORTS[id].state = imageExportObject.state;
        // IMAGE_EXPORTS[id].flags = imageExportObject.params.flags;
    }
    // console.log("[*] Load image exports: ")
    // console.log(IMAGE_EXPORTS);
}

/**
 * Find the smallest image export queue size source ID
 * @param {Object} imageExports - Image export configuration
 * @returns {string} Smallest queue size source ID
 */
function findSmallestImageExportQueueSizeSourceId(imageExports) {
    let smallestQueueSize = Infinity;
    let smallestSourceId = null;

    // Loop through all entries in IMAGE_EXPORTS
    Object.entries(imageExports).forEach(([sourceId, data]) => {
        const queueSize = parseInt(data.queue_size);

        if (queueSize < smallestQueueSize) {
            smallestQueueSize = queueSize;
            smallestSourceId = sourceId;
        }
    });

    return smallestSourceId;
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
 * Handle image export events and update queue sizes
 * @param {Object} e - Event object
 */
async function handleImageExportEvent(e) {
    await loadImageExports(SECUROS_CORE);
    // console.log(e);
    // let imageExportObject = await SECUROS_CORE.getObject(e.sourceType, e.sourceId);
    // if (e.sourceId === '6')
    //     console.log(imageExportObject);

    try {
        IMAGE_EXPORTS[e.sourceId].queue_size = parseInt(e.params.queue_size);
        // IMAGE_EXPORTS[e.sourceId].name = imageExportObject.name;
        // IMAGE_EXPORTS[e.sourceId].enabled = imageExportObject.enabled;
        // IMAGE_EXPORTS[e.sourceId].state = imageExportObject.state;
        // IMAGE_EXPORTS[e.sourceId].flags = imageExportObject.params.flags;
    } catch (err) {
        console.log(err);
    }
}


async function handleLeftOverFiles(core) {
    // 1) select files in the database without sizes
    let query = `
    SELECT 
        id,
        tid,
        plate_num,
        cam_id,
        site_id,
        file_name,
        date_folder,
        time_folder,
        file_path,
        export_retry_count,
        export_retry_log_object,
        export_params,
        image_export_done_date_time,
        date + time as timestamp
    FROM files fls
    WHERE 
        file_size = 0 AND deleted = false 
        AND date = CURRENT_DATE
        AND image_export_done_date_time ISNULL
        AND export_retry_count < 1
        AND (TO_TIMESTAMP(date::text || ' ' || time::text, 'YYYY-MM-DD HH24:MI:SS') AT TIME ZONE '+03') 
        BETWEEN 
            (NOW() AT TIME ZONE '+03' - INTERVAL '90 minutes')  -- Start time: 90 minutes ago
            AND 
            (NOW() AT TIME ZONE '+03' - INTERVAL '30 minutes')  -- End time: 30 minutes ago
    ORDER BY id DESC
    -- LIMIT 2000
    ;
    `;

    let result = await pool.query(query);
    console.log("Plates not produced in 240 minutes", result.rowCount);
    console.log(JSON.stringify(IMAGE_EXPORTS, null, 4));
    let filesRequireCalculations = result.rows;
    for (let i = 0; i < filesRequireCalculations.length; i++) {
        console.log(`File ${i + 1} from ${filesRequireCalculations.length}`);
        let fileRecord = filesRequireCalculations[i];
        try {
            let id = fileRecord.id;
            let filePath = fileRecord.file_path;
            let tid = fileRecord.tid;
            // let camera_id = fileRecord.cam_id;
            let timestamp = formatTimestamp(fileRecord.timestamp);
            let export_retry_count = parseInt(fileRecord.export_retry_count);
            let export_retry_log_object = fileRecord.export_retry_log_object;
            let export_params = fileRecord.export_params;
            let image_export_done_date_time = fileRecord.image_export_done_date_time;

            if (image_export_done_date_time) {
                console.log("[*] File is ready, just calculate the file size ...");
                calculateFileSize(id, filePath);
                continue;
            }

            // console.log(IMAGE_EXPORTS);

            let CURRENT_PROCESSOR = findSmallestImageExportQueueSizeSourceId(IMAGE_EXPORTS);

            if (export_retry_count > 2) {
                timestamp = formatTimestampRemoveMillis(fileRecord.timestamp);
            }

            export_retry_log_object.push({
                retryOn: new Date(),
                imageExportId: CURRENT_PROCESSOR,
                retry_count: export_retry_count,
                comment: "Issued By File Export Fixer",
                timestamp,
                tid,
            })

            console.log("------------------");
            console.log("Export Params: ", export_params);
            console.log("Retry: ", export_retry_count, "Timestamp: ", timestamp);
            console.log("Image processor: ", CURRENT_PROCESSOR);
            console.log("------------------");

            const updateRetryCountQuery = "UPDATE files SET export_retry_count=$1, export_retry_log_object=$3 where tid=$2";
            pool.query(updateRetryCountQuery, [export_retry_count + 1, tid, JSON.stringify(export_retry_log_object)]);
            // pool.query(updateRetryCountQuery, [export_retry_count + 1, tid, JSON.stringify(export_retry_log_object)]);

            core.doReact(
                "IMAGE_EXPORT",
                CURRENT_PROCESSOR,
                "EXPORT",
                export_params
            );

            IMAGE_EXPORTS[CURRENT_PROCESSOR].queue_size += 1;

            await sleep(100);


        } catch (e) {
            console.log("[!] Error ", e.message);
        }
    }
    // 4) sleep for few seconds
    console.log("Sleep for (600_000) seconds between export retries ...");
    await sleep(600_000);

    // 5) search again the database
}

securos.connect(async (core) => {

    SECUROS_CORE = core;
    await loadImageExports(core)

    // core.registerEventHandler("IMAGE_EXPORT", "*", "*", handleImageExportEvent);

    while (true) {
        await handleLeftOverFiles(core)
    }

});
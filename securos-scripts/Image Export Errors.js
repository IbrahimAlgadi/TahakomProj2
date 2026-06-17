const securos = require('securos');
const { Pool } = require("pg");
const fs = require('fs-extra');

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

console.log("\n\r");

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
 * Sleep for a specified amount of time
 * @param {number} ms - Time in milliseconds
 * @returns {Promise<void>} Resolves after the specified time
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function calculateFileSize(tid) {
    // 1) select files in the database without sizes
    let query = `
    SELECT 
        id,
        file_path
    FROM files fls
    WHERE file_size=0 and tid=$1
    `;

    let result = await pool.query(query, [tid]);
    let filesRequireCalculations = result.rows;
    // console.log(result)
    if (result.rowCount === 1) {
        try {
            let recordId = filesRequireCalculations[0].id;
            let filePath = filesRequireCalculations[0].file_path;
            const stats = await fs.stat(filePath);
            query = `
            UPDATE
                files
            SET file_size=$1 
            WHERE id=$2
            `;
            await pool.query(query, [stats.size, recordId]);
            console.log(`[*] Updated size of ${filePath} to be ${stats.size}`);
        } catch (e) {
            console.log("[!] Error ", e.message);
        }
    }
}

securos.connect(async core => {

    core.registerEventHandler(
        "IMAGE_EXPORT",
        "*",
        "*",
        async (e) => {
            
            if (e.action !== "EXPORT_DONE") {
                console.log(
                    "Image Export Event: ",
                    e.sourceType,
                    e.sourceId,
                    e.action,
                    e.params.request_id,
                    e.params.queue_size,
                    new Date()
                );
            }

            // console.log(e);

            if (e.action === "EXPORT_FAILED") {

                let result = await pool.query(`
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
                        date + time as timestamp
                    FROM files WHERE tid = $1 
                    -- AND file_size > 0 AND export_retry_count < 4
                `, [e.params.request_id]);

                // console.log("Image capture: ", e.sourceId, "\t", e.params.request_id, " => ", result.rows);
                // console.log(e);
                console.log("Image Capture: ", e.sourceId, "\t", e.params.request_id, " => ", e.params.comment, result.rowCount, result.rows);

                // console.log(tid, camera_id, timestamp, file_name, writeDir);

                let CURRENT_PROCESSOR = e.sourceId;

                if (result.rowCount === 1) {
                    let fileRecord = result.rows[0];
                    let tid = fileRecord.tid;
                    // let camera_id = fileRecord.cam_id;
                    let timestamp = formatTimestamp(fileRecord.timestamp);
                    // let file_name = fileRecord.file_name;
                    // let writeDir = fileRecord.file_path.substring(0, fileRecord.file_path.lastIndexOf('\\'));
                    let export_retry_count = parseInt(fileRecord.export_retry_count);
                    let export_retry_log_object = fileRecord.export_retry_log_object;
                    let export_params = fileRecord.export_params;

                    if (export_retry_count === 3) {
                        timestamp = formatTimestampRemoveMillis(fileRecord.timestamp);
                    }

                    await sleep(7000)
                    
                    export_retry_log_object.push({
                        retryOn: new Date(),
                        imageExportId: CURRENT_PROCESSOR,
                        retry_count: export_retry_count,
                        comment: e.params.comment,
                        timestamp,
                        tid,
                    })

                    console.log("------------------");
                    console.log("Export Params: ", export_params);
                    console.log("Retry: ", export_retry_count, "Timestamp: ", timestamp);
                    console.log("------------------");

                    let hasImageError = e.params.comment.includes("Image obtain error: Camera");

                    if (hasImageError) {
                        console.log('++++++++++++++++++++++++++++++++++++++++++++++++++')
                        console.log("Image obtain error");
                        // delete image
                        export_retry_log_object.push({
                            retryOn: new Date(),
                            imageExportId: CURRENT_PROCESSOR,
                            retry_count: export_retry_count,
                            comment: "Deleted, Image obtain error",
                            timestamp,
                            tid,
                        })
                        const deleteQuery = "UPDATE files SET deleted=true, deleted_date_time=$2 where tid=$1 AND file_size=0";
                        await pool.query(deleteQuery, [tid, new Date()]);
                    } else if (export_retry_count < 4) {

                        const updateRetryCountQuery = "UPDATE files SET export_retry_count=$1, export_retry_log_object=$3 where tid=$2";
                        await pool.query(updateRetryCountQuery, [export_retry_count + 1, tid, JSON.stringify(export_retry_log_object)]);

                        core.doReact(
                            "IMAGE_EXPORT",
                            CURRENT_PROCESSOR,
                            "EXPORT",
                            export_params
                        );
                    } else {
                        console.log("Reached maximum retry count, remove image")
                        const deleteQuery = "UPDATE files SET deleted=true, deleted_date_time=$2, export_retry_log_object=$3 where tid=$1 AND file_size=0";
                        await pool.query(deleteQuery, [e.params.request_id, new Date(), JSON.stringify(export_retry_log_object)]);
                    }

                } else {
                    const deleteQuery = "UPDATE files SET deleted=true, deleted_date_time=$2 where tid=$1 AND file_size=0";
                    await pool.query(deleteQuery, [e.params.request_id, new Date()]);
                }

            }
            // console.log(e);
        }
    );

})

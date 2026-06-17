const {Pool} = require("pg");
const fs = require('fs-extra');
const securos = require('securos');


let FILE_TYPE = 'png';

// let TRANSFER_STATUS = 'paused'; // running, paused 
// let STOP_TRANSFER_USED_STORAGE_PERCENT = 50; // 45%

// let IMAGE_EXPORT_IDS = ['4', '5'];
let CURRENT_PROCESSOR = '';

function toggleImageProcessor() {
    if (CURRENT_PROCESSOR == '4') 
        return '5'
    return '4'
}

/**
 * Image Export Configuration
 */
let IMAGE_EXPORTS = {}

async function loadImageExports(core) {
    let IMAGE_EXPORT_IDS = await core.getObjectsIds('IMAGE_EXPORT');
    for (const id of IMAGE_EXPORT_IDS) {
        IMAGE_EXPORTS[id] = IMAGE_EXPORTS[id] || { queue_size: 0 };
    }
    console.log("[*] Load image exports: ")
    console.log(IMAGE_EXPORTS);
}


function findSmallestImageExportQueueSizeSourceId(imageExports) {
    
    loadImageExports(core)

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


function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


async function calculateFileSize(core) {
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
        TO_CHAR(TO_TIMESTAMP(date::text || ' ' || time::text, 'YYYY-MM-DD HH24:MI:SS.MS'), 'DD-MM-YYYY HH24:MI:SS.MS') AS formatted_datetime
    FROM files fls
    WHERE file_size = 0 AND deleted = false 
        -- AND export_retry_count < 1
        AND TO_TIMESTAMP(date::text || ' ' || time::text, 'YYYY-MM-DD HH24:MI:SS') < (NOW() - INTERVAL '240 minutes')
    ;
    `;

    let result = await pool.query(query);
    console.log("Plates not produced in 240 minutes", result.rowCount);
    console.log(JSON.stringify(IMAGE_EXPORTS, null, 4));
    let filesRequireCalculations = result.rows;
    for (let i = 0; i < filesRequireCalculations.length; i++) {
        let record = filesRequireCalculations[i];
        try {
            let recordId = record.id;
            let filePath = record.file_path;
            // console.log(filePath);
            // 2) try to calculate the file size
            // console.log(`[*] Calculate size of ${filePath}`);
            const stats = await fs.stat(filePath);
            console.log("stats.size: ", stats.size);
            // 3) update the database with the new file size
            //     query = `
            // UPDATE
            //     files
            // SET file_size=$1 
            // WHERE id=$2
            //     `;
            //     await pool.query(query, [stats.size, recordId]);
            //     console.log(`[*] Updated size of ${filePath} to be ${stats.size}`);
            //     await sleep(100);
        } catch (e) {
            if (e.message.indexOf('no such file or directory') !== -1) {
                // console.log("Call the image export to work on those files... again....");
                // console.log(record);
                let tid = record.tid;
                let camera_id = record.cam_id;
                let timestamp = record.formatted_datetime;
                let file_name = record.file_name;
                let writeDir = record.file_path.substring(0, record.file_path.lastIndexOf('\\'));
                // console.log(tid, camera_id, timestamp, file_name, writeDir);

                let CURRENT_PROCESSOR = findSmallestImageExportQueueSizeSourceId(IMAGE_EXPORTS)
                
                console.log("CURRENT_PROCESSOR: ", IMAGE_EXPORTS, CURRENT_PROCESSOR);
                
                core.doReact(
                    "IMAGE_EXPORT",
                    CURRENT_PROCESSOR,
                    "EXPORT",
                    {
                        request_id: tid,
                        import: "cam$" + camera_id + ";time$" + timestamp,
                        export_engine: "file",
                        export: "filename$" + file_name + `;dir$` + writeDir,
                        export_image: "format$" + FILE_TYPE + ";"
                    }
                );

                const updateRetryCountQuery = "UPDATE files SET export_retry_count=1 where tid=$1 AND file_size=0";
                await pool.query(updateRetryCountQuery, [tid]);
            }
            // console.log("[!] Error ", e.message);
        }
    }
    // 4) sleep for few seconds
    await sleep(2000);

    // 5) search again the database
}

securos.connect(async (core) => {

    // loadImageExports(core)

    core.registerEventHandler(
        "IMAGE_EXPORT",
        "*",
        "*",
        (e) => {
            // console.log(
            //     "Image Export Event: ", 
            //     e.sourceType, 
            //     e.sourceId, 
            //     e.action, 
            //     e.params.request_id,
            //     e.params.queue_size
            // );
            try {
                IMAGE_EXPORTS[e.sourceId].queue_size = e.params.queue_size
            } catch(e) {
                
            }
        }
    );

    // core.registerEventHandler(
    //     "IMAGE_EXPORT",
    //     '4',
    //     "*",
    //     async (e) => {
    //         console.log(
    //             "Image Export Event: ", 
    //             e.sourceType, 
    //             e.sourceId, 
    //             e.action, 
    //             e.params.request_id
    //         );
    //         if (e.action === "EXPORT_FAILED") {

    //             console.log(e);

    //             if (e.params.comment.indexOf('Image obtain error') !== -1) {
    //                 // console.log(e);
    //                 // Mark file as deleted
    //                 const deleteQuery = "UPDATE files SET deleted = true where tid=$1";
    //                 await pool.query(deleteQuery, [e.params.request_id]);
    //                 console.log("Remove Failed");
    //             }
                
    //         }
    //     }
    // );
    // core.registerEventHandler(
    //     "IMAGE_EXPORT",
    //     '5',
    //     "*",
    //     (e) => {
    //         console.log(
    //             "Image Export Event: ", 
    //             e.sourceType, 
    //             e.sourceId, 
    //             e.action, 
    //             e.params.request_id
    //         );
    //         // console.log(e);
    //     }
    // );

    // setInterval(() => {
    //     const memoryUsage = process.memoryUsage();
    //     const formatMemory = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' MB';

    //     console.log(`Memory Usage:
    //     RSS: ${formatMemory(memoryUsage.rss)} (Resident Set Size - total memory allocated for the process)
    //     Heap Total: ${formatMemory(memoryUsage.heapTotal)} (total size of the allocated heap)
    //     Heap Used: ${formatMemory(memoryUsage.heapUsed)} (actual memory used during execution)
    //     External: ${formatMemory(memoryUsage.external)} (memory used by C++ objects in Node)
    //     Array Buffers: ${formatMemory(memoryUsage.arrayBuffers)} (memory allocated for ArrayBuffer and SharedArrayBuffer)
    //     `);
    // }, 10000);
    
    while (true) {
        await calculateFileSize(core)   
    }

    

});
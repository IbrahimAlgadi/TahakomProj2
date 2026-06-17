const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Configuration constants
const INPUT_DIR = "D:\\ISS_MEDIA\\CAM_3\\2025-07-14T12+0300";
const OUTPUT_DIR = "mp4_conversion";
const VIDEO_DURATION_SECONDS = 1.0214;
const VIDEOS_PER_GROUP = 50;
const INPUT_CODEC = 'h264';
const PARALLEL_PROCESSES = 2;

/**
 * Extract date from folder path (format: yyyy-MM-ddThh+zzzz)
 */
function extractDateFromPath(filePath) {
    const dateMatch = filePath.match(/(\d{4}-\d{2}-\d{2}T\d{2}\+\d{4})/);
    return dateMatch ? dateMatch[1] : "unknown_date";
}

/**
 * Extract camera ID from filename (format: xx-xx-xxx_N.issvd)
 */
function extractCameraId(filename) {
    const camMatch = filename.match(/_(\d+)\.issvd$/);
    return camMatch ? camMatch[1] : "unknown_camera";
}

/**
 * Extract timestamp from filename (e.g., "18-04-884" part)
 */
function extractTimestamp(filename) {
    const timeMatch = filename.match(/(\d{2}-\d{2}-\d{3})_/);
    return timeMatch ? timeMatch[1] : "00-00-000";
}

/**
 * Parse timestamp like "18-04-884" into hours and minutes
 */
function parseTimestamp(timestamp) {
    const parts = timestamp.split('-');
    if (parts.length === 3) {
        const hour = parseInt(parts[0], 10);
        const minute = parseInt(parts[1], 10);
        return { hour, minute };
    }
    return { hour: 0, minute: 0 };
}

/**
 * Convert .issvd file to .mp4 using ffmpeg
 */
function convertToMp4(inputFile, outputFile) {
    return new Promise((resolve, reject) => {
        const args = [
            '-f', INPUT_CODEC,      // Force input format to h264
            '-i', inputFile,        // Input file
            '-c:v', 'copy',        // Copy video stream without re-encoding
            '-f', 'mp4',           // Force output format to mp4
            outputFile,            // Output file
            '-y'                   // Overwrite output file if exists
        ];

        const ffmpeg = spawn('ffmpeg', args);
        let stderr = '';

        ffmpeg.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code === 0) {
                resolve(true);
            } else {
                console.error(`Error converting ${inputFile}: ${stderr}`);
                reject(new Error(`FFmpeg process exited with code ${code}`));
            }
        });

        ffmpeg.on('error', (error) => {
            console.error(`Exception while converting ${inputFile}: ${error.message}`);
            reject(error);
        });
    });
}

/**
 * Concatenate multiple mp4 files into a single file using ffmpeg
 */
async function concatenateMp4Files(mp4Files, outputFile) {
    try {
        const outputDir = path.dirname(outputFile);
        const concatListPath = path.join(outputDir, "concat_list.txt");
        
        // Ensure output directory exists
        await fs.mkdir(outputDir, { recursive: true });
        
        // Create concat list file
        const concatContent = mp4Files.map(file => {
            // Use absolute paths with forward slashes for ffmpeg
            const absPath = path.resolve(file).replace(/\\/g, '/');
            return `file '${absPath}'`;
        }).join('\n');
        
        await fs.writeFile(concatListPath, concatContent);
        
        // Run ffmpeg to concatenate the files
        const success = await new Promise((resolve, reject) => {
            const args = [
                '-f', 'concat',       // Format is concat
                '-safe', '0',         // Don't restrict filenames
                '-i', concatListPath, // Input file is the concat list
                '-c', 'copy',         // Copy streams without re-encoding
                outputFile            // Output file
            ];

            const ffmpeg = spawn('ffmpeg', args);
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ffmpeg.on('close', (code) => {
                if (code === 0) {
                    resolve(true);
                } else {
                    console.error(`Error concatenating files: ${stderr}`);
                    resolve(false);
                }
            });

            ffmpeg.on('error', (error) => {
                console.error(`Exception while concatenating files: ${error.message}`);
                resolve(false);
            });
        });
        
        // Delete the temporary concat list file
        try {
            await fs.unlink(concatListPath);
        } catch (error) {
            // Ignore cleanup errors
        }
        
        return success;
    } catch (error) {
        console.error(`Exception while concatenating files: ${error.message}`);
        return false;
    }
}

/**
 * Remove individual MP4 files after successful concatenation
 */
async function removeIndividualFiles(files) {
    const removePromises = files.map(async (file) => {
        try {
            await fs.unlink(file);
            console.log(`      Removed: ${path.basename(file)}`);
        } catch (error) {
            console.log(`      Warning: Could not remove ${path.basename(file)}: ${error.message}`);
        }
    });
    
    await Promise.all(removePromises);
}

/**
 * Process a single group of videos
 */
async function processGroup(groupData) {
    const { groupIndex, group, cameraId, date } = groupData;
    const firstTimestamp = group[0].timestamp;
    const lastTimestamp = group[group.length - 1].timestamp;
    const numVideos = group.length;
    const durationMinutes = (numVideos * VIDEO_DURATION_SECONDS) / 60.0;
    
    console.log(`    Group ${groupIndex + 1}: [${firstTimestamp} to ${lastTimestamp}] - ${numVideos} videos (${durationMinutes.toFixed(2)} minutes)`);
    
    // Create output directory for this group
    const cameraFolder = `CAM_${cameraId}`;
    const groupFolder = `group${groupIndex + 1}`;
    const outputPath = path.join(OUTPUT_DIR, cameraFolder, date, groupFolder);
    
    try {
        await fs.mkdir(outputPath, { recursive: true });
        console.log(`      Saving converted videos to: ${outputPath}`);
        
        // List to store paths of successfully converted mp4 files
        const convertedFiles = [];
        
        // Convert each file in the group
        for (const { timestamp, file } of group) {
            const filename = path.basename(file);
            const baseName = path.parse(filename).name;
            const outputFile = path.join(outputPath, `${baseName}.mp4`);
            
            console.log(`      Converting: ${filename} -> ${path.basename(outputFile)}`);
            
            try {
                await convertToMp4(file, outputFile);
                console.log(`      ✓ Converted successfully: ${path.basename(outputFile)}`);
                convertedFiles.push(outputFile);
            } catch (error) {
                console.log(`      ✗ Conversion failed: ${filename}`);
            }
        }
        
        // Concatenate all converted files in this group into a single file
        if (convertedFiles.length > 0) {
            const concatOutput = path.join(outputPath, `${firstTimestamp}_to_${lastTimestamp}_${cameraId}.mp4`);
            console.log(`      Concatenating ${convertedFiles.length} files into: ${path.basename(concatOutput)}`);
            
            const success = await concatenateMp4Files(convertedFiles, concatOutput);
            
            if (success) {
                console.log(`      ✓ Concatenation successful: ${path.basename(concatOutput)}`);
                console.log(`      Removing individual MP4 files...`);
                await removeIndividualFiles(convertedFiles);
            } else {
                console.log(`      ✗ Concatenation failed`);
            }
        }
    } catch (error) {
        console.error(`Error processing group ${groupIndex + 1}: ${error.message}`);
    }
}

/**
 * Process multiple groups in parallel with limited concurrency
 */
async function processGroupsInParallel(groupsData) {
    const results = [];
    
    // Process groups in batches to limit parallel processes
    for (let i = 0; i < groupsData.length; i += PARALLEL_PROCESSES) {
        const batch = groupsData.slice(i, i + PARALLEL_PROCESSES);
        const batchPromises = batch.map(groupData => processGroup(groupData));
        
        try {
            await Promise.all(batchPromises);
        } catch (error) {
            console.error(`Error in batch processing: ${error.message}`);
        }
    }
}

/**
 * Get all .issvd files from a directory
 */
async function getIssvdFiles(directory) {
    try {
        const allFiles = await fs.readdir(directory);
        const issvdFiles = allFiles
            .filter(filename => filename.toLowerCase().endsWith('.issvd'))
            .map(filename => path.join(directory, filename));
        return issvdFiles;
    } catch (error) {
        console.error(`Error reading directory ${directory}: ${error.message}`);
        return [];
    }
}

/**
 * Main function
 */
async function main() {
    try {
        console.log(`Searching for .issvd files in: ${INPUT_DIR}`);
        
        const files = await getIssvdFiles(INPUT_DIR);
        console.log(`Found ${files.length} files to convert`);
        
        // Group files by date and camera ID
        const groupedFiles = {};
        
        for (const file of files) {
            const date = extractDateFromPath(file);
            const filename = path.basename(file);
            const cameraId = extractCameraId(filename);
            const timestamp = extractTimestamp(filename);
            
            // Initialize nested objects if they don't exist
            if (!groupedFiles[date]) {
                groupedFiles[date] = {};
            }
            if (!groupedFiles[date][cameraId]) {
                groupedFiles[date][cameraId] = [];
            }
            
            // Store file with its timestamp for sorting
            groupedFiles[date][cameraId].push({ timestamp, file });
        }
        
        // Process grouped files
        const sortedDates = Object.keys(groupedFiles).sort();
        
        for (const date of sortedDates) {
            console.log(`\nDate: ${date}`);
            
            const sortedCameraIds = Object.keys(groupedFiles[date]).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
            
            for (const cameraId of sortedCameraIds) {
                console.log(`  Camera ID: ${cameraId}`);
                
                // Sort files by timestamp
                const sortedFiles = groupedFiles[date][cameraId].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
                
                // Group into chunks
                const videoGroups = [];
                for (let i = 0; i < sortedFiles.length; i += VIDEOS_PER_GROUP) {
                    videoGroups.push(sortedFiles.slice(i, i + VIDEOS_PER_GROUP));
                }
                
                // Prepare data for parallel processing
                const groupsData = videoGroups.map((group, index) => ({
                    groupIndex: index,
                    group: group,
                    cameraId: cameraId,
                    date: date
                }));
                
                // Process groups in parallel
                await processGroupsInParallel(groupsData);
            }
        }
        
        console.log('\nProcessing completed!');
    } catch (error) {
        console.error(`Error in main function: ${error.message}`);
        process.exit(1);
    }
}

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

// Run the main function if this script is executed directly
if (require.main === module) {
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = {
    extractDateFromPath,
    extractCameraId,
    extractTimestamp,
    parseTimestamp,
    convertToMp4,
    concatenateMp4Files,
    removeIndividualFiles,
    processGroup,
    getIssvdFiles,
    main
}; 
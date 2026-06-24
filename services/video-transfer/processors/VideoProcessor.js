const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'VideoProcessor', logFile: 'video-usb-pipeline' });
const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { sleep } = require('../../../utils.js');

class VideoProcessor {
    constructor(eventEmitter, config) {
        this.eventEmitter = eventEmitter;
        this.config = config;
        this.waitFileAccessTimeout = config.waitFileAccessTimeout || 5000;
        this.VIDEO_TEMP_DIR = config.VIDEO_TEMP_DIR || path.join(__dirname, '../../../temp_video_processing');
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
    }

    /**
     * Convert .issvd file to .mp4 using ffmpeg
     */
    convertToMp4(inputFile, outputFile) {
        const t0 = Date.now();
        return new Promise((resolve, reject) => {
            const args = [
                '-f', 'h264',
                '-i', inputFile,
                '-c:v', 'copy',
                '-f', 'mp4',
                outputFile,
                '-y'
            ];

            const ffmpeg = spawn('ffmpeg', args, {
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            let stderr = '';

            ffmpeg.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            ffmpeg.on('close', async (code) => {
                if (code === 0) {
                    try {
                        await sleep(200);
                        await this.waitForFileAccess(outputFile, this.waitFileAccessTimeout);
                        logger.info(`[VIDEO_CONVERT] FFmpeg convert complete`, { phase: 'ffmpeg-convert', durationMs: Date.now() - t0, sourceFile: inputFile, outputFile });
                        resolve(true);
                    } catch (error) {
                        logger.error(`[VIDEO_CONVERT_ERROR] VideoProcessor.convertToMp4: File access check failed for ${outputFile}: ${error.message}`);
                        reject(error);
                    }
                } else {
                    // Extract the last meaningful line from stderr for the error message
                    const stderrSummary = stderr
                        .split('\n')
                        .map(l => l.trim())
                        .filter(l => l && !l.startsWith('ffmpeg version') && !l.startsWith('built with') && !l.startsWith('configuration') && !l.startsWith('lib') && !l.startsWith('  '))
                        .join(' | ')
                        .slice(0, 300);
                    logger.error(`[VIDEO_CONVERT_ERROR] VideoProcessor.convertToMp4: Error converting ${inputFile}: ${stderr}`, { phase: 'ffmpeg-convert', durationMs: Date.now() - t0 });
                    reject(new Error(`FFmpeg exited ${code}: ${stderrSummary || 'no stderr'}`));
                }
            });

            ffmpeg.on('error', (error) => {
                logger.error(`[VIDEO_CONVERT_ERROR] VideoProcessor.convertToMp4: Exception while converting ${inputFile}: ${error.message}`);
                reject(error);
            });
        });
    }

    /**
     * Concatenate multiple mp4 files
     */
    async concatenateMp4Files(mp4Files, outputFile) {
        const t0Concat = Date.now();
        try {
            // logger.info(`[VIDEO] VideoProcessor.concatenateMp4Files: Concatenating files: ${mp4Files.length} to ${outputFile}`);
            const outputDir = path.dirname(outputFile);
            const concatListPath = path.join(outputDir, `concat_list_${Date.now()}.txt`);
            
            await fs.ensureDir(outputDir);
            
            // Verify all input files are accessible
            for (const file of mp4Files) {
                try {
                    await this.waitForFileAccess(file, 3000);
                } catch (error) {
                    logger.error(`[VIDEO] VideoProcessor.concatenateMp4Files Input file not accessible: ${file} - ${error.message}`);
                    return false;
                }
            }
            
            // Create concat list file
            const concatContent = mp4Files.map(file => {
                const absPath = path.resolve(file).replace(/\\/g, '/');
                return `file '${absPath}'`;
            }).join('\n');
            
            await fs.writeFile(concatListPath, concatContent);
            
            // Remove existing output file if it exists
            try {
                await fs.access(outputFile);
                await fs.unlink(outputFile);
                await sleep(500);
            } catch (error) {
                // File doesn't exist, which is fine
            }
            
            // Run ffmpeg to concatenate
            const success = await new Promise((resolve) => {
                const args = [
                    '-f', 'concat',
                    '-safe', '0',
                    '-i', concatListPath,
                    '-c', 'copy',
                    '-avoid_negative_ts', 'make_zero',
                    outputFile,
                    '-y'
                ];

                const ffmpeg = spawn('ffmpeg', args, {
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe']
                });
                
                let stderr = '';

                ffmpeg.stderr.on('data', (data) => {
                    stderr += data.toString();
                });

                ffmpeg.on('close', async (code) => {
                    if (code === 0) {
                        try {
                            await sleep(500);
                            await this.waitForFileAccess(outputFile, 3000);
                            logger.info(`[VIDEO_CONCAT] FFmpeg concat complete`, { phase: 'ffmpeg-concat', durationMs: Date.now() - t0Concat, segmentCount: mp4Files.length, outputFile });
                            resolve(true);
                        } catch (error) {
                            logger.error(`[VIDEO] VideoProcessor.concatenateMp4Files: Output file verification failed: ${error.message}`);
                            resolve(false);
                        }
                    } else {
                        logger.error(`[VIDEO_CONCAT_ERROR] VideoProcessor.concatenateMp4Files: Error concatenating files: ${stderr}`, { phase: 'ffmpeg-concat', durationMs: Date.now() - t0Concat });
                        resolve(false);
                    }
                });

                ffmpeg.on('error', (error) => {
                    logger.error(`[VIDEO_CONCAT_ERROR] VideoProcessor.concatenateMp4Files: Exception while concatenating files: ${error.message}`);
                    resolve(false);
                });
            });
            
            // Clean up temporary concat list file
            try {
                logger.info(`[VIDEO] VideoProcessor.concatenateMp4Files: Removing temporary concat list file: ${concatListPath.length}`);
                await fs.unlink(concatListPath);
            } catch (error) {
                // Ignore cleanup errors
            }
            
            return success;
        } catch (error) {
            logger.error(`[VIDEO_CONCAT_ERROR] VideoProcessor.concatenateMp4Files: Exception while concatenating files: ${error.message}`);
            return false;
        }
    }

    /**
     * Wait for file to be accessible
     */
    async waitForFileAccess(filePath, maxWaitMs = 5000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWaitMs) {
            try {
                await fs.access(filePath, fs.constants.F_OK | fs.constants.R_OK);
                const stats = await fs.stat(filePath);
                if (stats.size > 0) {
                    // Additional verification: try to open and close the file
                    const fd = await fs.open(filePath, 'r');
                    await fs.close(fd);
                    return true;
                }
                await sleep(100);
            } catch (error) {
                if (error.code === 'EBUSY' || error.code === 'EACCES' || 
                    error.code === 'ENOENT' || error.code === 'EPERM') {
                    await sleep(200);
                    continue;
                }
                throw error;
            }
        }
        
        throw new Error(`[ERROR] VideoProcessor.waitForFileAccess: File ${filePath} is still not accessible after ${maxWaitMs}ms`);
    }

    /**
     * Convert a single file and return the converted file path
     */
    async convertSingleFile(file, bufferRecord, tempGroupDir) {
        await fs.ensureDir(tempGroupDir);
        
        const filename = path.basename(file.file_name, '.issvd');
        // Use converted_file_name if available, otherwise generate from source filename
        const outputFilename = bufferRecord.converted_file_name || `${filename}.mp4`;
        const mp4Path = path.join(tempGroupDir, outputFilename);
        
        try {
            logger.info(`[VIDEO_CONVERT] VideoProcessor.convertSingleFile: Converting: ${file.file_name} to ${mp4Path}`);
            await this.convertToMp4(file.file_path, mp4Path);
            logger.info(`[VIDEO_CONVERT] VideoProcessor.convertSingleFile: Converted: ${file.file_name} to ${mp4Path}`);
            
            await sleep(100);
            return mp4Path;
            
        } catch (error) {
            logger.error(`[VIDEO_CONVERT] VideoProcessor.convertSingleFile: Failed to convert: ${file.file_name}`, error.message);
            throw error;
        }
    }

    /**
     * Create final video from converted files
     */
    async createFinalVideo(convertedFilePaths, finalVideoPath, finalVideoName, groupKey='') {
        try {
            logger.info(`[VIDEO] VideoProcessor.createFinalVideo: Starting concatenation to: ${finalVideoName}`);

            const success = await this.concatenateMp4Files(convertedFilePaths, finalVideoPath);
            
            if (success) {
                const stats = await fs.stat(finalVideoPath);
                const fileSize = stats.size;
                
                logger.info(`[VIDEO] VideoProcessor.createFinalVideo: ✓ Created: ${finalVideoName} (${(fileSize/1024/1024).toFixed(2)} MB)`);
                
                return {
                    videoPath: finalVideoPath,
                    videoName: finalVideoName,
                    fileSize: fileSize,
                    convertedFilePaths: convertedFilePaths
                };
            } else {
                logger.error(`[VIDEO] VideoProcessor.createFinalVideo: ✗ Failed to concatenate files for group ${groupKey}`);
                return null;
            }
            
        } catch (error) {
            logger.error(`[VIDEO] VideoProcessor.createFinalVideo: Error creating final video:`, error);
            return null;
        }
    }
}

module.exports = VideoProcessor;

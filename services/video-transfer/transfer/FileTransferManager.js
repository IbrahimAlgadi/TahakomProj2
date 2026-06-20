const fs = require('fs-extra');
const path = require('path');
const { sleep } = require('../../../utils.js');
const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'FileTransferManager' });

class FileTransferManager {
    constructor(eventEmitter, pool, redis, encryptionService, config) {
        this.eventEmitter = eventEmitter;
        this.pool = pool;
        this.redis = redis;
        this.encryptionService = encryptionService;
        this.config = config;
        this.serviceConfig = {};
        this.isEncryptionRequired = false;
        this.driveInfo = null;
    }

    /**
     * Update encryption setting
     */
    setEncryptionRequired(required) {
        this.isEncryptionRequired = required;
    }

    setMainConfig(serviceConfig) {
        this.serviceConfig = serviceConfig;
    }

    /**
     * Update drive information
     */
    setDriveInfo(driveInfo) {
        this.driveInfo = driveInfo;
    }

    /**
     * Get pending transfer files
     */
    async getPendingTransferFiles() {
        // First update job status from 'pending' to 'transferring' if needed
        await this.pool.query(`
            UPDATE video_transfer_queue_job 
            SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'pending' 
            AND batch_origin = 'auto_video'
            AND EXISTS (
                SELECT 1 FROM video_transfer_queue 
                WHERE job_id = video_transfer_queue_job.id 
                AND status = 'pending'
            )
        `);
        
        const { rows } = await this.pool.query(`
            SELECT vtq.*, vtqj.batch_id, vtqj.batch_origin
            FROM video_transfer_queue vtq
            JOIN video_transfer_queue_job vtqj ON vtq.job_id = vtqj.id
            WHERE vtq.status = 'pending' 
            AND vtqj.status IN ('transferring', 'pending')
            ORDER BY vtq.created_at ASC
            LIMIT 10
        `);
        return rows;
    }


    /**
     * Get pending transfer files
     */
    async getPendingTransferFileForJob(jobId, cameraId) {
        // First update job status from 'pending' to 'transferring' if needed
        await this.pool.query(`
            UPDATE video_transfer_queue_job 
            SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'pending' 
            AND id = $1
            AND EXISTS (
                SELECT 1 FROM video_transfer_queue 
                WHERE job_id = $1
                AND camera_id = $2
                AND status = 'pending'
            )
        `, [jobId, cameraId]);
        
        const { rows } = await this.pool.query(`
            SELECT *
            FROM video_transfer_queue
            WHERE job_id = $1
            AND camera_id = $2
            AND status = 'pending'
        `, [jobId, cameraId]);

        return rows[0];
    }

    /**
     * Transfer a video file to USB
     */
    async transferFile(file) {
        logger.info(`[FILE TRANSFER] Processing video file`, { filePath: file.video_file_path, fileId: file.id });
        
        const shouldEncrypt = this.isEncryptionRequired;
        
        try {
            if (!this.driveInfo || !this.driveInfo.drive) {
                throw new Error('Drive information not available or drive not connected');
            }
            
            const usb_path = this.driveInfo.drive;
            const videoFileName = path.basename(file.video_file_path);
            const relativePath = path.join('videos', videoFileName);
            const destinationPath = path.join(usb_path, relativePath);
            
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET destination_path = $1, usb_path = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [destinationPath, usb_path, file.id]);

            const t0 = Date.now();
            if (shouldEncrypt) {
                logger.info(`[FILE TRANSFER] Encrypting video file`, { fileId: file.id, phase: 'encrypt' });
                const publicKeyPath = "certs/" + this.serviceConfig.certificates.publicKeyFilename;
                if (!publicKeyPath) {
                    logger.warn(`[FILE TRANSFER] No public key path configured, falling back to basic encryption`, { fileId: file.id });
                    await this.processEncryptedVideoFile(file, usb_path);
                } else {
                    await this.processEncryptedVideoBatch(file, usb_path, publicKeyPath);
                }
                logger.info(`[FILE TRANSFER] Encryption complete`, { fileId: file.id, durationMs: Date.now() - t0, phase: 'encrypt-done' });
            } else {
                await fs.ensureDir(path.dirname(destinationPath));
                
                const sourceExists = await fs.pathExists(file.video_file_path);
                if (!sourceExists) {
                    throw new Error(`Source video file not found: ${file.video_file_path}`);
                }
                
                let shouldCopy = true;
                const destExists = await fs.pathExists(destinationPath);
                
                if (destExists) {
                    try {
                        const sourceStat = await fs.stat(file.video_file_path);
                        const destStat = await fs.stat(destinationPath);
                        
                        if (sourceStat.size === destStat.size) {
                            logger.info(`[FILE TRANSFER] File already exists with same size, skipping`, { destPath: destinationPath, fileId: file.id });
                            shouldCopy = false;
                        }
                    } catch (statError) {
                        logger.warn(`[FILE TRANSFER] Could not compare file stats`, { error: statError.message, fileId: file.id });
                    }
                }
                
                if (shouldCopy) {
                    await this.copyWithRetry(file.video_file_path, destinationPath, 3, 1000);
                    logger.info(`[FILE TRANSFER] USB copy complete`, { phase: 'usb-copy', durationMs: Date.now() - t0, destPath: destinationPath, fileId: file.id });
                }
            }
            
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [file.id]);
            
            logger.info(`[FILE TRANSFER] Successfully transferred video file`, { fileId: file.id, phase: 'usb-copy-done' });
            
        } catch (error) {
            logger.error(`[FILE TRANSFER] Failed to process video file`, { fileId: file.id, error: error.message, stack: error.stack });
            throw error;
        }
    }

    /**
     * Copy file with retry mechanism
     */
    async copyWithRetry(sourcePath, destPath, maxRetries = 3, delay = 1000) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await fs.copy(sourcePath, destPath, { overwrite: true, errorOnExist: false });
                return;
            } catch (error) {
                lastError = error;
                
                if (error.code === 'EBUSY' && attempt < maxRetries) {
                    logger.warn(`[FILE TRANSFER] Copy attempt ${attempt} failed with EBUSY, retrying in ${delay}ms`, { destPath, attempt, maxRetries });
                    await sleep(delay);
                    continue;
                }
                
                throw error;
            }
        }
        
        throw lastError;
    }

    /**
     * Handle transfer errors
     */
    async handleTransferError(file, error) {
        const isFileNotFound = error.code === 'ENOENT';
        const isNoSpaceError = error.code === 'ENOSPC';
        
        if (isFileNotFound) {
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET status = 'failed', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [`File not found: ${error.message}`, file.id]);
        } else if (isNoSpaceError) {
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET status = 'paused', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [`No space left on device: ${error.message}`, file.id]);
            
            return { shouldStopProcessing: true };
        } else {
            const newRetryCount = (file.retry_count || 0) + 1;
            const maxRetries = file.max_retries || 3;
            const newStatus = newRetryCount >= maxRetries ? 'failed' : 'pending';
            
            await this.pool.query(`
                UPDATE video_transfer_queue 
                SET retry_count = $1, status = $2, error_message = $3, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $4
            `, [newRetryCount, newStatus, `Retry ${newRetryCount}/${maxRetries}: ${error.message}`, file.id]);
        }
        
        return { shouldStopProcessing: false };
    }

    /**
     * Process encrypted video file
     */
    async processEncryptedVideoFile(file, usb_path) {
        const relativeDirPath = 'videos';
        const destinationGroupDir = path.join(usb_path, relativeDirPath);
        
        await fs.ensureDir(destinationGroupDir);
        
        const { key: aesKey, iv: aesIv } = this.encryptionService.generateAESKey();
        
        const newFilename = `${file.id}`;
        const encryptedFilePath = path.join(destinationGroupDir, newFilename);
        
        logger.info(`[FILE TRANSFER] Encrypting video file (basic)`, { filePath: file.video_file_path, encryptedFilePath, phase: 'encrypt' });
        await this.encryptionService.encryptFileAES(file.video_file_path, encryptedFilePath, aesKey, aesIv);
        
        await this.pool.query(`
            UPDATE video_transfer_queue 
            SET error_message = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [JSON.stringify({aesKey: aesKey.toString('hex'), iv: aesIv.toString('hex')}), file.id]);
    }

    /**
     * Process encrypted video file with metadata creation
     * Creates encrypted file with original name and RSA-encrypted metadata.json
     */
    async processEncryptedVideoBatch(file, usb_path, publicKeyPath) {
        if (!this.encryptionService) {
            throw new Error('Encryption service not available');
        }

        const relativeDirPath = 'videos';
        const destinationGroupDir = path.join(usb_path, relativeDirPath);
        
        await fs.ensureDir(destinationGroupDir);
        
        // Generate AES key for this video
        const { key: aesKey, iv: aesIv } = this.encryptionService.generateAESKey();
        
        // Extract filename without extension
        const originalFilename = path.basename(file.video_file_path, path.extname(file.video_file_path));
        const newFilename = originalFilename; // Use original name without .mp4
        const encryptedFilePath = path.join(destinationGroupDir, newFilename);
        
        const t0Encrypt = Date.now();
        logger.info(`[FILE TRANSFER] Encrypting video file (batch)`, { filePath: file.video_file_path, encryptedFilePath, phase: 'encrypt' });
        await this.encryptionService.encryptFileAES(file.video_file_path, encryptedFilePath, aesKey, aesIv);
        
        // Create metadata structure following same pattern as images
        const metadata = {
            files: null,
            keys: null
        };
        
        const keysData = {
            aesKey: aesKey.toString('hex'),
            iv: aesIv.toString('hex')
        };
        
        const filesData = [{
            original: path.basename(file.video_file_path),
            new: newFilename
        }];
        
        // Encrypt files data with AES and keys data with RSA
        const filesDataEncrypted = await this.encryptionService.encryptDataAES(JSON.stringify(filesData), aesKey, aesIv);
        const keysDataEncrypted = await this.encryptionService.encryptWithRSAPublicKey(JSON.stringify(keysData), publicKeyPath);
        
        metadata.files = filesDataEncrypted;
        metadata.keys = keysDataEncrypted;
        
        // Create metadata file with video filename
        const metadataJson = JSON.stringify(metadata, null, 2);
        const metadataPath = path.join(destinationGroupDir, `${newFilename}_metadata.json`);
        
        logger.info(`[FILE TRANSFER] Creating encrypted metadata file`, { metadataPath, phase: 'encrypt' });
        await fs.writeFile(metadataPath, metadataJson);
        
        // Update database with metadata
        await this.pool.query(`
            UPDATE video_transfer_queue 
            SET error_message = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [JSON.stringify({
            fileName: newFilename,
            metadataFile: `${newFilename}_metadata.json`,
            aesKey: aesKey.toString('hex'), 
            iv: aesIv.toString('hex')
        }), file.id]);
        
        logger.info(`[FILE TRANSFER] Encrypted video with metadata created`, { destDir: destinationGroupDir, durationMs: Date.now() - t0Encrypt, phase: 'encrypt-done' });
    }

    /**
     * Mark source files as transferred
     */
    async markSourceFilesAsTransferred(file) {
        try {
            const sourceFileIdsResult = await this.pool.query(`
                SELECT source_file_ids 
                FROM video_transfer_queue 
                WHERE id = $1
            `, [file.id]);
            
            if (sourceFileIdsResult.rows.length === 0) {
                logger.warn(`[FILE TRANSFER] No video transfer queue record found for file`, { fileId: file.id, phase: 'mark-transferred' });
                return;
            }
            
            const sourceFileIds = sourceFileIdsResult.rows[0].source_file_ids;
            
            if (!sourceFileIds || sourceFileIds.length === 0) {
                logger.warn(`[FILE TRANSFER] No source file IDs found for video`, { videoName: path.basename(file.video_file_path), phase: 'mark-transferred' });
                return;
            }
            
            await this.pool.query(`
                UPDATE iss_media_files 
                SET is_auto_transferred = true, updated_at = CURRENT_TIMESTAMP 
                WHERE id = ANY($1)
            `, [sourceFileIds]);
            
            logger.info(`[FILE TRANSFER] Marked source files as transferred`, { sourceFileCount: sourceFileIds.length, videoName: path.basename(file.video_file_path), phase: 'mark-transferred' });
            
        } catch (error) {
            logger.error(`[FILE TRANSFER] Failed to mark source files as transferred`, { filePath: file.video_file_path, error: error.message, stack: error.stack });
        }
    }

    /**
     * Clean up temporary video files
     */
    async cleanupTempVideo(videoPath) {
        try {
            await fs.unlink(videoPath);
            logger.info(`[FILE TRANSFER] Deleted temporary video`, { videoPath, phase: 'cleanup' });
            
            const parentDir = path.dirname(videoPath);
            const files = await fs.readdir(parentDir);
            if (files.length === 0) {
                await fs.rmdir(parentDir);
                logger.info(`[FILE TRANSFER] Removed empty temporary directory`, { parentDir, phase: 'cleanup' });
            }
        } catch (error) {
            logger.warn(`[FILE TRANSFER] Could not clean up temporary file/directory`, { videoPath, error: error.message, phase: 'cleanup' });
        }
    }
}

module.exports = FileTransferManager;

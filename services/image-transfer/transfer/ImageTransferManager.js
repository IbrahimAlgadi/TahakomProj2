const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'ImageTransferManager', logFile: 'image-usb-pipeline' });
const fs = require('fs-extra');
const path = require('path');
const TransferUtils = require('../../shared/TransferUtils');

class ImageTransferManager {
    constructor(pool, redis, config, encryptionService = null) {
        this.pool = pool;
        this.redis = redis;
        this.config = config;
        this.encryptionService = encryptionService;
        
        // USB Image transfer tables
        this.transferQueueTable = 'transfer_queue';
        this.jobTable = 'transfer_queue_job';
        this.sourceFilesTable = 'files';
        
        // Configuration
        this.isEncryptionRequired = false;
        this.driveInfo = null;
    }

    /**
     * Set encryption requirement
     */
    setEncryptionRequired(required) {
        this.isEncryptionRequired = required;
        // logger.info(`[IMAGE_TRANSFER] ImageTransferManager.setEncryptionRequired: Encryption ${required ? 'enabled' : 'disabled'}`);
    }

    /**
     * Set drive information
     */
    setDriveInfo(driveInfo) {
        this.driveInfo = driveInfo;
    }

    /**
     * Get pending files for processing
     */
    async getPendingFiles(limit = 100) {
        // First update job status from 'pending' to 'transferring' if needed
        await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'pending' 
            AND batch_origin = 'auto'
            AND EXISTS (
                SELECT 1 FROM ${this.transferQueueTable} 
                WHERE job_id = ${this.jobTable}.id 
                AND status = 'pending'
            )
        `);

        let filesQuery = `
            SELECT tq.*, tqj.batch_id, tqj.batch_origin
            FROM ${this.transferQueueTable} tq
            JOIN ${this.jobTable} tqj ON tq.job_id = tqj.id
            WHERE tq.status = 'pending' 
            AND tqj.status IN ('transferring', 'pending')
            AND tqj.batch_origin = 'auto'
            ORDER BY tq.created_at ASC
            LIMIT $1
        `;
        // logger.info(filesQuery);

        const { rows } = await this.pool.query(filesQuery, [limit]);

        return rows;
    }

    /**
     * Process individual image file
     */
    async processImageFile(file) {
        logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processImageFile: Processing image file: ${file.file_path}`);
        
        // Capture encryption decision ONCE at the start to avoid race conditions
        const shouldEncrypt = this.isEncryptionRequired;
        logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processImageFile: Image file ${file.id} - shouldEncrypt: ${shouldEncrypt}`);
        
        try {
            // Update file destinations based on current config
            const exportDir = this.config.storage && this.config.storage.directory;
            const usbPath = `${this.config.autoTransfer && this.config.autoTransfer.drive}:\\`;
            
            if (!exportDir || !(this.config.autoTransfer && this.config.autoTransfer.drive)) {
                throw new Error('Missing export directory or USB drive configuration');
            }
            
            // For image files, maintain directory structure
            const normalizedExportDir = path.normalize(exportDir);
            const normalizedFilePath = path.normalize(file.file_path);

            logger.info(`[IMAGE_TRANSFER] DEBUG: exportDir="${normalizedExportDir}", file.file_path="${normalizedFilePath}"`);

            let relativePath = path.relative(normalizedExportDir, normalizedFilePath);

            // Safety check: If path.relative returns an absolute path, something is wrong
            if (path.isAbsolute(relativePath)) {
                logger.error(`[IMAGE_TRANSFER] ERROR: path.relative returned absolute path: "${relativePath}"`);
                logger.error(`[IMAGE_TRANSFER] exportDir: "${normalizedExportDir}", file.file_path: "${normalizedFilePath}"`);

                // Fallback: Try to strip exportDir manually
                if (normalizedFilePath.startsWith(normalizedExportDir)) {
                    relativePath = normalizedFilePath.substring(normalizedExportDir.length).replace(/^[\\\/]+/, '');
                } else {
                    throw new Error(`File path "${normalizedFilePath}" is not under export directory "${normalizedExportDir}"`);
                }
            }

            const destinationPath = path.join(usbPath, relativePath);
            
            logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processImageFile: Image file: ${path.basename(file.file_path)} -> ${relativePath}`);
            
            // Update the transfer_queue record with paths
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET destination_path = $1, usb_path = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [destinationPath, usbPath, file.id]);

            if (shouldEncrypt && this.encryptionService) {
                // Handle encrypted image transfer
                await this.processEncryptedImageFile(file, exportDir, usbPath);
            } else {
                // Handle normal transfer
                await this.processNormalImageFile(file, destinationPath);
            }
            
            // Mark as transferred on success
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [file.id]);
            
            // Update original files table (files.is_auto_transferred — the column getFilesToTransfer checks)
            await TransferUtils.markImageFilesAsTransferred(this.pool, [file.file_id], 'auto');
            
            logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processImageFile: Successfully transferred image file ID: ${file.id}`);
            
        } catch (error) {
            logger.error(`[IMAGE_TRANSFER] ImageTransferManager.processImageFile: Failed to process image file ${file.id}:`, error);
            // await TransferUtils.handleTransferError(this.pool, this.file, error, 'transfer_queue');
            throw error;
        }
    }

    /**
     * Process normal (unencrypted) image file transfer
     */
    async processNormalImageFile(file, destinationPath) {
        await fs.ensureDir(path.dirname(destinationPath));
        
        // Check if destination file already exists and skip if same size
        const sourceExists = await fs.pathExists(file.file_path);
        const destExists = await fs.pathExists(destinationPath);
        
        if (!sourceExists) {
            throw new Error(`Source image file not found: ${file.file_path}`);
        }
        
        let shouldCopy = true;
        
        // if (destExists) {
        //     try {
        //         const sourceStat = await fs.stat(file.file_path);
        //         const destStat = await fs.stat(destinationPath);
                
        //         // If destination file has same size, assume it's already transferred correctly
        //         if (sourceStat.size === destStat.size) {
        //             logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processNormalImageFile: File already exists with same size, skipping copy: ${destinationPath}`);
        //             shouldCopy = false;
        //         }
        //     } catch (statError) {
        //         logger.warn(`[IMAGE_TRANSFER] ImageTransferManager.processNormalImageFile: Could not compare file stats, proceeding with copy: ${statError.message}`);
        //     }
        // }
        
        if (shouldCopy) {
            // Use retry mechanism for copying
            await this.copyWithRetry(file.file_path, destinationPath, 3, 1000);
            logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processNormalImageFile: Copied: ${file.file_path} to ${destinationPath}`);
        } else {
            logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processNormalImageFile: Skipped copy (file exists): ${file.file_path} to ${destinationPath}`);
        }
    }

    /**
     * Process encrypted image file transfer
     */
    async processEncryptedImageFile(file, exportDir, usbPath) {
        if (!this.encryptionService) {
            throw new Error('Encryption service not available');
        }

        // For image files, use the existing logic
        const normalizedExportDir = path.normalize(exportDir);
        const normalizedFilePath = path.normalize(file.file_path);

        logger.info(`[IMAGE_TRANSFER] DEBUG: exportDir="${normalizedExportDir}", file.file_path="${normalizedFilePath}"`);

        let relativePath = path.relative(normalizedExportDir, normalizedFilePath);

        // Safety check: If path.relative returns an absolute path, something is wrong
        if (path.isAbsolute(relativePath)) {
            logger.error(`[IMAGE_TRANSFER] ERROR: path.relative returned absolute path: "${relativePath}"`);
            logger.error(`[IMAGE_TRANSFER] exportDir: "${normalizedExportDir}", file.file_path: "${normalizedFilePath}"`);

            // Fallback: Try to strip exportDir manually
            if (normalizedFilePath.startsWith(normalizedExportDir)) {
                relativePath = normalizedFilePath.substring(normalizedExportDir.length).replace(/^[\\\/]+/, '');
            } else {
                throw new Error(`File path "${normalizedFilePath}" is not under export directory "${normalizedExportDir}"`);
            }
        }

        const relativeDirPath = path.dirname(relativePath);
        const destinationGroupDir = path.join(usbPath, relativeDirPath);
        
        await fs.ensureDir(destinationGroupDir);
        
        // Generate AES key for this file
        const { key: aesKey, iv: aesIv } = this.encryptionService.generateAESKey();
        
        const newFilename = `${file.id}`; // Use file ID as encrypted filename
        const encryptedFilePath = path.join(destinationGroupDir, newFilename);
        
        logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processEncryptedImageFile: Encrypting: ${file.file_path} to ${encryptedFilePath}`);
        await this.encryptionService.encryptFileAES(file.file_path, encryptedFilePath, aesKey, aesIv);
        
        // Store encryption metadata in the transfer_queue table
        await this.pool.query(`
            UPDATE ${this.transferQueueTable} 
            SET error_message = $1, updated_at = CURRENT_TIMESTAMP 
            WHERE id = $2
        `, [JSON.stringify({aesKey: aesKey.toString('hex'), iv: aesIv.toString('hex')}), file.id]);
    }

    /**
     * Process encrypted image file transfer with batch grouping and metadata creation
     * Groups images into batches of 3, encrypts with shared AES key, and creates RSA-encrypted metadata.json
     */
    async processEncryptedImageBatch(dirFiles, relativeDirPath, exportDir, usbPath, publicKeyPath) {
        if (!this.encryptionService) {
            throw new Error('Encryption service not available');
        }
        
        const batches = this.groupFilesIntoBatches(dirFiles, 3);
            
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
            const batch = batches[batchIndex];
            const destinationGroupDir = path.join(usbPath, relativeDirPath);
            
            await fs.ensureDir(destinationGroupDir);
            
            // Generate shared AES key for this batch
            const { key: aesKey, iv: aesIv } = this.encryptionService.generateAESKey();
            
            // Create metadata structure
            const metadata = {
                files: [],
                keys: null
            };
            const keysData = {
                aesKey: aesKey.toString('hex'),
                iv: aesIv.toString('hex')
            }
            let filesData = [];
            
            // Encrypt each file in the batch with meaningful filenames
            for (let i = 0; i < batch.length; i++) {
                const file = batch[i];
                
                // Extract meaningful part of filename (up to camera number)
                const originalFilename = path.basename(file.file_path, path.extname(file.file_path));
                const parts = originalFilename.split('__');
                // Find the camera part and take everything up to and including it
                let newFilename = '';
                for (let j = 0; j < parts.length; j++) {
                    if (parts[j].startsWith('Camera ')) {
                        newFilename = parts.slice(0, j + 1).join('__');
                        break;
                    }
                }
                // Fallback to sequential numbering if pattern not found
                if (!newFilename) {
                    newFilename = (i + 1).toString();
                }
                
                const encryptedFilePath = path.join(destinationGroupDir, newFilename);
                
                logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processEncryptedImageBatch: Encrypting batch file: ${file.file_path} to ${encryptedFilePath}`);
                await this.encryptionService.encryptFileAES(file.file_path, encryptedFilePath, aesKey, aesIv);
                
                filesData.push({
                    original: path.basename(file.file_path),
                    new: newFilename
                });
                
                // Update database with batch metadata
                await this.pool.query(`
                    UPDATE ${this.transferQueueTable} 
                    SET error_message = $1, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $2
                `, [JSON.stringify({
                    batchIndex: batchIndex,
                    fileName: newFilename,
                    aesKey: aesKey.toString('hex'), 
                    iv: aesIv.toString('hex')
                }), file.id]);

                // Mark as transferred on success
                await this.pool.query(`
                    UPDATE ${this.transferQueueTable} 
                    SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                    WHERE id = $1
                `, [file.id]);
                
                // Update original files table (files.is_auto_transferred — the column getFilesToTransfer checks)
                await TransferUtils.markImageFilesAsTransferred(this.pool, [file.file_id], 'auto');
                
                logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processEncryptedImageBatch: Successfully transferred image file ID: ${file.id}`);
            }
            
            // Create and encrypt metadata.json with RSA
            const filesDataEncrypted = await this.encryptionService.encryptDataAES(JSON.stringify(filesData), aesKey, aesIv);
            const keysDataEncrypted = await this.encryptionService.encryptWithRSAPublicKey(JSON.stringify(keysData), publicKeyPath);
            metadata.files = filesDataEncrypted;
            metadata.keys = keysDataEncrypted;
            
            const metadataJson = JSON.stringify(metadata, null, 2);
            const metadataPath = path.join(destinationGroupDir, 'metadata.json');
            logger.info({
                'filesData': filesData,
                'keysData': keysData,
                'metadataPath': metadataPath,
            });
            
            logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processEncryptedImageBatch: Creating RSA-encrypted metadata file: ${metadataPath}`);
            // const encryptedMetadata = await this.encryptionService.encryptWithRSAPublicKey(metadataJson, publicKeyPath);
            await fs.writeFile(metadataPath, metadataJson);
            
            logger.info(`[IMAGE_TRANSFER] ImageTransferManager.processEncryptedImageBatch: Created encrypted batch ${batchIndex + 1} with ${batch.length} files in: ${destinationGroupDir}`);
        }
    }

    /**
     * Group files by their directory structure
     */
    groupFilesByDirectory(files, exportDir) {
        const filesByDir = {};
        
        for (const file of files) {
            const normalizedExportDir = path.normalize(exportDir);
            const normalizedFilePath = path.normalize(file.file_path);

            logger.info(`[IMAGE_TRANSFER] DEBUG: exportDir="${normalizedExportDir}", file.file_path="${normalizedFilePath}"`);

            let relativePath = path.relative(normalizedExportDir, normalizedFilePath);

            // Safety check: If path.relative returns an absolute path, something is wrong
            if (path.isAbsolute(relativePath)) {
                logger.error(`[IMAGE_TRANSFER] ERROR: path.relative returned absolute path: "${relativePath}"`);
                logger.error(`[IMAGE_TRANSFER] exportDir: "${normalizedExportDir}", file.file_path: "${normalizedFilePath}"`);

                // Fallback: Try to strip exportDir manually
                if (normalizedFilePath.startsWith(normalizedExportDir)) {
                    relativePath = normalizedFilePath.substring(normalizedExportDir.length).replace(/^[\\\/]+/, '');
                } else {
                    throw new Error(`File path "${normalizedFilePath}" is not under export directory "${normalizedExportDir}"`);
                }
            }

            const relativeDirPath = path.dirname(relativePath);
            logger.info({
                'groupFilesByDirectory': {
                    relativeDirPath
                }
            });
            
            if (!filesByDir[relativeDirPath]) {
                filesByDir[relativeDirPath] = [];
            }
            filesByDir[relativeDirPath].push(file);
        }
        logger.info({filesByDir});
        return filesByDir;
    }

    /**
     * Group files into batches of specified size
     */
    groupFilesIntoBatches(files, batchSize) {
        const batches = [];
        for (let i = 0; i < files.length; i += batchSize) {
            batches.push(files.slice(i, i + batchSize));
        }
        return batches;
    }

    /**
     * Copy file with retry mechanism for EBUSY errors
     */
    async copyWithRetry(sourcePath, destPath, maxRetries = 3, delay = 1000) {
        let lastError;
        
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await fs.copy(sourcePath, destPath, { overwrite: true, errorOnExist: false });
                return; // Success, exit the function
            } catch (error) {
                lastError = error;
                
                // If it's an EBUSY error and we have more attempts, wait and retry
                if (error.code === 'EBUSY' && attempt < maxRetries) {
                    logger.warn(`[IMAGE_TRANSFER] ImageTransferManager.copyWithRetry: Copy attempt ${attempt} failed with EBUSY error, retrying in ${delay}ms...`);
                    await this.sleep(delay);
                    continue;
                }
                
                // If it's not EBUSY or we're out of attempts, throw the error
                throw error;
            }
        }
        
        throw lastError;
    }

    /**
     * Update transfer status for a file
     */
    async updateTransferStatus(fileId, status, errorMessage = null) {
        const query = errorMessage 
            ? `UPDATE ${this.transferQueueTable} SET status = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3`
            : `UPDATE ${this.transferQueueTable} SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`;
            
        const params = errorMessage ? [status, errorMessage, fileId] : [status, fileId];
        
        await this.pool.query(query, params);
        logger.info(`[IMAGE_TRANSFER] ImageTransferManager.updateTransferStatus: Updated file ${fileId} status to: ${status}`);
    }

    /**
     * Check and update completed jobs
     */
    async checkAndUpdateCompletedJobs() {
        // Find jobs that might be completed
        const jobsToCheck = await this.pool.query(`
            SELECT DISTINCT tqj.id, tqj.batch_id
            FROM ${this.jobTable} tqj
            WHERE tqj.status = 'transferring'
            AND NOT EXISTS (
                SELECT 1 FROM ${this.transferQueueTable} tq 
                WHERE tq.job_id = tqj.id AND tq.status = 'pending'
            )
        `);

        for (const job of jobsToCheck.rows) {
            const jobStatus = await this.pool.query(`
                SELECT 
                    COUNT(*) as total_files,
                    COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_files
                FROM ${this.transferQueueTable} 
                WHERE job_id = $1
            `, [job.id]);
            
            const stats = jobStatus.rows[0];
            const jobFinalStatus = stats.transferred_files > 0 ? 'transferred' : 'failed';
            
            await this.pool.query(`
                UPDATE ${this.jobTable} 
                SET status = $1, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [jobFinalStatus, job.id]);
            
            logger.info(`[IMAGE_TRANSFER] ImageTransferManager.checkAndUpdateCompletedJobs: Job ${job.id} (${job.batch_id}) marked as ${jobFinalStatus} - transferred: ${stats.transferred_files}, failed: ${stats.failed_files}`);
        }
    }

    /**
     * Sleep utility
     */
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = ImageTransferManager;

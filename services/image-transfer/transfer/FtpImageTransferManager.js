const ImageTransferManager = require('./ImageTransferManager');
const TransferUtils = require('../../shared/TransferUtils');
const ftp = require('basic-ftp');
const fs = require('fs-extra');
const path = require('path');

class FtpImageTransferManager extends ImageTransferManager {
    constructor(pool, redis, config, ftpConfig = null) {
        super(pool, redis, config, null); // No encryption service for FTP
        
        // FTP Image transfer tables
        this.transferQueueTable = 'ftp_image_transfer_queue';
        this.jobTable = 'ftp_image_transfer_queue_job';
        
        // FTP Configuration
        this.ftpConfig = ftpConfig;
        this.ftpClient = null;
        this.isConnected = false;
    }

    /**
     * Set FTP configuration
     */
    setFtpConfig(ftpConfig) {
        this.ftpConfig = ftpConfig;
        this.isConnected = ftpConfig && ftpConfig.connection && ftpConfig.connection.status === 'connected';
        console.log(`[FTP_IMAGE_TRANSFER] FTP connection status: ${this.isConnected ? 'connected' : 'disconnected'}`);
    }

    /**
     * Check if FTP is ready for transfers
     */
    isFtpReady() {
        return this.isConnected && this.ftpConfig && this.ftpConfig.server;
    }

    /**
     * Get pending FTP files for processing
     */
    async getPendingFiles(limit = 50) { // Smaller limit for FTP transfers
        // First update job status from 'pending' to 'transferring' if needed
        await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'pending' 
            AND batch_origin = 'auto_ftp'
            AND EXISTS (
                SELECT 1 FROM ${this.transferQueueTable} 
                WHERE job_id = ${this.jobTable}.id 
                AND status = 'pending'
            )
        `);

        const { rows } = await this.pool.query(`
            SELECT tq.*, tqj.batch_id, tqj.batch_origin
            FROM ${this.transferQueueTable} tq
            JOIN ${this.jobTable} tqj ON tq.job_id = tqj.id
            WHERE tq.status = 'pending' 
            AND tqj.status IN ('transferring', 'pending')
            AND tqj.batch_origin = 'auto_ftp'
            ORDER BY tq.created_at ASC
            LIMIT $1
        `, [limit]);

        return rows;
    }

    /**
     * Process individual image file for FTP upload
     */
    async processImageFile(file) {
        console.log(`[FTP_IMAGE_TRANSFER] Processing image file: ${file.file_path}`);
        
        if (!this.isFtpReady()) {
            throw new Error('FTP server not ready for transfers');
        }
        
        try {
            // Check if source file exists
            const sourceExists = await fs.pathExists(file.file_path);
            if (!sourceExists) {
                throw new Error(`Source image file not found: ${file.file_path}`);
            }
            
            // Connect to FTP if not already connected
            await this.connectFtp();
            
            // Upload file to FTP server
            await this.uploadToFtp(file.file_path, file.ftp_remote_path);
            
            // Update the transfer_queue record with FTP details
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET ftp_server_host = $1, ftp_upload_time = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $2
            `, [this.ftpConfig.server.host, file.id]);
            
            // Mark as transferred on success
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET status = 'transferred', transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [file.id]);
            
            // Update original files table
            await TransferUtils.markSourceFilesAsTransferred(this.pool, [file.file_id], 'ftp');
            
            console.log(`[FTP_IMAGE_TRANSFER] Successfully uploaded image file ID: ${file.id} to ${file.ftp_remote_path}`);
            
        } catch (error) {
            console.error(`[FTP_IMAGE_TRANSFER] Failed to process image file ${file.id}:`, error);
            
            // If FTP connection error, mark as disconnected
            if (this.isFtpConnectionError(error)) {
                this.isConnected = false;
                await this.disconnectFtp();
            }
            
            throw error;
        }
    }

    /**
     * Connect to FTP server
     */
    async connectFtp() {
        if (this.ftpClient && this.isConnected) {
            return; // Already connected
        }

        try {
            this.ftpClient = new ftp.Client();
            this.ftpClient.ftp.timeout = 30000; // 30 second timeout
            
            // Enable verbose logging for debugging
            this.ftpClient.ftp.verbose = true;
            
            // Determine if secure connection is needed
            const isSecure = this.ftpConfig.server.secure || 
                           (this.ftpConfig.server.protocol && this.ftpConfig.server.protocol.toLowerCase() === 'ftps');
            
            // Prepare connection options
            const connectionOptions = {
                host: this.ftpConfig.server.host,
                port: this.ftpConfig.server.port || 21,
                user: this.ftpConfig.server.username,
                password: this.ftpConfig.server.password,
                secure: isSecure
            };

            // Add secure options for FTPS connections
            if (isSecure) {
                connectionOptions.secureOptions = this.ftpConfig.server.secureOptions || {
                    rejectUnauthorized: false // Allow self-signed certificates by default
                };
            }

            console.log(`[FTP_IMAGE_TRANSFER] Connecting to ${this.ftpConfig.server.protocol || 'FTP'} server: ${this.ftpConfig.server.host}:${connectionOptions.port} (secure: ${connectionOptions.secure})`);
            
            await this.ftpClient.access(connectionOptions);
            
            this.isConnected = true;
            console.log(`[FTP_IMAGE_TRANSFER] Successfully connected to ${this.ftpConfig.server.protocol || 'FTP'} server: ${this.ftpConfig.server.host}`);
            
        } catch (error) {
            console.error('[FTP_IMAGE_TRANSFER] Failed to connect to FTP server:', error);
            this.isConnected = false;
            throw error;
        }
    }

    /**
     * Disconnect from FTP server
     */
    async disconnectFtp() {
        try {
            if (this.ftpClient) {
                this.ftpClient.close();
                this.ftpClient = null;
            }
            this.isConnected = false;
            console.log('[FTP_IMAGE_TRANSFER] Disconnected from FTP server');
        } catch (error) {
            console.error('[FTP_IMAGE_TRANSFER] Error disconnecting from FTP:', error);
        }
    }

    /**
     * Upload file to FTP server
     */
    async uploadToFtp(localPath, remotePath) {
        if (!this.ftpClient || !this.isConnected) {
            throw new Error('FTP client not connected');
        }

        try {
            // console.log({
            //     file,
            //     ftpConfig: this.ftpConfig.server.remotePath + remotePath
            // });

            // Construct full remote path including base directory
            const fullRemotePath = path.posix.join(this.ftpConfig.server.remoteDirectory || '/', remotePath);
            const remoteDir = path.dirname(fullRemotePath);
            
            console.log(`[FTP_IMAGE_TRANSFER] Full paths:`);
            console.log(`  Local: ${localPath}`);
            console.log(`  Remote: ${fullRemotePath}`);
            console.log(`  Remote dir: ${remoteDir}`);
            
            // Ensure remote directory exists using simple approach
            await this.ensureFtpDirectory(remoteDir);
            
            // Upload the file using the full path
            console.log(`[FTP_IMAGE_TRANSFER] Uploading file...`);
            await this.ftpClient.uploadFrom(localPath, fullRemotePath);
            
            console.log(`[FTP_IMAGE_TRANSFER] Successfully uploaded: ${fullRemotePath}`);
            
        } catch (error) {
            console.error(`[FTP_IMAGE_TRANSFER] FTP upload failed for ${localPath}:`, error);
            throw error;
        }
    }

    /**
     * Ensure FTP directory exists - simplified using basic-ftp ensureDir
     */
    async ensureFtpDirectory(dirPath) {
        if (!dirPath || dirPath === '/' || dirPath === '.') {
            return;
        }

        try {
            console.log(`[FTP_IMAGE_TRANSFER] Ensuring directory: ${dirPath}`);
            
            // Use the simple basic-ftp approach
            await this.ftpClient.ensureDir(dirPath);
            
            console.log(`[FTP_IMAGE_TRANSFER] Successfully ensured directory: ${dirPath}`);
            
        } catch (error) {
            console.error(`[FTP_IMAGE_TRANSFER] Failed to ensure directory ${dirPath}:`, error);
            
            // Parse specific 550 error messages
            if (error.code === 550) {
                const errorMessage = error.message.toLowerCase();
                
                if (errorMessage.includes('no space left') || errorMessage.includes('disk full') || errorMessage.includes('quota')) {
                    throw new Error(`FTP server disk space full. Cannot create directory ${dirPath}. Error: ${error.message}`);
                } else if (errorMessage.includes('permission denied') || errorMessage.includes('access denied')) {
                    throw new Error(`Permission denied creating directory ${dirPath}. Check FTP user permissions. Error: ${error.message}`);
                } else if (errorMessage.includes('already exists') || errorMessage.includes('file exists')) {
                    // This should normally be handled by ensureDir, but if we get here, continue
                    console.log(`[FTP_IMAGE_TRANSFER] Directory ${dirPath} already exists, continuing...`);
                    return;
                } else {
                    throw new Error(`Failed to create directory ${dirPath}. FTP Error 550: ${error.message}`);
                }
            } else if (error.code === 530) {
                throw new Error(`Authentication required for creating directory ${dirPath}. Error: ${error.message}`);
            }
            
            throw error;
        }
    }

    /**
     * Check if error is FTP connection related
     */
    isFtpConnectionError(error) {
        const connectionErrors = [
            'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
            'Connection', 'Timeout', 'Login', 'Authentication', 'AUTH first',
            '503', 'Use AUTH first'
        ];
        
        return connectionErrors.some(errorType => 
            error.message.includes(errorType) || error.code === errorType || 
            (typeof error.code === 'number' && error.code === 503)
        );
    }

    /**
     * Handle transfer error with FTP-specific logic
     */
    async handleTransferError(file, error) {
        console.error(`[FTP_IMAGE_TRANSFER] Transfer failed for ${file.file_path}:`, error);
        
        const newRetryCount = (file.retry_count || 0) + 1;
        const isConnectionError = this.isFtpConnectionError(error);
        
        if (isConnectionError) {
            // For connection errors, pause the job and disconnect
            this.isConnected = false;
            await this.disconnectFtp();
            
            await this.pool.query(`
                UPDATE ${this.jobTable} 
                SET status = 'paused', error_message = $1, updated_at = CURRENT_TIMESTAMP 
                WHERE id = (SELECT job_id FROM ${this.transferQueueTable} WHERE id = $2)
            `, ['FTP connection error: ' + error.message, file.id]);
            
            console.log(`[FTP_IMAGE_TRANSFER] Job paused due to FTP connection error`);
        } else if (newRetryCount >= (file.max_retries || 3)) {
            // Max retries reached, mark as failed
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET status = 'failed', retry_count = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [newRetryCount, error.message, file.id]);
        } else {
            // Increment retry count
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET retry_count = $1, error_message = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [newRetryCount, error.message, file.id]);
        }
    }

    /**
     * Override the encryption methods (not supported for FTP)
     */
    async processEncryptedImageFile(file, exportDir, targetPath) {
        throw new Error('Encryption not supported for FTP transfers');
    }

    setEncryptionRequired(required) {
        if (required) {
            console.warn('[FTP_IMAGE_TRANSFER] Encryption not supported for FTP transfers');
        }
        // Do nothing - FTP doesn't support encryption in this implementation
    }

    /**
     * Cleanup - disconnect FTP on shutdown
     */
    async cleanup() {
        await this.disconnectFtp();
    }
}

module.exports = FtpImageTransferManager;

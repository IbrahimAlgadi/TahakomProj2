const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'FtpTransferManager' });
const fs = require('fs-extra');
const path = require('path');
const { sleep } = require('../../../utils.js');
const TransferUtils = require('../../shared/TransferUtils');
const ftp = require('basic-ftp');

class FtpTransferManager {
    constructor(eventEmitter, pool, redis, config) {
        this.eventEmitter = eventEmitter;
        this.pool = pool;
        this.redis = redis;
        this.config = config;
        this.ftpConfig = null;
        this.isConnected = false;
        
        // FTP transfer tables
        this.transferQueueTable = 'ftp_video_transfer_queue';
        this.jobTable = 'ftp_video_transfer_queue_job';
    }

    /**
     * Set FTP configuration from config file
     */
    setFtpConfig(ftpConfig) {
        this.ftpConfig = ftpConfig;
        this.isConnected = ftpConfig && ftpConfig.connection && ftpConfig.connection.status === 'connected';
        logger.info(`[FTP_TRANSFER] setFtpConfig: FTP connection status: ${this.isConnected ? 'connected' : 'disconnected'}`);
    }

    /**
     * Check if FTP is ready for transfers
     */
    isFtpReady() {
        return this.isConnected && this.ftpConfig && this.ftpConfig.server;
    }

    /**
     * Get pending transfer file for FTP job
     */
    async getPendingTransferFileForJob(jobId, cameraId) {
        // First update job status from 'pending' to 'transferring' if needed
        await this.pool.query(`
            UPDATE ${this.jobTable} 
            SET status = 'transferring', updated_at = CURRENT_TIMESTAMP 
            WHERE status = 'pending' 
            AND id = $1
            AND EXISTS (
                SELECT 1 FROM ${this.transferQueueTable} 
                WHERE job_id = $1
                AND camera_id = $2
                AND status = 'pending'
            )
        `, [jobId, cameraId]);
        
        const { rows } = await this.pool.query(`
            SELECT *
            FROM ${this.transferQueueTable}
            WHERE job_id = $1
            AND camera_id = $2
            AND status = 'pending'
            ORDER BY created_at ASC
            LIMIT 1
        `, [jobId, cameraId]);

        return rows[0];
    }

    /**
     * Transfer a video file via FTP
     */
    async transferFile(file) {
        logger.info(`[FTP_TRANSFER] transferFile: Processing video file: ${file.video_file_path}`);
        
        try {
            if (!this.isFtpReady()) {
                throw new Error('FTP server not configured or not connected');
            }
            
            // Validate file before transfer
            const validation = await TransferUtils.validateFileForTransfer(file.video_file_path);
            if (!validation.valid) {
                throw new Error(`File validation failed: ${validation.error}`);
            }
            
            const videoFileName = path.basename(file.video_file_path);
            const remoteDir = this.ftpConfig.server.remoteDirectory || '/vpc';
            const remotePath = path.posix.join(remoteDir, 'videos', videoFileName);
            
            // Update transfer queue with FTP paths
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET ftp_remote_path = $1, ftp_server_host = $2, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $3
            `, [remotePath, this.ftpConfig.server.host, file.id]);

            // Perform FTP transfer
            await this._performFtpTransfer(file.video_file_path, remotePath);
            
            // Update transfer queue status
            await this.pool.query(`
                UPDATE ${this.transferQueueTable} 
                SET status = 'transferred', ftp_upload_time = CURRENT_TIMESTAMP, transferred_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP 
                WHERE id = $1
            `, [file.id]);
            
            logger.info(`[FTP_TRANSFER] transferFile: ✓ Successfully transferred: ${videoFileName} to ${remotePath}`);
            
        } catch (error) {
            logger.error(`[FTP_TRANSFER] transferFile: Failed to transfer ${file.video_file_path}:`, error);
            throw error;
        }
    }

    /**
     * Perform actual FTP transfer using basic-ftp
     */
    async _performFtpTransfer(localPath, remotePath) {
        const client = new ftp.Client();
        client.ftp.verbose = false; // Reduce logging
        
        try {
            logger.info(`[FTP_TRANSFER] _performFtpTransfer: Connecting to ${this.ftpConfig.server.host}:${this.ftpConfig.server.port}`);
            
            const connectionOptions = {
                host: this.ftpConfig.server.host,
                port: this.ftpConfig.server.port || 21,
                user: this.ftpConfig.server.username,
                password: this.ftpConfig.server.password,
                secure: this.ftpConfig.server.protocol === 'ftps'
            };

            // Add secure options for FTPS
            if (this.ftpConfig.server.protocol === 'ftps') {
                connectionOptions.secureOptions = {
                    rejectUnauthorized: false,
                    ...this.ftpConfig.server.secureOptions
                };
            }

            await client.access(connectionOptions);
            
            // Ensure remote directory exists
            const remoteDir = path.posix.dirname(remotePath);
            try {
                await client.ensureDir(remoteDir);
                logger.info(`[FTP_TRANSFER] _performFtpTransfer: ✓ Ensured remote directory: ${remoteDir}`);
            } catch (dirError) {
                logger.info(`[FTP_TRANSFER] _performFtpTransfer: Directory ${remoteDir} may already exist: ${dirError.message}`);
            }
            
            // Upload file with progress tracking
            logger.info(`[FTP_TRANSFER] _performFtpTransfer: Starting upload ${localPath} → ${remotePath}`);
            await client.uploadFrom(localPath, remotePath);
            logger.info(`[FTP_TRANSFER] _performFtpTransfer: ✓ Upload completed successfully`);
            
        } catch (error) {
            logger.error(`[FTP_TRANSFER] _performFtpTransfer: Upload failed:`, error);
            throw error;
        } finally {
            try {
                client.close();
            } catch (closeError) {
                logger.warn(`[FTP_TRANSFER] _performFtpTransfer: Error closing FTP connection:`, closeError);
            }
        }
    }

    /**
     * Mark source files as transferred using shared utilities
     */
    async markSourceFilesAsTransferred(file) {
        logger.info(`[FTP_TRANSFER] markSourceFilesAsTransferred: Marking source files as FTP transferred for video: ${file.video_file_name}`);
        
        try {
            // Use shared utility to mark source files as FTP transferred
            if (file.source_file_ids && file.source_file_ids.length > 0) {
                await TransferUtils.markSourceFilesAsTransferred(this.pool, file.source_file_ids, 'ftp');
            }

            logger.info(`[FTP_TRANSFER] markSourceFilesAsTransferred: ✓ Marked ${(file.source_file_ids && file.source_file_ids.length) || 0} source files as FTP transferred`);
            
        } catch (error) {
            logger.error('[FTP_TRANSFER] markSourceFilesAsTransferred: Error:', error);
            throw error;
        }
    }

    /**
     * Handle transfer error using shared utilities
     */
    async handleTransferError(file, error) {
        logger.error(`[FTP_TRANSFER] handleTransferError: Transfer failed for ${file.video_file_name}:`, error);
        
        const result = await TransferUtils.handleTransferError(
            this.pool, 
            file, 
            error, 
            this.transferQueueTable
        );
        
        // FTP-specific error handling
        if (error.message.includes('ECONNREFUSED') || error.message.includes('timeout')) {
            this.isConnected = false;
            logger.error('[FTP_TRANSFER] handleTransferError: FTP connection lost, marking as disconnected');
        } else if (error.message.includes('503 Use AUTH first') || error.message.includes('AUTH')) {
            this.isConnected = false;
            logger.error('[FTP_TRANSFER] handleTransferError: FTP server requires AUTH (TLS/SSL) authentication. Check if protocol should be "ftps"');
        } else if (error.message.includes('SSL') || error.message.includes('TLS') || error.message.includes('certificate')) {
            this.isConnected = false;
            logger.error('[FTP_TRANSFER] handleTransferError: TLS/SSL related error. Check secure connection settings');
        }
        
        return result;
    }

    /**
     * Cleanup temporary video file using shared utilities
     */
    async cleanupTempVideo(videoPath) {
        return await TransferUtils.cleanupTempVideo(videoPath);
    }

    /**
     * Check and complete job using shared utilities
     */
    async checkAndCompleteJob(jobId) {
        return await TransferUtils.checkJobCompletion(
            this.pool, 
            jobId, 
            this.transferQueueTable, 
            this.jobTable
        );
    }

    /**
     * Update job statistics using shared utilities
     */
    async updateJobStatistics(jobId) {
        return await TransferUtils.updateJobStatistics(
            this.pool, 
            jobId, 
            this.jobTable, 
            this.transferQueueTable
        );
    }

    /**
     * Test FTP connection
     */
    async testFtpConnection() {
        if (!this.ftpConfig || !this.ftpConfig.server) {
            return { success: false, message: 'FTP configuration not available' };
        }

        const client = new ftp.Client();
        
        try {
            const connectionOptions = {
                host: this.ftpConfig.server.host,
                port: this.ftpConfig.server.port || 21,
                user: this.ftpConfig.server.username,
                password: this.ftpConfig.server.password,
                secure: this.ftpConfig.server.protocol === 'ftps'
            };

            // Add secure options for FTPS
            if (this.ftpConfig.server.protocol === 'ftps') {
                connectionOptions.secureOptions = {
                    rejectUnauthorized: false,
                    ...this.ftpConfig.server.secureOptions
                };
            }

            await client.access(connectionOptions);
            
            // Try to list the remote directory
            await client.list(this.ftpConfig.server.remoteDirectory || '/');
            
            this.isConnected = true;
            return { success: true, message: 'FTP connection successful' };
            
        } catch (error) {
            this.isConnected = false;
            let errorMessage = error.message;
            
            // Provide more specific error messages for common FTP auth issues
            if (error.message.includes('503 Use AUTH first')) {
                errorMessage = 'FTP server requires TLS/SSL authentication. Configuration updated to use FTPS protocol.';
            } else if (error.message.includes('AUTH')) {
                errorMessage = 'FTP authentication error: ' + error.message;
            } else if (error.message.includes('SSL') || error.message.includes('TLS')) {
                errorMessage = 'TLS/SSL connection error: ' + error.message;
            }
            
            return { success: false, message: errorMessage };
        } finally {
            try {
                client.close();
            } catch (closeError) {
                // Ignore close errors
            }
        }
    }

    /**
     * Get transfer statistics
     */
    async getTransferStatistics(jobId = null) {
        try {
            let query = `
                SELECT 
                    COUNT(*) as total_files,
                    COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending_files,
                    COUNT(CASE WHEN status = 'transferred' THEN 1 END) as transferred_files,
                    COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_files,
                    COALESCE(SUM(video_file_size), 0) as total_size,
                    COALESCE(SUM(CASE WHEN status = 'transferred' THEN video_file_size ELSE 0 END), 0) as transferred_size
                FROM ${this.transferQueueTable}
            `;
            
            const params = [];
            if (jobId) {
                query += ' WHERE job_id = $1';
                params.push(jobId);
            }
            
            const result = await this.pool.query(query, params);
            return result.rows[0];
            
        } catch (error) {
            logger.error('[FTP_TRANSFER] getTransferStatistics: Error:', error);
            return null;
        }
    }

    /**
     * Get current transfer stats for metrics
     */
    async getCurrentTransferStats() {
        try {
            // Get currently processing files
            const currentFileQuery = `
                SELECT video_file_name, video_file_size, created_at
                FROM ${this.transferQueueTable}
                WHERE status IN ('pending', 'transferring')
                ORDER BY created_at ASC
                LIMIT 1
            `;
            const currentFileResult = await this.pool.query(currentFileQuery);
            
            const stats = {
                currentFile: null,
                progress: 0,
                speed: 0,
                eta: null
            };
            
            if (currentFileResult.rows.length > 0) {
                const currentFile = currentFileResult.rows[0];
                stats.currentFile = {
                    name: currentFile.video_file_name,
                    size: currentFile.video_file_size,
                    startTime: currentFile.created_at
                };
                
                // Calculate basic progress (this is simplified, real implementation would track actual transfer progress)
                const now = new Date();
                const startTime = new Date(currentFile.created_at);
                const elapsed = (now - startTime) / 1000; // seconds
                
                // Estimate progress based on elapsed time and file size (very basic estimation)
                if (currentFile.video_file_size > 0) {
                    // Assume average transfer speed of 1MB/s for estimation
                    const estimatedDuration = currentFile.video_file_size / (1024 * 1024); // seconds
                    stats.progress = Math.min(Math.round((elapsed / estimatedDuration) * 100), 95);
                    stats.speed = elapsed > 0 ? (currentFile.video_file_size / (1024 * 1024)) / elapsed : 0;
                    
                    if (stats.progress < 95) {
                        const remainingTime = estimatedDuration - elapsed;
                        stats.eta = remainingTime > 0 ? Math.round(remainingTime) + ' sec' : null;
                    }
                }
            }
            
            return stats;
            
        } catch (error) {
            logger.error('[FTP_TRANSFER] getCurrentTransferStats: Error:', error);
            return {
                currentFile: null,
                progress: 0,
                speed: 0,
                eta: null
            };
        }
    }
}

module.exports = FtpTransferManager;

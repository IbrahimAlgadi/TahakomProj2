const { createLogger } = require('../../../utils/logger');

const logger = createLogger({ service: 'ImageSpaceValidator', logFile: 'image-usb-pipeline' });
class ImageSpaceValidator {
    constructor(config) {
        this.config = config;
        this.minRequiredSpaceMB = config.minRequiredSpaceMB || 50; // Smaller requirement for images
        this.bufferMB = 10; // Keep 10MB buffer for images (smaller than videos)
        this.driveInfo = null;
        this.shouldStopTransfer = false;
    }

    /**
     * Update drive information
     */
    updateDriveInfo(driveInfo, shouldStopTransfer) {
        this.driveInfo = driveInfo;
        this.shouldStopTransfer = shouldStopTransfer;
        
        if (this.driveInfo && this.shouldStopTransfer) {
            const freeSpaceMB = this.getFreeSpaceMB();
            logger.info(`[IMAGE_SPACE_VALIDATOR] Drive space check: ${freeSpaceMB.toFixed(1)}MB free, threshold: ${this.minRequiredSpaceMB}MB`);
        }
    }

    /**
     * Get free space in MB from drive info
     */
    getFreeSpaceMB() {
        if (!this.driveInfo) {
            return 0;
        }
        
        // Handle different possible property names for free space (values are in GB)
        let freeSpaceGB = 0;
        
        if (this.driveInfo.remainingSpace) {
            freeSpaceGB = parseFloat(this.driveInfo.remainingSpace);
        } else if (this.driveInfo.freeSize) {
            freeSpaceGB = parseFloat(this.driveInfo.freeSize);
        } else if (this.driveInfo.availableSpace) {
            freeSpaceGB = parseFloat(this.driveInfo.availableSpace);
        } else if (this.driveInfo.available) {
            freeSpaceGB = parseFloat(this.driveInfo.available);
        }
        
        return freeSpaceGB * 1024; // Convert GB to MB
    }

    /**
     * Check if there's enough space for a specific image file
     */
    hasSpaceForFile(fileSizeBytes) {
        if (!this.driveInfo) {
            logger.warn('[IMAGE_SPACE_VALIDATOR] Drive info not available for space check');
            return !this.shouldStopTransfer;
        }
        
        const fileSizeMB = fileSizeBytes / (1024 * 1024);
        const freeSpaceMB = this.getFreeSpaceMB();
        
        if (freeSpaceMB === 0) {
            logger.warn('[IMAGE_SPACE_VALIDATOR] No free space information available in drive info');
            return !this.shouldStopTransfer;
        }
        
        const hasSpace = freeSpaceMB > (fileSizeMB + this.bufferMB);
        
        if (!hasSpace) {
            logger.info(`[IMAGE_SPACE_VALIDATOR] Insufficient space: need ${fileSizeMB.toFixed(1)}MB + ${this.bufferMB}MB buffer, only ${freeSpaceMB.toFixed(1)}MB available`);
        }
        
        return hasSpace;
    }

    /**
     * Check if there's enough space for a batch of files
     */
    hasSpaceForBatch(files) {
        if (!this.driveInfo) {
            logger.warn('[IMAGE_SPACE_VALIDATOR] Drive info not available for batch space check');
            return !this.shouldStopTransfer;
        }
        
        const totalSizeBytes = files.reduce((sum, file) => sum + (file.file_size || 0), 0);
        const totalSizeMB = totalSizeBytes / (1024 * 1024);
        const freeSpaceMB = this.getFreeSpaceMB();
        
        if (freeSpaceMB === 0) {
            logger.warn('[IMAGE_SPACE_VALIDATOR] No free space information available for batch check');
            return !this.shouldStopTransfer;
        }
        
        const hasSpace = freeSpaceMB > (totalSizeMB + this.bufferMB);
        
        logger.info(`[IMAGE_SPACE_VALIDATOR] Batch space check: ${files.length} files (${totalSizeMB.toFixed(1)}MB) vs ${freeSpaceMB.toFixed(1)}MB free`);
        
        if (!hasSpace) {
            logger.info(`[IMAGE_SPACE_VALIDATOR] Insufficient space for batch: need ${totalSizeMB.toFixed(1)}MB + ${this.bufferMB}MB buffer, only ${freeSpaceMB.toFixed(1)}MB available`);
        }
        
        return hasSpace;
    }

    /**
     * Validate destination path exists and is writable
     */
    async validateDestinationPath(destinationPath) {
        const fs = require('fs-extra');
        const path = require('path');
        
        try {
            // Ensure the directory exists
            const dir = path.dirname(destinationPath);
            await fs.ensureDir(dir);
            
            // Try to write a test file to check write permissions
            const testFile = path.join(dir, '.write-test');
            await fs.writeFile(testFile, 'test');
            await fs.remove(testFile);
            
            return true;
            
        } catch (error) {
            logger.error(`[IMAGE_SPACE_VALIDATOR] Destination path validation failed for ${destinationPath}:`, error);
            return false;
        }
    }

    /**
     * Get space utilization percentage
     */
    getSpaceUtilizationPercentage() {
        if (!this.driveInfo) {
            return 0;
        }
        
        // Use the usedPercentage if available, otherwise calculate
        if (this.driveInfo.usedPercentage !== undefined) {
            return parseFloat(this.driveInfo.usedPercentage);
        }
        
        // Calculate from total and free space
        const freeSpaceMB = this.getFreeSpaceMB();
        let totalSpaceMB = 0;
        
        if (this.driveInfo.totalSpace) {
            totalSpaceMB = parseFloat(this.driveInfo.totalSpace) * 1024; // GB to MB
        }
        
        if (totalSpaceMB > 0) {
            const usedSpaceMB = totalSpaceMB - freeSpaceMB;
            return (usedSpaceMB / totalSpaceMB) * 100;
        }
        
        return 0;
    }

    /**
     * Check if drive is getting full (warning threshold)
     */
    isDriveNearFull(warningThresholdPercent = 85) {
        const utilization = this.getSpaceUtilizationPercentage();
        return utilization >= warningThresholdPercent;
    }

    /**
     * Get space status summary
     */
    getSpaceStatus() {
        if (!this.driveInfo) {
            return {
                status: 'unknown',
                message: 'Drive information not available',
                freeSpaceMB: 0,
                utilizationPercent: 0
            };
        }
        
        const freeSpaceMB = this.getFreeSpaceMB();
        const utilizationPercent = this.getSpaceUtilizationPercentage();
        
        let status = 'ok';
        let message = `${freeSpaceMB.toFixed(1)}MB free (${utilizationPercent.toFixed(1)}% used)`;
        
        if (this.shouldStopTransfer) {
            status = 'full';
            message = `Drive is full - transfers stopped. ${message}`;
        } else if (this.isDriveNearFull()) {
            status = 'warning';
            message = `Drive is getting full. ${message}`;
        }
        
        return {
            status,
            message,
            freeSpaceMB: freeSpaceMB,
            utilizationPercent: utilizationPercent,
            shouldStopTransfer: this.shouldStopTransfer
        };
    }
}

module.exports = ImageSpaceValidator;

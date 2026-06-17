class SpaceValidator {
    constructor(eventEmitter, config) {
        this.eventEmitter = eventEmitter;
        this.config = config;
        this.minRequiredSpaceMB = config.minRequiredSpaceMB || 500;
        this.ISS_MEDIA_FILE_SIZE = config.ISS_MEDIA_FILE_SIZE || 8192; // KB
        this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT = config.ISS_VIDEO_TRANSFER_CONVERSION_COUNT || 10;
        this.driveInfo = null;
        this.shouldStopProcessing = false;
    }

    /**
     * Update drive information
     */
    updateDriveInfo(driveInfo, shouldStopProcessing) {
        this.driveInfo = driveInfo;
        this.shouldStopProcessing = shouldStopProcessing;
    }

    /**
     * Check if there's enough space for processing
     */
    hasSpaceForProcessing(estimatedSizeMB = 100) {
        if (!this.driveInfo) {
            return !this.shouldStopProcessing;
        }
        
        const freeSpaceGB = parseFloat(this.driveInfo.remainingSpace || 0);
        console.log(`[ESTIMATE] Free space: ${freeSpaceGB}GB`);
        const freeSpaceMB = freeSpaceGB * 1024;
        console.log(`[ESTIMATE] Free space: ${freeSpaceMB}MB`);
        const bufferMB = 120;
        const totalRequired = estimatedSizeMB + bufferMB;
        console.log(`[ESTIMATE] Total required: ${totalRequired}MB`);
        
        return freeSpaceMB >= totalRequired;
    }

    /**
     * Get estimated processing size for a group of files
     */
    getEstimatedProcessingSize() {
        const avgFileSizeMB = this.ISS_MEDIA_FILE_SIZE / 1024;
        console.log(`[ESTIMATE] Avg file size: ${avgFileSizeMB}MB`);
        const tempMp4SizeMB = avgFileSizeMB * this.ISS_VIDEO_TRANSFER_CONVERSION_COUNT;
        console.log(`[ESTIMATE] Temp MP4 size: ${tempMp4SizeMB}MB`);
        const bufferSpaceForFinalVideo = tempMp4SizeMB * 0.25;
        const finalVideoSizeMB = tempMp4SizeMB + bufferSpaceForFinalVideo;
        console.log(`[ESTIMATE] Final video size: ${finalVideoSizeMB}MB`);
        return finalVideoSizeMB;
    }

    /**
     * Validate if processing can proceed based on space requirements
     */
    validateProcessingSpace() {
        const estimatedSpaceMB = this.getEstimatedProcessingSize();
        const hasSpace = this.hasSpaceForProcessing(estimatedSpaceMB);
        
        if (!hasSpace) {
            console.log(`[SPACE_VALIDATOR] Insufficient space for processing (${estimatedSpaceMB}MB needed)`);
            return {
                canProceed: false,
                estimatedSpaceMB,
                reason: 'Insufficient disk space'
            };
        }
        
        return {
            canProceed: true,
            estimatedSpaceMB
        };
    }

    /**
     * Check if drive is ready for operations
     */
    isDriveReady() {
        return this.driveInfo !== null && !this.shouldStopProcessing;
    }

    /**
     * Get current drive status
     */
    getDriveStatus() {
        if (!this.driveInfo) {
            return {
                connected: false,
                hasSpace: false,
                freeSpaceGB: 0,
                reason: 'No drive info available'
            };
        }

        const freeSpaceGB = parseFloat(this.driveInfo.remainingSpace || 0);
        const hasSpace = !this.shouldStopProcessing;

        return {
            connected: true,
            hasSpace,
            freeSpaceGB,
            freeSpaceMB: freeSpaceGB * 1024,
            minRequiredMB: this.minRequiredSpaceMB,
            reason: hasSpace ? 'OK' : 'Insufficient space'
        };
    }

    /**
     * Calculate storage requirements for a batch of operations
     */
    calculateBatchRequirements(fileGroups) {
        let totalEstimatedMB = 0;
        const groupRequirements = [];

        for (const group of fileGroups) {
            const estimatedMB = this.getEstimatedProcessingSize(group.files);
            totalEstimatedMB += estimatedMB;
            
            groupRequirements.push({
                groupKey: group.group_key,
                camera_id: group.camera_id,
                fileCount: group.files.length,
                estimatedMB
            });
        }

        return {
            totalEstimatedMB,
            groupRequirements,
            canProcessBatch: this.hasSpaceForProcessing(totalEstimatedMB)
        };
    }
}

module.exports = SpaceValidator;

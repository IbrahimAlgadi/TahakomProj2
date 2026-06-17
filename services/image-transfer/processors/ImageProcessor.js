const fs = require('fs-extra');
const path = require('path');

class ImageProcessor {
    constructor(encryptionService = null, config = {}) {
        this.encryptionService = encryptionService;
        this.config = config;
        this.supportedImageExtensions = ['.jpg', '.jpeg', '.png'];
    }

    /**
     * Validate if file is a valid image file
     */
    async validateImageFile(filePath) {
        try {
            // Check if file exists
            const exists = await fs.pathExists(filePath);
            if (!exists) {
                throw new Error(`Image file not found: ${filePath}`);
            }

            // Check file extension
            const ext = path.extname(filePath).toLowerCase();
            if (!this.supportedImageExtensions.includes(ext)) {
                throw new Error(`Unsupported image format: ${ext}. Supported formats: ${this.supportedImageExtensions.join(', ')}`);
            }

            // Check file size
            const stats = await fs.stat(filePath);
            if (stats.size === 0) {
                throw new Error(`Image file is empty: ${filePath}`);
            }

            // Basic header validation for common image formats
            const isValidFormat = await this.validateImageHeader(filePath, ext);
            if (!isValidFormat) {
                throw new Error(`Invalid or corrupted image file: ${filePath}`);
            }

            console.log(`[IMAGE_PROCESSOR] Validated image file: ${path.basename(filePath)} (${(stats.size / 1024).toFixed(1)} KB)`);
            return true;

        } catch (error) {
            console.error(`[IMAGE_PROCESSOR] Image validation failed for ${filePath}:`, error.message);
            throw error;
        }
    }

    /**
     * Validate image file header to ensure it's not corrupted
     */
    async validateImageHeader(filePath, extension) {
        try {
            const buffer = Buffer.alloc(16);
            const fd = await fs.open(filePath, 'r');
            await fs.read(fd, buffer, 0, 16, 0);
            await fs.close(fd);

            switch (extension) {
                case '.jpg':
                case '.jpeg':
                    // JPEG files start with FF D8 FF
                    return buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF;
                
                case '.png':
                    // PNG files start with 89 50 4E 47 0D 0A 1A 0A
                    return buffer[0] === 0x89 && buffer[1] === 0x50 && 
                           buffer[2] === 0x4E && buffer[3] === 0x47;
                default:
                    // For unsupported formats, assume valid if we got here
                    return true;
            }

        } catch (error) {
            console.warn(`[IMAGE_PROCESSOR] Could not validate image header for ${filePath}:`, error.message);
            return true; // Assume valid if we can't read header
        }
    }

    /**
     * Prepare destination path maintaining directory structure
     */
    prepareDestinationPath(sourcePath, exportDir, targetPath) {
        try {
            // Calculate relative path from export directory
            const relativePath = path.relative(exportDir, sourcePath);
            const destinationPath = path.join(targetPath, relativePath);
            
            // Normalize path separators for the target platform
            const normalizedPath = path.normalize(destinationPath);
            
            console.log(`[IMAGE_PROCESSOR] Prepared destination: ${path.basename(sourcePath)} -> ${relativePath}`);
            return normalizedPath;

        } catch (error) {
            console.error(`[IMAGE_PROCESSOR] Error preparing destination path:`, error);
            throw error;
        }
    }

    /**
     * Handle encryption of image file
     */
    async handleEncryption(sourcePath, destPath) {
        if (!this.encryptionService) {
            throw new Error('Encryption service not available');
        }

        try {
            console.log(`[IMAGE_PROCESSOR] Encrypting image: ${path.basename(sourcePath)}`);
            
            // Generate AES key and IV for this file
            const { key: aesKey, iv: aesIv } = this.encryptionService.generateAESKey();
            
            // Encrypt the file
            await this.encryptionService.encryptFileAES(sourcePath, destPath, aesKey, aesIv);
            
            // Return encryption metadata
            const encryptionMetadata = {
                aesKey: aesKey.toString('hex'),
                iv: aesIv.toString('hex'),
                algorithm: 'AES-256-CBC',
                encrypted: true
            };
            
            console.log(`[IMAGE_PROCESSOR] Successfully encrypted image: ${path.basename(destPath)}`);
            return encryptionMetadata;

        } catch (error) {
            console.error(`[IMAGE_PROCESSOR] Encryption failed for ${sourcePath}:`, error);
            throw error;
        }
    }

    /**
     * Generate metadata for image file
     */
    async generateImageMetadata(file) {
        try {
            const metadata = {
                fileId: file.id,
                fileName: path.basename(file.file_path),
                fileSize: file.file_size,
                fileType: 'image',
                extension: path.extname(file.file_path).toLowerCase(),
                processedAt: new Date().toISOString()
            };

            // Add file stats if available
            if (await fs.pathExists(file.file_path)) {
                const stats = await fs.stat(file.file_path);
                metadata.createdAt = stats.birthtime.toISOString();
                metadata.modifiedAt = stats.mtime.toISOString();
                metadata.actualSize = stats.size;
            }

            // Add image-specific metadata
            metadata.isImage = this.supportedImageExtensions.includes(metadata.extension);
            metadata.estimatedTransferTime = this.estimateTransferTime(file.file_size);

            return metadata;

        } catch (error) {
            console.error(`[IMAGE_PROCESSOR] Error generating metadata for file ${file.id}:`, error);
            // Return basic metadata even if enhanced metadata fails
            return {
                fileId: file.id,
                fileName: path.basename(file.file_path),
                fileSize: file.file_size,
                fileType: 'image',
                processedAt: new Date().toISOString(),
                error: error.message
            };
        }
    }

    /**
     * Estimate transfer time based on file size (rough estimate)
     */
    estimateTransferTime(fileSizeBytes) {
        // Rough estimates based on typical image transfer speeds
        const sizeInMB = fileSizeBytes / (1024 * 1024);
        
        if (sizeInMB < 1) {
            return '< 1 second';
        } else if (sizeInMB < 10) {
            return `~${Math.ceil(sizeInMB)} seconds`;
        } else {
            return `~${Math.ceil(sizeInMB / 5)} seconds`;
        }
    }

    /**
     * Validate batch of image files
     */
    async validateImageBatch(files) {
        console.log(`[IMAGE_PROCESSOR] Validating batch of ${files.length} image files...`);
        
        const results = {
            valid: [],
            invalid: [],
            totalSize: 0
        };

        for (const file of files) {
            try {
                await this.validateImageFile(file.file_path);
                results.valid.push(file);
                results.totalSize += file.file_size || 0;
            } catch (error) {
                console.warn(`[IMAGE_PROCESSOR] File validation failed: ${file.file_path} - ${error.message}`);
                results.invalid.push({
                    file: file,
                    error: error.message
                });
            }
        }

        console.log(`[IMAGE_PROCESSOR] Batch validation complete: ${results.valid.length} valid, ${results.invalid.length} invalid`);
        return results;
    }

    /**
     * Get supported image extensions
     */
    getSupportedExtensions() {
        return [...this.supportedImageExtensions];
    }

    /**
     * Check if file extension is supported
     */
    isImageExtensionSupported(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        return this.supportedImageExtensions.includes(ext);
    }

    /**
     * Clean up temporary files or resources
     */
    async cleanup() {
        // Override in subclasses if needed
        console.log('[IMAGE_PROCESSOR] Cleanup completed');
    }
}

module.exports = ImageProcessor;

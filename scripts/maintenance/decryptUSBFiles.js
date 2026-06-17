const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const encryptionService = require('../../utils/encryptionService');

class FileDecryptor {
    constructor(usbRootPath, outputPath, privateKeyPath, options = {}) {
        this.usbRootPath = usbRootPath;
        this.outputPath = outputPath || path.join(process.cwd(), 'decrypted_files');
        this.privateKeyPath = privateKeyPath || path.join(__dirname, '..', '..', 'certs', 'private_key.pem');
        this.options = {
            preserveOriginal: true,  // Always preserve original encrypted files
            overwriteExisting: false, // Don't overwrite existing decrypted files
            ...options
        };
        this.stats = {
            totalGroups: 0,
            processedGroups: 0,
            totalFiles: 0,
            processedFiles: 0,
            skippedFiles: 0,
            errors: 0,
            startTime: null,
            endTime: null,
            totalTime: null
        };
    }

    async initialize() {
        try {
            // Ensure output directory exists
            await fs.ensureDir(this.outputPath);
            
            // Check if private key exists
            if (!await fs.pathExists(this.privateKeyPath)) {
                throw new Error(`Private key not found at: ${this.privateKeyPath}`);
            }
            
            console.log(`🔓 File Decryptor initialized`);
            console.log(`📁 USB Root: ${this.usbRootPath}`);
            console.log(`📂 Output: ${this.outputPath}`);
            console.log(`🔑 Private Key: ${this.privateKeyPath}`);
            console.log('─'.repeat(60));
            
        } catch (error) {
            console.error('❌ Initialization failed:', error.message);
            throw error;
        }
    }

    async findEncryptedGroups() {
        const groups = [];
        
        try {
            console.log(' Scanning USB drive for encrypted file groups...');
            await this.scanDirectoryRecursively(this.usbRootPath, groups);
            
            this.stats.totalGroups = groups.length;
            console.log(`📊 Found ${groups.length} encrypted file groups`);
            
        } catch (error) {
            console.error('❌ Error scanning USB drive:', error.message);
            throw error;
        }
        
        return groups;
    }

    async scanDirectoryRecursively(currentPath, groups) {
        try {
            const items = await fs.readdir(currentPath);
            
            for (const item of items) {
                const itemPath = path.join(currentPath, item);
                
                try {
                    const stat = await fs.stat(itemPath);
                    
                    if (stat.isDirectory()) {
                        // Check if this directory contains metadata.dat
                        const metadataPath = path.join(itemPath, 'metadata.dat');
                        const hasMetadata = await fs.pathExists(metadataPath);
                        
                        if (hasMetadata) {
                            // Check if this directory has encrypted files
                            const hasEncryptedFiles = await this.hasEncryptedFiles(itemPath);
                            
                            if (hasEncryptedFiles) {
                                // Calculate relative path from USB root for group name
                                const relativePath = path.relative(this.usbRootPath, itemPath);
                                const groupName = relativePath.replace(/\\/g, '_').replace(/\//g, '_');
                                
                                groups.push({
                                    name: groupName,
                                    path: itemPath,
                                    metadataPath: metadataPath,
                                    relativePath: relativePath
                                });
                                
                                console.log(`   📁 Found encrypted group: ${relativePath}`);
                            }
                        } else {
                            // Continue scanning subdirectories
                            await this.scanDirectoryRecursively(itemPath, groups);
                        }
                    }
                } catch (error) {
                    // Skip items that can't be accessed (permissions, etc.)
                    console.log(`   ⚠️  Skipping ${item}: ${error.message}`);
                }
            }
        } catch (error) {
            // Handle directory access errors
            console.log(`   ⚠️  Cannot access directory ${currentPath}: ${error.message}`);
        }
    }

    async hasEncryptedFiles(dirPath) {
        try {
            const files = await fs.readdir(dirPath);
            return files.some(file => {
                const filePath = path.join(dirPath, file);
                try {
                    const stat = fs.statSync(filePath);
                    return stat.isFile() && !file.includes('.') && file !== 'metadata.dat';
                } catch (error) {
                    return false;
                }
            });
        } catch (error) {
            return false;
        }
    }

    async decryptMetadata(metadataPath) {
        try {
            const encryptedMetadata = await fs.readFile(metadataPath);
            const decryptedJson = await encryptionService.decryptWithRSAPrivateKey(encryptedMetadata, this.privateKeyPath);
            return JSON.parse(decryptedJson);
        } catch (error) {
            console.error(`❌ Failed to decrypt metadata from ${metadataPath}:`, error.message);
            throw error;
        }
    }

    async decryptFileGroup(group) {
        try {
            console.log(`\n🔓 Processing group: ${group.relativePath || group.name}`);
            
            // Decrypt metadata
            const metadata = await this.decryptMetadata(group.metadataPath);
            console.log(`    Metadata decrypted successfully`);
            
            // Create output directory structure matching the original path
            let groupOutputPath;
            if (group.relativePath) {
                groupOutputPath = path.join(this.outputPath, group.relativePath);
            } else {
                groupOutputPath = path.join(this.outputPath, group.name);
            }
            await fs.ensureDir(groupOutputPath);
            
            // Decrypt each file
            for (const fileMapping of metadata.files) {
                try {
                    const encryptedFilePath = path.join(group.path, fileMapping.new);
                    const decryptedFilePath = path.join(groupOutputPath, fileMapping.original);
                    
                    // Check if decrypted file already exists
                    if (await fs.pathExists(decryptedFilePath) && !this.options.overwriteExisting) {
                        console.log(`   ⏭️  Skipping ${fileMapping.original} (already exists)`);
                        this.stats.skippedFiles++;
                        continue;
                    }
                    
                    // Convert hex strings back to buffers
                    const aesKey = Buffer.from(metadata.aesKey, 'hex');
                    const aesIv = Buffer.from(metadata.iv, 'hex');
                    
                    console.log(`    Decrypting: ${fileMapping.new} → ${fileMapping.original}`);
                    await encryptionService.decryptFileAES(encryptedFilePath, decryptedFilePath, aesKey, aesIv);
                    
                    this.stats.processedFiles++;
                    console.log(`   ✅ Decrypted: ${fileMapping.original}`);
                    
                } catch (error) {
                    console.error(`   ❌ Failed to decrypt ${fileMapping.original}:`, error.message);
                    this.stats.errors++;
                }
            }
            
            this.stats.processedGroups++;
            console.log(`   ✅ Group completed: ${group.relativePath || group.name}`);
            console.log(`    Original encrypted files preserved on USB drive`);
            
        } catch (error) {
            console.error(`❌ Failed to process group ${group.relativePath || group.name}:`, error.message);
            this.stats.errors++;
        }
    }

    async decryptAll() {
        try {
            // Start timing
            this.stats.startTime = new Date();
            console.log(`🚀 Starting decryption process at ${this.stats.startTime.toLocaleTimeString()}`);
            
            await this.initialize();
            
            const groups = await this.findEncryptedGroups();
            
            if (groups.length === 0) {
                console.log('ℹ️  No encrypted file groups found on USB drive');
                return;
            }
            
            console.log(`\n🚀 Starting decryption process...\n`);
            
            for (const group of groups) {
                await this.decryptFileGroup(group);
            }
            
            // End timing
            this.stats.endTime = new Date();
            this.stats.totalTime = this.stats.endTime - this.stats.startTime;
            
            this.printSummary();
            
        } catch (error) {
            console.error('❌ Decryption process failed:', error.message);
            process.exit(1);
        }
    }

    formatDuration(milliseconds) {
        const seconds = Math.floor(milliseconds / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        
        if (hours > 0) {
            return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
        } else if (minutes > 0) {
            return `${minutes}m ${seconds % 60}s`;
        } else {
            return `${seconds}s`;
        }
    }

    printSummary() {
        console.log('\n' + '─'.repeat(60));
        console.log(' DECRYPTION SUMMARY');
        console.log('─'.repeat(60));
        console.log(`📁 Total Groups: ${this.stats.totalGroups}`);
        console.log(`✅ Processed Groups: ${this.stats.processedGroups}`);
        console.log(`📄 Total Files: ${this.stats.totalFiles}`);
        console.log(`✅ Processed Files: ${this.stats.processedFiles}`);
        console.log(`⏭️  Skipped Files: ${this.stats.skippedFiles}`);
        console.log(`❌ Errors: ${this.stats.errors}`);
        console.log(`📂 Output Location: ${this.outputPath}`);
        console.log(` Original encrypted files preserved on USB drive`);
        
        if (this.stats.totalTime !== null) {
            console.log(`⏱️  Total Time: ${this.formatDuration(this.stats.totalTime)}`);
            console.log(`🕐 Started: ${this.stats.startTime.toLocaleTimeString()}`);
            console.log(`🕐 Finished: ${this.stats.endTime.toLocaleTimeString()}`);
            
            if (this.stats.processedFiles > 0) {
                const avgTimePerFile = this.stats.totalTime / this.stats.processedFiles;
                console.log(`⚡ Average time per file: ${this.formatDuration(avgTimePerFile)}`);
            }
        }
        
        console.log('─'.repeat(60));
    }
}

// CLI Interface
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        console.log(' File Decryptor');
        console.log('Usage: node decryptFiles.js <usb_root_path> [output_path] [private_key_path]');
        console.log('');
        console.log('Arguments:');
        console.log('  usb_root_path     Path to the root directory of the USB drive');
        console.log('  output_path       (Optional) Output directory for decrypted files');
        console.log('  private_key_path  (Optional) Path to the RSA private key');
        console.log('');
        console.log('Examples:');
        console.log('  node decryptFiles.js E:\\');
        console.log('  node decryptFiles.js E:\\ C:\\decrypted');
        console.log('  node decryptFiles.js E:\\ C:\\decrypted C:\\keys\\private_key.pem');
        process.exit(0);
    }
    
    const usbRootPath = args[0];
    const outputPath = args[1];
    const privateKeyPath = args[2];
    
    // Validate USB path exists
    if (!await fs.pathExists(usbRootPath)) {
        console.error(`❌ USB path does not exist: ${usbRootPath}`);
        process.exit(1);
    }
    
    const decryptor = new FileDecryptor(usbRootPath, outputPath, privateKeyPath);
    await decryptor.decryptAll();
}

// Run if called directly
if (require.main === module) {
    main().catch(error => {
        console.error('❌ Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = FileDecryptor; 
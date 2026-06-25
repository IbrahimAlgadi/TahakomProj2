'use strict';

const fs = require('fs-extra');
const path = require('path');
const encryptionService = require('../../utils/encryptionService');

/**
 * Decrypts a manual USB transfer job folder produced by manualTransferRoutes.js.
 *
 * Expected on-disk layout (written by the encryption-enabled copy phase):
 *
 *   {jobRoot}/images/
 *     <encryptedName>              — AES-256-CBC encrypted bytes (no extension)
 *     <encryptedName>_metadata.json — { files: <Buffer>, keys: <Buffer> }
 *
 *   {jobRoot}/videos/
 *     <encryptedName>              — AES-256-CBC encrypted bytes (no extension)
 *     <encryptedName>_metadata.json — { files: <Buffer>, keys: <Buffer> }
 *
 * metadata.json fields:
 *   keys  — RSA-OAEP encrypted JSON string: { aesKey: "hex", iv: "hex" }
 *   files — AES-256-CBC encrypted JSON string: [{ original: "orig.jpg", new: "encName" }]
 *
 * Output:
 *   {outputRoot}/images/<original_filename>
 *   {outputRoot}/videos/<original_filename>
 */
class FileDecryptor {
    /**
     * @param {string} jobRoot      - Root of the encrypted job folder (contains images/ and videos/)
     * @param {string} outputRoot   - Root for decrypted output (images_dec/ and videos_dec/ created here)
     * @param {string} privateKeyPath - Path to RSA private key PEM file
     * @param {object} options
     */
    constructor(jobRoot, outputRoot, privateKeyPath, options = {}) {
        this.jobRoot = jobRoot;
        this.outputRoot = outputRoot || path.join(path.dirname(jobRoot), path.basename(jobRoot) + '_decrypted');
        this.privateKeyPath = privateKeyPath || path.join(process.cwd(), 'certs', 'private_key.pem');
        this.options = {
            overwriteExisting: false,
            ...options,
        };
        this.stats = {
            images:  { processed: 0, skipped: 0, errors: 0 },
            videos:  { processed: 0, skipped: 0, errors: 0 },
            startTime: null,
            endTime: null,
        };
    }

    async initialize() {
        if (!(await fs.pathExists(this.privateKeyPath))) {
            throw new Error(`Private key not found at: ${this.privateKeyPath}`);
        }
        if (!(await fs.pathExists(this.jobRoot))) {
            throw new Error(`Job root not found: ${this.jobRoot}`);
        }
        console.log(`File Decryptor initialised`);
        console.log(`  Source : ${this.jobRoot}`);
        console.log(`  Output : ${this.outputRoot}`);
        console.log(`  Key    : ${this.privateKeyPath}`);
    }

    /**
     * Decrypt a single metadata file + its encrypted payload.
     * Returns the number of files decrypted.
     */
    async decryptGroup(metadataPath, outputDir) {
        const encDir = path.dirname(metadataPath);

        const metaRaw = JSON.parse(await fs.readFile(metadataPath, 'utf8'));

        // Recover AES key/IV: RSA-decrypt the "keys" buffer
        const keysBuffer = Buffer.from(metaRaw.keys);
        const keysJson   = await encryptionService.decryptWithRSAPrivateKey(keysBuffer, this.privateKeyPath);
        const { aesKey: aesKeyHex, iv: aesIvHex } = JSON.parse(keysJson);
        const aesKey = Buffer.from(aesKeyHex, 'hex');
        const aesIv  = Buffer.from(aesIvHex, 'hex');

        // Recover file mapping: AES-decrypt the "files" buffer
        const filesBuffer = Buffer.from(metaRaw.files);
        const filesJson   = encryptionService.decryptDataAES(filesBuffer, aesKey, aesIv);
        const filesMapping = JSON.parse(filesJson.toString('utf8'));

        await fs.ensureDir(outputDir);

        let count = 0;
        for (const mapping of filesMapping) {
            const encryptedFile = path.join(encDir, mapping.new);
            const decryptedFile = path.join(outputDir, mapping.original);

            if (!(await fs.pathExists(encryptedFile))) {
                console.warn(`  [SKIP] Encrypted file not found: ${mapping.new}`);
                continue;
            }

            if ((await fs.pathExists(decryptedFile)) && !this.options.overwriteExisting) {
                console.log(`  [SKIP] Already exists: ${mapping.original}`);
                count++;
                continue;
            }

            await encryptionService.decryptFileAES(encryptedFile, decryptedFile, aesKey, aesIv);
            console.log(`  [OK]   ${mapping.new} → ${mapping.original}`);
            count++;
        }
        return count;
    }

    async decryptSection(section, outputDir) {
        const encDir = path.join(this.jobRoot, section);
        if (!(await fs.pathExists(encDir))) {
            console.log(`  [INFO] No ${section}/ folder found — skipping`);
            return;
        }

        const items = await fs.readdir(encDir);
        const metadataFiles = items.filter(f => f.endsWith('_metadata.json'));

        if (metadataFiles.length === 0) {
            console.log(`  [INFO] No *_metadata.json files found in ${section}/ — folder may be unencrypted or already decrypted`);
            return;
        }

        console.log(`\n[${section.toUpperCase()}] Found ${metadataFiles.length} encrypted group(s) in ${encDir}`);
        const statsKey = section === 'images' ? 'images' : 'videos';

        for (const metaFile of metadataFiles) {
            const metaPath = path.join(encDir, metaFile);
            try {
                const count = await this.decryptGroup(metaPath, outputDir);
                this.stats[statsKey].processed += count;
            } catch (err) {
                console.error(`  [ERR]  Failed to process ${metaFile}: ${err.message}`);
                this.stats[statsKey].errors++;
            }
        }
    }

    async decryptAll() {
        this.stats.startTime = new Date();
        console.log(`\nDecryption started at ${this.stats.startTime.toLocaleTimeString()}`);

        await this.initialize();

        const imagesOut = path.join(this.outputRoot, 'images_dec');
        const videosOut = path.join(this.outputRoot, 'videos_dec');

        await this.decryptSection('images', imagesOut);
        await this.decryptSection('videos', videosOut);

        this.stats.endTime = new Date();
        const elapsed = ((this.stats.endTime - this.stats.startTime) / 1000).toFixed(1);

        console.log('\n─────────────────────────────────────────────');
        console.log('DECRYPTION SUMMARY');
        console.log('─────────────────────────────────────────────');
        console.log(`Images  : ${this.stats.images.processed} decrypted, ${this.stats.images.errors} errors`);
        console.log(`Videos  : ${this.stats.videos.processed} decrypted, ${this.stats.videos.errors} errors`);
        console.log(`Duration: ${elapsed}s`);
        console.log(`Output  : ${this.outputRoot}`);
        console.log('─────────────────────────────────────────────');

        return this.stats;
    }
}

// ── CLI interface ─────────────────────────────────────────────────────────────
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: node decryptUSBFiles.js <jobRoot> [outputRoot] [privateKeyPath]');
        console.log('');
        console.log('  jobRoot        Path containing images/ and videos/ encrypted folders');
        console.log('                 e.g. G:\\transfer\\123');
        console.log('  outputRoot     (Optional) Where to write decrypted files.');
        console.log('                 Defaults to <jobRoot> — images_dec/ and videos_dec/ created inside.');
        console.log('  privateKeyPath (Optional) Path to RSA private key. Defaults to certs/private_key.pem');
        console.log('');
        console.log('Examples:');
        console.log('  node decryptUSBFiles.js G:\\transfer\\123');
        console.log('  node decryptUSBFiles.js G:\\transfer\\123 G:\\transfer\\123 C:\\keys\\private_key.pem');
        process.exit(0);
    }

    const [jobRoot, outputRoot, privateKeyPath] = args;

    if (!(await fs.pathExists(jobRoot))) {
        console.error(`Job root does not exist: ${jobRoot}`);
        process.exit(1);
    }

    const decryptor = new FileDecryptor(jobRoot, outputRoot || jobRoot, privateKeyPath);
    await decryptor.decryptAll();
}

if (require.main === module) {
    main().catch(err => {
        console.error('Fatal error:', err.message);
        process.exit(1);
    });
}

module.exports = FileDecryptor;

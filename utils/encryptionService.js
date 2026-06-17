const crypto = require('crypto');
const fs = require('fs-extra');

function generateAESKey() {
    const key = crypto.randomBytes(32); // 256-bit key
    const iv = crypto.randomBytes(16);  // 128-bit IV
    return { key, iv };
}

async function encryptFileAES(inputPath, outputPath, key, iv) {
    return new Promise((resolve, reject) => {
        const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
        const input = fs.createReadStream(inputPath);
        const output = fs.createWriteStream(outputPath);

        input.pipe(cipher).pipe(output);

        output.on('finish', () => resolve());
        output.on('error', (err) => reject(err));
        cipher.on('error', (err) => reject(err));
        input.on('error', (err) => reject(err));
    });
}

async function decryptFileAES(inputPath, outputPath, key, iv) {
    return new Promise((resolve, reject) => {
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        const input = fs.createReadStream(inputPath);
        const output = fs.createWriteStream(outputPath);

        input.pipe(decipher).pipe(output);

        output.on('finish', () => resolve());
        output.on('error', (err) => reject(err));
        decipher.on('error', (err) => reject(err));
        input.on('error', (err) => reject(err));
    });
}

function encryptDataAES(data, key, iv) {
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
    return encrypted;
}

function decryptDataAES(encryptedData, key, iv) {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    return decrypted;
}

async function encryptWithRSAPublicKey(data, publicKeyPath) {
    const publicKey = await fs.readFile(publicKeyPath, 'utf8');
    const buffer = Buffer.from(data, 'utf8');
    const encrypted = crypto.publicEncrypt({
        key: publicKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
    }, buffer);
    return encrypted;
}

async function decryptWithRSAPrivateKey(encryptedData, privateKeyPath) {
    const privateKey = await fs.readFile(privateKeyPath, 'utf8');
    const decrypted = crypto.privateDecrypt({
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
    }, encryptedData);
    return decrypted.toString('utf8');
}

function generateRSAKeyPair(keySize = 2048) {
    return new Promise((resolve, reject) => {
        crypto.generateKeyPair('rsa', {
            modulusLength: keySize, // Key size in bits
            publicKeyEncoding: {
                type: 'spki',
                format: 'pem'
            },
            privateKeyEncoding: {
                type: 'pkcs8',
                format: 'pem'
            }
        }, (err, publicKey, privateKey) => {
            if (err) reject(err);
            else resolve({ publicKey, privateKey });
        });
    });
}

// Synchronous version (available in Node.js 12+)
function generateRSAKeyPairSync(keySize = 2048) {
    return crypto.generateKeyPairSync('rsa', {
        modulusLength: keySize,
        publicKeyEncoding: {
            type: 'spki',
            format: 'pem'
        },
        privateKeyEncoding: {
            type: 'pkcs8',
            format: 'pem'
        }
    });
}

module.exports = {
    generateAESKey,
    encryptFileAES,
    decryptFileAES,
    encryptDataAES,
    decryptDataAES,
    encryptWithRSAPublicKey,
    decryptWithRSAPrivateKey,
    generateRSAKeyPair,
    generateRSAKeyPairSync,
};

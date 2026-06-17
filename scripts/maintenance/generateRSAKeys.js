const crypto = require('crypto');
const fs = require('fs-extra');
const path = require('path');
const { generateRSAKeyPairSync } = require('../../utils/encryptionService');

async function generateRSAKeys() {
    try {
        // Create certs directory if it doesn't exist
        const certsDir = path.join(__dirname, '..', '..', 'certs');
        await fs.ensureDir(certsDir);
        
        console.log('Generating RSA key pair...');
        
        // Generate 4096-bit RSA key pair
        const { privateKey, publicKey } = generateRSAKeyPairSync(4096);
        
        // Write private key
        const privateKeyPath = path.join(certsDir, 'private_key.pem');
        await fs.writeFile(privateKeyPath, privateKey);
        console.log(`Private key saved to: ${privateKeyPath}`);
        
        // Write public key
        const publicKeyPath = path.join(certsDir, 'public_key.pem');
        await fs.writeFile(publicKeyPath, publicKey);
        console.log(`Public key saved to: ${publicKeyPath}`);
        
        console.log('RSA key pair generated successfully!');
        console.log('Note: Keep your private key secure and never share it.');
        
        // Test the keys work
        console.log('\nTesting key functionality...');
        const testData = 'Hello, this is a test message!';
        
        // Encrypt with public key
        const encrypted = crypto.publicEncrypt({
            key: publicKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
        }, Buffer.from(testData, 'utf8'));
        
        // Decrypt with private key
        const decrypted = crypto.privateDecrypt({
            key: privateKey,
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
        }, encrypted);
        
        if (decrypted.toString('utf8') === testData) {
            console.log('✅ Key pair test successful!');
        } else {
            console.log('❌ Key pair test failed!');
        }
        
    } catch (error) {
        console.error('Error generating RSA keys:', error.message);
        process.exit(1);
    }
}

// Run the key generation
generateRSAKeys();

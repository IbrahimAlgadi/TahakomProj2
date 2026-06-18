'use strict';

/**
 * Real-crypto round-trip tests for utils/encryptionService.js.
 * These use Node's built-in crypto module with real key generation and
 * actual file I/O in the OS temp directory – no mocks required.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs-extra');
const enc  = require('../utils/encryptionService');

// Extend timeout for RSA key generation (CPU-bound)
jest.setTimeout(15000);

const TEMP_DIR = path.join(os.tmpdir(), 'tahakom-enc-tests-' + process.pid);

beforeAll(async () => {
  await fs.ensureDir(TEMP_DIR);
});

afterAll(async () => {
  await fs.remove(TEMP_DIR);
});

// ---------------------------------------------------------------------------
// generateAESKey
// ---------------------------------------------------------------------------

describe('encryptionService.generateAESKey', () => {
  it('returns a 32-byte key and a 16-byte IV', () => {
    const { key, iv } = enc.generateAESKey();
    expect(Buffer.isBuffer(key)).toBe(true);
    expect(key.length).toBe(32);
    expect(Buffer.isBuffer(iv)).toBe(true);
    expect(iv.length).toBe(16);
  });

  it('returns different keys on subsequent calls', () => {
    const { key: k1 } = enc.generateAESKey();
    const { key: k2 } = enc.generateAESKey();
    expect(k1.equals(k2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// encryptDataAES / decryptDataAES (in-memory, synchronous)
// ---------------------------------------------------------------------------

describe('encryptionService.encryptDataAES / decryptDataAES', () => {
  it('produces a ciphertext different from the plaintext', () => {
    const { key, iv } = enc.generateAESKey();
    const plaintext = 'Hello, USB transfer!';
    const cipher = enc.encryptDataAES(plaintext, key, iv);
    expect(Buffer.isBuffer(cipher)).toBe(true);
    expect(cipher.toString()).not.toBe(plaintext);
  });

  it('round-trips: decrypt(encrypt(data)) === original data', () => {
    const { key, iv } = enc.generateAESKey();
    const original = JSON.stringify({ aesKey: 'abc', iv: 'def', file: 'vid.mp4' });
    const encrypted = enc.encryptDataAES(original, key, iv);
    const decrypted = enc.decryptDataAES(encrypted, key, iv);
    expect(decrypted.toString('utf8')).toBe(original);
  });

  it('handles Buffer input as well as string input', () => {
    const { key, iv } = enc.generateAESKey();
    const buf = Buffer.from('binary data', 'utf8');
    const cipher = enc.encryptDataAES(buf, key, iv);
    const plain  = enc.decryptDataAES(cipher, key, iv);
    expect(plain.toString()).toBe('binary data');
  });
});

// ---------------------------------------------------------------------------
// encryptFileAES / decryptFileAES (file-based, async)
// ---------------------------------------------------------------------------

describe('encryptionService.encryptFileAES / decryptFileAES', () => {
  it('round-trips a text file through AES-256-CBC encryption', async () => {
    const { key, iv } = enc.generateAESKey();

    const srcPath  = path.join(TEMP_DIR, 'source.txt');
    const encPath  = path.join(TEMP_DIR, 'source.enc');
    const decPath  = path.join(TEMP_DIR, 'source.dec.txt');
    const content  = 'USB video transfer test file content – 2026';

    await fs.writeFile(srcPath, content, 'utf8');
    await enc.encryptFileAES(srcPath, encPath, key, iv);

    // Encrypted file must exist and differ from original
    const encBuf = await fs.readFile(encPath);
    const srcBuf = await fs.readFile(srcPath);
    expect(encBuf.equals(srcBuf)).toBe(false);

    // Decrypted content must match original
    await enc.decryptFileAES(encPath, decPath, key, iv);
    const decContent = await fs.readFile(decPath, 'utf8');
    expect(decContent).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// generateRSAKeyPairSync
// ---------------------------------------------------------------------------

describe('encryptionService.generateRSAKeyPairSync', () => {
  it('generates a valid PEM-formatted RSA key pair', () => {
    const { publicKey, privateKey } = enc.generateRSAKeyPairSync(2048);
    expect(publicKey).toMatch(/-----BEGIN PUBLIC KEY-----/);
    expect(privateKey).toMatch(/-----BEGIN PRIVATE KEY-----/);
  });
});

// ---------------------------------------------------------------------------
// encryptWithRSAPublicKey / decryptWithRSAPrivateKey (file-based keys)
// ---------------------------------------------------------------------------

describe('encryptionService.encryptWithRSAPublicKey / decryptWithRSAPrivateKey', () => {
  let pubKeyPath, privKeyPath;

  beforeAll(async () => {
    const { publicKey, privateKey } = enc.generateRSAKeyPairSync(2048);
    pubKeyPath  = path.join(TEMP_DIR, 'test_pub.pem');
    privKeyPath = path.join(TEMP_DIR, 'test_priv.pem');
    await fs.writeFile(pubKeyPath,  publicKey,  'utf8');
    await fs.writeFile(privKeyPath, privateKey, 'utf8');
  });

  it('round-trips a JSON payload through RSA OAEP encryption', async () => {
    const payload = JSON.stringify({ aesKey: 'deadbeef', iv: 'cafebabe' });
    const encrypted = await enc.encryptWithRSAPublicKey(payload, pubKeyPath);

    expect(Buffer.isBuffer(encrypted)).toBe(true);
    // Encrypted form must not equal the original plaintext
    expect(encrypted.toString()).not.toBe(payload);

    const decrypted = await enc.decryptWithRSAPrivateKey(encrypted, privKeyPath);
    expect(decrypted).toBe(payload);
  });
});

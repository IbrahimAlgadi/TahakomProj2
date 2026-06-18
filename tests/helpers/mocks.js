'use strict';

/**
 * Creates a mock pg Pool whose query() resolves with { rows: defaultRows }.
 * Override per-call with: pool.query.mockResolvedValueOnce({ rows: [...] })
 */
function createMockPool(defaultRows = []) {
  return {
    query: jest.fn().mockResolvedValue({ rows: defaultRows }),
    end: jest.fn().mockResolvedValue(undefined)
  };
}

/**
 * Creates a mock ioredis client.
 */
function createMockRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    publish: jest.fn().mockResolvedValue(1),
    subscribe: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue(undefined)
  };
}

/**
 * Creates a mock encryptionService matching the shape of utils/encryptionService.js.
 * generateAESKey returns a fixed 32-byte key and 16-byte IV.
 * All async methods resolve immediately.
 */
function createMockEncryption() {
  const fixedKey = Buffer.alloc(32, 0xab);
  const fixedIv  = Buffer.alloc(16, 0xcd);
  return {
    generateAESKey:           jest.fn().mockReturnValue({ key: fixedKey, iv: fixedIv }),
    encryptFileAES:           jest.fn().mockResolvedValue(undefined),
    decryptFileAES:           jest.fn().mockResolvedValue(undefined),
    encryptDataAES:           jest.fn().mockReturnValue(Buffer.from('aes-encrypted-data')),
    decryptDataAES:           jest.fn().mockReturnValue(Buffer.from('decrypted-data')),
    encryptWithRSAPublicKey:  jest.fn().mockResolvedValue(Buffer.from('rsa-encrypted-keys')),
    decryptWithRSAPrivateKey: jest.fn().mockResolvedValue('decrypted-keys')
  };
}

// ---------------------------------------------------------------------------
// Sample fixture objects
// ---------------------------------------------------------------------------

/** Simulates a USB drive entry as stored in Redis CONNECTED_DRIVE_LIST */
const sampleDriveInfo = {
  drive: 'F:',
  remainingSpace: '10',   // 10 GB free
  totalSpace: '64',       // 64 GB total
  usedPercentage: '84.4'
};

/** Sample row from video_transfer_queue */
const sampleVideoQueueRow = {
  id: 1,
  job_id: 10,
  camera_id: '1',
  video_file_name: 'cam1_2026-06-01.mp4',
  video_file_path: 'C:\\temp\\cam1_2026-06-01.mp4',
  file_size: 50 * 1024 * 1024, // 50 MB
  status: 'pending',
  retry_count: 0,
  max_retries: 3,
  source_file_ids: [101, 102, 103]
};

/** Sample row from transfer_queue (image) */
const sampleImageQueueRow = {
  id: 1,
  job_id: 10,
  file_id: 201,
  file_path: 'C:\\export\\2026-06-01\\Camera 1\\img001.jpg',
  file_name: 'img001.jpg',
  file_size: 512 * 1024, // 512 KB
  status: 'pending',
  retry_count: 0,
  max_retries: 3,
  batch_id: 'batch-001',
  batch_origin: 'auto'
};

module.exports = {
  createMockPool,
  createMockRedis,
  createMockEncryption,
  sampleDriveInfo,
  sampleVideoQueueRow,
  sampleImageQueueRow
};

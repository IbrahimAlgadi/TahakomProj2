'use strict';

jest.mock('fs-extra');
jest.mock('../../services/shared/TransferUtils');

const path = require('path');
const fs   = require('fs-extra');
const TransferUtils = require('../../services/shared/TransferUtils');

const ImageTransferManager = require('../../services/image-transfer/transfer/ImageTransferManager');
const { createMockPool, createMockEncryption, sampleImageQueueRow } = require('../helpers/mocks');

// Config that mirrors the runtime config consumed by ImageTransferManager
const MOCK_CONFIG = {
  storage:     { directory: 'C:\\export' },
  autoTransfer: { drive: 'F', encryption: { enabled: false } }
};

function makeManager({ enc = null, config = MOCK_CONFIG, pool = null } = {}) {
  const mockPool = pool || createMockPool();
  const mgr = new ImageTransferManager(mockPool, {}, config, enc);
  return { mgr, pool: mockPool };
}

// ---------------------------------------------------------------------------
// groupFilesIntoBatches
// ---------------------------------------------------------------------------

describe('ImageTransferManager.groupFilesIntoBatches', () => {
  const { mgr } = makeManager();
  const files = [1, 2, 3, 4, 5, 6, 7].map(id => ({ id }));

  it('splits an array into batches of the specified size', () => {
    const batches = mgr.groupFilesIntoBatches(files, 3);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(3);
    expect(batches[1]).toHaveLength(3);
    expect(batches[2]).toHaveLength(1); // remainder
  });

  it('returns one batch when files fit inside batchSize', () => {
    expect(mgr.groupFilesIntoBatches(files, 10)).toHaveLength(1);
  });

  it('returns empty array for empty input', () => {
    expect(mgr.groupFilesIntoBatches([], 3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// groupFilesByDirectory
// ---------------------------------------------------------------------------

describe('ImageTransferManager.groupFilesByDirectory', () => {
  const { mgr } = makeManager();
  const exportDir = 'C:\\export';
  const files = [
    { id: 1, file_path: 'C:\\export\\2026-06-01\\Camera 1\\img001.jpg' },
    { id: 2, file_path: 'C:\\export\\2026-06-01\\Camera 1\\img002.jpg' },
    { id: 3, file_path: 'C:\\export\\2026-06-01\\Camera 2\\img003.jpg' }
  ];

  it('groups files by their relative parent directory', () => {
    const grouped = mgr.groupFilesByDirectory(files, exportDir);
    const keys = Object.keys(grouped);
    expect(keys).toHaveLength(2);

    const cam1Key = keys.find(k => k.includes('Camera 1'));
    const cam2Key = keys.find(k => k.includes('Camera 2'));
    expect(grouped[cam1Key]).toHaveLength(2);
    expect(grouped[cam2Key]).toHaveLength(1);
  });

  it('throws when a file path is not under the export directory', () => {
    const badFiles = [{ id: 99, file_path: 'D:\\other\\img.jpg' }];
    expect(() => mgr.groupFilesByDirectory(badFiles, exportDir)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// processNormalImageFile
// ---------------------------------------------------------------------------

describe('ImageTransferManager.processNormalImageFile', () => {
  beforeEach(() => {
    fs.ensureDir.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(true);
    fs.copy.mockResolvedValue(undefined);
  });

  it('copies the source file to the destination path', async () => {
    const { mgr } = makeManager();
    const destPath = 'F:\\2026-06-01\\Camera 1\\img001.jpg';
    await mgr.processNormalImageFile(sampleImageQueueRow, destPath);

    expect(fs.ensureDir).toHaveBeenCalled();
    expect(fs.copy).toHaveBeenCalledWith(
      sampleImageQueueRow.file_path,
      destPath,
      expect.objectContaining({ overwrite: true })
    );
  });

  it('throws when the source file does not exist', async () => {
    const { mgr } = makeManager();
    fs.pathExists.mockResolvedValue(false);

    await expect(mgr.processNormalImageFile(sampleImageQueueRow, 'F:\\img001.jpg'))
      .rejects.toThrow('Source image file not found');
  });
});

// ---------------------------------------------------------------------------
// processImageFile
// ---------------------------------------------------------------------------

describe('ImageTransferManager.processImageFile', () => {
  beforeEach(() => {
    fs.ensureDir.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(true);
    fs.copy.mockResolvedValue(undefined);
    TransferUtils.markSourceFilesAsTransferred.mockResolvedValue(undefined);
  });

  it('throws when storage directory is missing from config', async () => {
    const { mgr } = makeManager({ config: { storage: {}, autoTransfer: { drive: 'F' } } });
    await expect(mgr.processImageFile(sampleImageQueueRow))
      .rejects.toThrow('Missing export directory');
  });

  it('throws when USB drive is missing from config', async () => {
    const { mgr } = makeManager({ config: { storage: { directory: 'C:\\export' }, autoTransfer: {} } });
    await expect(mgr.processImageFile(sampleImageQueueRow))
      .rejects.toThrow('Missing export directory');
  });

  it('computes correct relative path and copies file (non-encrypted)', async () => {
    const { mgr, pool } = makeManager();
    await mgr.processImageFile(sampleImageQueueRow);

    // pool.query should be called to update destination_path
    const updateDestCall = pool.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes('destination_path')
    );
    expect(updateDestCall).toBeDefined();

    // Destination should be under the USB drive path
    const destArg = updateDestCall[1][0];
    expect(destArg).toMatch(/^F:\\/);

    // fs.copy should have been called
    expect(fs.copy).toHaveBeenCalled();

    // Final status update should set 'transferred'
    const transferredCall = pool.query.mock.calls.find(c =>
      typeof c[0] === 'string' && c[0].includes("'transferred'")
    );
    expect(transferredCall).toBeDefined();

    // TransferUtils should be called to mark source file
    expect(TransferUtils.markSourceFilesAsTransferred).toHaveBeenCalledWith(
      pool,
      [sampleImageQueueRow.file_id],
      'auto'
    );
  });

  it('delegates to processEncryptedImageFile when encryption is enabled', async () => {
    const enc = createMockEncryption();
    const config = {
      storage:     { directory: 'C:\\export' },
      autoTransfer: { drive: 'F', encryption: { enabled: true } }
    };
    const { mgr } = makeManager({ enc, config });
    mgr.setEncryptionRequired(true);

    fs.ensureDir.mockResolvedValue(undefined);

    await mgr.processImageFile(sampleImageQueueRow);

    expect(enc.generateAESKey).toHaveBeenCalled();
    expect(enc.encryptFileAES).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// processEncryptedImageBatch
// ---------------------------------------------------------------------------

describe('ImageTransferManager.processEncryptedImageBatch', () => {
  const exportDir = 'C:\\export';
  const usbPath   = 'F:\\';
  const pubKeyPath = 'certs/public.pem';

  const dirFiles = [
    { id: 1, file_id: 101, file_path: 'C:\\export\\2026-06-01__Camera 1__img001.jpg' },
    { id: 2, file_id: 102, file_path: 'C:\\export\\2026-06-01__Camera 1__img002.jpg' },
    { id: 3, file_id: 103, file_path: 'C:\\export\\2026-06-01__Camera 2__img003.jpg' }
  ];

  beforeEach(() => {
    fs.ensureDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    TransferUtils.markSourceFilesAsTransferred.mockResolvedValue(undefined);
  });

  it('throws when encryptionService is not provided', async () => {
    const { mgr } = makeManager({ enc: null });
    await expect(mgr.processEncryptedImageBatch(dirFiles, '2026-06-01', exportDir, usbPath, pubKeyPath))
      .rejects.toThrow('Encryption service not available');
  });

  it('encrypts each file and writes a metadata.json per batch', async () => {
    const enc = createMockEncryption();
    const { mgr, pool } = makeManager({ enc });

    await mgr.processEncryptedImageBatch(dirFiles, '2026-06-01', exportDir, usbPath, pubKeyPath);

    // Three files → one batch of 3 (batchSize=3)
    expect(enc.generateAESKey).toHaveBeenCalledTimes(1);
    expect(enc.encryptFileAES).toHaveBeenCalledTimes(3);
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('metadata.json'),
      expect.any(String)
    );
  });

  it('derives filename from "Camera N" token when present', async () => {
    const enc = createMockEncryption();
    const { mgr } = makeManager({ enc });

    // File with "Camera 1" in name
    const files = [{ id: 1, file_id: 101, file_path: 'C:\\export\\2026-06-01__Camera 1__img001.jpg' }];
    await mgr.processEncryptedImageBatch(files, '2026-06-01', exportDir, usbPath, pubKeyPath);

    const encryptCallArg = enc.encryptFileAES.mock.calls[0][1]; // destination path
    expect(encryptCallArg).toContain('2026-06-01__Camera 1');
  });

  it('falls back to sequential numbering when no "Camera N" token is found', async () => {
    const enc = createMockEncryption();
    const { mgr } = makeManager({ enc });

    const files = [{ id: 1, file_id: 101, file_path: 'C:\\export\\2026-06-01\\plainname.jpg' }];
    await mgr.processEncryptedImageBatch(files, '2026-06-01', exportDir, usbPath, pubKeyPath);

    const encryptCallArg = enc.encryptFileAES.mock.calls[0][1];
    // fallback filename is '1' (index 0 + 1)
    expect(path.basename(encryptCallArg)).toBe('1');
  });

  it('marks each source file as transferred in the DB', async () => {
    const enc = createMockEncryption();
    const { mgr, pool } = makeManager({ enc });

    await mgr.processEncryptedImageBatch(dirFiles, '2026-06-01', exportDir, usbPath, pubKeyPath);

    // Each file should have its transfer_queue record updated to 'transferred'
    const transferredCalls = pool.query.mock.calls.filter(c =>
      typeof c[0] === 'string' && c[0].includes("'transferred'")
    );
    expect(transferredCalls).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// copyWithRetry (image variant – uses this.sleep internally)
// ---------------------------------------------------------------------------

describe('ImageTransferManager.copyWithRetry', () => {
  it('succeeds on the first attempt', async () => {
    const { mgr } = makeManager();
    fs.copy.mockResolvedValue(undefined);
    await mgr.copyWithRetry('/src/img.jpg', '/dest/img.jpg', 3, 0);
    expect(fs.copy).toHaveBeenCalledTimes(1);
  });

  it('retries on EBUSY then succeeds', async () => {
    const { mgr } = makeManager();
    const busyErr = Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    fs.copy
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);
    await mgr.copyWithRetry('/src/img.jpg', '/dest/img.jpg', 3, 0);
    expect(fs.copy).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-EBUSY error', async () => {
    const { mgr } = makeManager();
    const permErr = Object.assign(new Error('EPERM'), { code: 'EPERM' });
    fs.copy.mockRejectedValue(permErr);
    await expect(mgr.copyWithRetry('/src/img.jpg', '/dest/img.jpg', 3, 0))
      .rejects.toThrow('EPERM');
    expect(fs.copy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// updateTransferStatus
// ---------------------------------------------------------------------------

describe('ImageTransferManager.updateTransferStatus', () => {
  it('executes an UPDATE with the correct status', async () => {
    const { mgr, pool } = makeManager();
    await mgr.updateTransferStatus(42, 'failed', 'Something went wrong');
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE/);
    expect(params).toContain(42);
    expect(params).toContain('failed');
    expect(params).toContain('Something went wrong');
  });

  it('omits error_message param when not provided', async () => {
    const { mgr, pool } = makeManager();
    await mgr.updateTransferStatus(42, 'transferred');
    const [, params] = pool.query.mock.calls[0];
    expect(params).toHaveLength(2); // [status, id]
  });
});

// ---------------------------------------------------------------------------
// checkAndUpdateCompletedJobs
// ---------------------------------------------------------------------------

describe('ImageTransferManager.checkAndUpdateCompletedJobs', () => {
  it('marks a transferring job as "transferred" when all files are done', async () => {
    const pool = createMockPool();
    pool.query
      // First call: SELECT transferring jobs without pending files
      .mockResolvedValueOnce({ rows: [{ id: 10, batch_id: 'b-001' }] })
      // Second call: file stats
      .mockResolvedValueOnce({ rows: [{ total_files: '5', transferred_files: '5', failed_files: '0' }] })
      // Third call: UPDATE job status
      .mockResolvedValueOnce({ rows: [] });

    const { mgr } = makeManager({ pool });
    await mgr.checkAndUpdateCompletedJobs();

    const statusUpdate = pool.query.mock.calls[2];
    expect(statusUpdate[0]).toMatch(/UPDATE/);
    expect(statusUpdate[1]).toContain('transferred');
    expect(statusUpdate[1]).toContain(10);
  });

  it('marks job as "failed" when no files were transferred', async () => {
    const pool = createMockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 10, batch_id: 'b-001' }] })
      .mockResolvedValueOnce({ rows: [{ total_files: '3', transferred_files: '0', failed_files: '3' }] })
      .mockResolvedValueOnce({ rows: [] });

    const { mgr } = makeManager({ pool });
    await mgr.checkAndUpdateCompletedJobs();

    const statusUpdate = pool.query.mock.calls[2];
    expect(statusUpdate[1]).toContain('failed');
  });

  it('does nothing when no jobs need checking', async () => {
    const pool = createMockPool([]);
    const { mgr } = makeManager({ pool });
    await mgr.checkAndUpdateCompletedJobs();
    expect(pool.query).toHaveBeenCalledTimes(1); // only the SELECT
  });
});

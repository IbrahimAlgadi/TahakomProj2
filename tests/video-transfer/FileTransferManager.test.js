'use strict';

// Mock fs-extra before requiring the module under test
jest.mock('fs-extra');

// Mock utils.js sleep so retry tests don't wait real milliseconds
jest.mock('../../utils.js', () => ({
  sleep: jest.fn().mockResolvedValue(undefined),
  formatGB: jest.fn()
}));

const path = require('path');
const fs   = require('fs-extra');
const { sleep } = require('../../utils.js');

const FileTransferManager = require('../../services/video-transfer/transfer/FileTransferManager');
const { createMockPool, createMockEncryption, sampleVideoQueueRow, sampleDriveInfo } = require('../helpers/mocks');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager({ enc = null, pool = null, config = {} } = {}) {
  const mockPool = pool || createMockPool();
  const mgr = new FileTransferManager({}, mockPool, {}, enc, config);
  mgr.setDriveInfo({ ...sampleDriveInfo });
  return { mgr, pool: mockPool };
}

// ---------------------------------------------------------------------------
// transferFile
// ---------------------------------------------------------------------------

describe('FileTransferManager.transferFile', () => {
  let pool, mgr;

  beforeEach(() => {
    ({ mgr, pool } = makeManager());
    fs.ensureDir.mockResolvedValue(undefined);
    fs.pathExists.mockResolvedValue(true);
    fs.copy.mockResolvedValue(undefined);
  });

  it('throws when driveInfo is null', async () => {
    mgr.setDriveInfo(null);
    await expect(mgr.transferFile(sampleVideoQueueRow))
      .rejects.toThrow('Drive information not available');
  });

  it('throws when driveInfo.drive is missing', async () => {
    mgr.setDriveInfo({ remainingSpace: '10' });
    await expect(mgr.transferFile(sampleVideoQueueRow))
      .rejects.toThrow('Drive information not available');
  });

  it('throws when source file does not exist', async () => {
    fs.pathExists
      .mockResolvedValueOnce(false); // source absent
    await expect(mgr.transferFile(sampleVideoQueueRow))
      .rejects.toThrow('Source video file not found');
  });

  it('copies the file and marks it transferred (non-encrypted, new destination)', async () => {
    // source exists, dest does NOT exist
    fs.pathExists
      .mockResolvedValueOnce(true)   // source exists
      .mockResolvedValueOnce(false); // dest does not exist

    await mgr.transferFile(sampleVideoQueueRow);

    expect(fs.ensureDir).toHaveBeenCalled();
    expect(fs.copy).toHaveBeenCalledWith(
      sampleVideoQueueRow.video_file_path,
      expect.stringContaining('cam1_2026-06-01.mp4'),
      expect.objectContaining({ overwrite: true })
    );

    // Second pool.query should mark as 'transferred'
    const lastQuery = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(lastQuery[0]).toMatch(/status = 'transferred'/);
    expect(lastQuery[1]).toContain(sampleVideoQueueRow.id);
  });

  it('skips copy when destination already has the same size', async () => {
    const fileSize = sampleVideoQueueRow.file_size;
    fs.pathExists
      .mockResolvedValueOnce(true)  // source exists
      .mockResolvedValueOnce(true); // dest exists
    fs.stat
      .mockResolvedValueOnce({ size: fileSize })  // source stat
      .mockResolvedValueOnce({ size: fileSize });  // dest stat (same)

    await mgr.transferFile(sampleVideoQueueRow);

    expect(fs.copy).not.toHaveBeenCalled();
    const lastQuery = pool.query.mock.calls[pool.query.mock.calls.length - 1];
    expect(lastQuery[0]).toMatch(/status = 'transferred'/);
  });

  it('copies when destination exists but size differs', async () => {
    fs.pathExists
      .mockResolvedValueOnce(true)  // source exists
      .mockResolvedValueOnce(true); // dest exists
    fs.stat
      .mockResolvedValueOnce({ size: 100 })
      .mockResolvedValueOnce({ size: 200 }); // different sizes

    await mgr.transferFile(sampleVideoQueueRow);

    expect(fs.copy).toHaveBeenCalled();
  });

  it('delegates to processEncryptedVideoBatch when encryption is enabled', async () => {
    const enc = createMockEncryption();
    const { mgr: encMgr, pool: encPool } = makeManager({ enc });
    encMgr.setEncryptionRequired(true);
    encMgr.setMainConfig({ certificates: { publicKeyFilename: 'public.pem' } });

    fs.ensureDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);

    await encMgr.transferFile(sampleVideoQueueRow);

    expect(enc.generateAESKey).toHaveBeenCalled();
    expect(enc.encryptFileAES).toHaveBeenCalled();
    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('_metadata.json'),
      expect.any(String)
    );
  });
});

// ---------------------------------------------------------------------------
// copyWithRetry
// ---------------------------------------------------------------------------

describe('FileTransferManager.copyWithRetry', () => {
  let mgr;

  beforeEach(() => {
    ({ mgr } = makeManager());
  });

  it('succeeds on the first attempt', async () => {
    fs.copy.mockResolvedValue(undefined);
    await mgr.copyWithRetry('/src/file.mp4', '/dest/file.mp4', 3, 0);
    expect(fs.copy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries on EBUSY and succeeds on the second attempt', async () => {
    const busyErr = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    fs.copy
      .mockRejectedValueOnce(busyErr)
      .mockResolvedValue(undefined);

    await mgr.copyWithRetry('/src/file.mp4', '/dest/file.mp4', 3, 0);

    expect(fs.copy).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-EBUSY error without retrying', async () => {
    const permErr = Object.assign(new Error('EPERM: permission denied'), { code: 'EPERM' });
    fs.copy.mockRejectedValue(permErr);

    await expect(mgr.copyWithRetry('/src/file.mp4', '/dest/file.mp4', 3, 0))
      .rejects.toThrow('EPERM');

    expect(fs.copy).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('throws after exhausting all EBUSY retries', async () => {
    const busyErr = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    fs.copy.mockRejectedValue(busyErr); // always fails

    await expect(mgr.copyWithRetry('/src/file.mp4', '/dest/file.mp4', 3, 0))
      .rejects.toThrow('EBUSY');

    expect(fs.copy).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // between attempts 1-2 and 2-3
  });
});

// ---------------------------------------------------------------------------
// handleTransferError
// ---------------------------------------------------------------------------

describe('FileTransferManager.handleTransferError', () => {
  let pool, mgr;

  beforeEach(() => {
    ({ mgr, pool } = makeManager());
  });

  it('marks file as failed on ENOENT', async () => {
    const file = { id: 1 };
    const err  = Object.assign(new Error('no such file'), { code: 'ENOENT' });

    const result = await mgr.handleTransferError(file, err);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'failed'/);
    expect(params).toContain('File not found: no such file');
    expect(result).toEqual({ shouldStopProcessing: false });
  });

  it('marks file as paused and returns shouldStopProcessing=true on ENOSPC', async () => {
    const file = { id: 1 };
    const err  = Object.assign(new Error('no space left'), { code: 'ENOSPC' });

    const result = await mgr.handleTransferError(file, err);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'paused'/);
    expect(params).toContain('No space left on device: no space left');
    expect(result).toEqual({ shouldStopProcessing: true });
  });

  it('increments retry_count and keeps status pending when below max_retries', async () => {
    const file = { id: 1, retry_count: 0, max_retries: 3 };
    const err  = new Error('network timeout');

    const result = await mgr.handleTransferError(file, err);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/retry_count/);
    expect(params).toContain(1);           // new retry_count
    expect(params).toContain('pending');   // new status
    expect(result).toEqual({ shouldStopProcessing: false });
  });

  it('marks file as failed when retry_count reaches max_retries', async () => {
    const file = { id: 1, retry_count: 2, max_retries: 3 };
    const err  = new Error('persistent failure');

    await mgr.handleTransferError(file, err);

    const [sql, params] = pool.query.mock.calls[0];
    expect(params).toContain(3);         // retry_count = 3
    expect(params).toContain('failed');  // status
  });
});

// ---------------------------------------------------------------------------
// processEncryptedVideoBatch
// ---------------------------------------------------------------------------

describe('FileTransferManager.processEncryptedVideoBatch', () => {
  let enc, pool, mgr;

  beforeEach(() => {
    enc  = createMockEncryption();
    pool = createMockPool();
    mgr  = new FileTransferManager({}, pool, {}, enc, {});
    mgr.setDriveInfo({ ...sampleDriveInfo });
    fs.ensureDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
  });

  it('throws when encryptionService is not provided', async () => {
    const noEncMgr = new FileTransferManager({}, pool, {}, null, {});
    noEncMgr.setDriveInfo({ ...sampleDriveInfo });
    await expect(noEncMgr.processEncryptedVideoBatch(sampleVideoQueueRow, 'F:', 'certs/pub.pem'))
      .rejects.toThrow('Encryption service not available');
  });

  it('calls generateAESKey and encryptFileAES with correct paths', async () => {
    await mgr.processEncryptedVideoBatch(sampleVideoQueueRow, 'F:', 'certs/pub.pem');

    expect(enc.generateAESKey).toHaveBeenCalledTimes(1);
    expect(enc.encryptFileAES).toHaveBeenCalledWith(
      sampleVideoQueueRow.video_file_path,
      expect.stringContaining('cam1_2026-06-01'), // newFilename = original name without extension
      expect.any(Buffer),
      expect.any(Buffer)
    );
  });

  it('writes a *_metadata.json file to the USB videos directory', async () => {
    await mgr.processEncryptedVideoBatch(sampleVideoQueueRow, 'F:', 'certs/pub.pem');

    expect(fs.writeFile).toHaveBeenCalledWith(
      expect.stringContaining('cam1_2026-06-01_metadata.json'),
      expect.any(String)
    );
  });

  it('encrypts files data with AES and keys data with RSA', async () => {
    await mgr.processEncryptedVideoBatch(sampleVideoQueueRow, 'F:', 'certs/pub.pem');

    expect(enc.encryptDataAES).toHaveBeenCalled();
    expect(enc.encryptWithRSAPublicKey).toHaveBeenCalled();
  });

  it('updates the database record after encrypting', async () => {
    await mgr.processEncryptedVideoBatch(sampleVideoQueueRow, 'F:', 'certs/pub.pem');

    const calledIds = pool.query.mock.calls.map(c => c[1]).filter(p => p && p.includes(sampleVideoQueueRow.id));
    expect(calledIds.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// markSourceFilesAsTransferred
// ---------------------------------------------------------------------------

describe('FileTransferManager.markSourceFilesAsTransferred', () => {
  let pool, mgr;

  beforeEach(() => {
    pool = createMockPool([{ source_file_ids: [101, 102] }]);
    mgr  = new FileTransferManager({}, pool, {}, null, {});
    mgr.setDriveInfo({ ...sampleDriveInfo });
  });

  it('queries source_file_ids then updates iss_media_files', async () => {
    await mgr.markSourceFilesAsTransferred(sampleVideoQueueRow);

    expect(pool.query).toHaveBeenCalledTimes(2);
    const updateCall = pool.query.mock.calls[1];
    expect(updateCall[0]).toMatch(/iss_media_files/);
    expect(updateCall[0]).toMatch(/is_auto_transferred/);
    expect(updateCall[1]).toEqual([[101, 102]]);
  });

  it('logs a warning and returns early when no queue record is found', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // no record
    await mgr.markSourceFilesAsTransferred(sampleVideoQueueRow);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('returns early when source_file_ids is empty', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ source_file_ids: [] }] });
    await mgr.markSourceFilesAsTransferred(sampleVideoQueueRow);
    expect(pool.query).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// getPendingTransferFileForJob
// ---------------------------------------------------------------------------

describe('FileTransferManager.getPendingTransferFileForJob', () => {
  it('returns the first pending transfer row for a given job and camera', async () => {
    const pool = createMockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [] })              // UPDATE job status
      .mockResolvedValueOnce({ rows: [sampleVideoQueueRow] }); // SELECT

    const mgr = new FileTransferManager({}, pool, {}, null, {});
    const result = await mgr.getPendingTransferFileForJob(10, '1');

    expect(result).toEqual(sampleVideoQueueRow);
  });

  it('returns undefined when no pending files exist for the job', async () => {
    const pool = createMockPool();
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // UPDATE
      .mockResolvedValueOnce({ rows: [] }); // SELECT (empty)

    const mgr = new FileTransferManager({}, pool, {}, null, {});
    const result = await mgr.getPendingTransferFileForJob(10, '1');

    expect(result).toBeUndefined();
  });
});

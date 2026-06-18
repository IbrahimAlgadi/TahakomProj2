'use strict';

jest.mock('fs-extra');

const fs   = require('fs-extra');
const path = require('path');

const TransferUtils = require('../../services/shared/TransferUtils');
const { createMockPool } = require('../helpers/mocks');

// ---------------------------------------------------------------------------
// markSourceFilesAsTransferred
// ---------------------------------------------------------------------------

describe('TransferUtils.markSourceFilesAsTransferred', () => {
  it('updates is_auto_transferred for auto transfer type', async () => {
    const pool = createMockPool();
    await TransferUtils.markSourceFilesAsTransferred(pool, [1, 2, 3], 'auto');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/is_auto_transferred/);
    expect(params).toEqual([[1, 2, 3]]);
  });

  it('updates is_ftp_transferred for ftp transfer type', async () => {
    const pool = createMockPool();
    await TransferUtils.markSourceFilesAsTransferred(pool, [1], 'ftp');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/is_ftp_transferred/);
  });

  it('returns early without querying when sourceFileIds is empty', async () => {
    const pool = createMockPool();
    await TransferUtils.markSourceFilesAsTransferred(pool, [], 'auto');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('returns early without querying when sourceFileIds is null', async () => {
    const pool = createMockPool();
    await TransferUtils.markSourceFilesAsTransferred(pool, null, 'auto');
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// markUSBSourceFilesAsTransferred
// ---------------------------------------------------------------------------

describe('TransferUtils.markUSBSourceFilesAsTransferred', () => {
  it('updates the files table (not iss_media_files)', async () => {
    const pool = createMockPool();
    await TransferUtils.markUSBSourceFilesAsTransferred(pool, [10, 11], 'auto');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE files/);
    expect(sql).toMatch(/is_auto_transferred/);
    expect(params).toEqual([[10, 11]]);
  });

  it('returns early for empty array', async () => {
    const pool = createMockPool();
    await TransferUtils.markUSBSourceFilesAsTransferred(pool, []);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// markImageFilesAsTransferred
// ---------------------------------------------------------------------------

describe('TransferUtils.markImageFilesAsTransferred', () => {
  it('updates files table for auto transfers', async () => {
    const pool = createMockPool();
    await TransferUtils.markImageFilesAsTransferred(pool, [201, 202], 'auto');

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE files/);
    expect(sql).toMatch(/is_auto_transferred/);
    expect(params).toEqual([[201, 202]]);
  });

  it('updates is_ftp_transferred for ftp type', async () => {
    const pool = createMockPool();
    await TransferUtils.markImageFilesAsTransferred(pool, [201], 'ftp');

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/is_ftp_transferred/);
  });
});

// ---------------------------------------------------------------------------
// handleTransferError
// ---------------------------------------------------------------------------

describe('TransferUtils.handleTransferError', () => {
  it('marks file as failed after exceeding max_retries', async () => {
    const pool = createMockPool();
    const file = { id: 1, video_file_name: 'vid.mp4', retry_count: 2, max_retries: 3 };
    const result = await TransferUtils.handleTransferError(pool, file, new Error('oops'));

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'failed'/);
    expect(params[0]).toBe(3);    // retry_count
    expect(result.maxRetriesReached).toBe(true);
  });

  it('increments retry_count without failing when below max_retries', async () => {
    const pool = createMockPool();
    const file = { id: 1, video_file_name: 'vid.mp4', retry_count: 0, max_retries: 3 };
    const result = await TransferUtils.handleTransferError(pool, file, new Error('timeout'));

    const [sql] = pool.query.mock.calls[0];
    expect(sql).not.toMatch(/status = 'failed'/);
    expect(result.maxRetriesReached).toBe(false);
    expect(result.retryCount).toBe(1);
  });

  it('sets shouldStopProcessing=true for ENOSPC errors', async () => {
    const pool = createMockPool();
    const file = { id: 1, video_file_name: 'vid.mp4', retry_count: 0, max_retries: 3 };
    const result = await TransferUtils.handleTransferError(pool, file, new Error('ENOSPC no space left'));
    expect(result.shouldStopProcessing).toBe(true);
  });

  it('sets shouldStopProcessing=true for connection errors', async () => {
    const pool = createMockPool();
    const file = { id: 1, video_file_name: 'vid.mp4', retry_count: 0, max_retries: 3 };
    const result = await TransferUtils.handleTransferError(pool, file, new Error('Connection refused'));
    expect(result.shouldStopProcessing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleImageTransferError
// ---------------------------------------------------------------------------

describe('TransferUtils.handleImageTransferError', () => {
  it('marks image file as failed after exceeding max_retries', async () => {
    const pool = createMockPool();
    const file = { id: 1, file_path: 'img.jpg', retry_count: 2, max_retries: 3 };
    const result = await TransferUtils.handleImageTransferError(pool, file, new Error('disk error'));

    expect(result.maxRetriesReached).toBe(true);
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'failed'/);
  });

  it('sets shouldStopProcessing=true for USB-related errors', async () => {
    const pool = createMockPool();
    const file = { id: 1, file_path: 'img.jpg', retry_count: 0, max_retries: 3 };
    const result = await TransferUtils.handleImageTransferError(pool, file, new Error('USB drive error'));
    expect(result.shouldStopProcessing).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isDriveRelatedError
// ---------------------------------------------------------------------------

describe('TransferUtils.isDriveRelatedError', () => {
  const trueErrors = [
    'drive disconnected',
    'USB removed',
    'device not ready',
    'no such device',
    'unknown error mkdir',
    'enoent mkdir',
    'write F:\\somefile',
    'path not found'
  ];

  trueErrors.forEach(msg => {
    it(`returns true for: "${msg}"`, () => {
      expect(TransferUtils.isDriveRelatedError(new Error(msg))).toBe(true);
    });
  });

  it('returns false for a generic error', () => {
    expect(TransferUtils.isDriveRelatedError(new Error('timeout'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isFileNotFoundError
// ---------------------------------------------------------------------------

describe('TransferUtils.isFileNotFoundError', () => {
  it('returns true for ENOENT with lstat syscall', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT', syscall: 'lstat' });
    expect(TransferUtils.isFileNotFoundError(err)).toBe(true);
  });

  it('returns false for ENOENT with mkdir syscall (drive error, not file-not-found)', () => {
    const err = Object.assign(new Error('no such file'), { code: 'ENOENT', syscall: 'mkdir' });
    expect(TransferUtils.isFileNotFoundError(err)).toBe(false);
  });

  it('returns false for non-ENOENT errors', () => {
    const err = Object.assign(new Error('permission denied'), { code: 'EPERM', syscall: 'open' });
    expect(TransferUtils.isFileNotFoundError(err)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatDuration
// ---------------------------------------------------------------------------

describe('TransferUtils.formatDuration', () => {
  it('returns seconds string for values under 60', () => {
    expect(TransferUtils.formatDuration(45)).toBe('45 seconds');
  });

  it('returns minutes string for values between 60 and 3600', () => {
    expect(TransferUtils.formatDuration(120)).toBe('2 minutes');
    expect(TransferUtils.formatDuration(90)).toBe('1m 30s');
  });

  it('returns hours string for values >= 3600', () => {
    expect(TransferUtils.formatDuration(3600)).toBe('1 hours');
    expect(TransferUtils.formatDuration(5400)).toBe('1h 30m');
  });
});

// ---------------------------------------------------------------------------
// calculateImageTransferEstimate
// ---------------------------------------------------------------------------

describe('TransferUtils.calculateImageTransferEstimate', () => {
  it('estimates transfer time proportional to total file size', () => {
    // 15 MB file at 15 MB/s → 1 second
    const files = [{ file_size: 15 * 1024 * 1024 }];
    const estimate = TransferUtils.calculateImageTransferEstimate(files);
    expect(estimate.totalFiles).toBe(1);
    expect(estimate.totalSizeMB).toBeCloseTo(15, 1);
    expect(estimate.estimatedSeconds).toBe(1);
  });

  it('handles empty file list', () => {
    const estimate = TransferUtils.calculateImageTransferEstimate([]);
    expect(estimate.totalFiles).toBe(0);
    expect(estimate.totalSizeMB).toBe(0);
    expect(estimate.estimatedSeconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateDestinationPath
// ---------------------------------------------------------------------------

describe('TransferUtils.generateDestinationPath', () => {
  it('creates path under videos/YYYY-MM-DD/camera_X/', () => {
    const result = TransferUtils.generateDestinationPath('F:\\', 'vid.mp4', '1', '2026-06-01');
    expect(result.relativePath).toMatch(/videos/);
    expect(result.relativePath).toMatch(/2026-06-01/);
    expect(result.relativePath).toMatch(/camera_1/);
    expect(result.relativePath).toMatch(/vid.mp4/);
  });

  it('uses today\'s date when recordingDate is not provided', () => {
    const today = new Date().toISOString().split('T')[0];
    const result = TransferUtils.generateDestinationPath('F:\\', 'vid.mp4', '2');
    expect(result.relativePath).toContain(today);
  });
});

// ---------------------------------------------------------------------------
// generateImageDestinationPath
// ---------------------------------------------------------------------------

describe('TransferUtils.generateImageDestinationPath', () => {
  it('preserves relative directory structure from export dir to destination', () => {
    const exportDir = 'C:\\export';
    const sourceFile = 'C:\\export\\2026-06-01\\Camera 1\\img.jpg';
    const targetDir  = 'F:\\';

    const result = TransferUtils.generateImageDestinationPath(sourceFile, exportDir, targetDir);
    expect(result.relativePath).toContain('2026-06-01');
    expect(result.relativePath).toContain('Camera 1');
    expect(result.filename).toBe('img.jpg');
  });
});

// ---------------------------------------------------------------------------
// validateFileForTransfer (uses fs-extra – mocked)
// ---------------------------------------------------------------------------

describe('TransferUtils.validateFileForTransfer', () => {
  it('returns valid=true for an existing non-empty mp4 file', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.stat.mockResolvedValue({ isFile: () => true, size: 1024 });

    const result = await TransferUtils.validateFileForTransfer('C:\\temp\\vid.mp4');
    expect(result.valid).toBe(true);
    expect(result.size).toBe(1024);
    expect(result.extension).toBe('.mp4');
  });

  it('returns valid=false when file does not exist', async () => {
    fs.pathExists.mockResolvedValue(false);

    const result = await TransferUtils.validateFileForTransfer('C:\\temp\\missing.mp4');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/does not exist/);
  });

  it('returns valid=false for a zero-byte file', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.stat.mockResolvedValue({ isFile: () => true, size: 0 });

    const result = await TransferUtils.validateFileForTransfer('C:\\temp\\empty.mp4');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/empty/i);
  });
});

// ---------------------------------------------------------------------------
// validateImageFileForTransfer (uses fs-extra – mocked)
// ---------------------------------------------------------------------------

describe('TransferUtils.validateImageFileForTransfer', () => {
  it('accepts supported image extensions (.jpg, .jpeg, .png)', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.stat.mockResolvedValue({ isFile: () => true, size: 512 });

    for (const ext of ['.jpg', '.jpeg', '.png']) {
      const result = await TransferUtils.validateImageFileForTransfer(`img${ext}`);
      expect(result.valid).toBe(true);
      expect(result.isImage).toBe(true);
    }
  });

  it('rejects unsupported extensions', async () => {
    fs.pathExists.mockResolvedValue(true);
    fs.stat.mockResolvedValue({ isFile: () => true, size: 512 });

    const result = await TransferUtils.validateImageFileForTransfer('img.bmp');
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Unsupported/i);
  });

  it('returns valid=false when file is missing', async () => {
    fs.pathExists.mockResolvedValue(false);
    const result = await TransferUtils.validateImageFileForTransfer('img.jpg');
    expect(result.valid).toBe(false);
  });
});

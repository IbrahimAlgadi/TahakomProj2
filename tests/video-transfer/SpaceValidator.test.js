'use strict';

const SpaceValidator = require('../../services/video-transfer/validators/SpaceValidator');

// Minimal config matching the shape of utils/envConfig.js
const BASE_CONFIG = {
  minRequiredSpaceMB: 500,
  ISS_MEDIA_FILE_SIZE: 8192,                 // 8 MB per file
  ISS_VIDEO_TRANSFER_CONVERSION_COUNT: 10
};

const DRIVE_INFO_10GB = { drive: 'F:', remainingSpace: '10' }; // 10 GB free

function makeValidator(config = {}) {
  return new SpaceValidator({}, { ...BASE_CONFIG, ...config });
}

// ---------------------------------------------------------------------------
// isDriveReady
// ---------------------------------------------------------------------------

describe('SpaceValidator.isDriveReady', () => {
  it('returns false when no drive info is set', () => {
    const sv = makeValidator();
    expect(sv.isDriveReady()).toBe(false);
  });

  it('returns false when shouldStopProcessing is true', () => {
    const sv = makeValidator();
    sv.updateDriveInfo(DRIVE_INFO_10GB, true);
    expect(sv.isDriveReady()).toBe(false);
  });

  it('returns true when drive info is present and not stopping', () => {
    const sv = makeValidator();
    sv.updateDriveInfo(DRIVE_INFO_10GB, false);
    expect(sv.isDriveReady()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getDriveStatus
// ---------------------------------------------------------------------------

describe('SpaceValidator.getDriveStatus', () => {
  it('returns not-connected status when driveInfo is null', () => {
    const sv = makeValidator();
    const status = sv.getDriveStatus();
    expect(status.connected).toBe(false);
    expect(status.freeSpaceGB).toBe(0);
    expect(status.reason).toBe('No drive info available');
  });

  it('returns connected + OK status for a healthy drive', () => {
    const sv = makeValidator();
    sv.updateDriveInfo(DRIVE_INFO_10GB, false);
    const status = sv.getDriveStatus();
    expect(status.connected).toBe(true);
    expect(status.hasSpace).toBe(true);
    expect(status.freeSpaceGB).toBe(10);
    expect(status.reason).toBe('OK');
  });

  it('reports insufficient space when shouldStopProcessing is true', () => {
    const sv = makeValidator();
    sv.updateDriveInfo(DRIVE_INFO_10GB, true);
    const status = sv.getDriveStatus();
    expect(status.hasSpace).toBe(false);
    expect(status.reason).toBe('Insufficient space');
  });
});

// ---------------------------------------------------------------------------
// getEstimatedProcessingSize
// ---------------------------------------------------------------------------

describe('SpaceValidator.getEstimatedProcessingSize', () => {
  it('computes expected MB estimate from config values', () => {
    const sv = makeValidator();
    // avgFileSizeMB = 8192 / 1024 = 8 MB
    // tempMp4SizeMB = 8 * 10 = 80 MB
    // finalVideoSizeMB = 80 * 1.25 = 100 MB
    const estimate = sv.getEstimatedProcessingSize();
    expect(estimate).toBeCloseTo(100, 1);
  });
});

// ---------------------------------------------------------------------------
// hasSpaceForProcessing
// ---------------------------------------------------------------------------

describe('SpaceValidator.hasSpaceForProcessing', () => {
  it('returns true when free space exceeds estimate + 120 MB buffer', () => {
    const sv = makeValidator();
    sv.updateDriveInfo({ remainingSpace: '1' }, false); // 1 GB = 1024 MB free
    // estimate = 100 MB, buffer = 120 MB, required = 220 MB < 1024 MB
    expect(sv.hasSpaceForProcessing(100)).toBe(true);
  });

  it('returns false when free space is below required threshold', () => {
    const sv = makeValidator();
    sv.updateDriveInfo({ remainingSpace: '0.1' }, false); // ~102 MB free
    // estimate = 100 MB, buffer = 120 MB, required = 220 MB > 102 MB
    expect(sv.hasSpaceForProcessing(100)).toBe(false);
  });

  it('falls back to shouldStopProcessing flag when driveInfo is null', () => {
    const sv = makeValidator();
    // no driveInfo, shouldStopProcessing = false → should return true
    expect(sv.hasSpaceForProcessing(100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateProcessingSpace
// ---------------------------------------------------------------------------

describe('SpaceValidator.validateProcessingSpace', () => {
  it('returns canProceed=true when drive has enough space', () => {
    const sv = makeValidator();
    sv.updateDriveInfo({ remainingSpace: '5' }, false); // 5 GB free >> 220 MB needed
    const result = sv.validateProcessingSpace();
    expect(result.canProceed).toBe(true);
    expect(result.estimatedSpaceMB).toBeGreaterThan(0);
  });

  it('returns canProceed=false with reason when space is insufficient', () => {
    const sv = makeValidator();
    sv.updateDriveInfo({ remainingSpace: '0.01' }, false); // ~10 MB free
    const result = sv.validateProcessingSpace();
    expect(result.canProceed).toBe(false);
    expect(result.reason).toBe('Insufficient disk space');
  });
});

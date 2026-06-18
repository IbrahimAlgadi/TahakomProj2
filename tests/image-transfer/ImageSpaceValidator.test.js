'use strict';

const ImageSpaceValidator = require('../../services/image-transfer/validators/ImageSpaceValidator');

const BASE_CONFIG = { minRequiredSpaceMB: 50 };

const DRIVE_10GB  = { drive: 'F:', remainingSpace: '10',  usedPercentage: '50' };
const DRIVE_FULL  = { drive: 'F:', remainingSpace: '0.04', usedPercentage: '99.96' }; // ~41 MB free

function makeValidator(config = {}) {
  return new ImageSpaceValidator({ ...BASE_CONFIG, ...config });
}

// ---------------------------------------------------------------------------
// getFreeSpaceMB
// ---------------------------------------------------------------------------

describe('ImageSpaceValidator.getFreeSpaceMB', () => {
  it('returns 0 when no driveInfo is set', () => {
    const v = makeValidator();
    expect(v.getFreeSpaceMB()).toBe(0);
  });

  it('reads remainingSpace in GB and converts to MB', () => {
    const v = makeValidator();
    v.updateDriveInfo(DRIVE_10GB, false);
    expect(v.getFreeSpaceMB()).toBeCloseTo(10 * 1024, 0);
  });

  it('falls back to freeSize property', () => {
    const v = makeValidator();
    v.updateDriveInfo({ freeSize: '5' }, false);
    expect(v.getFreeSpaceMB()).toBeCloseTo(5 * 1024, 0);
  });
});

// ---------------------------------------------------------------------------
// hasSpaceForFile
// ---------------------------------------------------------------------------

describe('ImageSpaceValidator.hasSpaceForFile', () => {
  it('returns true when drive has plenty of free space', () => {
    const v = makeValidator();
    v.updateDriveInfo(DRIVE_10GB, false);
    const oneMB = 1 * 1024 * 1024;
    expect(v.hasSpaceForFile(oneMB)).toBe(true);
  });

  it('returns false when free space is below file size + 10 MB buffer', () => {
    const v = makeValidator();
    v.updateDriveInfo(DRIVE_FULL, false); // ~41 MB free
    // 50 MB file > 41 MB available
    const fiftyMB = 50 * 1024 * 1024;
    expect(v.hasSpaceForFile(fiftyMB)).toBe(false);
  });

  it('falls back to !shouldStopTransfer when driveInfo is null', () => {
    const v = makeValidator();
    // shouldStopTransfer defaults to false → should say there IS space
    expect(v.hasSpaceForFile(0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hasSpaceForBatch
// ---------------------------------------------------------------------------

describe('ImageSpaceValidator.hasSpaceForBatch', () => {
  it('returns true when total batch fits in free space', () => {
    const v = makeValidator();
    v.updateDriveInfo(DRIVE_10GB, false);
    const files = [{ file_size: 1024 * 1024 }, { file_size: 1024 * 1024 }]; // 2 MB total
    expect(v.hasSpaceForBatch(files)).toBe(true);
  });

  it('returns false when batch exceeds free space', () => {
    const v = makeValidator();
    v.updateDriveInfo(DRIVE_FULL, false); // ~41 MB
    const files = Array.from({ length: 10 }, () => ({ file_size: 10 * 1024 * 1024 })); // 100 MB
    expect(v.hasSpaceForBatch(files)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isDriveNearFull
// ---------------------------------------------------------------------------

describe('ImageSpaceValidator.isDriveNearFull', () => {
  it('returns false when utilization is below the threshold', () => {
    const v = makeValidator();
    v.updateDriveInfo({ usedPercentage: '60' }, false);
    expect(v.isDriveNearFull(85)).toBe(false);
  });

  it('returns true when utilization meets or exceeds the threshold', () => {
    const v = makeValidator();
    v.updateDriveInfo({ usedPercentage: '90' }, false);
    expect(v.isDriveNearFull(85)).toBe(true);
  });

  it('returns true at exactly the threshold value', () => {
    const v = makeValidator();
    v.updateDriveInfo({ usedPercentage: '85' }, false);
    expect(v.isDriveNearFull(85)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getSpaceStatus
// ---------------------------------------------------------------------------

describe('ImageSpaceValidator.getSpaceStatus', () => {
  it('returns unknown status when no driveInfo', () => {
    const v = makeValidator();
    const s = v.getSpaceStatus();
    expect(s.status).toBe('unknown');
    expect(s.freeSpaceMB).toBe(0);
  });

  it('returns ok status for a healthy drive', () => {
    const v = makeValidator();
    v.updateDriveInfo({ ...DRIVE_10GB, usedPercentage: '50' }, false);
    const s = v.getSpaceStatus();
    expect(s.status).toBe('ok');
    expect(s.freeSpaceMB).toBeGreaterThan(0);
    expect(s.shouldStopTransfer).toBe(false);
  });

  it('returns full status when shouldStopTransfer is true', () => {
    const v = makeValidator();
    v.updateDriveInfo(DRIVE_10GB, true);
    const s = v.getSpaceStatus();
    expect(s.status).toBe('full');
    expect(s.message).toMatch(/stopped/i);
  });

  it('returns warning status when drive is near full (>85%)', () => {
    const v = makeValidator();
    v.updateDriveInfo({ usedPercentage: '90', remainingSpace: '6' }, false);
    const s = v.getSpaceStatus();
    expect(s.status).toBe('warning');
  });
});

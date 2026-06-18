'use strict';

/**
 * Tests for the pure schedule-helper methods on UnifiedVideoTransferService:
 *   _calculateNextScheduledRun
 *   _isInScheduledWindow
 *   _updateScheduleStatus
 *
 * We import the class safely because the constructor only registers event
 * listeners and does no I/O. We never call start().
 */

// Mock heavy dependencies that UnifiedVideoTransferService imports at module
// level so we avoid any real network/FS operations during require().
jest.mock('ioredis', () => {
  return class MockRedis {
    subscribe() {}
    on() {}
    quit() { return Promise.resolve(); }
  };
});
jest.mock('pg', () => ({ Pool: class { on() {} end() { return Promise.resolve(); } } }));
jest.mock('fs-extra');

// Stub all internal service classes – they are newed inside start() which we
// never call, but Jest still needs to resolve their require() calls.
jest.mock('../../services/video-transfer/processors/VideoProcessor',   () => class {});
jest.mock('../../services/video-transfer/transfer/FileTransferManager', () => class {});
jest.mock('../../services/video-transfer/state/JobManager',             () => class {});
jest.mock('../../services/video-transfer/state/ProcessingStateManager', () => class {});
jest.mock('../../services/video-transfer/validators/SpaceValidator',     () => class {
  updateDriveInfo() {}
});
jest.mock('../../services/shared/CleanupService',                        () => class {});
jest.mock('../../services/video-transfer/processors/CompleteBufferManager', () => class {});

const { UnifiedVideoTransferService } = require('../../refactored_autoVideoTransferEDAMicroservice');

// Minimal config required by the constructor
const MIN_CONFIG = {
  ISS_VIDEO_TRANSFER_CONVERSION_COUNT: 10,
  ISS_MEDIA_CAMERAS: ['CAM_1', 'CAM_2']
};

function makeService() {
  return new UnifiedVideoTransferService(MIN_CONFIG);
}

// ---------------------------------------------------------------------------
// _calculateNextScheduledRun
// ---------------------------------------------------------------------------

describe('UnifiedVideoTransferService._calculateNextScheduledRun', () => {
  afterEach(() => jest.useRealTimers());

  it('returns null when scheduleConfig is null', () => {
    const svc = makeService();
    expect(svc._calculateNextScheduledRun(null)).toBeNull();
  });

  it('returns null when type is not "scheduled"', () => {
    const svc = makeService();
    expect(svc._calculateNextScheduledRun({ type: 'immediate' })).toBeNull();
  });

  it('returns null for unknown mode', () => {
    const svc = makeService();
    expect(svc._calculateNextScheduledRun({ type: 'scheduled', mode: 'monthly' })).toBeNull();
  });

  it('returns a Date later today (daily mode) when current time is before the scheduled hour', () => {
    jest.useFakeTimers();
    // Use local Date constructor so hour comparisons work regardless of timezone
    jest.setSystemTime(new Date(2026, 5, 15, 8, 0, 0, 0)); // June 15 2026, 08:00 LOCAL

    const svc = makeService();
    const next = svc._calculateNextScheduledRun({ type: 'scheduled', mode: 'daily', hour: 14 });

    expect(next).toBeInstanceOf(Date);
    expect(next.getHours()).toBe(14);
    expect(next > new Date()).toBe(true);
  });

  it('advances to tomorrow (daily mode) when scheduled hour has already passed today', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 5, 15, 22, 0, 0, 0)); // June 15 2026, 22:00 LOCAL

    const svc = makeService();
    const next = svc._calculateNextScheduledRun({ type: 'scheduled', mode: 'daily', hour: 14 });

    expect(next).toBeInstanceOf(Date);
    expect(next > new Date()).toBe(true);
    expect(next.getHours()).toBe(14);
  });

  it('returns a future Date for weekly mode', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2026, 5, 15, 10, 0, 0, 0)); // June 15 2026 (Monday), 10:00 LOCAL

    const svc = makeService();
    // Schedule for Wednesday (day 3)
    const next = svc._calculateNextScheduledRun({ type: 'scheduled', mode: 'weekly', dayOfWeek: 3, hour: 9 });

    expect(next).toBeInstanceOf(Date);
    expect(next.getDay()).toBe(3);  // Wednesday
    expect(next.getHours()).toBe(9);
    expect(next > new Date()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _isInScheduledWindow
// ---------------------------------------------------------------------------

describe('UnifiedVideoTransferService._isInScheduledWindow', () => {
  afterEach(() => jest.useRealTimers());

  it('returns false when scheduleConfig is null', () => {
    const svc = makeService();
    expect(svc._isInScheduledWindow(null)).toBe(false);
  });

  it('returns false when type is not "scheduled"', () => {
    const svc = makeService();
    expect(svc._isInScheduledWindow({ type: 'immediate' })).toBe(false);
  });

  it('returns true within the 2-hour daily window', () => {
    jest.useFakeTimers();
    // 14:30 LOCAL – inside a 14:00–16:00 window
    jest.setSystemTime(new Date(2026, 5, 15, 14, 30, 0, 0));

    const svc = makeService();
    const inWindow = svc._isInScheduledWindow({ type: 'scheduled', mode: 'daily', hour: 14 });
    expect(inWindow).toBe(true);
  });

  it('returns false outside the 2-hour daily window', () => {
    jest.useFakeTimers();
    // 17:00 LOCAL – outside the 14:00–16:00 window
    jest.setSystemTime(new Date(2026, 5, 15, 17, 0, 0, 0));

    const svc = makeService();
    const inWindow = svc._isInScheduledWindow({ type: 'scheduled', mode: 'daily', hour: 14 });
    expect(inWindow).toBe(false);
  });

  it('returns false for weekly mode on wrong day', () => {
    jest.useFakeTimers();
    // June 15 2026 = Monday (day 1), 14:30 LOCAL
    jest.setSystemTime(new Date(2026, 5, 15, 14, 30, 0, 0));

    const svc = makeService();
    // Schedule is for Wednesday (3)
    const inWindow = svc._isInScheduledWindow({ type: 'scheduled', mode: 'weekly', dayOfWeek: 3, hour: 14 });
    expect(inWindow).toBe(false);
  });

  it('returns true for weekly mode on correct day and hour', () => {
    jest.useFakeTimers();
    // June 17 2026 = Wednesday (day 3), 14:30 LOCAL
    jest.setSystemTime(new Date(2026, 5, 17, 14, 30, 0, 0));

    const svc = makeService();
    const inWindow = svc._isInScheduledWindow({ type: 'scheduled', mode: 'weekly', dayOfWeek: 3, hour: 14 });
    expect(inWindow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _updateScheduleStatus
// ---------------------------------------------------------------------------

describe('UnifiedVideoTransferService._updateScheduleStatus', () => {
  afterEach(() => jest.useRealTimers());

  it('sets status to immediate_active when not in scheduled mode', () => {
    const svc = makeService();
    svc.isScheduledTransfer = false;
    svc._updateScheduleStatus();
    expect(svc.currentScheduleStatus).toBe('immediate_active');
  });

  it('sets status to scheduled_running when inside a scheduled window', () => {
    jest.useFakeTimers();
    // 14:30 LOCAL – inside the 14:00 daily window
    jest.setSystemTime(new Date(2026, 5, 15, 14, 30, 0, 0));

    const svc = makeService();
    svc.isScheduledTransfer = true;
    svc.scheduleConfig = { type: 'scheduled', mode: 'daily', hour: 14 };
    svc._updateScheduleStatus();

    expect(svc.currentScheduleStatus).toBe('scheduled_running');
    expect(svc.isInScheduledWindow).toBe(true);
  });

  it('sets status to scheduled_pending when outside window and computes nextScheduledRun', () => {
    jest.useFakeTimers();
    // 22:00 LOCAL – outside the 14:00 window
    jest.setSystemTime(new Date(2026, 5, 15, 22, 0, 0, 0));

    const svc = makeService();
    svc.isScheduledTransfer = true;
    svc.scheduleConfig = { type: 'scheduled', mode: 'daily', hour: 14 };
    svc._updateScheduleStatus();

    expect(svc.currentScheduleStatus).toBe('scheduled_pending');
    expect(svc.isInScheduledWindow).toBe(false);
    expect(svc.nextScheduledRun).toBeInstanceOf(Date);
    expect(svc.nextScheduledRun > new Date()).toBe(true);
  });
});

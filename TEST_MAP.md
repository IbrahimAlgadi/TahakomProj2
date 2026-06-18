# TEST_MAP.md

**Tahakom Data Transfer System** — Living test-suite map.  
_Update this file whenever a test file is added, renamed, or coverage changes significantly._

> **For AI agents**: load this file when writing new tests, checking coverage gaps, or extending the test setup.  
> Cross-reference with `PROJECT_MAP.md [TESTING]` for the summary view.

---

## Quick Reference

```bash
npm test              # Run all suites (silent, one-shot)
npm run test:watch    # Watch mode (re-runs on save)
npm run test:coverage # Coverage report (lcov + text)
```

Test results output: stdout (silent mode suppresses production `console.*`).  
Coverage output: `coverage/` directory (generated; git-ignored).

---

## Test Stack

| Component | Detail |
|---|---|
| Runner / assertions | Jest (devDependency, `^29.7.0`) |
| Module system | CommonJS (`require` / `module.exports`) — project uses Node 18.x + CommonJS |
| Config file | `jest.config.js` (workspace root) |
| Test root | `tests/` |
| Test pattern | `**/tests/**/*.test.js` |
| Excluded paths | `data_transfer_v2/`, `archived/`, `node_modules/` |
| Coverage sources | `services/**/*.js`, `utils/encryptionService.js` |
| Silent mode | `silent: true` — suppresses `console.log/warn/error` from production code during test runs |
| Mock clearing | `clearMocks: true` — resets all mock state between tests |

---

## Shared Test Helpers

### `tests/helpers/mocks.js`

Central factory file for all test suites. Import as:

```js
const { createMockPool, createMockRedis, createMockEncryption,
        sampleDriveInfo, sampleVideoQueueRow, sampleImageQueueRow } = require('../helpers/mocks');
```

| Export | Type | Returns |
|---|---|---|
| `createMockPool(defaultRows?)` | Factory | `{ query: jest.fn(), end: jest.fn() }` — mimics `pg.Pool` |
| `createMockRedis()` | Factory | `{ get: jest.fn(), set: jest.fn(), del: jest.fn(), publish: jest.fn(), subscribe: jest.fn(), quit: jest.fn() }` — mimics `ioredis` client |
| `createMockEncryption()` | Factory | All seven `encryptionService` methods as `jest.fn()` with deterministic return values |
| `sampleDriveInfo` | Fixture | `{ driveId, drivePath, name }` — valid USB drive info object |
| `sampleVideoQueueRow` | Fixture | DB row shape for `video_transfer_queue` |
| `sampleImageQueueRow` | Fixture | DB row shape for `transfer_queue` |

---

## Suite Index

### 1. `tests/video-transfer/FileTransferManager.test.js`

**Target**: `services/video-transfer/transfer/FileTransferManager.js`

| # | Test group | What is verified |
|---|---|---|
| 1–4 | `transferFile — drive checks` | Returns early when no drive / drive not ready |
| 5–8 | `transferFile — file existence` | Skips missing source; delegates to `copyWithRetry` + encryption |
| 9–12 | `copyWithRetry` | Retries on `EBUSY`, propagates other errors, succeeds on first try |
| 13–16 | `handleTransferError` | Categorises drive vs. file-not-found errors; increments retry counts |
| 17–20 | `processEncryptedVideoBatch` | AES key generation, file encryption, metadata payload shape |
| 21–22 | `markSourceFilesAsTransferred` | Delegates to `TransferUtils` with correct args |
| 23–24 | `getPendingTransferFileForJob` | SQL SELECT delegation; handles empty result |

**Mocked dependencies**: `fs-extra`, `utils.js` → `sleep`, `pg` Pool (via `createMockPool`), `encryptionService` (via `createMockEncryption`)

---

### 2. `tests/video-transfer/SpaceValidator.test.js`

**Target**: `services/video-transfer/validators/SpaceValidator.js`

| # | Test group | What is verified |
|---|---|---|
| 1–2 | `isDriveReady` | Truthy/falsy on valid vs. missing drive config |
| 3–4 | `getDriveStatus` | Returns structured status object; handles null drive |
| 5–7 | `getEstimatedProcessingSize` | Size sum across file list; empty list; partial sizes |
| 8–10 | `hasSpaceForProcessing` | True when free > estimated; false when not; handles zero free |
| 11–12 | `validateProcessingSpace` | Composite: ready + has space; fails when either is false |

**Mocked dependencies**: `config` (injected via constructor — no external mock needed)

---

### 3. `tests/video-transfer/UnifiedVideoTransferService.schedule.test.js`

**Target**: `services/video-transfer/UnifiedVideoTransferService.js` — scheduling helpers only

| # | Test group | What is verified |
|---|---|---|
| 1–4 | `_calculateNextScheduledRun` | Daily next-run when current time is before/after window; weekly next-run |
| 5–8 | `_isInScheduledWindow` | True inside window, false outside; edge cases (midnight, week boundary) |
| 9–11 | `_updateScheduleStatus` | Redis WRITE called with correct key; handles Redis error gracefully |
| 12–14 | Clock fidelity | `jest.useFakeTimers()` + local-time `new Date(y, m, d, h, …)` for timezone-safe assertions |

**Key notes**:
- Uses `jest.useFakeTimers()` / `jest.setSystemTime()` — time is controlled per test.
- Fake date is constructed as `new Date(year, monthIndex, day, hour, min, sec)` (local time), **not** as a UTC string, to match `Date.prototype.setHours()` behaviour in production code.
- Module-level mocks for `pg`, `ioredis`, `ConfigStateServiceRedis`, `monitorConnectedExternalDrives` prevent the service's top-level auto-start from opening live connections.

**Mocked dependencies**: `pg` Pool, `ioredis`, Redis state service, drive monitor service

---

### 4. `tests/image-transfer/ImageTransferManager.test.js`

**Target**: `services/image-transfer/transfer/ImageTransferManager.js`

| # | Test group | What is verified |
|---|---|---|
| 1–4 | `groupFilesIntoBatches` | Correct batch count, max batch size, empty input |
| 5–8 | `groupFilesByDirectory` | Groups by parent directory; mixed directories; single file |
| 9–12 | `processNormalImageFile` | `fs.copy` called with correct src/dest; DB update called; missing src handled |
| 13–16 | `processImageFile` | Encrypted vs. normal path selection; relative path mapping |
| 17–20 | `processEncryptedImageBatch` | Filename derivation, AES encryption, metadata payload |
| 21–23 | `copyWithRetry` | Uses `this.sleep` (injectable delay); retries on EBUSY; propagates other errors |
| 24–26 | `updateTransferStatus` | Delegates to `TransferUtils.markImageFilesAsTransferred` |
| 27–28 | `checkAndUpdateCompletedJobs` | Marks job done when all files transferred; skips partial jobs |

**Mocked dependencies**: `fs-extra`, `TransferUtils`, `pg` Pool, `encryptionService`

---

### 5. `tests/image-transfer/ImageSpaceValidator.test.js`

**Target**: `services/image-transfer/validators/ImageSpaceValidator.js`

| # | Test group | What is verified |
|---|---|---|
| 1–3 | `getFreeSpaceMB` | Converts bytes to MB; handles zero; handles no drive |
| 4–6 | `hasSpaceForFile` | True when free > file size; false otherwise; threshold buffer applied |
| 7–9 | `hasSpaceForBatch` | Sums file sizes; passes when enough room; fails when not |
| 10–11 | `isDriveNearFull` | True when free < `nearFullThresholdMB`; false otherwise |
| 12–13 | `getSpaceStatus` | Returns structured status: `{ free, total, nearFull, hasSpace }` |

**Mocked dependencies**: `systeminformation` (injected drive stats), `config`

---

### 6. `tests/shared/TransferUtils.test.js`

**Target**: `services/shared/TransferUtils.js`

| # | Test group | What is verified |
|---|---|---|
| 1–4 | `markSourceFilesAsTransferred` | SQL UPDATE called; handles empty array; handles DB error |
| 5–8 | `markUSBSourceFilesAsTransferred` | USB-specific UPDATE; multiple file IDs; SQL param binding |
| 9–12 | `markImageFilesAsTransferred` | Image UPDATE; batch IDs; empty array no-op |
| 13–16 | `handleTransferError` | Error type → `error_type` field; retry increment; max retry guard |
| 17–19 | `handleImageTransferError` | Same as above for image table |
| 20–21 | `isDriveRelatedError` | Recognises `ENOENT`, `ENOSPC`, drive-letter errors |
| 22–23 | `isFileNotFoundError` | True on `ENOENT` code; false on other errors |
| 24–25 | `formatDuration` | `ms` → `HH:MM:SS` string; sub-second rounds to `00:00:00` |
| 26–27 | `calculateImageTransferEstimate` | Estimate in seconds from file count and avg rate |
| 28–29 | `generateDestinationPath` | Path assembly from drive root + date folder + filename |
| 30 | `generateImageDestinationPath` | Image-specific path with plate/cam sub-dirs |
| 31–32 | `validateFileForTransfer` | Rejects zero-size / missing-path files; accepts valid rows |

**Mocked dependencies**: `fs-extra`, `pg` Pool (via `createMockPool`)

---

### 7. `tests/encryptionService.test.js`

**Target**: `utils/encryptionService.js`

> **This suite uses the REAL Node.js `crypto` module** — no mocks for crypto primitives.  
> Temporary files are written to `os.tmpdir()` and cleaned up after each test.

| # | Test group | What is verified |
|---|---|---|
| 1 | `generateAESKey` | Returns `{ key: Buffer(32), iv: Buffer(16) }` |
| 2–3 | `encryptDataAES` / `decryptDataAES` | Round-trip: original Buffer === decrypted Buffer |
| 4–5 | `encryptFileAES` / `decryptFileAES` | File round-trip: decrypted file matches original content |
| 6 | `generateRSAKeyPairSync` | Returns `{ publicKey, privateKey }` PEM strings |
| 7–8 | `encryptWithRSAPublicKey` / `decryptWithRSAPrivateKey` | RSA-OAEP round-trip: decrypted payload matches plaintext |

**Mocked dependencies**: none (real crypto, real filesystem via `os.tmpdir()`)

---

### 8. `tests/logger.test.js`

**Target**: `utils/logger.js`

| # | Test group | What is verified |
|---|---|---|
| 1–2 | `newTraceId` | Returns UUID v4 string; unique per call |
| 3–5 | `runWithTrace` — context access | `getTraceContext` / `getTraceId` return correct values inside scope; return empty/undefined outside scope |
| 6 | `runWithTrace` — nested contexts | Inner context does not leak to outer scope |
| 7–8 | `addTraceField` | Adds key to current store in-place; no-op outside scope |
| 9–10 | `createLogger` | Creates logger without error; injects `traceId`/`jobId` into log entries inside `runWithTrace` |
| 11 | `createLogger` — no trace | Log entries outside `runWithTrace` contain no `traceId` |
| 12–15 | `traceMiddleware` | Generates `X-Trace-Id` header; re-uses upstream `X-Trace-Id`; re-uses `X-Request-Id`; `getTraceId()` returns correct value inside `next()` |

**Mocked dependencies**: none (real Winston, real Node `async_hooks.AsyncLocalStorage`)

**Key notes**:
- Uses a temporary `Writable` stream transport to capture log entries as JSON for assertion — no filesystem writes.
- Does not use `jest.mock()` for Winston; tests exercise the real format pipeline end-to-end.
- `silent: true` in jest config suppresses the console transport output from the test logger instances.

---

## Total Test Count (as of Jun 2026)

| Suites | Tests |
|---|---|
| 8 | **155** |

Last verified run:

```
Test Suites: 8 passed, 8 total
Tests:       155 passed, 155 total
Snapshots:   0 total
Time:        ~5.8 s
```

---

## Coverage Summary (as of Jun 2026)

Run `npm run test:coverage` for the latest figures. Approximate baseline:

| File | Stmts | Branches | Funcs | Lines |
|---|---|---|---|---|
| `services/image-transfer/transfer/ImageTransferManager.js` | 89% | ~75% | 87% | 88% |
| `services/video-transfer/transfer/FileTransferManager.js` | 81% | ~68% | 77% | 81% |
| `services/video-transfer/validators/SpaceValidator.js` | 85% | ~80% | 88% | 85% |
| `services/image-transfer/validators/ImageSpaceValidator.js` | 66% | ~55% | 90% | 66% |
| `services/shared/TransferUtils.js` | 51% | ~45% | 63% | 51% |
| `utils/encryptionService.js` | 79% | ~60% | 57% | 91% |

---

## Gap Registry (Not Yet Tested)

| # | Item | Type | Priority | Notes |
|---|---|---|---|---|
| G-1 | `services/image-transfer/transfer/FtpImageTransferManager.js` | Unit | Medium | FTP file upload + retry logic |
| G-2 | `services/video-transfer/transfer/FtpTransferManager.js` | Unit | Medium | FTP video upload |
| G-3 | `services/video-transfer/state/JobManager.js` | Unit | Medium | Camera-batch selection, buffer state |
| G-4 | `services/video-transfer/state/CompleteBufferManager.js` | Unit | Medium | 38-file-per-camera buffer accumulation |
| G-5 | `services/video-transfer/state/ProcessingStateManager.js` | Unit | Low | In-memory state; lightweight |
| G-6 | `services/image-transfer/state/ImageJobManager.js` | Unit | Medium | Image batch selection and enqueueing |
| G-7 | `services/image-transfer/state/FtpImageJobManager.js` | Unit | Low | FTP image batch selection |
| G-8 | `services/shared/CleanupService.js` | Unit | Low | Post-transfer queue cleanup |
| G-9 | `routes/autoTransferRoutes.js` and all other route files | Integration | Low | Requires Express `supertest` harness |
| G-10 | `TransferUtils.js` — uncovered branches | Unit | Low | Branch coverage currently ~45%; add edge cases |
| G-11 | SecurOS scripts | Unit | None | Cannot run without SecurOS runtime injection (see T-5b) |

---

## Mocking Strategy

### Principle
Mock only **external I/O boundaries** (filesystem, DB, Redis, encryption). Pure logic
(calculations, string transforms, branching) runs against real code.

### Module-level mocking pattern

```js
jest.mock('fs-extra');           // Mocks the entire fs-extra module
jest.mock('../../helpers/mocks', () => ({ ... }));   // Factory override

beforeEach(() => {
  pool = createMockPool([{ id: 1, ... }]);
  manager = new ImageTransferManager({ pool, encryption });
});
```

### Fake timers (scheduling tests)

```js
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

// Always use local Date constructor — NOT UTC strings — to match
// Date.prototype.setHours() used in production scheduling code
jest.setSystemTime(new Date(2026, 0, 15, 10, 0, 0));   // Jan 15 2026, 10:00 local
```

### Real crypto (encryptionService tests)

No mocks for `crypto` primitives. Files written to `os.tmpdir()`:

```js
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enc-test-'));
// cleanup in afterEach
```

---

## Adding New Tests

1. Create `tests/<domain>/<ClassName>.test.js`.
2. Import shared factories from `tests/helpers/mocks.js`.
3. Add `jest.mock(...)` for all external I/O at the top of the file.
4. Group tests with `describe` + `it` (no `test()` shorthand — project style).
5. Update this file: add a row to the Suite Index and Gap Registry.
6. Update `PROJECT_MAP.md [TESTING]` total count.

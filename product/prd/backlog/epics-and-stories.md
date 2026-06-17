# Epics & User Stories

**Tahakom Data Transfer System**  
Last updated: 2026-06-17

> Stories are organized under epics mapped to Roadmap milestones (see [../../../product/roadmap/roadmap.md](../../roadmap/roadmap.md)).  
> Each story follows the Gherkin acceptance criteria format for testability.

---

## Epic E1 — Observability Hardening (Roadmap M1)

**Hypothesis**: If operators can see capture health and transfer status on the dashboard without SSH access, they will detect and resolve incidents 80% faster.

**Success metric**: All incidents visible in dashboard within 5 minutes of occurrence.

---

### Story E1-S1: Stuck Export KPI Card

**As a** site operator,  
**I want** to see a count of images that have been exported but whose file_size is still 0 (stuck exports),  
**so that** I can detect camera or exporter failures before they accumulate.

**Acceptance Criteria**:

```gherkin
Given the dashboard is open
When the data loads
Then I see a "Stuck Exports" card showing the count of files WHERE file_size = 0 AND deleted = false AND image_export_done_date_time IS NULL

Given stuck exports count is 0
Then the card displays green / success state

Given stuck exports count is > 0
Then the card displays amber / warning state

Given stuck exports count is > 10
Then the card displays red / critical state
```

---

### Story E1-S2: Retry Backlog Summary

**As a** site operator,  
**I want** to see how many files have been retried and how many have been permanently deleted due to max retries,  
**so that** I can identify recurring camera/exporter problems.

**Acceptance Criteria**:

```gherkin
Given the dashboard data loads
Then I see a "Retry Backlog" metric showing count of files WHERE export_retry_count > 0 AND deleted = false

And I see a "Permanently Failed" metric showing count of files WHERE deleted = true AND export_retry_count > 0

Given a file has been retried 3+ times
Then it appears in the retry backlog with its plate number, camera ID, and retry count visible on drill-down
```

---

### Story E1-S3: Service Restart History

**As a** site operator,  
**I want** to see when PM2 services were last restarted by the ClusterStatusMonitorScript,  
**so that** I know if any service has been crashing repeatedly.

**Acceptance Criteria**:

```gherkin
Given the Process Monitor page is open
When ClusterStatusMonitorScript has triggered a restart in the last 24 hours
Then I see the service name, restart time, and reason in the process history panel

Given no restarts have occurred
Then the panel shows "No restarts in last 24 hours"
```

---

## Epic E2 — Database Reliability (Roadmap M2)

**Hypothesis**: Enabling the commented-out `files` table indexes and moving runtime schema alterations to the migration will eliminate query latency spikes and prevent startup-time race conditions.

**Success metric**: P95 query latency for `ImageJobManager.selectEligibleFiles()` < 100ms at 10,000+ rows.

---

### Story E2-S1: Enable files Table Indexes

**As a** backend engineer,  
**I want** the `idx_files_ts` and `idx_files_grouping` indexes to be active in the migration,  
**so that** transfer service queries that filter by `ts`, `deleted`, and `file_size` use index scans instead of sequential scans.

**Acceptance Criteria**:

```gherkin
Given DatabaseMigration.js is run on a fresh database
Then the files table has active indexes: idx_files_ts and idx_files_grouping

Given the autoUSBImageTransferService runs a selectEligibleFiles() query
When the files table has > 10,000 rows
Then EXPLAIN ANALYZE shows Index Scan (not Seq Scan) on the relevant index
```

---

### Story E2-S2: Move Runtime Schema Alterations to Migration

**As a** backend engineer,  
**I want** the `pending_deletion` and `updated_at` columns and their trigger to be defined in `DatabaseMigration.js`,  
**so that** `ExportDirectoryControlV3.js` does not need to ALTER TABLE on startup.

**Acceptance Criteria**:

```gherkin
Given DatabaseMigration.js is run
Then the files table includes columns: pending_deletion BOOLEAN DEFAULT FALSE, updated_at TIMESTAMP DEFAULT NOW()
And the update trigger for updated_at is active

Given ExportDirectoryControlV3.js starts
Then it does not issue any ALTER TABLE commands
And it logs "Schema already up to date" on startup
```

---

## Epic E3 — FTP Transfer Reliability (Roadmap M3)

**Hypothesis**: Configuring and validating FTP credentials will activate the FTP transfer path, enabling remote archival without physical USB swaps.

**Success metric**: 100% of eligible images uploaded to FTP within 1 hour of capture.

---

### Story E3-S1: Configure FTP Transfer

**As a** system administrator,  
**I want** to configure FTP credentials through the dashboard config editor,  
**so that** the FTP transfer services activate without editing JSON files manually.

**Acceptance Criteria**:

```gherkin
Given I open the Config page on the dashboard
When I fill in host, port, username, password, remoteDirectory for ftpTransfer
And I click Save
Then dataTransferConfig.json is updated with the new FTP credentials
And ConfigStateServiceRedis publishes the change
And autoFTPImageTransferService and autoFtpVideoTransferService pick up the new config within 30 seconds
```

---

### Story E3-S2: FTP Transfer Dashboard Card

**As a** site operator,  
**I want** to see FTP transfer queue status (pending, transferred, failed) on the dashboard,  
**so that** I know if FTP uploads are healthy or backed up.

**Acceptance Criteria**:

```gherkin
Given the dashboard loads
Then I see an FTP Transfer card showing:
  - Images pending FTP transfer
  - Images successfully FTP transferred today
  - Images with FTP transfer errors

Given FTP transfer fails for any file
Then the failed count increments in the dashboard card
And the error message from ftp_image_transfer_queue is accessible on drill-down
```

---

## Epic E4 — Audit & Reporting (Roadmap M4)

**Hypothesis**: Exportable daily/weekly reports will reduce the time operators spend manually compiling transfer summaries.

**Success metric**: Dashboard PDF export generates a complete daily summary in < 5 seconds.

---

### Story E4-S1: Daily PDF Report Export

**As a** site operator,  
**I want** to export a PDF report from the dashboard showing today's plate captures, transfer counts, and storage usage,  
**so that** I can share it with supervisors without copying data manually.

**Acceptance Criteria**:

```gherkin
Given I am on the Dashboard page
When I click "Export PDF"
Then a PDF is generated containing:
  - Total plates captured today
  - Images successfully exported (file_size > 0)
  - Images transferred to USB (is_auto_transferred = true)
  - Images transferred to FTP (is_ftp_transferred = true)
  - Current storage used / total capacity
  - Date range and site ID in the header
And the file downloads to my browser within 5 seconds
```

---

### Story E4-S2: Per-Camera Breakdown in Dashboard

**As a** site operator,  
**I want** to see capture and transfer counts broken down by camera ID,  
**so that** I can quickly identify if a specific camera is failing to export.

**Acceptance Criteria**:

```gherkin
Given the Dashboard page loads
When data is fetched from /dashboard/data
Then I see a table or chart showing:
  - Camera ID
  - Total captures today
  - Successfully exported (file_size > 0)
  - Transferred to USB
  - Stuck (file_size = 0)
For each camera ID in the files table for today's date
```

---

## Epic E5 — SecurOS Script Hardening (Roadmap M5, Deferred)

**Hypothesis**: Better error handling and a mock harness will reduce production incidents caused by uncaught exceptions in SecurOS scripts.

**Success metric**: Zero unhandled exceptions in SecurOS logs for 30 consecutive days after hardening.

---

### Story E5-S1: DB Connection Retry in OptimizedImageCapture.js

**As a** backend engineer,  
**I want** `OptimizedImageCapture.js` to retry DB connections with exponential backoff when PostgreSQL is temporarily unavailable,  
**so that** a brief DB restart does not result in lost capture records.

**Acceptance Criteria**:

```gherkin
Given OptimizedImageCapture.js receives CAR_LP_RECOGNIZED
When the DB connection fails on INSERT
Then it retries up to 3 times with 500ms, 1000ms, 2000ms delays
And it logs each retry attempt with the error message
And if all retries fail, it logs a CRITICAL error with the plate, cam_id, and timestamp
```

---

### Story E5-S2: Extract retry log to dedicated table

**As a** backend engineer,  
**I want** `export_retry_log_object` to be stored in a dedicated `export_retry_log` table instead of as inline JSONB on `files`,  
**so that** the files table does not accumulate JSONB bloat at high plate volume.

**Acceptance Criteria**:

```gherkin
Given a new migration is run
Then a table export_retry_log exists with columns:
  id, file_id (FK → files.id), retry_on, image_export_id,
  retry_count, comment, created_at

Given Image Export Errors.js processes a EXPORT_FAILED event
Then it inserts a row into export_retry_log instead of appending to files.export_retry_log_object

Given a file is queried for its retry history
Then JOINing files with export_retry_log returns the full history
```

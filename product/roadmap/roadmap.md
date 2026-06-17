# Product Roadmap

**Tahakom Data Transfer System**  
Last updated: 2026-06-17

> Milestones below are ordered by priority and dependency. Each has a Verifiable Goal (VG) — a pass/fail test confirming it is done.

---

## Baseline State (As-Built, June 2026)

The core capture→export→transfer pipeline is operational. The following are confirmed working:

- SecurOS ALPR → `OptimizedImageCapture.js` → `files` table
- Export lifecycle (success, error, retry, fixer)
- Retention + FIFO governance (`ExportDirectoryControlV3.js`)
- USB image transfer (`autoUSBImageTransferService`)
- USB video transfer (`autoVideoTransferEDAMicroservice`)
- Dashboard reporting (`DashboardReportingBackend`, port 8454)
- PM2 health watchdog (`ClusterStatusMonitorScript.js`)

---

## Open Items (Blocking or Degraded State)

| ID | Item | Priority | Blocking |
|---|---|---|---|
| O-1 | SecurOS log paths not registered | High | engineering-ops-agent cannot tail securos logs |
| O-2 | `auto` DB content unknown | Medium | architecture-data-agent cannot advise on securos_auto MCP usage |
| O-3 | FTP credentials not configured | Medium | FTP image + video transfer inactive |
| O-4 | `DriveStateServiceRedis.js` existence unconfirmed | High | Dependency graph may have a broken reference |
| O-5 | Production `retentionDays` + `maxCapacity` values unknown | High | Cannot validate disk governance is correctly tuned |

---

## Milestone Plan

### M0 — Configuration Hygiene (Immediate)

**Goal**: Eliminate the five open items that degrade or block system visibility and operation.

| VG | Task | Owner |
|---|---|---|
| VG-0.1: FTP transfer service starts and uploads a test file | Configure `ftpTransfer` in `dataTransferConfig.json` (host, port, user, password, remoteDirectory) | Site Admin |
| VG-0.2: `DriveStateServiceRedis.js` confirmed present or dependency graph corrected in `ecosystem.config.js` | Verify file existence; if missing, remove or stub the dependency | Engineering |
| VG-0.3: SecurOS log registry filled in | Fill `<<PROVIDE_LOG_PATH>>` entries in `.cursor/skills/securos-log-registry/SKILL.md` | Site Operator |
| VG-0.4: Production retention values documented | Update `PROJECT_MAP.md` O-5 with confirmed `retentionDays` and `maxCapacity` | Site Admin |

---

### M1 — Observability Hardening

**Goal**: Operators can detect problems in under 5 minutes without SSH/RDP access.

| VG | Task | Owner |
|---|---|---|
| VG-1.1: Dashboard shows count of stuck exports (file_size=0, image_export_done_date_time IS NULL) | Add "Stuck Exports" KPI card to dashboard via `/dashboard/data` endpoint | Engineering |
| VG-1.2: Dashboard shows active retry backlog | Add retry backlog summary to dashboard (query `export_retry_count > 0`) | Engineering |
| VG-1.3: Alert email or PM2 metric fires when stuck exports exceed a threshold | Implement threshold alerting in `ExportDirectoryControlV3.js` or a new monitor | Engineering |
| VG-1.4: `ClusterStatusMonitorScript.js` restart events are visible in dashboard | Expose PM2 restart event history on the process monitor page | Engineering |

---

### M2 — Database Reliability

**Goal**: Eliminate known technical debt that could cause performance degradation at scale.

| VG | Task | Owner |
|---|---|---|
| VG-2.1: `files` table indexes active and tested | Enable `idx_files_ts` and `idx_files_grouping` in `DatabaseMigration.js`; run EXPLAIN ANALYZE on transfer service queries | Engineering |
| VG-2.2: `pending_deletion` + `updated_at` in migration | Move runtime `ALTER TABLE` from `ExportDirectoryControlV3.js` to `DatabaseMigration.js` | Engineering |
| VG-2.3: Baseline query latency documented | Instrument and log P95 latency for `ImageJobManager.selectEligibleFiles()` | Engineering |

---

### M3 — FTP Transfer Reliability

**Goal**: FTP image and video transfers are stable and monitored.

| VG | Task | Owner |
|---|---|---|
| VG-3.1: FTP image transfer completes 100 files without error | Configure credentials (M0-O-3) and run `autoFTPImageTransferService` in production | Engineering |
| VG-3.2: FTP video transfer completes one camera's segments | Configure and test `autoFtpVideoTransferService` | Engineering |
| VG-3.3: FTP transfer errors visible in dashboard | Add FTP queue error count to dashboard | Engineering |

---

### M4 — Audit & Reporting Improvements

**Goal**: Operations can export and share daily/weekly transfer reports.

| VG | Task | Owner |
|---|---|---|
| VG-4.1: Dashboard exports PDF report with daily capture + transfer summary | Implement PDF export via existing pdfkit dependency | Engineering |
| VG-4.2: Per-camera capture breakdown visible in dashboard | Add camera-level grouping to `/dashboard/data` | Engineering |
| VG-4.3: Transfer history page shows completed jobs with file counts and sizes | Add transfer job history query to `routes/autoTransferRoutes.js` | Engineering |

---

### M5 — SecurOS Script Hardening (Deferred)

**Goal**: SecurOS scripts are more resilient and testable.

| VG | Task | Owner | Deferred until |
|---|---|---|---|
| VG-5.1: DB connection pool errors in SecurOS scripts are handled with exponential backoff | Update `OptimizedImageCapture.js` DB connection logic | Engineering | After M1 observability |
| VG-5.2: `export_retry_log_object` extracted to a dedicated `export_retry_log` table | Migration + script update | Engineering | After M2 |
| VG-5.3: A mock SecurOS runtime harness exists for unit testing scripts | Build a minimal `securos` module mock for local testing | Engineering | After M3 |

---

## Out of Scope (Rejected for this system)

- Cloud storage (S3, Azure Blob) — no current requirement
- Multi-site aggregation UI — `site_id` field exists but no multi-site product requirement
- Mobile dashboard — LAN-only deployment
- Automated SecurOS script deployment — manual copy is the required workflow

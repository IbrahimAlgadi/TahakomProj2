# PRD: Tahakom Data Transfer System

**Version**: 1.0  
**Status**: Accepted  
**Date**: 2026-06-17  
**Owner**: Engineering / Operations Team  

> This is a retrospective PRD capturing the as-built system. It serves as the authoritative reference for product decisions, scope, and success criteria. Use it to evaluate future enhancements against the original intent.

---

## 1. Executive Summary

The Tahakom Data Transfer System is the operational middleware between the ISS SecurOS ALPR platform and downstream data recipients (USB drives, FTP servers). SecurOS cameras recognize vehicle license plates 24/7; this system captures the resulting images, stores them reliably in PostgreSQL, enforces disk retention, distributes files to USB drives and FTP endpoints, and provides an operations dashboard for monitoring and manual control.

The core problem: ALPR-generated images and ISS NVR video segments need to reliably leave the capture server and reach portable media (USB) or remote storage (FTP) while maintaining a complete audit trail, enforcing disk capacity limits, and giving operators real-time visibility into transfer health.

---

## 2. Problem Statement

### Who has this problem?

Site operators and system administrators managing an ISS SecurOS ALPR deployment at Tahakom facilities. They are technically capable but not software developers; they need a reliable, self-healing system that requires minimal daily intervention.

### What is the problem?

1. **Image delivery reliability**: SecurOS image exports fail silently or partially. Without a retry mechanism and audit trail, images are lost with no visibility.
2. **Disk capacity management**: ALPR systems generate images continuously. Without automatic retention and capacity enforcement, disks fill up and SecurOS stops writing.
3. **Distribution**: Images and video segments need to reach USB drives (for physical transport) and FTP servers (for remote archival). Manual copying is error-prone and slow.
4. **Operational visibility**: Operators have no centralized view of how many files have been captured, how many are stuck, how much disk space remains, or whether transfer services are healthy.

### Why is it painful?

- A single failed IMAGE_EXPORT event leaves a `file_size=0` row in the DB — images are silently missing from downstream systems.
- Disk overflow causes SecurOS to stop writing new images — a critical operational failure.
- Manual USB copying at shift-end is time-consuming and leaves an incomplete audit trail.
- No dashboard means operators discover problems via complaints, not proactive monitoring.

### Evidence

- System design: SecurOS script architecture explicitly models failure paths (retry logic, Export Fixer, soft deletes).
- Config: `maxCapacity: 1000` and retention settings in `dataTransferConfig.json` directly address disk overflow.
- Transfer queue schema: `export_retry_count`, `export_retry_log_object` columns record every failure event for audit.

---

## 3. Target Users & Personas

### Primary: Site Operator

- **Role**: Manages the ALPR system day-to-day; monitors capture rates, handles physical USB swaps
- **Technical level**: Moderate — comfortable with Windows, SecurOS UI; not a developer
- **Goals**: Know that images are being captured and transferred without manual intervention; be alerted to failures before they become critical
- **Pain points**: Silent failures, full disks, needing to ssh/RDP into server to check if services are running
- **Uses**: Dashboard (monitoring), manual transfer UI (ad-hoc USB exports), process monitor

### Secondary: System Administrator

- **Role**: Configures the system, applies updates, manages credentials and certificates
- **Technical level**: High — manages Windows Server, PostgreSQL, PM2, SSL certs
- **Goals**: Deploy updates with minimal downtime; understand service dependencies; audit configuration changes
- **Uses**: `dataTransferConfig.json`, `ecosystem.config.js`, database migration scripts, ADRs

---

## 4. Strategic Context

### Business Goals

1. **Zero image loss**: Every recognized plate event must have a successfully exported image or an explicit, logged deletion reason.
2. **Continuous operation**: System must self-heal (retry, restart, capacity cleanup) without operator intervention for routine operations.
3. **Complete audit trail**: Every file, every transfer attempt, every failure is recorded in PostgreSQL for forensic retrieval.
4. **Multi-channel distribution**: Support both physical (USB) and network (FTP) export without reconfiguration of the capture layer.

### Why This Architecture

- SecurOS scripts must run inside SecurOS's runtime (injected `securos` module) — they cannot be Node.js services. This creates the two-boundary design (SecurOS scripts + PM2 services).
- PostgreSQL is the integration point between the two boundaries: SecurOS scripts write, PM2 services read.
- Redis decouples real-time state propagation (config changes, drive events) from database polling.

---

## 5. Solution Overview

### Image Capture & Export Lifecycle

1. SecurOS ALPR fires `CAR_LP_RECOGNIZED` → `OptimizedImageCapture.js` creates the target directory and inserts a `files` row with `file_size=0`.
2. `IMAGE_EXPORT` is dispatched to the least-busy exporter (load balanced).
3. On `EXPORT_DONE`: `ImageExportSuccessOptimized.js` stamps `file_size` and `image_export_done_date_time`.
4. On `EXPORT_FAILED`: `Image Export Errors.js` retries up to max retries; on exhaustion, soft-deletes the row.
5. `Export Fixer Microservice.js` runs periodically to catch any exports where neither event fired.
6. `ExportDirectoryControlV3.js` runs continuously to enforce `retentionDays` and `maxCapacity` FIFO limits.

### Transfer

- `autoUSBImageTransferService` picks up `files` with `file_size > 0` and `is_auto_transferred = false` and copies them to the configured USB drive.
- `autoFTPImageTransferService` does the same for FTP upload.
- Video: `monitorISSMediaFilesOptimizedMicroservice` indexes ISS NVR segments → `autoVideoTransferEDAMicroservice` (USB) and `autoFtpVideoTransferService` (FTP) transfer them.

### Dashboard

`DashboardReportingBackend` on port 8454 provides:
- File/transfer statistics with ECharts visualizations
- Real-time service process monitor
- Connected USB drive status
- Manual transfer job creation
- System configuration editor

---

## 6. Success Metrics

### Primary Metric

**Image capture completeness rate** = `(files with file_size > 0) / (total files inserted)` per day.  
- Current: unknown (no baseline instrumentation)
- Target: ≥ 99.5%

### Secondary Metrics

| Metric | Target |
|---|---|
| Export retry rate | < 5% of files require a retry |
| USB transfer lag | < 30 minutes between image capture and USB transfer |
| Disk utilization | Stays below `maxCapacity` setting — zero over-capacity events |
| Service uptime | All PM2 processes online > 99.9% of time |
| Dashboard load time | < 2 seconds on LAN |

### Guardrail Metrics

- Zero unintentional permanent deletions (deleted files always have an explicit `deleted_date_time` and reason in `export_retry_log_object`)
- FTP transfer success rate must not degrade USB transfer throughput

---

## 7. Key Features & Requirements

### FR-1: Reliable Image Export

- Every `CAR_LP_RECOGNIZED` event must result in either a completed file (`file_size > 0`) or an explicit soft delete with a logged reason.
- Max retries configurable; each retry logged in `export_retry_log_object` JSONB.
- Export Fixer safety net catches events missed by the primary retry handler.

### FR-2: Automatic Disk Governance

- `ExportDirectoryControlV3.js` enforces `retentionDays` (age-based) and `maxCapacity` (FIFO capacity).
- Deletion is always soft-delete-first (`pending_deletion=true`) before physical removal.
- Root directories listed in `preserveRootDirs` are never deleted.

### FR-3: Automatic USB Image Transfer

- Transfer runs automatically when a USB drive is connected.
- Files are queued in `transfer_queue_job` / `transfer_queue` for atomic progress tracking.
- Interrupted transfers can resume from the last successful queue item.

### FR-4: FTP Image and Video Upload

- Both images and video segments support FTP/FTPS upload.
- FTP credentials are stored in `dataTransferConfig.json` (currently empty — pending configuration, see O-3 in PROJECT_MAP.md).

### FR-5: Operator Dashboard

- Real-time capture and transfer statistics.
- Service health monitor (PM2 process states).
- Manual transfer job creation (by date range, plate filter, USB path).
- Config editor for live reconfiguration without server restart.

### FR-6: Encryption

- Optional AES-256-CBC file encryption on USB transfers.
- RSA-encrypted AES key per file.
- Metadata encryption when enabled.

---

## 8. Out of Scope

| Item | Reason |
|---|---|
| Cloud storage (S3, Azure Blob) | Not in current requirements; FTP covers remote transfer |
| Real-time plate search API | Dashboard is for operations, not search — separate system concern |
| SecurOS configuration management | SecurOS is a separate product; we only react to its events |
| Mobile app / remote dashboard | LAN-only deployment by design |
| Automated SecurOS script deployment | Scripts require manual copy to SecurOS machine (runtime dependency on injected `securos` module) |
| Multi-site aggregation | Single-site deployment; `site_id` is a field but no multi-site UI exists |

---

## 9. Dependencies & Risks

### Dependencies

| Dependency | Type | Risk if unavailable |
|---|---|---|
| ISS SecurOS (ALPR engine) | External system | Entire capture pipeline stops |
| PostgreSQL localhost:5432 | Infrastructure | All services fail; data loss risk |
| Redis localhost | Infrastructure | Config/state propagation fails; services run on stale config |
| PM2 (bundled with SecurOS Node) | Runtime | Service restart/monitoring fails |
| USB drive (for USB transfer) | Physical hardware | USB transfer cannot proceed |
| FTP server (for FTP transfer) | External system | FTP transfer cannot proceed |

### Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Disk full before ExportDirectoryControl runs cleanup | Medium | High — SecurOS stops writing | Tune `maxCapacity` conservatively; monitor disk via dashboard |
| Export retry exhaustion (camera down) | Medium | Medium — images lost | Review `export_retry_log_object` daily; alert on high retry counts |
| PostgreSQL connection pool exhaustion | Low | High — all services fail | Monitor active connections; add PgBouncer if needed |
| SecurOS script update causes regression | Low | High — capture stops | Test in staging SecurOS environment before deploying |
| FTP credentials not configured | **Current** | Medium — FTP transfer inactive | O-3: Configure `ftpTransfer` in `dataTransferConfig.json` |

---

## 10. Open Questions

| # | Question | Status |
|---|---|---|
| Q-1 | What are the production values for `retentionDays` and `maxCapacity`? | Open — see O-5 in PROJECT_MAP.md |
| Q-2 | What does the `auto` / `securos_auto` database contain? | Open — see O-2 in PROJECT_MAP.md |
| Q-3 | Is the legacy `transfer_job` / `transfer_job_log` flow still actively used? | Open — assess whether to deprecate in favor of `transfer_queue_job` |
| Q-4 | Should the ALPR system support multi-site aggregation in future? | Deferred — `site_id` field is present but no multi-site UI exists |
| Q-5 | What is the expected daily plate recognition volume? | Unknown — needed for capacity planning and index tuning (T-1) |

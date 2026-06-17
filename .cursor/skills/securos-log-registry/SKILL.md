# SecurOS Log Registry

## Purpose

This skill is used exclusively by the **engineering-ops-agent** when operating in **SecurOS mode**.

It provides:
1. A **fill-in log path registry** — one entry per SecurOS script, each pointing to its on-disk log file on the SecurOS machine.
2. **Instructions for reading and tailing logs** in this Windows environment.
3. **Inspection guidance** — what to look for in each script's log for health, errors, and retry patterns.

---

## Log Directory

All SecurOS script logs are located at:

```
C:\ProgramData\ISS\logs\
```

The log files follow the `nodejs.<N>.console.log` pattern where `N` is the SecurOS node instance number. The full registry is filled in below. The engineering-ops-agent can use the Read tool (for batch inspection) or the PowerShell tail command (for live monitoring) described in the next section.

---

## Log Path Registry

All SecurOS script logs are written to `C:\ProgramData\ISS\logs\` using the `nodejs.<N>.console.log` naming convention, where `N` is the SecurOS node instance number assigned to each script.

> **Shared log file**: `ClusterStatusMonitorScript.js` shares `nodejs.1.console.log` with no other named script. `OptimizedImageCapture.js` uses `nodejs.2.console.log` exclusively. When tailing a shared or high-volume log, use `Select-String` to filter by script-specific log markers.

| SecurOS Script | Purpose | Log Path |
|---|---|---|
| `ClusterStatusMonitorScript.js` | PM2 health check every 10 min; restarts ecosystem apps | `C:\ProgramData\ISS\logs\nodejs.1.console.log` |
| `OptimizedImageCapture.js` | Core ALPR capture; INSERT into `files` | `C:\ProgramData\ISS\logs\nodejs.2.console.log` |
| `ImageExportSuccessOptimized.js` | Stamps `file_size` and `image_export_done_date_time` on successful export | `C:\ProgramData\ISS\logs\nodejs.3.console.log` |
| `Image Export Errors.js` | Retry logic + soft delete on max retries | `C:\ProgramData\ISS\logs\nodejs.4.console.log` |
| `ExportDirectoryControlV3.js` | Retention + FIFO capacity governance | `C:\ProgramData\ISS\logs\nodejs.5.console.log` |
| `Export Fixer Microservice.js` | Periodic safety net; re-exports stale `file_size=0` rows | `C:\ProgramData\ISS\logs\nodejs.6.console.log` |

### PM2 Service Logs (written to the app `logs/` directory)

These are on the local machine — paths are from `ecosystem.config.js`. Replace the prefix if the app was installed somewhere other than the workspace root.

| PM2 Service | Out log | Error log |
|---|---|---|
| ConfigStateServiceRedis | `<APP_ROOT>\logs\ConfigStateServiceRedis-out.log` | `<APP_ROOT>\logs\ConfigStateServiceRedis-error.log` |
| monitorConnectedExternalDrivesMicroservice | `<APP_ROOT>\logs\monitorConnectedExternalDrivesMicroservice-out.log` | `<APP_ROOT>\logs\monitorConnectedExternalDrivesMicroservice-error.log` |
| monitorSpecialProcessesMicroservice | `<APP_ROOT>\logs\monitorSpecialProcessesMicroservice-out.log` | `<APP_ROOT>\logs\monitorSpecialProcessesMicroservice-error.log` |
| monitorISSMediaFilesOptimizedMicroservice | `<APP_ROOT>\logs\monitorISSMediaFilesOptimizedMicroservice-out.log` | `<APP_ROOT>\logs\monitorISSMediaFilesOptimizedMicroservice-error.log` |
| autoVideoTransferEDAMicroservice | `<APP_ROOT>\logs\refactored_autoVideoTransferEDAMicroservice-out.log` | `<APP_ROOT>\logs\refactored_autoVideoTransferEDAMicroservice-error.log` |
| autoFtpVideoTransferService | `<APP_ROOT>\logs\autoFtpVideoTransferService-out.log` | `<APP_ROOT>\logs\autoFtpVideoTransferService-error.log` |
| autoUSBImageTransferService | `<APP_ROOT>\logs\autoUSBImageTransferService-out.log` | `<APP_ROOT>\logs\autoUSBImageTransferService-error.log` |
| autoFTPImageTransferService | `<APP_ROOT>\logs\autoFTPImageTransferService-out.log` | `<APP_ROOT>\logs\autoFTPImageTransferService-error.log` |
| DashboardReportingBackend | `<APP_ROOT>\logs\DashboardReportingBackend-out.log` | `<APP_ROOT>\logs\DashboardReportingBackend-error.log` |

> Replace `<APP_ROOT>` with the actual app installation path, e.g.  
> `d:\ISS\SA\6_Tahakom\TahakomDataTransfer2026\VideoTransferApp\VideoTransferApp\app`

---

## How to Read and Tail Logs (Windows / PowerShell)

### Read last N lines (static snapshot)

Use the **Read tool** with the absolute path for full-file inspection, or run:

```powershell
Get-Content -Path "C:\path\to\script.log" -Tail 200
```

### Live tail (follow mode — blocks until stopped)

```powershell
Get-Content -Path "C:\path\to\script.log" -Tail 50 -Wait
```

> Use the Shell tool with `block_until_ms: 0` to background this command if live monitoring is needed during a session.

### Search for errors in a log

```powershell
Select-String -Path "C:\path\to\script.log" -Pattern "ERROR|FAILED|retry" -CaseSensitive:$false
```

### Search across all PM2 logs for a plate number

```powershell
Select-String -Path "<APP_ROOT>\logs\*-out.log" -Pattern "ABC123" -CaseSensitive:$false
```

---

## What to Look For (Per Script)

### `OptimizedImageCapture.js`
- Confirm INSERT statements are succeeding.
- Look for DB connection errors (pool exhaustion, ECONNREFUSED).
- Watch for `IMAGE_EXPORT` dispatch failures.
- Healthy pattern: `[INFO] Plate ABC123 — inserted file_id=N, dispatched EXPORT to IMAGE_EXPORT_1`.

### `ImageExportSuccessOptimized.js`
- Confirm batch UPDATE counts: `Updated N rows with file_size`.
- Watch for `0 rows updated` (export success received but no matching DB row — `tid` mismatch).
- Healthy pattern: `[INFO] Batch update: 3 rows stamped`.

### `Image Export Errors.js`
- Track retry counts per plate/cam.
- Alert if `export_retry_count >= MAX_RETRIES` (file marked deleted).
- Look for `Image obtain error` — indicates camera issue, not retry-able.
- Healthy pattern: `[WARN] Retry 1/3 for tid=X`. Alert: `[ERROR] Max retries reached — marking deleted`.

### `Export Fixer Microservice.js`
- Should run quietly if exports are healthy.
- Alert if it finds many stale rows repeatedly (indicates EXPORT_DONE events are not firing).
- Look for: `Found N stale rows, re-dispatching`.

### `ExportDirectoryControlV3.js`
- Confirm capacity and retention cycles complete without error.
- Watch for filesystem errors (disk full, path not found, permission denied).
- Alert if `pending_deletion` rows pile up without being cleared.

### `ClusterStatusMonitorScript.js`
- Alert if any `pm2 restart` is triggered (means a service crashed).
- Look for: `All N processes online` (healthy) vs `Restarting ecosystem` (alert).

---

## Agent Constraints (SecurOS Mode)

When operating on SecurOS scripts, the engineering-ops-agent **must** follow these rules:

1. **Read DB via MCP only** — use `postgresql-tahakom_transfer-mcp` for SELECT queries only. Never run destructive SQL (UPDATE, DELETE, DROP) via MCP.
2. **Edit scripts in repo** — changes to `securos-scripts/` are made in the local repo at `securos-scripts/<script-name>.js`. The user copies the updated file to the SecurOS machine manually. The agent never deploys or runs scripts on SecurOS.
3. **Provide handoff instructions** — after editing a SecurOS script, always tell the user: which file changed, what the change does, and the exact steps to deploy it to SecurOS (stop old script in SecurOS UI → replace file → reload script in SecurOS UI).
4. **No `node script.js` execution** — SecurOS scripts require the injected `securos` module; running them outside the SecurOS runtime will fail immediately. Never attempt it.
5. **Log paths are external** — SecurOS logs are on the SecurOS machine, not in this repository. Reference them by their registered absolute paths. Use the Read tool for inspection (if accessible) or ask the user to paste relevant excerpts.

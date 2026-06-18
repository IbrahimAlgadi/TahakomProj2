# Database Migration Runbook

**Schema source**: `scripts/migration/DatabaseMigration.js`  
Last updated: 2026-06-18

> The migration script is the **single authoritative source** for the `tahakom_transfer` database schema.  
> Run it once on a fresh server or to wipe-and-reset a dev/staging database.

---

## Control Flags

At the top of `DatabaseMigration.js`:

```js
const CREATE_DB   = true;   // Create the tahakom_transfer database if it does not exist
const DROP_SCHEMA = true;   // Drop all objects before recreating — set false to skip drop phase
```

| Scenario | `CREATE_DB` | `DROP_SCHEMA` |
|---|---|---|
| First-time production setup | `true` | `true` |
| Wipe + rebuild dev/staging | `true` (or `false`) | `true` |
| Apply only new objects to existing schema (rare) | `false` | `false` |

> **Warning**: `DROP_SCHEMA = true` permanently deletes all data. Never run with `DROP_SCHEMA = true` on a live production DB with data you want to keep.

---

## How to Run

```bash
cd scripts/migration
node DatabaseMigration.js
```

Expected output:

```
🏗️  Creating database...
Database created.
🔐 Granting privileges...
   ✅ All privileges granted successfully
🗑️  Dropping existing schema...
   🔄 Dropping triggers and functions...
   🔄 Dropping tables in dependency order...
   ✅ All tables and functions dropped successfully
✅ Schema dropped successfully
🏗️  Creating tables...
   ✅ All tables, indexes, and functions created successfully
✅ Tables created successfully
```

---

## What the Migration Creates

### Phase 1 — Drop (if `DROP_SCHEMA = true`)

Dropped in reverse-dependency order:

1. Triggers
2. Functions (`get_readable_uptime`, `update_updated_at_column`, queue-specific triggers)
3. **Dashboard materialized views** (all 6, `CASCADE`)
4. Child tables (`transfer_queue`, `video_transfer_queue`, `video_converted_buffer`, …)
5. Parent tables (`transfer_queue_job`, `video_transfer_queue_job`, `files`, …)

### Phase 2 — Create

Objects created in `createTables()` in this order:

| Step | Object | Notes |
|---|---|---|
| 1 | `files` table | Central ALPR plate image registry |
| 2 | `device_connections` table | USB drive connection history |
| 3 | `transfer_job`, `transfer_job_log` | Legacy manual transfer flow |
| 4 | `auto_transfer_device`, `auto_transfer_job` | **ORPHAN** — created but not used at runtime |
| 5 | `transfer_queue_job`, `transfer_queue` | USB image auto-transfer queue |
| 6 | `iss_media_files` | ISS NVR video segment index |
| 7 | `video_transfer_queue_job`, `video_converted_buffer`, `video_transfer_queue` | USB video transfer |
| 8 | `ftp_image_transfer_queue_job`, `ftp_image_transfer_queue` | FTP image transfer |
| 9 | `ftp_video_transfer_queue_job`, `ftp_video_converted_buffer`, `ftp_video_transfer_queue` | FTP video transfer |
| 10 | `ALTER TABLE device_connections ADD COLUMN IF NOT EXISTS current_uptime_minutes / total_uptime_minutes` | Runtime columns |
| 11 | `CREATE INDEX idx_device_connections_status_connected` | Drive status index |
| 12 | `ALTER TABLE files ADD COLUMN IF NOT EXISTS ts` | Generated timestamp column (`date + time`) |
| 13 | **Covering partial indexes on `files`** | `idx_files_dashboard_date`, `idx_files_dashboard_cam_date` — enable index-only scans for dashboard queries |
| 14 | Functions + triggers | `get_readable_uptime`, `update_updated_at_column`, per-table update triggers |
| 15 | **Dashboard materialized views** (6) | `mv_files_daily`, `mv_files_daily_agg`, `mv_files_monthly`, `mv_files_monthly_agg`, `mv_files_yearly`, `mv_files_yearly_agg` |
| 16 | Unique indexes on each MV | Required for `REFRESH MATERIALIZED VIEW CONCURRENTLY` |

---

## Idempotency

All DDL uses `IF NOT EXISTS` / `IF EXISTS` / `CREATE OR REPLACE` guards:

- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE … ADD COLUMN IF NOT EXISTS`
- `CREATE INDEX IF NOT EXISTS`
- `CREATE MATERIALIZED VIEW IF NOT EXISTS`
- `CREATE UNIQUE INDEX IF NOT EXISTS`
- `DROP … IF EXISTS CASCADE`
- `CREATE OR REPLACE FUNCTION`

The script is safe to re-run without `DROP_SCHEMA = true` — existing objects will be skipped.

---

## Adding Indexes to a Live Production Database

The migration uses regular `CREATE INDEX` (not `CONCURRENTLY`) because the table is empty during a fresh migration. If the `files` table already has data and you need to add the covering indexes **without downtime**, run these two statements manually in a `psql` session (each must be the only command — not inside a `BEGIN/COMMIT` block):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_dashboard_date
  ON public.files (date)
  INCLUDE (cam_id, plate_num, file_size, image_export_done_date_time, time)
  WHERE deleted = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_files_dashboard_cam_date
  ON public.files (cam_id, date)
  INCLUDE (plate_num, file_size, image_export_done_date_time)
  WHERE deleted = false;
```

---

## After Migration — Verification

```sql
-- Confirm tables exist
SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;

-- Confirm covering indexes exist
SELECT indexname FROM pg_indexes WHERE tablename = 'files';

-- Confirm materialized views exist
SELECT matviewname FROM pg_matviews WHERE schemaname = 'public';

-- Confirm MV data (will be empty on fresh DB — populated once the app runs)
SELECT COUNT(*) FROM mv_files_daily;
```

The dashboard materialized views will be empty immediately after migration. `DashboardReportingBackend.js` populates them on startup via its scheduled `REFRESH MATERIALIZED VIEW CONCURRENTLY` background task.

---

## Rollback

`DROP_SCHEMA = true` already covers rollback — re-run the script with that flag to wipe everything and start fresh.

For production, take a `pg_dump` **before** running the migration if rollback to data is needed:

```bash
pg_dump -h localhost -U postgres tahakom_transfer > backup_$(date +%Y%m%d).sql
```

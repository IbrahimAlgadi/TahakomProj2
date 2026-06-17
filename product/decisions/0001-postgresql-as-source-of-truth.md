# ADR-0001: Use PostgreSQL as the Integration Layer Between SecurOS and Transfer Services

## Status

Accepted

## Date

2026-06-17

## Context

The system has two distinct runtime boundaries:
1. **SecurOS Script Integration Engine** — scripts run inside SecurOS's process space with the injected `securos` module, reacting to ALPR events. They produce image files on disk.
2. **PM2 Node.js services** — standard services that need to consume those images and distribute them to USB drives and FTP servers.

These two boundaries cannot share memory, process state, or direct function calls. They need an integration point that:
- Persists data durably (survives restarts of either boundary)
- Supports complex queries (filter by date, plate, camera, transfer status)
- Supports concurrent writers (multiple SecurOS script instances) and concurrent readers (multiple transfer services)
- Provides a full audit trail (every file, every transfer attempt, every failure)
- Is available locally (on-premises deployment, no cloud dependency)

## Options Considered

### Option A: PostgreSQL (relational database)
- **Pros**: ACID transactions; complex queries with indexes; concurrent access; full audit trail via typed columns; available on-premises; `pg` npm client is mature; supports JSONB for flexible retry log storage
- **Cons**: Requires schema migrations; connection pool management; another system process to manage

### Option B: Redis (in-memory store)
- **Pros**: Already used in the system for state; very fast; simple key-value and list operations
- **Cons**: Not designed for durable relational data; no complex queries (filter by date + camera + transfer status); data loss on Redis restart without persistence config; no JSONB/audit trail; TTL-based rather than retention-policy based

### Option C: SQLite (embedded database)
- **Pros**: No separate process; simple setup
- **Cons**: Poor concurrent write performance; WAL mode needed for concurrency; no server-side aggregations at scale; not suitable for multi-process concurrent writers from SecurOS scripts

## Decision

We choose **PostgreSQL** because:

1. The `files` table is the integration contract between SecurOS scripts and transfer services. It requires relational joins, complex WHERE clauses (by date, plate, camera, transfer status), and concurrent multi-process writes — all strengths of PostgreSQL.
2. JSONB support covers flexible data like `export_params` and `export_retry_log_object` without sacrificing queryability.
3. ACID guarantees ensure that a crash mid-INSERT does not leave partially recorded files that the transfer service would attempt to move.
4. PostgreSQL is already deployed on the target machine (confirmed in `.cursor/mcp.json`, `utils/envConfig.js`).
5. The same database serves both the file transfer pipeline and the dashboard reporting queries — a single system of record reduces synchronization complexity.

## Consequences

**Positive**:
- Complete, queryable audit trail of every captured image, every export attempt, every transfer
- All services — SecurOS scripts, PM2 services, dashboard routes — query the same data source with no synchronization overhead
- Complex dashboard analytics (by date, camera, site, transfer status) are native SQL

**Negative / Trade-offs**:
- Every SecurOS script must maintain a `pg.Pool` connection, adding a small startup/connect overhead inside the SecurOS runtime
- Schema changes require running `DatabaseMigration.js` — currently some runtime ALTER TABLE calls exist in `ExportDirectoryControlV3.js` (tech debt T-2)
- Connection pool exhaustion across many concurrent scripts is a risk (see PROJECT_MAP.md T-1)

**Risks**:
- If PostgreSQL becomes unavailable, the entire capture pipeline degrades: SecurOS scripts will fail to INSERT, and transfer services will fail to query
- `export_retry_log_object` as inline JSONB on `files` may cause bloat at very high plate volume (see tech debt T-3; deferred to roadmap M5)

## References

- `scripts/migration/DatabaseMigration.js` — full schema definition
- `product/technical/database/schema.md` — schema reference
- `utils/envConfig.js` — DB connection defaults
- See also: ADR-0002 (SecurOS script integration), ADR-0004 (Redis for state)

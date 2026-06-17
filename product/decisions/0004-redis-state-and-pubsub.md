# ADR-0004: Use Redis for Inter-Service State and Configuration Propagation

## Status

Accepted

## Date

2026-06-17

## Context

Nine PM2 services need to share two categories of state:

1. **Configuration state** — `dataTransferConfig.json` settings (storage paths, FTP credentials, retention settings). When an operator changes the config, all running services must pick up the new values without restarting.
2. **Drive state** — which USB drives are currently connected, their capacity, and their connection/disconnection events. Transfer services need this to decide whether to start a USB transfer batch.

These services run in separate Node.js processes and cannot share in-memory state directly. The options are database polling, direct HTTP calls, or a shared in-memory store with pub/sub.

## Options Considered

### Option A: Redis (in-memory key-value store + pub/sub)
- **Pros**: Sub-millisecond reads for state; native pub/sub for change notifications; ioredis client is stable and maintained; supports JSON values; no polling required — services are notified on change
- **Cons**: Another infrastructure process to manage; data is lost on Redis restart without AOF/RDB persistence (acceptable — all state is reconstructible from disk and PostgreSQL); connection management per service

### Option B: PostgreSQL polling
- **Pros**: No additional infrastructure; state persisted durably
- **Cons**: Polling adds DB load and latency; config changes may take up to the poll interval to propagate; drives the DB connection count up with polling queries; not designed for high-frequency state queries

### Option C: Direct HTTP between services
- **Pros**: No additional infrastructure; explicit API contracts between services
- **Cons**: Complex service discovery; circular dependency risk (config service needs to know addresses of all consumers); REST calls are higher overhead than Redis get/publish; dashboard and transfer services would need to register with each other

### Option D: Shared filesystem (config file polling)
- **Pros**: Simplest — just read the file; no additional infrastructure
- **Cons**: File system watchers are unreliable on Windows (chokidar helps but is not guaranteed); no pub/sub; race conditions on concurrent reads/writes; not suitable for drive state (too transient)

## Decision

We choose **Redis** because:

1. The pub/sub model (`PUBLISH` / `SUBSCRIBE`) is the exact right pattern for "push config change to all consumers" — no polling, no HTTP overhead, instantaneous propagation.
2. Redis GET for state reads is O(1) and adds negligible latency to service startup queries.
3. Redis is already on the machine as a common Node.js infrastructure dependency; ioredis (^5.6.1) is in `package.json`.
4. Drive state is highly transient (a drive connects/disconnects on a human timescale but services need to react within seconds) — Redis's in-memory speed is appropriate.

## Consequences

**Positive**:
- Config changes propagate to all services in < 100ms via pub/sub
- Services start up with current config by doing a single Redis GET — no file reads per service
- Drive state is available to any service that subscribes, without DB queries
- `redisKeyStore.js` provides a central registry of all key names, preventing magic-string key collisions

**Negative / Trade-offs**:
- Redis state is lost on Redis restart (e.g., machine reboot) — services must handle "empty Redis" gracefully by re-reading from disk on startup
- Each of 9 services maintains its own Redis client connection (9 × ioredis connections); at low concurrency this is fine, but connection limit should be monitored
- No persistence configured by default — Redis is used as a cache/bus, not a durable store

**Risks**:
- If Redis goes down, services cannot receive config updates or drive state changes; they continue running on stale in-memory state (acceptable graceful degradation)
- `CONNECTED_DRIVE_LIST_UPDATE` channel publish must be reliable — if a drive connects before a transfer service subscribes, the transfer service will not receive the notification (mitigated by transfer services also polling Redis at startup)

## References

- `ConfigStateServiceRedis.js` — config state owner
- `monitorConnectedExternalDrivesMicroservice.js` — drive state owner
- `redisKeyStore.js` — key/channel name registry
- `product/technical/architecture.md` — Redis key space table
- See also: ADR-0001 (PostgreSQL for durable state), ADR-0003 (PM2 microservice topology)

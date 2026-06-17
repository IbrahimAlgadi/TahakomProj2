# ADR-0003: Use PM2 with a Microservice Topology for Transfer and Monitoring Services

## Status

Accepted

## Date

2026-06-17

## Context

The transfer services (USB image, FTP image, USB video, FTP video), monitoring services (drives, processes, media files), and the dashboard all need to run continuously on a Windows machine, restart automatically on failure, and have independent log files. They have different dependency relationships — e.g., the config service must start before transfer services, and the drive monitor must start before image/video transfer.

Key requirements:
- Automatic restart on crash (max 5 times with backoff to avoid restart loops)
- Log rotation without a separate log rotation process
- Service dependency ordering at startup
- Windows compatibility (no `systemd`, no Docker required)
- Uses the same Node.js binary as SecurOS scripts for consistency

## Options Considered

### Option A: PM2 (Process Manager 2)
- **Pros**: Native Windows support; ecosystem.config.js provides declarative multi-service config with dependencies, restart policy, and log paths; uses the SecurOS-bundled Node.js binary via `interpreter`; widely used in Node.js production deployments; PM2 binary is available on the machine (bundled with SecurOS)
- **Cons**: PM2 itself needs to be started on boot (Windows startup task or service wrapper required); not a Windows service natively

### Option B: node-windows (Windows Service wrappers)
- **Pros**: Each service runs as a true Windows Service with native SCM integration; auto-starts on boot without additional tooling
- **Cons**: One wrapper per service; no built-in dependency ordering; no log rotation; harder to manage 9 services simultaneously; `node-windows` is in beta for Windows 11; no single config file for all services

### Option C: Monolith (single Node.js process)
- **Pros**: Simplest deployment; one process to monitor
- **Cons**: A crash in one service (e.g., USB transfer error) kills the dashboard and all other services; violates the single-responsibility requirement; cannot independently scale or restart individual services

## Decision

We choose **PM2** because:

1. PM2 is already available on the machine (bundled with ISS SecurOS's Node.js installation), eliminating any additional runtime dependency.
2. `ecosystem.config.js` provides a single, version-controlled source of truth for all 9 services, their dependencies, restart policies, and log paths — zero manual service management commands needed day-to-day.
3. The `interpreter` field in `ecosystem.config.js` points each service to the SecurOS-bundled Node.js binary, ensuring all services use the same runtime as SecurOS scripts — no Node.js version management overhead.
4. `exp_backoff_restart_delay` and `max_restarts: 5` prevent restart loops while ensuring crashed services recover automatically.

## Consequences

**Positive**:
- 9 services managed via a single `pm2 start ecosystem.config.js` command
- Log files auto-created at defined paths (`logs/<ServiceName>-{out,error}.log`)
- `ClusterStatusMonitorScript.js` in SecurOS can use the same PM2 binary to health-check all services and restart them if needed
- Service-level restart isolation: a failing USB transfer service does not affect the dashboard or FTP service

**Negative / Trade-offs**:
- PM2 itself does not automatically start on Windows boot without additional setup (Windows Task Scheduler or `pm2-windows-startup`)
- `ecosystem.config.js` dependency ordering (`dependencies` field) relies on PM2's sequential startup — a service that starts before its dependency may fail briefly on first launch
- Log files are not structured JSON — they are free-form Winston output, making programmatic log analysis harder

**Risks**:
- If the SecurOS Node.js runtime version is updated, all PM2 services will use the new version automatically — regression risk if APIs changed
- PM2 `max_restarts: 5` means a repeatedly crashing service will stop after 5 restarts; no automatic alert is generated (observability gap — see roadmap M1)

## References

- `ecosystem.config.js` — all PM2 service definitions
- `product/technical/services.md` — per-service documentation
- `securos-scripts/ClusterStatusMonitorScript.js` — PM2 health watchdog from SecurOS
- See also: ADR-0004 (Redis for inter-service state)

# ADR-0006: Shared Winston Logger with AsyncLocalStorage Trace IDs

## Status

Accepted

## Date

2026-06-18

## Context

The system has nine PM2 microservices and two primary runtime boundaries (SecurOS scripts and PM2 services). Before this decision, logging was inconsistent:

- Only `DashboardReportingBackend.js` used Winston with daily log rotation.
- All other PM2 services (`autoVideoTransferEDAMicroservice`, `autoUSBImageTransferService`, etc.) logged with raw `console.log/error/warn`, captured by PM2 into flat `-out.log` / `-error.log` files.
- No shared module existed — each service that adopted Winston would need to re-implement configuration.
- No correlation IDs: it was impossible to follow a single file transfer, job batch, or HTTP request across all the log lines it produced, especially since a job spans multiple shared `services/**` helpers (`FileTransferManager`, `JobManager`, etc.).

The project runs on **Windows under PM2** (`exec_mode: "fork"`) with the SecurOS-bundled Node.js interpreter. Any logging solution must work without native modules (no ETW / Event Log integration at this stage) and must not break PM2's existing stdout/stderr capture into `-out/-error.log` files.

---

## Options Considered

### Option A: Full OpenTelemetry distributed tracing
- **Pros**: Industry standard; exportable to Jaeger, Grafana Tempo, Zipkin.
- **Cons**: Requires a collector or backend running locally on Windows; large dependency footprint (`@opentelemetry/*` packages); major overkill for a single-host system with no external observability infrastructure; significant instrumentation effort across all services.

### Option B: Custom per-service Winston loggers (no shared module)
- **Pros**: Zero refactoring of existing services; each service owns its format.
- **Cons**: Configuration drift; no correlation IDs; still no ability to follow a job across log lines; duplicates the same Winston setup code in every file.

### Option C: Shared `utils/logger.js` with AsyncLocalStorage trace IDs (chosen)
- **Pros**: Single factory for all services; zero dependencies beyond already-installed `winston` and `uuid` (both already in `package.json`); `AsyncLocalStorage` is a Node.js built-in (no extra packages); trace IDs propagate automatically through async call chains without threading an argument through every function signature; TTY-aware console format keeps PM2 `-out.log` files clean; additive — no existing behaviour broken.
- **Cons**: Trace IDs are per-process, not automatically cross-service (requires explicit propagation via HTTP headers or Redis message fields for end-to-end tracing); `AsyncLocalStorage` requires Node ≥ 12.17 (confirmed compatible with SecurOS-bundled Node).

---

## Decision

We choose **Option C** because:

1. Winston and `uuid` are already installed dependencies — zero new packages required.
2. `AsyncLocalStorage` (Node built-in) is the correct primitive for implicit async context propagation on a single-host system; it eliminates the need to thread `traceId` arguments through `FileTransferManager`, `JobManager`, and other shared helpers.
3. The TTY-aware console format solves the pre-existing ANSI colour escape code pollution in PM2-captured log files without any configuration overhead.
4. The solution is purely additive: existing PM2 log files (`-out.log` / `-error.log`) keep working; new per-service daily-rotated JSON files (`<service>-app-%DATE%.log`) are added alongside them.
5. A full OpenTelemetry stack is not justified for a single-host, on-premises deployment with no external monitoring infrastructure.

---

## Consequences

**Positive**:
- Every PM2 service can adopt structured logging in two lines: `createLogger({ service })` and replace `console.*` with `logger.*`.
- Correlation IDs (`traceId`, `jobId`, `camera`) flow automatically through `runWithTrace` scopes — including inside shared `services/**` helpers — without any helper signature changes.
- HTTP requests through `DashboardReportingBackend` echo a `traceId` in the `X-Trace-Id` response header, enabling browser-side correlation.
- JSON format in rotated files is machine-parseable (compatible with future log shippers such as Filebeat, Fluentd, or Better Stack).
- `LOG_LEVEL`, `LOG_MAX_SIZE`, `LOG_MAX_FILES` already defined in `.env` are reused — no new env vars needed.

**Negative / Trade-offs**:
- Trace IDs do **not** automatically propagate across process boundaries (e.g. from `DashboardReportingBackend` to `autoVideoTransferEDAMicroservice`). Cross-service correlation requires explicit ID propagation in HTTP headers or Redis messages.
- The remaining ~8 PM2 services and ~30+ `console.*` call sites are not migrated in this pass; correlation only works in-process for the two adopted services. Migration is intentionally incremental.
- Logs now appear in both Winston-rotated files and PM2-captured files (minor redundancy). This matches the pre-existing behaviour of `DashboardReportingBackend` and is acceptable.

**Risks**:
- If the SecurOS-bundled Node.js interpreter is older than 12.17, `AsyncLocalStorage` will throw at startup. This risk is mitigated by the fact that `winston-daily-rotate-file` already runs successfully on that interpreter.
- Log volume doubles per service (Winston file + PM2 capture). `LOG_MAX_FILES: 14d` and `LOG_MAX_SIZE: 20m` bound disk usage.

---

## References

- Implementation: `utils/logger.js`
- Adopted in: `DashboardReportingBackend.js` (HTTP request tracing), `refactored_autoVideoTransferEDAMicroservice.js` (job-scoped tracing)
- Tests: `tests/logger.test.js` (24 tests)
- See also: ADR-0003 (PM2 microservice topology), `product/technical/architecture.md` → Logging Architecture

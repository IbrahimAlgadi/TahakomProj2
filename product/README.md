# Product Knowledge Base

**Tahakom Data Transfer System**  
Last updated: 2026-06-21 (SecurOS export crash fixes — OptimizedImageCapture.js OVER-fallback + null guard + try/catch (T-7); Export Fixer unawaited pool.query deadlock crash fixed (T-8))

This folder is the **single source of truth** for product decisions, requirements, technical architecture, and the agent team for the Tahakom Data Transfer System.

> **For AI agents**: read this file and `PROJECT_MAP.md` (workspace root) at the start of every session.  
> Do not rely on parametric memory — trust the files in this folder.

---

## Document Index

### Product

| Document | Path | Purpose |
|---|---|---|
| PRD | [prd/PRD-tahakom-data-transfer.md](prd/PRD-tahakom-data-transfer.md) | Problem, users, solution, success metrics, scope, risks, open questions |
| Backlog | [prd/backlog/epics-and-stories.md](prd/backlog/epics-and-stories.md) | Epics + user stories with Gherkin acceptance criteria, mapped to roadmap milestones |
| Roadmap | [roadmap/roadmap.md](roadmap/roadmap.md) | Milestone plan with Verifiable Goals (M0–M5) |

### Technical

| Document | Path | Purpose |
|---|---|---|
| Architecture | [technical/architecture.md](technical/architecture.md) | Full architectural design — two-boundary model, event-driven capture, transfer pipeline, encryption, logging, deployment |
| Services | [technical/services.md](technical/services.md) | Per-service reference — trigger, DB reads/writes, key logic, log paths |
| DB Schema | [technical/database/schema.md](technical/database/schema.md) | All PostgreSQL tables, columns, indexes, functions, key query patterns |
| File Accumulation | [technical/file-accumulation-approach.md](technical/file-accumulation-approach.md) | 38-file-per-camera buffer algorithm and job phase logging for `video_converted_buffer` |

### Technical — Diagrams

| Document | Path | Purpose |
|---|---|---|
| Diagrams Index | [technical/diagrams/README.md](technical/diagrams/README.md) | Index of per-service activity diagrams and shared patterns |
| Diagrams Overview | [technical/diagrams/diagrams.md](technical/diagrams/diagrams.md) | Mermaid system/service architecture and file-transfer flow diagrams |
| Auto USB Video Flow | [technical/diagrams/refactored_autoVideoTransferEDAMicroservice-activity.md](technical/diagrams/refactored_autoVideoTransferEDAMicroservice-activity.md) | Detailed activity diagram: USB video transfer (job mgmt, scheduling, encryption) |
| Auto FTP Video Flow | [technical/diagrams/autoFtpVideoTransferService-activity.md](technical/diagrams/autoFtpVideoTransferService-activity.md) | Detailed activity diagram: FTP video transfer (scheduling, monitoring, buffer loops) |
| Auto USB Image Flow | [technical/diagrams/autoUSBImageTransferService-activity.md](technical/diagrams/autoUSBImageTransferService-activity.md) | Detailed activity & behaviour map: USB image transfer (start/stop control, USB connect/disconnect, resume, continuous loop, exactly-3 rule, error handling, stall risks) |
| Auto FTP Image Flow | [technical/diagrams/autoFTPImageTransferService-activity.md](technical/diagrams/autoFTPImageTransferService-activity.md) | Detailed activity diagram: FTP image transfer (batch-50, FTP readiness, retries) |
| File Transfer Modes | [technical/diagrams/File transfer Modes.drawio](technical/diagrams/File%20transfer%20Modes.drawio) | Editable Draw.io diagram for VMS storage indexing workflow |

### Technical — Developer Guides

| Document | Path | Purpose |
|---|---|---|
| Backend Architecture | [technical/development-guides/backend-frontend-architecture-guide.json](technical/development-guides/backend-frontend-architecture-guide.json) | System architecture for devs: microservices, ports, responsibilities, communication patterns |
| Backend Running | [technical/development-guides/backend-running-guide.json](technical/development-guides/backend-running-guide.json) | Ops runbook: prerequisites, env vars, PM2 `ecosystem.config.js`, startup order, troubleshooting |
| Backend API Dev | [technical/development-guides/backend-api-development-guide.json](technical/development-guides/backend-api-development-guide.json) | API dev standards + full endpoint catalog with request/response examples |
| Features Implementation | [technical/development-guides/features-implementation-guide.json](technical/development-guides/features-implementation-guide.json) | Feature-to-code map: auto/manual transfer, dashboard, devices — DB queries, Redis keys, routes |
| Redis Usage | [technical/development-guides/redis-usage-guide.json](technical/development-guides/redis-usage-guide.json) | ioredis setup, `redisKeyStore.js` keys, queues/pub-sub per feature |
| Node.js Version | [technical/development-guides/nodejs-version-guide.json](technical/development-guides/nodejs-version-guide.json) | Node.js v12.18.3 compatibility: allowed/forbidden ES features and safe alternatives |
| Frontend Scripts | [technical/development-guides/frontend-script-guide.json](technical/development-guides/frontend-script-guide.json) | Frontend JS patterns: Fetch/WebSocket, ECharts, Bootstrap helpers |
| Frontend Theme | [technical/development-guides/frontend-theme-development-guide.json](technical/development-guides/frontend-theme-development-guide.json) | Nunjucks layout hierarchy, Bootstrap 5, Font Awesome, ECharts, responsive layout |
| Frontend–Backend API | [technical/development-guides/frontend-backend-api-calling-guide.json](technical/development-guides/frontend-backend-api-calling-guide.json) | Client–server contract: HTTP/WebSocket protocols, message formats, error handling |

### Ops Runbooks

| Document | Path | Purpose |
|---|---|---|
| Environment Setup | [ops/environment-setup.md](ops/environment-setup.md) | `.env` variables, `setup-env.js`, `utils/envConfig.js` — onboarding guide |
| DB Migration Runbook | [ops/database-migration-runbook.md](ops/database-migration-runbook.md) | Steps to run `DatabaseMigration.js`, table order, rollback, verification |
| FTP Transfer Runbook | [ops/ftp-video-transfer-runbook.md](ops/ftp-video-transfer-runbook.md) | FTP video setup, shared vs FTP-specific components, monitoring SQL, troubleshooting |

### PRD Sources

| Document | Path | Purpose |
|---|---|---|
| SOW June 2025 | [prd/sources/sow-2025-06-10.md](prd/sources/sow-2025-06-10.md) | Formal client scope document (dated 2025-06-10) — contractual traceability source upstream of the PRD |

### Backlog — SOW Stories

| Document | Path | Purpose |
|---|---|---|
| SOW Backlog | [prd/backlog/sow-stories/](prd/backlog/sow-stories/) | Broad SOW-level user stories (`ST00xx`) — 8 written, 92 planned — covering full Tahakom Traffic Enforcement System scope |
| SOW Stories Plan | [prd/backlog/sow-stories/USER_STORIES_PLAN.md](prd/backlog/sow-stories/USER_STORIES_PLAN.md) | Master plan for ~100 stories (ST0001–ST0100) |
| SOW Stories Progress | [prd/backlog/sow-stories/USER_STORIES_PROGRESS.md](prd/backlog/sow-stories/USER_STORIES_PROGRESS.md) | Status tracker for written vs pending SOW stories |

### Decisions

| ADR | Path | Decision |
|---|---|---|
| ADR-0001 | [decisions/0001-postgresql-as-source-of-truth.md](decisions/0001-postgresql-as-source-of-truth.md) | Use PostgreSQL as the integration layer between SecurOS and transfer services |
| ADR-0002 | [decisions/0002-securos-script-integration-engine.md](decisions/0002-securos-script-integration-engine.md) | Run capture logic as SecurOS scripts, not external Node.js services |
| ADR-0003 | [decisions/0003-pm2-microservice-topology.md](decisions/0003-pm2-microservice-topology.md) | Use PM2 with a microservice topology for transfer and monitoring services |
| ADR-0004 | [decisions/0004-redis-state-and-pubsub.md](decisions/0004-redis-state-and-pubsub.md) | Use Redis for inter-service state and configuration propagation |
| ADR-0005 | [decisions/0005-mcp-read-access-to-databases.md](decisions/0005-mcp-read-access-to-databases.md) | Provide MCP read-only access to PostgreSQL for Cursor AI agents |
| ADR-0006 | [decisions/0006-shared-logger-trace-ids.md](decisions/0006-shared-logger-trace-ids.md) | Shared Winston logger with AsyncLocalStorage trace IDs for all PM2 services |
| ADR-0007 | [decisions/0007-event-driven-usb-detection.md](decisions/0007-event-driven-usb-detection.md) | Replace polling with usb@3 WebUSB hotplug events + safety-net for instant drive detection |
| Template | [decisions/template.md](decisions/template.md) | ADR template for new decisions |

### Root Maps

| Document | Path | Purpose |
|---|---|---|
| Project Map | [../PROJECT_MAP.md](../PROJECT_MAP.md) | Living tech stack, system flow, architecture, orphans & pending — update on every change |
| Test Map | [../TEST_MAP.md](../TEST_MAP.md) | Jest test suite index, coverage table, mocking strategy, and gap registry — update when tests are added or coverage changes |

### Agent Skills

| Skill | Path | Purpose |
|---|---|---|
| SecurOS Log Registry | [../.cursor/skills/securos-log-registry/SKILL.md](../.cursor/skills/securos-log-registry/SKILL.md) | Fill-in log path registry + SecurOS mode constraints for engineering-ops-agent |

---

## Agent Team

Three Cursor subagents under `.cursor/agents/`. Invoke by name or description.

| Agent | File | Owns | Key Skills |
|---|---|---|---|
| Product Strategy | [../.cursor/agents/product-strategy-agent.md](../.cursor/agents/product-strategy-agent.md) | PRD, backlog, roadmap, this README | prd-development, user-story, roadmap-planning, context-engineering-advisor |
| Architecture & Data | [../.cursor/agents/architecture-data-agent.md](../.cursor/agents/architecture-data-agent.md) | PROJECT_MAP.md, technical/, decisions/ | planning-protocol, architecture-decision-records, database-design, slow-query-audit |
| Engineering & Ops | [../.cursor/agents/engineering-ops-agent.md](../.cursor/agents/engineering-ops-agent.md) | Node services, SecurOS scripts (SecurOS Mode), log tailing | execution-protocol, modification-protocol, diagnostic-rescue-protocol, analyze-logs, securos-log-registry |

---

## Context Manifest

This section defines what information to **always load**, what to **retrieve on demand**, and what to **exclude** when working on this project. It implements the principles from the `context-engineering-advisor` skill to keep AI sessions high-signal.

### Always Load (Persist in every session)

These files provide the minimum context required for any task:

| File | Why always needed |
|---|---|
| `PROJECT_MAP.md` | Service names, data flows, DB table owners, open items — referenced in almost every task |
| This file (`product/README.md`) | Document index, agent team, context manifest — navigation entry point |

### Load on Demand (Retrieve when task requires it)

| Context | When to load | File |
|---|---|---|
| PRD + problem framing | When evaluating feature requests or writing user stories | `product/prd/PRD-tahakom-data-transfer.md` |
| User stories / backlog | When planning a sprint, writing acceptance criteria, or estimating | `product/prd/backlog/epics-and-stories.md` |
| SOW backlog | When checking SOW compliance or tracing a requirement to an ST00xx story | `product/prd/backlog/sow-stories/USER_STORIES_PLAN.md` |
| SOW contractual source | When verifying requirement provenance against the original client scope | `product/prd/sources/sow-2025-06-10.md` |
| Roadmap | When prioritizing work or scoping a milestone | `product/roadmap/roadmap.md` |
| Architecture details | When designing a new service or modifying a complex interaction | `product/technical/architecture.md` |
| Service reference | When modifying a specific PM2 service or SecurOS script | `product/technical/services.md` |
| DB schema | When writing SQL, migration changes, or MCP queries | `product/technical/database/schema.md` |
| File accumulation algorithm | When working on `video_converted_buffer`, job phases, or the 38-file batch rule | `product/technical/file-accumulation-approach.md` |
| Specific ADR | When a decision is being revisited or a related decision is being made | `product/decisions/0001–0005.md` |
| Per-service activity diagrams | When tracing the detailed flow of USB video, FTP video, or FTP image transfer | `product/technical/diagrams/*-activity.md` |
| Developer how-to guides | When setting up the dev environment, understanding frontend/backend patterns, or extending the API | `product/technical/development-guides/` |
| Environment setup | When onboarding a new developer or troubleshooting missing `.env` values | `product/ops/environment-setup.md` |
| DB migration runbook | When running or rolling back a schema migration | `product/ops/database-migration-runbook.md` |
| FTP transfer runbook | When configuring or troubleshooting FTP video transfer | `product/ops/ftp-video-transfer-runbook.md` |
| SecurOS log registry | When tailing SecurOS logs or editing a SecurOS script | `.cursor/skills/securos-log-registry/SKILL.md` |
| Ecosystem config | When adding a service, changing restart policy, or checking log paths | `ecosystem.config.js` |
| Migration script | When modifying the database schema | `scripts/migration/DatabaseMigration.js` |
| Test suite map | When writing new tests, checking coverage gaps, or extending the test setup | `TEST_MAP.md` |

### Always Exclude

| Excluded | Why |
|---|---|
| `data_transfer_v2/public/vendors/` | Third-party vendor bundles; never modify; too large to load |
| `archived/` | Legacy services and docs; superseded by current architecture; load only if investigating historical context |
| `archived/legacy-docs/` | Superseded documentation (pre-PRD drafts, stale service docs, scratch notes); use `product/` instead |
| `node_modules/` | Never load |
| `package-lock.json` | Use `package.json` for dependency versions |
| Individual log files | Use `securos-log-registry` skill for targeted log tailing; never bulk-load all logs |

### Context Manifest Owner

**Product Strategy Agent** owns this Context Manifest. Update it when:
- A new major document is added to `product/`
- A new agent is added to `.cursor/agents/`
- A file becomes irrelevant and should be excluded
- A previously on-demand file becomes always-needed (or vice versa)

---

## Open Items Requiring User Action

> Mirror of `PROJECT_MAP.md [ORPHANS & PENDING]` — see that file for the full list.

| # | Item | Action |
|---|---|---|
| ~~O-1~~ | ~~SecurOS log paths not registered~~ | **Resolved** — all paths registered in `.cursor/skills/securos-log-registry/SKILL.md`. Base dir: `C:\ProgramData\ISS\logs\`, files `nodejs.1–6.console.log` |
| O-2 | `auto` DB purpose unknown | Query via `postgresql-securos_auto-mcp` MCP and update ADR-0005 + PROJECT_MAP.md |
| O-3 | FTP credentials not configured | Fill `ftpTransfer` section in `data_transfer_v2/dataTransferConfig.json` |
| O-4 | `DriveStateServiceRedis.js` existence unconfirmed | Verify file exists; fix `ecosystem.config.js` dependency list if missing |
| O-5 | Production retention + capacity values unknown | Confirm and document in PROJECT_MAP.md O-5 |

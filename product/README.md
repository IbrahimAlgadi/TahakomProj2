# Product Knowledge Base

**Tahakom Data Transfer System**  
Last updated: 2026-06-17

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

### Decisions

| ADR | Path | Decision |
|---|---|---|
| ADR-0001 | [decisions/0001-postgresql-as-source-of-truth.md](decisions/0001-postgresql-as-source-of-truth.md) | Use PostgreSQL as the integration layer between SecurOS and transfer services |
| ADR-0002 | [decisions/0002-securos-script-integration-engine.md](decisions/0002-securos-script-integration-engine.md) | Run capture logic as SecurOS scripts, not external Node.js services |
| ADR-0003 | [decisions/0003-pm2-microservice-topology.md](decisions/0003-pm2-microservice-topology.md) | Use PM2 with a microservice topology for transfer and monitoring services |
| ADR-0004 | [decisions/0004-redis-state-and-pubsub.md](decisions/0004-redis-state-and-pubsub.md) | Use Redis for inter-service state and configuration propagation |
| ADR-0005 | [decisions/0005-mcp-read-access-to-databases.md](decisions/0005-mcp-read-access-to-databases.md) | Provide MCP read-only access to PostgreSQL for Cursor AI agents |
| Template | [decisions/template.md](decisions/template.md) | ADR template for new decisions |

### Root Map

| Document | Path | Purpose |
|---|---|---|
| Project Map | [../PROJECT_MAP.md](../PROJECT_MAP.md) | Living tech stack, system flow, architecture, orphans & pending — update on every change |

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
| Roadmap | When prioritizing work or scoping a milestone | `product/roadmap/roadmap.md` |
| Architecture details | When designing a new service or modifying a complex interaction | `product/technical/architecture.md` |
| Service reference | When modifying a specific PM2 service or SecurOS script | `product/technical/services.md` |
| DB schema | When writing SQL, migration changes, or MCP queries | `product/technical/database/schema.md` |
| Specific ADR | When a decision is being revisited or a related decision is being made | `product/decisions/0001–0005.md` |
| SecurOS log registry | When tailing SecurOS logs or editing a SecurOS script | `.cursor/skills/securos-log-registry/SKILL.md` |
| Ecosystem config | When adding a service, changing restart policy, or checking log paths | `ecosystem.config.js` |
| Migration script | When modifying the database schema | `scripts/migration/DatabaseMigration.js` |

### Always Exclude

| Excluded | Why |
|---|---|
| `data_transfer_v2/public/vendors/` | Third-party vendor bundles; never modify; too large to load |
| `archived/` | Legacy services; superseded by current architecture; load only if investigating historical context |
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

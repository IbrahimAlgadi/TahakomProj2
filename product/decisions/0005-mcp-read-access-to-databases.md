# ADR-0005: Provide MCP Read-Only Access to PostgreSQL for Cursor AI Agents

## Status

Accepted

## Date

2026-06-17

## Context

The project uses Cursor IDE with AI agents to assist with development, debugging, and operations. These agents need to query the `tahakom_transfer` PostgreSQL database to:
- Check for stuck exports (`files` where `file_size=0`, `image_export_done_date_time IS NULL`)
- Review retry backlogs (`export_retry_count > 0`)
- Inspect transfer queue health (`transfer_queue_job` status distribution)
- Validate schema changes before writing migration code

Additionally, a second PostgreSQL database (`auto`, also called `securos_auto`) exists on the same server and may contain SecurOS-related data that the engineering-ops agent may need to inspect.

The question is: how should AI agents access the database, and with what permissions?

Constraints:
- AI agents should never run destructive SQL (UPDATE, DELETE, DROP) — production data must be protected
- The MCP connection is a development/tooling concern, not an application dependency
- Credentials should match the existing PostgreSQL setup (local user `postgres` with password `postgres`)
- Configuration must be checked into the repository so all team members and agents have consistent access

## Options Considered

### Option A: MCP server via `@henkey/postgres-mcp-server` (npx)
- **Pros**: Zero installation — runs via `npx`; standard MCP protocol understood by Cursor; connection string in `.cursor/mcp.json` is version-controlled; supports SELECT queries out of the box; one entry per database
- **Cons**: No built-in read-only enforcement at the MCP server level — relies on agent prompt instructions to restrict to SELECT; `npx` on every startup adds a small cold-start latency

### Option B: Dedicated read-only PostgreSQL role
- **Pros**: Database-level enforcement of read-only access (GRANT SELECT only); more secure
- **Cons**: Requires DBA action (CREATE ROLE, GRANT); adds operational complexity for a development tooling concern; not portable in `.cursor/mcp.json` without credential management

### Option C: No MCP — agents read SQL via shell commands
- **Pros**: No new dependencies
- **Cons**: Requires `psql` to be installed and on PATH in the agent environment; less ergonomic; no structured query result format for agents

## Decision

We choose **Option A: MCP server via `@henkey/postgres-mcp-server`** because:

1. The existing `.cursor/mcp.json` already defines both MCP servers — this decision documents and formalizes what is already in place.
2. `npx` execution requires no global installation and keeps the tool dependency in the npm registry rather than the machine.
3. Agent prompt-level READ-ONLY enforcement (documented in `.cursor/skills/securos-log-registry/SKILL.md` and in each agent's system prompt) is sufficient for our threat model — these are development/ops tools used by the engineering team, not an untrusted third party.
4. Two separate MCP servers for `tahakom_transfer` and `auto` allow agents to query each database independently, following the principle of least privilege at the connection level.

## Consequences

**Positive**:
- Any Cursor agent can query `tahakom_transfer` for operational diagnostics without SSH/psql access
- The `postgresql-securos_auto-mcp` server provides a safe way to inspect the `auto` database content (see O-2 in PROJECT_MAP.md) without risking accidental data modification
- MCP configuration is version-controlled in `.cursor/mcp.json` — consistent across all developer machines

**Negative / Trade-offs**:
- No database-level read-only enforcement — an agent that ignores its prompt constraints could execute mutating SQL. This is a trust-based control, not a technical one.
- `@henkey/postgres-mcp-server` is a community package — its availability and maintenance should be monitored; pin to a specific version in a future iteration if stability becomes a concern
- `npx` requires internet access on the machine to download the package on first run (or cache it)

**Risks**:
- If an agent is misconfigured or a prompt injection occurs, destructive SQL could be executed via MCP. Mitigation: agent system prompts explicitly state "SELECT only via MCP"; the engineering-ops-agent SecurOS mode documents this constraint in `.cursor/skills/securos-log-registry/SKILL.md`.
- Connection string contains credentials in plaintext in `.cursor/mcp.json` — acceptable for a local development environment with local PostgreSQL using default credentials, but must be changed before any network-exposed deployment.

## References

- `.cursor/mcp.json` — MCP server configuration
- `.cursor/skills/securos-log-registry/SKILL.md` — SecurOS mode agent constraints (includes MCP read-only rule)
- `.cursor/agents/engineering-ops-agent.md` — agent that uses tahakom_transfer MCP most heavily
- `.cursor/agents/architecture-data-agent.md` — agent that uses both MCP servers for schema analysis
- See also: ADR-0001 (PostgreSQL as source of truth)

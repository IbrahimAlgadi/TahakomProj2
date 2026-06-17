---
name: slow-query-audit
description: Systematic codebase audit for N+1 queries, missing pagination, missing select, GraphQL field-resolver N+1, JSON-path scans, and other TypeORM/Postgres performance anti-patterns. Use when the user asks to find slow queries, audit DB performance, scan for N+1, review database access patterns, hunt for slow endpoints, or update SLOW_QUERIES_MAP.md.
---

# Slow Query Audit Protocol

Produces or updates `SLOW_QUERIES_MAP.md` at the repo root with a prioritized, evidence-backed list of database performance issues across all `*.service.ts` and `*.resolver.ts` files.

## Workflow

### Phase 1 — Scope & parallel scan

1. List top-level modules under `src/` (e.g. `core`, `vendor`, `shifter`, `payment_transaction`, `notification`, `feedback`, `foodics`, `news-feed`, `location`, `content`, `common`, `marketplace`, `announcement`).
2. Group modules into batches of ≤ 5.
3. Spawn ONE `explore` subagent per batch in parallel — single message, multiple `Task` tool calls. Each subagent receives the pattern checklist in Phase 2 verbatim and the reporting format in Phase 3.
4. Wait for all subagents to finish (use `AwaitShell` for polling between checks).

### Phase 2 — Pattern checklist (give to every subagent verbatim)

For every `*.service.ts` and `*.resolver.ts`, look for:

| # | Pattern | What to find |
|---|---------|--------------|
| 1 | N+1 query | `for` / `forEach` / `map(async)` with `await repo.*` or `await manager.*` inside |
| 2 | Concurrent N+1 | `Promise.all(...map(async i => await repo.*))` |
| 3 | Unbounded list | `repo.find({...})` / `qb.getMany()` with no `take` / `limit` |
| 4 | Reload anti-pattern | `await save(...)` immediately followed by `findOne(saved.id)` |
| 5 | Count-loop | `for (const x of enumValues) await repo.count(...)` |
| 6 | Double round-trip | `getCount()` and `getMany()` on the same QB |
| 7 | Full entity for few fields | `findOne` without `select` where caller only reads 1–3 fields |
| 8 | Filter-in-JS | `find(broadWhere)` followed by `.filter(...)` in app code |
| 9 | GraphQL field N+1 | `@ResolveField()` issuing `repo.*` without DataLoader |
| 10 | JSON-path / ILIKE no index | `#>>`, `LIKE '%...%'`, `ILIKE` on non-indexed columns |
| 11 | Bulk in loop | `for (...) await repo.save(one)` / `await manager.update(one)` |
| 12 | Sequential `findOne` chain | 3+ awaited reads that could be one JOIN |
| 13 | Long write-TX across HTTP | `dataSource.transaction` wrapping an external API call |
| 14 | Cron scans full table | `@Cron` handler calling `find()` without `take` |

### Phase 3 — Finding format (every finding)

```
### [Pn-i] <one-line title>

**File:** <relative path>
**Lines:** ~<start>–<end>
**Pattern:** <category # from checklist>

<literal code snippet showing the issue, no paraphrasing>

**Why slow:** <one sentence>
**Fix:** <concrete remediation>
```

### Phase 4 — Prioritization rubric

- **P0** — On a hot path (checkout, auth, list endpoint, cron run frequently) AND causes N×K queries where K grows with data
- **P1** — On admin/bulk path OR causes N queries with bounded K OR GraphQL field N+1
- **P2** — Hygiene (`getManyAndCount`, `select` narrowing, reload anti-pattern, getCount+getMany duplicates)

### Phase 5 — Output structure

`SLOW_QUERIES_MAP.md` must contain in this order:

1. **Header** — audit date, scope, method, legend
2. **Quick-reference counts** — pattern → count table
3. **P0 / P1 / P2 sections** in priority order, each finding using the Phase 3 format
4. **Acceptable patterns** — explicitly list things that LOOK risky but aren't (DataLoader-backed resolvers, bounded `Promise.all` with `pLimit`, external API loops, paginated external sync, etc.) to prevent re-flagging
5. **Remediation roadmap** — table with priority, batch, effort (S/M/L), impact

## Rules during audit

- READ files; never modify.
- Cite exact line numbers (or `~` ranges) — vague references are rejected.
- Include the literal code snippet for every finding; no paraphrasing.
- If unsure whether a pattern is bad, mark it `P2` with the uncertainty noted — never silently drop it.
- Reuse subagents via `resume` to ask for clarification rather than re-scanning from scratch.
- Run targeted `Grep` searches yourself in parallel with the subagents to catch patterns they might miss (especially patterns 1, 6, 9, 11).

## Updating an existing SLOW_QUERIES_MAP.md

- Diff against git history to identify likely-fixed items.
- Mark fixed items with `~~strikethrough~~` and the commit hash; do NOT delete them.
- Add a "Recently resolved" section at the bottom.
- Re-run the full scan; don't trust the previous map's coverage.

## Companion artifact

Once issues are mapped, recommend the user check `.cursor/rules/typeorm-query-performance.mdc` — that rule prevents new violations of the same patterns at write-time.

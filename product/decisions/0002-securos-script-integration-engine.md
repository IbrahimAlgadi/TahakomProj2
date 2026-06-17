# ADR-0002: Run Capture Logic as SecurOS Scripts, Not as External Node.js Services

## Status

Accepted

## Date

2026-06-17

## Context

ALPR image capture must react to SecurOS events (`CAR_LP_RECOGNIZED`, `EXPORT_DONE`, `EXPORT_FAILED`) and invoke SecurOS actions (`IMAGE_EXPORT`, `EXPORT` reaction). These events and actions are only accessible through the SecurOS object model and event bus, exposed via the proprietary `securos` module injected by the SecurOS Script Integration Engine.

The question is: where should the capture and export lifecycle code live?

Constraints:
- The `securos` module is only available inside the SecurOS Script Integration Engine process
- SecurOS scripts run under the SecurOS-bundled Node.js runtime: `C:\Program Files (x86)\ISS\SecurOS\bin64\node.js\bin\node.exe`
- Scripts cannot be run with plain `node script.js` outside of SecurOS
- Scripts are deployed by copying files to the SecurOS machine and loading them via the SecurOS UI

## Options Considered

### Option A: SecurOS Script Integration Engine (chosen)
Run all capture and export lifecycle logic as SecurOS scripts (`.js` files loaded by SecurOS).
- **Pros**: Native access to `securos` event bus and object model; no inter-process communication needed for events; directly dispatches `IMAGE_EXPORT` reactions; event-driven (no polling)
- **Cons**: Cannot be unit tested outside SecurOS runtime; deployment requires manual copy + reload via SecurOS UI; limited to the SecurOS Node.js runtime version; no PM2 management

### Option B: External HTTP/WebSocket bridge from SecurOS scripts to a separate Node.js service
SecurOS scripts listen to events and forward them to a standalone Node.js service via HTTP or WebSocket; the standalone service processes them.
- **Pros**: Standalone service can be PM2-managed and unit tested normally
- **Cons**: Adds network latency to every plate recognition event; two hops for every image export (SecurOS → bridge → service → SecurOS back for IMAGE_EXPORT dispatch); additional failure point; serialization overhead; more complex retry handling

### Option C: SecurOS macro/built-in export rules (no scripts)
Use SecurOS's built-in image export rules without any custom scripting.
- **Pros**: No code to maintain; supported by ISS
- **Cons**: Cannot perform DB writes; no custom retry logic; no FIFO/retention governance; no audit trail in PostgreSQL; cannot integrate with the PM2 transfer services

## Decision

We choose **Option A: SecurOS Script Integration Engine** because:

1. The `securos` module is the only way to reliably receive ALPR events and dispatch `IMAGE_EXPORT` reactions synchronously within the SecurOS event loop. Option B introduces a network hop that adds latency and a failure point on every plate recognition.
2. The SecurOS Script Integration Engine is the correct architectural boundary for anything that needs to talk to SecurOS objects. Our scripts are essentially event handlers — keeping them inside SecurOS's own runtime is the simplest, most reliable design.
3. Option C has no path to the PostgreSQL audit trail, which is a hard requirement (every capture must be recorded).

## Consequences

**Positive**:
- Zero inter-process communication overhead for the hot path (plate recognition → image export)
- Load balancing across multiple `IMAGE_EXPORT` objects is straightforward (iterate `core.getObjectsIds('IMAGE_EXPORT')`)
- `ClusterStatusMonitorScript.js` can monitor PM2 services from within SecurOS using the bundled PM2 binary

**Negative / Trade-offs**:
- Scripts cannot be tested outside SecurOS (no `securos` module available in a plain Node.js environment)
- Deployment is manual: edit file in repo → copy to SecurOS machine → reload in SecurOS UI → confirm in SecurOS logs
- The SecurOS Node.js runtime version is fixed and may lag behind current Node.js LTS

**Risks**:
- A bug in a SecurOS script can cause the entire SecurOS Script Integration Engine to fault; scripts must handle all exceptions internally
- SecurOS runtime upgrades may break scripts if the bundled Node.js version changes significantly

## References

- `securos-scripts/README.md` — deployment and runtime documentation
- `securos-scripts/*.js` — all six capture/governance scripts
- `.cursor/skills/securos-log-registry/SKILL.md` — log path registry + SecurOS mode constraints
- See also: ADR-0001 (PostgreSQL integration layer)

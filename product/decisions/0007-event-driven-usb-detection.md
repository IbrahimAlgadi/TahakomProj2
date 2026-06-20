# ADR-0007: Event-driven USB Drive Detection

## Status

Accepted

## Date

2026-06-20

## Context

`monitorConnectedExternalDrivesMicroservice.js` was implemented as a tight `while (true)` loop that called `systeminformation.blockDevices()` once per second plus `si.fsSize()` sequentially for every external drive per iteration. On Windows, `si.blockDevices()` spawns a PowerShell process that runs WMI/CIM disk-topology queries, typically taking 1–3 seconds per call. As a result:

1. **Plug latency**: A newly inserted USB drive could take 3–10 seconds to appear in the device list (WMI spawn + N × `fsSize` calls + Redis publish + WebSocket push).
2. **Unplug latency**: Same overhead — the drive disappeared from the OS but the loop had to complete its current `blockDevices()` call before detecting the absence.
3. **Correctness bug**: The inaccessible-drive guard used falsy checks (`!fs.used`, `!fs.available`), which incorrectly cached a valid but nearly-empty or full USB as inaccessible for 30 seconds, doubling the apparent latency for many real drives.

The system already depended on `systeminformation` for drive space data, so that call could not be eliminated; the goal was to stop running it on a fixed 1-second clock and instead run it only when the OS signals a device change.

## Options Considered

### Option A: Keep 1-second polling
- **Pros**: No new dependency; current code.
- **Cons**: Detection latency remains 3–10s; WMI spawn runs every second unconditionally; bug not fixed.

### Option B: Replace systeminformation with `drivelist` (Balena) polling
- **Pros**: `drivelist` is faster than `si.blockDevices()` for enumeration.
- **Cons**: Still polling-based; adds a dependency to replace one; detection latency is still bounded by the poll interval rather than the OS event.

### Option C: WMI event subscription via long-lived PowerShell process
- **Pros**: True OS-level hotplug signal; no native Node build.
- **Cons**: Requires spawning and parsing a persistent PowerShell child process; fragile IPC; no npm package; harder to maintain and test.

### Option D: `usb@2.x` (node-usb/node-usb, libusb) — `usb.on('attach'/'detach')`
- **Pros**: Established API matching the linked migration guide; well-documented.
- **Cons**: `usb@2.x` requires a node-gyp native build (C++ + Python + VS Build Tools) at install time on the production machine; no prebuilt binary available for all Node versions; adds build-time risk on the locked SecurOS Windows environment.

### Option E: `usb@3.0.0` (node-usb-rs, NAPI-rs + Rust nusb) — `usb.addEventListener('connect'/'disconnect')`
- **Pros**: Ships prebuilt NAPI binary (`@node-usb/usb-win32-x64-msvc`) — zero build-time native tooling required; NAPI is Node-ABI-stable so the binary works across Node versions; loads cleanly on the SecurOS-bundled Node v22.11.0 / ABI 127; near-instant OS hotplug signal; no exclusive driver claim (we only listen for events, never `device.open()`).
- **Cons**: `connect`/`disconnect` events must be verified empirically for USB mass-storage (which uses `usbstor.sys`, not WinUSB) — the library fires events for all libusb-observable devices, and mass-storage visibility is unconfirmed at decision time; mitigated by 15s safety-net poll (see Consequences).

## Decision

We choose **Option E** (`usb@3.0.0` WebUSB event-driven + hybrid safety-net) because:

1. **Prebuilt binary eliminates build-time risk** on the locked production machine — the most critical constraint in this environment.
2. **NAPI ABI stability** means the binary will continue to load as SecurOS updates its bundled Node.js runtime.
3. **Near-instant detection** is the primary goal; the 400/1200/3000ms staggered reconcile schedule absorbs Windows' drive-letter assignment delay after plug, making appearance latency sub-2-second in practice.
4. **Non-breaking fallback**: the `require('usb')` call is wrapped in `try/catch`; if the native module ever fails to load, the service falls back to the original 1-second polling loop automatically — the system can never be worse than before.
5. **Safety-net poll** (15s `setInterval`) covers non-USB removable media, any USB mass-storage device that does not trigger libusb-level events, and periodic space/uptime refresh — making the event-driven path non-critical-path.

The concurrent correctness bug (falsy `fs.used`/`fs.available` guard) is fixed as part of the same change: the guard is changed from `!fs.size || !fs.used || !fs.available` to explicit nullish checks (`== null`), so a valid but empty or full USB is never wrongly cached as inaccessible.

## Consequences

**Positive**:
- USB drive appearance latency drops from ~3–10 seconds to ~1–2 seconds under normal conditions.
- USB drive disappearance latency drops similarly.
- CPU/WMI overhead reduced: `si.blockDevices()` now runs on-demand (on events + every 15s) instead of every 1 second continuously.
- The "full or empty USB incorrectly hidden for 30s" bug is eliminated.

**Negative / Trade-offs**:
- `usb` is a new runtime dependency (3 packages: `usb`, `@node-usb/usb-win32-x64-msvc`, `@types/w3c-web-usb`).
- USB mass-storage hotplug event reliability on Windows is empirically assumed (must be validated on the target machine by physically plugging/unplugging a USB stick and observing the console output of the smoke-test command in the verification section of the plan).
- `usb@3.0.0` uses the WebUSB `addEventListener` API, not the `usb.on('attach')` API from the v2 migration guide that motivated this change — the v3 API was installed by npm and documented accordingly.

**Risks**:
- If the `usb` native module fails to load silently (returns a non-throwing but non-functional stub), hotplug events would not fire and the safety-net 15s poll would become the primary detector. Mitigated: the startup log line `[USB] usb@3 loaded successfully — event-driven mode active` vs `[USB] usb@3 native module failed to load — using 1s poll fallback` makes the mode observable in PM2 logs.

## References

- `monitorConnectedExternalDrivesMicroservice.js` — refactored service
- [node-usb-rs README](https://github.com/node-usb/node-usb-rs) — `usb@3.x` (NAPI-rs rewrite)
- [node-usb v2 migration guide](https://github.com/node-usb/node-usb#migrating-from-node-usb-detection) — v2 API reference (not what was installed)
- `product/technical/services.md` — updated service entry
- `product/technical/architecture.md` — updated Drive State section
- See also: ADR-0003 (PM2 microservice topology), ADR-0004 (Redis state and pub/sub)

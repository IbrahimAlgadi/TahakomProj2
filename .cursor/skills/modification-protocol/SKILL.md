---
name: modification-protocol
description: Strict Staff Engineer surgical editing protocol for modifying existing features without regressions. Use when the user asks to modify, change, edit, patch, tweak, or surgically update existing code; mentions surgical edits, minimal-diff changes, no-refactor modifications, impact analysis, PROJECT_MAP.md updates for changes, TDD on a change, or wants to implement a feature/modification while preserving existing behavior. Enforces touch-only-what-must-be-touched, exact style matching, footprint-only cleanup, DRY/Shared-layer reuse, logging, Verifiable Goals with TDD and No Regression, and live PROJECT_MAP.md state synchronization.
---

# Enhanced Modification Prompt (Surgical Editing Protocol)

[Role & Mission]
You are a Staff Software Engineer. Your task is to perform surgical modifications to the project in order to implement the following change (without breaking existing features):

[Feature / Modification Description]

[Surgical Change Rules]

Touch only what must be touched:
Do not reformat adjacent code.
Do not rewrite old comments.
Do not refactor working code unless explicitly requested.
Style Matching:
Follow the existing code style exactly, even if you personally consider it suboptimal.
Clean Up Only Your Own Footprints:
If your modification causes a function or import to become orphaned, remove it.
Do not touch pre-existing dead code.

[Analysis & Execution Protocols]

Protocol 1: Impact Analysis

Read PROJECT_MAP.md.
Precisely identify all affected files.
Research the latest technologies if necessary.

Protocol 2: Architectural Safety & Abstraction

Follow the DRY principle (Do Not Repeat Yourself).
Reuse the Shared/Core layer when appropriate.
Add logging support for the new modification.

Protocol 3: Verification & Goal-Driven Success

Convert the modification into a “Verifiable Goal.”
Write the test first, confirm it fails, then make it pass (TDD).
Ensure all previous feature tests continue to pass (No Regression).

Protocol 4: State Synchronization

Update PROJECT_MAP.md immediately.
Any code that becomes deprecated due to your modification must either be addressed or recorded under pending issues.

[Execution Command]

Execute the protocols continuously. Start with impact analysis and explicitly state assumptions (“Think Before Coding”), then proceed directly into surgical implementation.

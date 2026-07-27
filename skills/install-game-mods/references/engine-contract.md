# Installation Engine Contract

## Runtime objects

The installation backend owns six distinct objects:

| Object | Purpose | Lifetime |
|---|---|---|
| Package Analysis | Identifies package units, roots, identities, entry files, dependencies, and ambiguity. | Analysis/planning |
| Install Plan | Freezes exact source, instance, Adapter, target operations, conflicts, and pre-state. | Review/apply/audit |
| Transaction Journal | Records operation intent, writes, backups, verification, rollback, and recovery state. | Transaction/audit |
| Installation Record | Records what was actually committed and which files are owned. | Durable |
| Backup Object | Stores a verified preimage needed for recovery or later uninstall. | While referenced |
| Current-State Inspection | Compares current disk state with the committed post-state. | Verify/uninstall planning |

These are not a persistent per-Mod Recipe system. Analysis identifies, Plan controls one attempted mutation, Journal recovers incomplete work, and Installation Record is the durable authority.

## Invariants

- Archive and receipt paths must be absolute and refer to the same verified Nexus file.
- The engine supports only declared archive formats and rejects traversal, links, collisions, encryption, and resource-limit violations.
- Game writes are restricted by a versioned Game Profile.
- One deterministic Adapter must own planning.
- A Plan is immutable, hash-bound, expiring, and bound to source hash, staging tree, game instance, Adapter, and target pre-state.
- Apply accepts only `planId`.
- Apply revalidates the receipt, Archive, Plan, staging, game processes, instance lock, and target pre-state.
- The engine journals intent before writes and verifies post-state before committing an Installation Record.
- Failed apply attempts roll back automatically when the pre-state can be proven.
- Installation Records describe actual outcomes, not merely planned operations.
- A future uninstall must derive a new plan from the Installation Record and current-state inspection; it must not blindly reverse an old Plan.

## Confirmation

Inspection and probing are read-only. Planning writes manager-owned state but not the game. Applying writes the game and requires explicit approval of the returned plan summary.

Approval must refer to the current `planId` or unmistakably to the plan just displayed. Regenerate and re-review expired or stale plans.

## Forbidden substitutions

Never bypass the engine with:

- Shell or generic filesystem copy, move, extraction, deletion, or overwrite.
- Agent-authored target paths or operation arrays.
- Editing Plan, Journal, Record, backup, context, or lock files.
- Treating a recovery tool as uninstall.
- Claiming runtime success from static file presence.

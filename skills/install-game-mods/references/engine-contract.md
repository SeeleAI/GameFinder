# Installation Engine Contract

## V2 planning objects

| Object | Purpose | Lifetime |
|---|---|---|
| Evidence Pack | Immutable source, Archive, package, dependency, and provenance evidence. | Planning/audit |
| Dynamic Game Context | Evidence-backed game identity, exact root, loaders, processes, and path boundaries. | Planning/audit |
| Installation Method | Reusable, revisioned installation knowledge. | Durable |
| Install Proposal | One evidence-bound candidate strategy produced by a Method or Agent. | Planning/audit |
| Install Plan V2 | Frozen operations, pre-state, conflicts, risk, reversibility, and approval digest. | Review/apply/audit |

## Retained transaction objects

| Object | Purpose | Lifetime |
|---|---|---|
| Transaction Journal | Records intent, writes, backups, verification, rollback, and recovery. | Transaction/audit |
| Installation Record | Records what actually committed and which paths are owned. | Durable |
| Backup Object | Stores verified pre-state needed for recovery or uninstall. | While referenced |
| Current-State Inspection | Compares current disk state with the committed post-state. | Verify/uninstall planning |

These are not persistent per-Mod Recipes. Method captures reusable knowledge; Proposal and Plan control one attempt; Record remains the durable uninstall authority.

## Invariants

- Archive and receipt are absolute, hash-verified, and identify the same Nexus file.
- Dynamic writable roots are evidence-backed and bounded; protected roots cannot be overridden.
- A missing prewritten Adapter is not a planning failure.
- Proposal validation is deterministic and cannot write the game.
- Plan V2 is immutable, expiring, and hash-bound to Evidence, Context, strategy, operations, and pre-state.
- Apply accepts only `planId`.
- Game writes run through locks, process guards, backups, journals, verification, and automatic rollback.
- A controlled installer runs only from verified staging through a fixed runtime with no shell, a minimal environment, a timeout, frozen arguments, declared write-root snapshots, and complete game-root side-effect comparison.
- An undeclared change can never be accepted as success. Declared roots are restored when possible and the record becomes `recovery_required` when out-of-scope state cannot be proven restored.
- Installation Records describe actual outcomes.
- Uninstall derives a new plan from the Record plus current state; it never blindly reverses an old Plan.

Inspection, context probing, Evidence preparation, Proposal validation, and Plan freezing may write manager-owned state but do not modify the game. Apply requires explicit approval of the exact displayed Plan.

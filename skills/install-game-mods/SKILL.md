---
name: install-game-mods
description: Install verified downloaded game Mods through the evidence-driven Contract V2 workflow in nexus-mods-server MCP. Use when the user explicitly asks to install one Archive plus its matching Nexus receipt or a dependency-aware Mod Bundle Manifest. Build a Dynamic Game Context, reuse a verified Method when available, otherwise research and submit a bounded Agent Proposal, freeze an immutable Install Plan, classify it as auto_safe, review_required, or blocked, and apply auto_safe Plans without an extra approval turn. Do not use for Mod discovery, downloading, manual extraction, Vortex import, Mod development, or uninstalling a committed Mod.
---

# Install Game Mods

Install verified material through a reviewable transaction. Keep inspection, staging, game writes, backups, verification, and recovery inside nexus-mods-server MCP.

Explicit `$install-game-mods` invocation is the stable production entry point. Automatic triggering is optional.

## Inputs

Accept one exact Archive plus its matching `.nexus-receipt.json`, or one verified Bundle Manifest. Require the exact target `game_root`. A registered `profile_id` is useful but no longer mandatory: an unseen game may use an evidence-backed Dynamic Game Context.

If verified download material is missing, hand off to `download-nexus-mods`. Download completion supplies material but does not by itself authorize installation beyond the user's explicit request.

Read:

- [references/agentic-v2-sop.md](references/agentic-v2-sop.md) for the required Contract V2 sequence.
- [references/bundle-contract.md](references/bundle-contract.md) for dependency ordering.
- [references/engine-contract.md](references/engine-contract.md) for object ownership and safety.
- [references/routing-boundaries.md](references/routing-boundaries.md) for combined requests.
- [references/result-contract.md](references/result-contract.md) before reporting.

## Core behavior

1. Call `list_game_profiles`, then establish a Dynamic Game Context. Use a matching `legacyProfileId`; use explicit identity only for an unregistered game.
2. Prepare an immutable Evidence Pack for each verified Archive.
3. Query reusable installation Methods and obey `proposalReadiness.recommendedAction`. For `select_verified_method`, call `instantiate_install_method` with the exact candidate binding and current package unit; never reconstruct its operations by hand.
4. Submit a Proposal only when the result permits it. Never invent a package unit. If no Method matches, research only what is needed and submit either a bounded file Proposal or one controlled-installer Proposal according to `recommendedAction`. Do not ask the user to develop an Adapter.
5. Call `freeze_install_plan` with `reviewMode: "auto_safe"`, then show its source, selected package, exact game root, strategy, target operations, conflicts, risk, reversibility, `planId`, expiry, and returned `review` object.
6. Follow `review.nextAction`: continue in the same turn for `apply_now`, stop for confirmation on `request_confirmation`, and stop without applying on `stop`. Do not override the server's classification locally.
7. Apply with only `planId`. For a file execution, verify the resulting legacy `installationId`; for a controlled installer, inspect its V2 Installation Record, static verification, observed changes, recovery state, and refreshed Game Context. Review `methodLearning`: a successful Agent Proposal should return a `local_verified` Method plus a successful Method Outcome; a reused Method should append a new Outcome without creating a Mod-specific duplicate.

For Bundles, process required dependencies in `installOrder`. Freeze, classify, apply, and verify one current Plan at a time; do not classify later nodes from an earlier filesystem state.

## Review policy

Default every valid frozen Plan to `auto_safe`. Keep that classification when the Plan exactly implements the user's install request, has no unresolved choice or blocker, stays inside evidence-backed writable roots, and uses reversible transaction safeguards.

Use `review_required` only when at least one material condition is present:

- the user asked to inspect the Plan before writes;
- package, target, dependency scope, or strategy requires a user choice;
- the Plan uses `run_bundled_installer`, replaces an existing file, reports high risk, or cannot prove bounded reversible side effects;
- the Plan introduces a target or operation not reasonably implied by the explicit install request.

Use `blocked` for MCP blockers, protected paths, unresolved conflicts, missing capabilities, running game processes, unverifiable evidence, or recovery-required state. Never relabel a blocker as `review_required` or `auto_safe`.

After expiry, staleness, or replanning, display and classify the new Plan. Continue automatically when the new Plan is still `auto_safe`; never transfer an earlier classification without re-evaluation.

M2 executes bounded whole-tree and source-to-target file mappings without a prewritten Adapter. This includes manifest-free `root-overlay` packages, but only through exact writable paths and reviewable `ensure_directory`, `install_new_file`, or backup-backed `replace_file` operations. M3 additionally executes one evidence-hashed bundled installer through a fixed runtime, minimal environment, timeout, declared write roots, pre-state snapshots, backups, complete game-root side-effect observation, and bounded recovery. A controlled-installer Proposal is always high risk and must declare the smallest justified write roots and required postconditions.

## Hard boundaries

Never copy, extract, execute, delete, overwrite, edit, or reconstruct game operations using shell, Python, browser automation, or generic filesystem tools.

Apply accepts only:

```text
apply_agentic_install_plan(planId)
```

Use `rollback_mod_install(transactionId)` only for incomplete transaction recovery, never as uninstall. Distinguish static verification from runtime verification and never claim in-game success when runtime verification is `not-run`.

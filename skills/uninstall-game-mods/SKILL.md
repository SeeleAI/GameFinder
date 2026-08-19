---
name: uninstall-game-mods
description: Safely inspect, plan, execute, and verify removal of a committed managed file Mod through nexus-mods-server MCP. Use when the user explicitly asks to uninstall, remove, or clean up a Mod previously installed by install-game-mods and identifies it by Installation ID or by an exact canonical Nexus Mod URL plus game root. Enforce active-dependent and dirty-file blockers, preserve unmanaged generated data, classify immutable Uninstall Plans as auto_safe, review_required, or blocked, and apply auto_safe Plans without an extra approval turn. Do not use for discovery, downloading, installation, failed-install rollback, manually installed or untracked Mods, controlled bundled installers, loaders/runtimes, or deleting arbitrary game files.
---

# Uninstall Game Mods

Remove a committed managed file Mod through a reviewable inverse transaction. Keep dependency checks, filesystem inspection, planning, writes, backups, and verification inside nexus-mods-server MCP.

Explicit `$uninstall-game-mods` invocation is the stable entry point. Never substitute shell deletion.

## Inputs

Prefer one exact `installationId`. If the user supplies a canonical Nexus Mod URL instead, require the exact game root and call `find_installed_nexus_mod`; continue only when one active file-transaction record is unambiguous. Ask the user to choose when multiple active installations match.

Read:

- [references/mcp-uninstall-sop.md](references/mcp-uninstall-sop.md) for the mandatory tool sequence and blocker handling.
- [references/scope-boundaries.md](references/scope-boundaries.md) before handling loaders, controlled installers, untracked files, or combined requests.
- [references/result-contract.md](references/result-contract.md) before displaying a classified Plan or reporting completion.

## Core behavior

1. Resolve the exact active managed file Installation Record without guessing an ID.
2. Call `inspect_mod_uninstall(installationId)`.
3. Stop on every blocker. Never override `DEPENDENTS_EXIST`, `INSTALLATION_DIRTY`, protected paths, replaced ownership, or an already-uninstalled state.
4. Call `plan_mod_uninstall(installationId, reviewMode="auto_safe")` only when inspection is eligible.
5. Call `get_mod_uninstall_plan(uninstallPlanId)` and present the exact stored actions, retained directories and files, target game root, record revision, plan ID, expiry, derived lifecycle, and review classification. Treat the immutable Plan's `status` as its creation status; use `lifecycle.state` for the current state.
6. Follow `review.nextAction`: continue in the same turn for `apply_now`, stop for confirmation on `request_confirmation`, and stop without applying on `stop`. Do not override the server's classification locally.
7. Apply using only `apply_mod_uninstall(uninstallPlanId)`. After expiry, staleness, or replanning, classify the new Plan instead of reusing the earlier decision.
8. Call `verify_mod_uninstall(installationId)`. Report success only when `passed` is true.

Dependency checks run again at apply time. Reject a Plan when a new dependent appears regardless of its earlier classification.

Generated configuration or other unmanaged data may remain. Report every `retainedFilePath` plus its retained parent path; never describe retained data as deleted.

## Review policy

Default every eligible frozen Uninstall Plan to `auto_safe` when it targets the uniquely resolved managed Installation Record, removes only owned files, restores only verified backup-backed paths, cleans only empty managed directories, preserves unmanaged data, and has no blockers.

Use `review_required` only when the user asked to inspect before writes, target resolution requires a material choice, or the displayed actions exceed the expected inverse of the managed Installation Record. Use `blocked` for active dependents, dirty managed files, protected or replaced ownership, unsupported record kinds, lifecycle inconsistency, running processes, or any MCP blocker. Never convert dirty-file or dependent blockers into approval questions.

## Hard boundaries

Never copy, delete, move, overwrite, restore, or inspect game files with shell, Python, browser automation, or generic filesystem tools as a replacement for MCP.

Apply accepts only:

```text
apply_mod_uninstall(uninstallPlanId)
```

`rollback_mod_install(transactionId)` repairs an incomplete installation transaction; it is not uninstall. Do not attempt cascade uninstall. Do not uninstall a loader/runtime or controlled-installer record with this version of the Skill.

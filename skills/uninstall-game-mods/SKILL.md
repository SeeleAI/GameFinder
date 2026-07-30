---
name: uninstall-game-mods
description: Safely inspect, plan, approve, execute, and verify removal of a committed managed file Mod through nexus-mods-server MCP. Use when the user explicitly asks to uninstall, remove, or clean up a Mod previously installed by install-game-mods and identifies it by Installation ID or by an exact canonical Nexus Mod URL plus game root. Enforce active-dependent and dirty-file blockers, preserve unmanaged generated data, and apply only an explicitly approved immutable Uninstall Plan. Do not use for discovery, downloading, installation, failed-install rollback, manually installed or untracked Mods, controlled bundled installers, loaders/runtimes, or deleting arbitrary game files.
---

# Uninstall Game Mods

Remove a committed managed file Mod through a reviewable inverse transaction. Keep dependency checks, filesystem inspection, planning, writes, backups, and verification inside nexus-mods-server MCP.

Explicit `$uninstall-game-mods` invocation is the stable entry point. Never substitute shell deletion.

## Inputs

Prefer one exact `installationId`. If the user supplies a canonical Nexus Mod URL instead, require the exact game root and call `find_installed_nexus_mod`; continue only when one active file-transaction record is unambiguous. Ask the user to choose when multiple active installations match.

Read:

- [references/mcp-uninstall-sop.md](references/mcp-uninstall-sop.md) for the mandatory tool sequence and blocker handling.
- [references/scope-boundaries.md](references/scope-boundaries.md) before handling loaders, controlled installers, untracked files, or combined requests.
- [references/result-contract.md](references/result-contract.md) before requesting approval or reporting completion.

## Core behavior

1. Resolve the exact active managed file Installation Record without guessing an ID.
2. Call `inspect_mod_uninstall(installationId)`.
3. Stop on every blocker. Never override `DEPENDENTS_EXIST`, `INSTALLATION_DIRTY`, protected paths, replaced ownership, or an already-uninstalled state.
4. Call `plan_mod_uninstall(installationId)` only when inspection is eligible.
5. Call `get_mod_uninstall_plan(uninstallPlanId)` and present the exact stored actions, retained directories and files, target game root, record revision, plan ID, expiry, and derived lifecycle. Treat the immutable Plan's `status` as its creation status; use `lifecycle.state` for the current state.
6. Stop for explicit approval of that exact `uninstallPlanId`.
7. Apply using only `apply_mod_uninstall(uninstallPlanId)`. Do not reuse approval after expiry, staleness, or replanning.
8. Call `verify_mod_uninstall(installationId)`. Report success only when `passed` is true.

Dependency checks run again at apply time. A Plan approved before a new dependent appears must be rejected.

Generated configuration or other unmanaged data may remain. Report every `retainedFilePath` plus its retained parent path; never describe retained data as deleted.

## Hard boundaries

Never copy, delete, move, overwrite, restore, or inspect game files with shell, Python, browser automation, or generic filesystem tools as a replacement for MCP.

Apply accepts only:

```text
apply_mod_uninstall(uninstallPlanId)
```

`rollback_mod_install(transactionId)` repairs an incomplete installation transaction; it is not uninstall. Do not attempt cascade uninstall. Do not uninstall a loader/runtime or controlled-installer record with this version of the Skill.

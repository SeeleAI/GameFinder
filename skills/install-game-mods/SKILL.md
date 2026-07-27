---
name: install-game-mods
description: Inspect, plan, apply, and verify downloaded game Mods through deterministic nexus-mods-server MCP installation tools. Use when the user explicitly invokes installation for either one verified Archive plus matching receipt or a dependency-aware Mod Bundle Manifest produced by download-nexus-mods. Require an exact target game root and explicit approval of each frozen Install Plan. Do not use for discovery, downloading, manual extraction, Vortex import, Mod development, arbitrary deployment, or uninstalling a committed Mod.
---

# Install Game Mods

Install one verified Archive or a verified dependency-aware Bundle through reviewable transactions. Keep extraction, game writes, backups, verification, and recovery inside MCP.

## Route and inputs

Explicit `$install-game-mods` invocation is the supported production path; implicit triggering is optional quality coverage, not an acceptance requirement.

Accept exactly one input form:

```yaml
single:
  archive_path: C:\absolute\path\mod.zip
  receipt_path: C:\absolute\path\mod.zip.nexus-receipt.json
```

or:

```yaml
bundle:
  bundle_path: C:\absolute\path\nexus-mod-bundle-<uuid>.json
```

Both require:

```yaml
game_root: C:\absolute\path\Game
profile_id: stardew-valley
```

Use `download-nexus-mods` when verified inputs are missing. Download completion is not installation approval.

Read:

- [references/bundle-contract.md](references/bundle-contract.md) for Bundle validation and ordering.
- [references/engine-contract.md](references/engine-contract.md) for immutable objects and safety.
- [references/mcp-install-sop.md](references/mcp-install-sop.md) for the exact tool sequence.
- [references/routing-boundaries.md](references/routing-boundaries.md) for combined Research, Download, and Install requests.
- [references/smapi-loader-adapter.md](references/smapi-loader-adapter.md) when a Bundle contains SMAPI.
- [references/result-contract.md](references/result-contract.md) before reporting.

## Verify the game and material

Call `probe_game_install(profileId, gameRoot)` for the exact instance.

For a single input, call `inspect_mod_archive`. For a Bundle:

1. Call `inspect_mod_bundle(bundlePath)`.
2. Stop if its hash, any receipt, or any Archive fails validation.
3. Stop on pending manual requirements.
4. Follow `installOrder`; never install the root before unresolved required dependencies.
5. For each `loader_runtime`, check the Game Profile before installation.

If SMAPI is already detected but its version is unknown, report that compatibility is unproven. If SMAPI is missing and no implemented Loader Adapter can produce a deterministic Plan, stop before installing dependent Mods. A downloaded SMAPI ZIP is not an installed runtime.

## Plan and approve each transaction

For each supported unsatisfied Archive in dependency order:

1. Call `inspect_mod_archive`.
2. Resolve package ambiguity and Adapter compatibility.
3. Call `plan_mod_install`.
4. Show source, game root, Adapter, target operations, conflicts, warnings, `planId`, and expiry.
5. Stop for explicit approval of that exact Plan.

Do not preapprove unseen plans for later Bundle entries. Generate a dependent Mod's Plan only after earlier dependency transactions finish, so pre-state remains current.

## Apply by planId only

After approval, call:

```text
apply_mod_install(planId)
```

Pass only `planId`. Never copy, extract, execute, delete, overwrite, edit, or reconstruct operations with shell, Python, browser automation, or generic filesystem tools.

On failure, report the stable code, transaction, rollback state, and next action. Use `rollback_mod_install(transactionId)` only for incomplete transaction recovery, never as uninstall.

## Verify and report

Call `verify_mod_install(installationId)` after every committed entry. Distinguish static verification from runtime verification. Never claim “working in game” when runtime verification is `not-run`.

For a Bundle, return per-node outcomes and stop the remaining sequence when any required dependency fails or remains unverified at a level required by its dependent.

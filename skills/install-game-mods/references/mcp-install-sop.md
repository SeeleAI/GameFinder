# MCP Installation SOP

## 0. Select input mode

For a Bundle, call `inspect_mod_bundle(bundlePath)` first and apply the Bundle Contract linked directly from `SKILL.md`. Process dependency-first entries one at a time through the remaining sections. Stop on pending manual requirements or an unsatisfied Loader Runtime without an implemented Adapter.

For a single Archive, begin with section 1.

## 1. Establish the target

Require:

- Absolute verified Archive path.
- Absolute matching `.nexus-receipt.json` path.
- Registered `profileId`.
- Exact verified game root.
- Explicit `packageUnitId` only when inspection reports multiple units.

If Archive and receipt are missing, stop and hand off to `download-nexus-mods`. Do not download inside this workflow unless the user separately requested that stage.

## 2. Profile and instance

1. `list_game_profiles` if profile identity is unknown.
2. `detect_game_installs(profileId)` for bounded conventional discovery only.
3. `probe_game_install(profileId, gameRoot)` for the selected root.

Stop on:

- `GAME_PROFILE_NOT_FOUND`
- `GAME_INSTANCE_NOT_FOUND`
- `GAME_INSTANCE_AMBIGUOUS`
- missing or ambiguous required loader

## 3. Archive and Adapter

1. `inspect_mod_archive(archivePath, receiptPath)`
2. Review source Mod/file identity, archive hash, package units, identities, dependencies, and ambiguities.
3. When needed, `match_install_adapters(archivePath, receiptPath, profileId, gameRoot)`.

Stop on receipt mismatch, unsupported/unsafe Archive, archive limits, no Adapter, or unresolved Adapter/package ambiguity. Do not infer a package root from file names when MCP declines to do so.

## 4. Plan

Call:

```text
plan_mod_install(
  archivePath,
  receiptPath,
  profileId,
  gameRoot,
  packageUnitId?
)
```

Validate:

- Source Mod ID/file ID and Archive hash match the selected download.
- Game root and profile match the intended instance.
- Adapter is supported and dependencies are present.
- Every target is under a declared writable root.
- No conflict is blocking.
- Plan has a UUID, hash, creation/expiry time, and `requiresExplicitApplyConfirmation=true`.

Show the plan and stop for approval. Do not call apply in the same turn that first reveals target writes unless the user had already approved that exact `planId`.

## 5. Apply

Call:

```text
apply_mod_install(planId)
```

No other argument is allowed. On success, require:

- `installationId`
- `transactionId`
- committed operation outcomes
- static verification passed
- explicit runtime-verification state

Then call:

```text
verify_mod_install(installationId)
```

## 6. Status and recovery

Use:

```text
get_install_status(kind, id)
```

where `kind` is `plan`, `transaction`, or `installation`.

Use:

```text
rollback_mod_install(transactionId)
```

only when apply reports an incomplete, failed, or recovery-required install transaction. It recovers journaled pre-state. For a terminal committed transaction it does not remove the installation.

## 7. Stable error handling

| Error | Response |
|---|---|
| `INPUT_RECEIPT_MISMATCH` | Use the exact Download archive and receipt; do not edit either. |
| `ARCHIVE_UNSUPPORTED` | Stop; do not convert or extract manually. |
| `ARCHIVE_UNSAFE` / `ARCHIVE_LIMIT_EXCEEDED` | Stop and report the safety evidence. |
| `DEPENDENCY_MISSING` | Report the missing loader/dependency; do not install it implicitly. |
| `ADAPTER_NOT_FOUND` / `ADAPTER_AMBIGUOUS` | Stop; request exact package choice or backend support. |
| `INSTALL_CONFLICT` / `PROTECTED_PATH` | Stop; report paths and current state. |
| `GAME_PROCESS_RUNNING` | Ask the user to close the named game/loader processes. |
| `PLAN_STALE` | Re-plan, display, and obtain new approval. |
| `LOCK_BUSY` | Wait for the active instance transaction. |
| `VERIFY_FAILED` | Do not claim success; inspect transaction and recovery result. |
| `ROLLBACK_FAILED` / `RECOVERY_REQUIRED` | Stop writes and recover by transaction ID. |

Use the server's `nextAction` when present. Never “fix” a deterministic refusal with manual filesystem operations.

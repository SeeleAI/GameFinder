# Scope Boundaries

## Supported

- A committed file-transaction Installation Record produced by the managed install engine.
- Exact owned-file removal.
- Backup-backed restoration of replaced managed paths.
- Empty-directory cleanup.
- Preservation and reporting of unmanaged generated data.
- Required-dependent blocking in the same game root.

## Unsupported

- A Mod installed manually, by Vortex, or by another manager without a compatible Installation Record.
- Controlled bundled-installer records, including loader/runtime installation records.
- Cascade uninstall.
- Arbitrary file cleanup or user-directed force deletion.
- Failed-install recovery; use the installation recovery workflow.
- Updating or reinstalling a Mod in the same transaction.

For a combined “uninstall old, install new” request, finish and verify the uninstall as one transaction, then hand off the new Archive or Bundle to `install-game-mods`. Classify each Plan separately from its current filesystem state; each `auto_safe` Plan may proceed without an extra confirmation turn.

If a target is a required dependency, keep it installed while any active dependent remains. Do not infer that an apparently unused shared loader is safe to remove.

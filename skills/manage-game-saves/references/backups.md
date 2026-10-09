# Independent backups and restore

Use `create_save_backup` with the specific `sourceRoot`, explicit relative `paths`, relevant `processNames`, and a description. Stop the identified writers cleanly first. It snapshots and verifies the selected files without importing anything. Retain the returned `backupId`, `backupRoot`, and file paths.

`get_save_backup(backupId)` rechecks the stored record and bytes, including after restart. Reading a backup does not require the game to remain installed.

For a requested restore, call `prepare_save_backup_restore(backupId)`; optionally supply a newly verified target directory or process names. Add concrete task evidence to the returned `restoreInput` (omit `evidence.installationRoot` if the installation is no longer present), then call `plan_save_import` and `apply_save_import`. This preserves the current selected files before restoring the snapshot. The snapshot covers only listed files and does not authorize deleting other saves.

For rollback of an existing import, use its `restore_save_import(planId)` directly instead of reconstructing a second restore workflow.

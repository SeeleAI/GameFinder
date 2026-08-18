# Backup, restore, and replacement transactions

## Backup

Call `create_save_backup(saveContextId, unitId, reason)` and then `verify_save_backup`. A successful record requires stable pre/post source snapshots, content-addressed objects, and a verified record hash. Use `acceptance_baseline` before risky acceptance work and `manual` for an ordinary user backup.

## Restore

1. Call `plan_save_restore` with the exact Backup, Save Context, target kind, and mode.
2. Display the immutable Restore Plan and obtain approval when the target is a real Save Context.
3. Re-fetch it with `get_save_restore_plan`; do not apply an expired or changed plan.
4. Call `apply_save_restore(restorePlanId)` only after approval and process shutdown.
5. Call `verify_save_restore(recordId)` and then record user runtime evidence separately.

## Replacement

Use `assess_save_package_compatibility` first. Same-account complete-container replacement may use `plan_save_replacement`. Game-specific conversion or slot import requires the corresponding adapter workflow; never downgrade unknown account binding to direct compatibility.

For any real replacement:

- Display source identity/hash, target prestate, exact operations and strategy.
- Require explicit approval of the exact Replacement Plan ID.
- Expect apply to create and verify `pre_replacement_rescue` before writing.
- Verify the committed record and preserve the rescue Backup ID.
- Ask for offline runtime verification and call `record_save_runtime_verification` with the user's observed outcome.

If runtime verification fails, retain diagnostics and plan a baseline restore. Do not silently retry a different source, slot, or target.

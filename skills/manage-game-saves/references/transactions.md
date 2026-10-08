# Backup, restore, and replacement transactions

## Backup

Call `create_save_backup(saveContextId, unitId, reason)` and then `verify_save_backup`. A successful record requires stable pre/post source snapshots, content-addressed objects, and a verified record hash. Use `acceptance_baseline` before risky acceptance work and `manual` for an ordinary user backup.

## Restore

1. Call `plan_save_restore` with the exact Backup, Save Context, target kind, mode, and `reviewMode: "auto_safe"`.
2. Display the immutable Restore Plan and complete returned `review` object. Treat `classification`, `reasonCodes`, `policyVersion`, `reviewDigest`, `nextAction`, and `requestScope` as authoritative.
3. Re-fetch it with `get_save_restore_plan`; do not apply an expired or changed plan.
4. Follow `review.nextAction`: call `apply_save_restore(restorePlanId)` immediately for `apply_now`, wait for confirmation on `request_confirmation`, and do not apply on `stop`. Always require process shutdown.
5. Call `verify_save_restore(recordId)` and then record user runtime evidence separately.

## Replacement

Use `assess_save_adapter_requirement` for the exact operation, then `assess_save_package_compatibility`. Same-account complete-container replacement may use `plan_save_replacement` only when both assessments permit it and their IDs/hashes are bound. Game-specific conversion or slot import requires the corresponding adapter workflow; never downgrade unknown account binding to direct compatibility.

For a V2 `replace-whole-unit` request, the Package file set is the exact desired final Save Unit: create Package paths that are absent, replace or preserve matching paths, and delete currently materialized managed files that are absent from the Package. Do not require source paths to already exist under the same target name. Every new exact path must first match the bound Recipe's managed patterns and be frozen in Compatibility and the Replacement Plan. Treat path-preserving overlay/merge and slot import as different operations; do not silently substitute either for whole-unit replacement.

Call `plan_save_replacement` (or the game-specific plan tool) with `reviewMode: "auto_safe"`. Pass `always_review` only when the user explicitly requests a preview/confirmation gate.

For any real replacement:

- Display source identity/hash, target prestate, exact operations and strategy.
- Default to `auto_safe` when source, target, account, slot, and strategy are unambiguous and the user requested the live replacement. Use `review_required` only for a material choice, missing overwrite consent, unexpected scope, or a user-requested preview.
- Expect apply to create and verify `pre_replacement_rescue` before writing.
- Verify the committed record and preserve the rescue Backup ID.
- Ask for offline runtime verification and call `record_save_runtime_verification` with the user's observed outcome.
- Treat apply-time static verification as evidence for the frozen post-state. After the user launches the game, a normal auto-save may legitimately change file hashes; record that post-launch drift separately instead of reclassifying the committed transaction as failed or overwriting the new live state merely to reproduce the old hash.

If runtime verification fails, retain diagnostics and plan a baseline restore. Do not silently retry a different source, slot, or target.

When acceptance began with an explicit requirement to restore the original baseline, classify the exact verified baseline Restore Plan as `auto_safe`. Expiry or prestate drift requires a new Plan and fresh classification, not another confirmation by default.

After baseline restore, verify exact hashes before launch and ask the user to confirm the original save in game. If the confirmation launch updates an auto-save, preserve it and record `original_restored` with the observed drift; do not perform another restore unless the user reports that the original state was not restored.

# Records from older GameFinder versions

Existing generic `plan_save_import` IDs remain readable and recoverable through `get_save_import` and `restore_save_import`.

For an old backup or operation, use `prepare_legacy_save_recovery` with its stable `recordId` and `kind: backup | operation | transaction`. It verifies historical hashes and backup blobs, exports actual source files, and returns `restoreInput` with the exact target and mappings. For operation recovery it also returns deletion paths supported by frozen pre-operation absence. V2 records used the V1 transaction bridge and share the same historical reader.

Add current relevant `processNames` and evidence, review the explicit scope, and pass the result to `plan_save_import` and `apply_save_import`. The new transaction backs up current files before recovery; unrelated files remain in place. An independent historical backup restores its listed files only and supplies no deletion authority.

Old research, registration and replacement plans cannot continue executing. Regenerate a current explicit plan from verified evidence. A hard interruption that left only a journal, without a finalized transaction and rescue linkage, may lack enough data for automatic recovery. Preserve the old data and report the exact missing record/blob/scope; do not infer deletion paths. A user can still identify a complete historical backup and restore its known files through the backup route.

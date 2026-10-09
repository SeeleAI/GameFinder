# Existing save interfaces

Read this only for standalone backup requests, known specialized games, or continuing an existing Context/Package/Backup/Replacement workflow. For a new ordinary import use the generic tools in `SKILL.md`; registered game knowledge is optional there.

## Discovery and backups

For a game supported by existing Recipes, `probe_save_game_install` -> `resolve_save_locations` yields a Save Context. Re-read it with `get_save_context` and resolve account ambiguity. The existing `begin_save_location_probe` / `complete_save_location_probe` tools require Recipe-derived roots and are not a fallback for unregistered games.

Use `create_save_backup` and `verify_save_backup` for an established Save Context. For a standalone backup of an unregistered game, locate and verify the file group from evidence, copy it to a separate backup directory while writers are stopped, and compare the exact source/backup file list and hashes. Record paths and scope; do not manufacture a legacy Backup ID. Restoring such a backup uses a generic import with explicit mappings.

For a legacy Backup ID, use `plan_save_restore`, inspect its returned review, then `apply_save_restore` and `verify_save_restore`. Follow `review.nextAction`: apply `apply_now` within the user's scope, seek the specified confirmation for `request_confirmation`, and stop for `stop`. The tool checks prestate, process guards, and verified rescue data.

## Packages and specialized replacement

When required by a specialized tool, inspect input then use `normalize_save_package` (or downloaded equivalents), and `verify_standard_save_package`. Normalization preserves bytes/provenance; it does not convert formats or prove compatibility.

The existing `assess_save_adapter_requirement` -> `assess_save_package_compatibility` -> `plan_save_replacement` chain retains its own eligibility and review rules. Bind the actual returned IDs/hashes and respect blockers. Do not reroute a demonstrated conversion requirement through generic copying; a legacy inability to classify otherwise evidenced whole-file copying can instead be addressed through the main generic evidence-based workflow.

V2 `replace-whole-unit` replaces the exact managed set, including deleting omitted managed files. Use it only when that full-set scope is intended; ordinary generic imports retain unmapped files. Elden Ring staged replacement has its own slot-preservation path.

Report committed file verification and runtime observations separately. Keep the imported result by default. Restore the original baseline only if requested or needed for failure recovery; retain current diagnostics/data before restoring. Respect later gameplay changes instead of overwriting them to reproduce earlier hashes.

---
name: manage-game-saves
description: Find, download, back up, import, and restore Windows game saves using local and web evidence plus GameFinder's reversible file tools. Use with a game name, installation root, and Nexus game page, or an existing save/archive. Handles whole-file imports, independent backups, historical recovery, and supported account conversion or character-slot merging. Not for game Mods, cloud-save administration, console saves, or gameplay-value editing.
---

# Manage Game Saves

Research the game and choose the save as an agent; use the MCP tools to stage, back up, import, verify, and recover files. A game name, installation root, and canonical Nexus game page are enough to begin.

Keep the imported result and its backup by default. A request to search and import authorizes routine candidate selection, download, backup, and the corresponding bounded file writes. Pause only for login, unresolved material choices, actual blockers, or an explicit confirmation requirement.

Read and retain every complete raw MCP result, including `structuredContent` and stable IDs, in the task's run record. Use returned IDs exactly; keep raw records separate from the concise user report.

## 1. Locate the target and select a source

- Cross-check installation/version/platform clues with save-location documentation and actual local files. Search likely Windows user directories and their redirected locations; the installation directory is an identity clue, not necessarily the save location. Resolve the target player and associated file group before writing. Modification time alone does not select among accounts.
- Research directly from the supplied `https://www.nexusmods.com/games/<slug>` using `resolve_game`, `search_mods`, `get_mod`, and `get_mod_files`. Read applicable requirements and import instructions. Local investigation and web research may proceed together.
- Exclude known version/platform conflicts and unavailable required DLC/Mods. Rank remaining candidates by supported completion and evidence. Separate main story, DLC, side quests, and collections where relevant; author claims and popularity are not runtime verification. For “as complete as possible,” choose the best evidenced applicable candidate and disclose gaps rather than inventing a 100% claim.
- When static research cannot locate the target, observe a small explicit set of likely directories before and after an authorized in-game save; compare actual changed files.

Finish with a specific target directory/player, selected source file, and documented import method. Do not install extra Mods, buy DLC, or change accounts as an incidental part of this task.

## 2. Download and inspect

For Nexus acquisition, read [nexus-download.md](references/nexus-download.md) before preparing the download. It contains the required full-result and same-session protocol, including login handling. For user-provided local input, start here directly.

Call `inspect_save_input` with `stage: true` to inspect and safely stage the archive, file, or directory away from live saves. Review the returned file list and actual contents to identify the intended payload and any companion files; do not execute included programs. Verify the downloaded file against its receipt. Resolve competing save variants before planning.

Preserving whole-file bytes normally uses the generic route below, including filename/directory remapping. Unknown binary internals or checksum algorithms alone do not require conversion. If evidence indicates account rebinding, slot merging, resigning, or format conversion, read [special-formats.md](references/special-formats.md) and complete that work before importing. No applicable import evidence is a research blocker; known conversion requirements cannot be ignored.

## 3. Plan and import

Call `plan_save_import` with:

- `inputPath`: the original inspected source (omit only for a justified deletion-only plan); `targetRoot`: the specific game/player save directory (or installation directory for evidenced install-local saves). Planning stages its own frozen copy, so mappings use paths relative to the original inspected payload. Keep original provenance in `evidence.source`.
- `mappings`: exact relative `sourcePath` to `targetPath` pairs, including required companion files. Omit unrelated archive contents.
- `deletePaths`: only explicitly justified removals, with `deletionReason`. Source omissions do not authorize deleting old saves; default to adding/overwriting mapped files.
- For a prepared Elden Ring conversion, retain its `preparationId` and exact returned input/target/mappings. The receipt binds the plan to the target state used during conversion.
- `processNames`: the actual game and any evidenced conflicting writer processes.
- `evidence`: `gameName`, the supplied `installationRoot` (optional for backup recovery), and concrete `source`, `target`, `compatibility`, and `method` explanations, plus `knownConversionRequired`. Include source URLs/version claims and local corroboration; unsupported assertions do not establish compatibility.

Review the returned exact operations for task scope. Stop relevant writers cleanly before apply. Address demonstrated cloud conflicts; local backups do not reverse remote state, and there is no blanket requirement to disable cloud or close every platform.

Apply the exact `planId` with `apply_save_import` when the task authorizes those operations and no material ambiguity remains. The tool freezes source bytes, checks target prestate, verifies backups, journals writes, and verifies the committed result. It must succeed before claiming file import. If state changed, inspect the difference before creating a fresh plan. Do not bypass a tool rejection with direct copying.

## 4. Verify and retain the result

Use `get_save_import(planId)` to read the durable status and backup/recovery information, including after a lost response. Do not create a new plan to blindly retry an uncertain write. For failed/interrupted operations, follow the returned recovery state; `restore_save_import(planId)` restores affected originals while preserving the recovery-time state and unrelated files.

Report file verification separately from game verification. When available and authorized, confirm the save is visible, loadable, and matches the requested progress in game; otherwise report the smallest remaining user check. Normal post-launch auto-saving is not evidence that file import failed. Keep successful imports. Restore only for user-requested rollback/temporary testing or failure recovery; preserve the current state before reverting runtime failures.

Give the selected source link and completion evidence, target, operation ID, backup location, file result, and runtime result/pending check. Keep internal hashes and raw MCP results in the run record rather than dumping them into the user summary.

For **backup-only or backup restore** requests, read [backups.md](references/backups.md). For **records created by older GameFinder versions**, read [historical-recovery.md](references/historical-recovery.md).

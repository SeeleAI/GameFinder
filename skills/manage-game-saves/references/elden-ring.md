# Elden Ring PC saves

The usual Steam Windows location is `%APPDATA%\EldenRing\<SteamID64>`; verify the actual player and redirected folder locally. The primary file is `ER0000.sl2`, with a game-created `.bak` companion and possible `steam_autocloud.vdf`. These names are research hints, not automatic permission to replace every file.

The built-in converter supports the 28,967,888-byte `BND4` PC container with ten slots and the established MD5 layout. It verifies length, signature, account binding, active-slot table, slot checksums and header checksum. Unsupported formats stop before live writes.

1. Call `analyze_elden_ring_save({filePath})` separately for source and target. Retain each `fileSha256` and examine active slots, character names, levels and play time.
2. Select source and destination indexes (zero-based). An unambiguous empty destination may be selected under the import request. Replacing an occupied character requires explicit user authorization for that character; do not ask again if already given.
3. Call `prepare_elden_ring_import` with `sourcePath`, `targetPath`, `sourceSha256` and `targetSha256` (from each analysis's `fileSha256`), and `slots: [{sourceSlot,targetSlot,allowOverwriteOccupied}]`. Conversion starts with target bytes, imports only selected slots, rebinds their account bytes, recomputes checksums, and verifies unchanged unselected slots. It only writes manager staging.
4. Pass its exact `preparationId`, `inputPath`, `targetRoot` and `mappings` into `plan_save_import`, adding current process names and evidence. Set `knownConversionRequired: false` only after this verified conversion. Do not re-stage or detach the output from its preparation. `get_elden_ring_preparation` recovers and verifies the receipt after restart.
5. Apply the returned generic plan. A changed destination after analysis/conversion requires fresh analysis and conversion; a changed destination after planning blocks apply. This prevents overwriting later progress with stale merged bytes.

Report file verification separately from in-game visibility/loading. Preserve the successful result and transaction backups. Author claims about online safety are not guarantees. Use `restore_save_import` for requested rollback or failed-import recovery, retaining the current state first.

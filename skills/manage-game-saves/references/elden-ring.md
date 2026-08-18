# Elden Ring Steam PC adapter

## Supported shape

- Game: Steam app `1245620`, Windows.
- Root: `%APPDATA%\EldenRing\<SteamID64>`.
- Primary: `ER0000.sl2`; companion: `ER0000.sl2.bak`; preserved auxiliary: `steam_autocloud.vdf`.
- Adapter: `elden-ring-steam-pc`.
- Supported first-version container: 28,967,888-byte `BND4`, ten slots, PC MD5 layout.

Reject any length, signature, account, active-table, boundary, slot checksum, or header checksum mismatch. Do not parse a same-sized arbitrary file as Elden Ring.

## Analyze and plan

1. Call `analyze_elden_ring_package(packageId)` and `analyze_elden_ring_save_context(saveContextId)`.
2. Show all active source/target slots with zero-based indexes, character names, levels, and play time.
3. Default to the first active source slot and first empty target slot only when that choice is unambiguous.
4. If the target slot is occupied, require an explicit target index and explicit overwrite consent.
5. Call `plan_elden_ring_slot_import`. Display both SteamID64 values, the selected/replaced characters, checksum operations, preserved slots, four allowed byte ranges, Plan ID, hash, and expiry.

## Stage

Call `stage_elden_ring_slot_import` only for the frozen plan, then `verify_elden_ring_staged_import`. Staging must:

- begin from a byte copy of the target container;
- copy only the selected source slot and summary;
- replace exact source SteamID64 occurrences inside that slot with the target SteamID64;
- set only the target active flag;
- recompute target-slot and header-section MD5 values;
- constrain every changed byte to the frozen allowlist;
- prove all nine unselected target slots remain byte-identical.

Staging is not approval to write the real save.

## Real import and acceptance

Call `plan_elden_ring_staged_replacement(stagedImportId)` to convert the verified staged artifact into an immutable slot-import Replacement Plan. Require explicit approval of its exact Replacement Plan ID before `apply_save_replacement`; apply requires a verified rescue backup, stopped Elden Ring/Steam processes, target-prestate revalidation, atomic publish, and static post-verification.

Ask the user to launch offline, confirm the imported character is visible and loadable, save once, and exit. Never characterize author-claimed online safety as a guarantee. Unless the user explicitly keeps the result, restore the acceptance baseline and verify every managed-file hash plus the original character screen.

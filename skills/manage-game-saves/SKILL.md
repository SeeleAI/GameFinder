---
name: manage-game-saves
description: Locate, inspect, research, download, standardize, back up, restore, replace, or import Windows game saves through the GameFinder save-management MCP tools. Use when the agent is given a Windows game root or local save/archive and needs to discover the corresponding save location, acquire a Nexus or Speedrun save, create or verify backups, safely restore a prior state, replace a same-account save, or import an Elden Ring character slot with SteamID64/checksum handling. Do not use for game Mods, cloud-save administration, console saves, or editing gameplay values.
---

# Manage Game Saves

Operate game saves as evidence-bound, reversible transactions. Start from a game root whenever available; derive the registered Game Save Profile and confirmed Save Context before acting on local saves.

## Route the request

- For game-root and save-location discovery, read [references/discovery.md](references/discovery.md).
- For Nexus/Speedrun research, download, manual handoff, archive inspection, or Standard Save Package creation, read [references/sources-and-packages.md](references/sources-and-packages.md).
- For backup, restore, direct replacement, risk classification, rollback, and runtime verification, read [references/transactions.md](references/transactions.md).
- Before importing an external save or deciding whether game-specific binary support is needed, read [references/adapter-assessment.md](references/adapter-assessment.md).
- For Elden Ring `.sl2` analysis or character-slot import, also read [references/elden-ring.md](references/elden-ring.md).

## Enforce safety invariants

1. Require Windows and a confirmed game/install identity. Never guess a save path from a game name alone.
2. Treat source progress, version, DLC, and online-safety text as author claims until independently verified.
3. Inspect and standardize external inputs without writing into a game save root.
4. Assess the intended operation after standardization. Treat `undetermined` and `required+missing` as hard blockers for a real Replacement Plan; do not infer safety from matching extensions or an account ID not appearing in a simple byte scan.
5. Before any real restore or replacement, freeze an immutable Plan and display its ID, expiry, exact target, operations, pre/post hashes, preserved paths, rescue unit, warnings, and review classification.
6. Default a valid Plan to `auto_safe` and apply its exact unexpired ID without an extra approval turn when it implements the user's explicit save-management request. Stop only for `review_required` or `blocked`. A changed file, slot, source, target, strategy, or Plan ID requires fresh classification.
7. Require the game and lock-sensitive platform processes to be stopped. Do not disable anti-cheat, alter cloud settings, or request credentials.
8. Require a verified rescue backup before the first target write. On failure, follow the transaction rollback result; never claim success from a partial write.
9. Separate static verification from runtime verification. Ask the user to launch the game offline and report what is visible; do not infer runtime success from hashes.
10. Preserve the original baseline through acceptance. Restore it after testing unless the user explicitly chooses to keep the imported save.

## Review policy

Default every valid frozen Restore or Replacement Plan to `auto_safe` when its source, live target, account, slot, and strategy are unambiguous; the live write is implied by the user's request; required processes are stopped; and the transaction provides verified rescue, prestate checks, atomic publish, verification, and rollback.

Treat restoration of the preserved acceptance baseline as `auto_safe` when the original task established that the baseline should be restored after testing. Treat an occupied-slot overwrite as `auto_safe` only when the user already gave explicit overwrite consent for that exact slot.

Use `review_required` only when the user asked to inspect before writes, the request did not authorize a live-save change, an occupied slot lacks prior overwrite consent, a material source/target/account/strategy choice remains, or the Plan expands beyond the original request. Use `blocked` for running lock-sensitive processes, missing or unverifiable rescue data, stale prestate, unsupported format/account binding, unsafe path behavior, or any MCP blocker.

## Report outcomes

Return stable IDs and safe absolute paths for Contexts, Packages, Backups, Plans, Records, and staged outputs. Include hashes, preserved files, unresolved DLC/external requirements, and whether the live save changed. Never expose cookies, authorization values, temporary download URLs, browser profiles, or transient staging internals unrelated to the requested result.

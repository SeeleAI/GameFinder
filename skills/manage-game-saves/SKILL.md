---
name: manage-game-saves
description: Locate, inspect, research, download, standardize, back up, restore, replace, or import Windows game saves through the GameFinder save-management MCP tools. Use when Codex is given a Windows game root or local save/archive and needs to discover the corresponding save location, acquire a Nexus or Speedrun save, create or verify backups, safely restore a prior state, replace a same-account save, or import an Elden Ring character slot with SteamID64/checksum handling. Do not use for game Mods, cloud-save administration, console saves, or editing gameplay values.
---

# Manage Game Saves

Operate game saves as evidence-bound, reversible transactions. Start from a game root whenever available; derive the registered Game Save Profile and confirmed Save Context before acting on local saves.

## Route the request

- For game-root and save-location discovery, read [references/discovery.md](references/discovery.md).
- For Nexus/Speedrun research, download, manual handoff, archive inspection, or Standard Save Package creation, read [references/sources-and-packages.md](references/sources-and-packages.md).
- For backup, restore, direct replacement, approval, rollback, and runtime verification, read [references/transactions.md](references/transactions.md).
- For Elden Ring `.sl2` analysis or character-slot import, also read [references/elden-ring.md](references/elden-ring.md).

## Enforce safety invariants

1. Require Windows and a confirmed game/install identity. Never guess a save path from a game name alone.
2. Treat source progress, version, DLC, and online-safety text as author claims until independently verified.
3. Inspect and standardize external inputs without writing into a game save root.
4. Before any real restore or replacement, freeze an immutable Plan and display its ID, expiry, exact target, operations, pre/post hashes, preserved paths, rescue unit, and warnings.
5. Apply only the exact unexpired Plan ID the user explicitly approves. A changed file, slot, source, target, strategy, or Plan ID requires a new review.
6. Require the game and lock-sensitive platform processes to be stopped. Do not disable anti-cheat, alter cloud settings, or request credentials.
7. Require a verified rescue backup before the first target write. On failure, follow the transaction rollback result; never claim success from a partial write.
8. Separate static verification from runtime verification. Ask the user to launch the game offline and report what is visible; do not infer runtime success from hashes.
9. Preserve the original baseline through acceptance. Restore it after testing unless the user explicitly chooses to keep the imported save.

## Report outcomes

Return stable IDs and safe absolute paths for Contexts, Packages, Backups, Plans, Records, and staged outputs. Include hashes, preserved files, unresolved DLC/external requirements, and whether the live save changed. Never expose cookies, authorization values, temporary download URLs, browser profiles, or transient staging internals unrelated to the requested result.

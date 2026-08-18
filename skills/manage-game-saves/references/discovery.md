# Windows save discovery

## Static path

1. Call `list_game_save_profiles` to check whether the game has a registered Windows Profile.
2. Call `probe_save_game_install(gameRoot)` and require a confirmed game identity.
3. Call `resolve_save_locations(installContextId)`.
4. Require one confirmed Save Context. If multiple account roots remain plausible, stop for account selection; do not choose by modification time alone.
5. Re-read with `get_save_context` before any later operation that depends on it.

The game root identifies the installed version and store context; the Profile expands Windows environment/account templates and verifies required Save Unit files. A numeric folder name or familiar filename is supporting evidence, not sufficient identity by itself.

## Differential fallback

When no static Profile resolves a unique root:

1. Call `begin_save_location_probe(installContextId)`.
2. Ask the user to start the game, trigger one normal save, and exit cleanly.
3. Call `complete_save_location_probe(probeId)` before expiry.
4. Accept only a bounded, local-verified learned profile tied to the same game-root fingerprint.

Do not widen probe roots beyond those returned by the registered Profile. Reject reparse-point traversal and stale learned evidence.

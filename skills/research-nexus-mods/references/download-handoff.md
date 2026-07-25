# Research-to-Download Handoff

Emit this only after the user has selected one researched Mod for download. This handoff transfers identity, selection intent, dependencies, and warnings; it does not authorize a download or contain temporary credentials.

## Contract

```json
{
  "schema_version": "1.0",
  "handoff_type": "nexus_download_candidate",
  "game": {
    "name": "Elden Ring",
    "nexus_url": "https://www.nexusmods.com/games/eldenring",
    "domain_name": "eldenring"
  },
  "selection": {
    "name": "Example Mod",
    "mod_url": "https://www.nexusmods.com/eldenring/mods/9531",
    "mod_id": 9531,
    "file_id": 47215,
    "file_selection": "explicit",
    "dependencies": [],
    "compatibility_warnings": [],
    "observed_at": "YYYY-MM-DD"
  }
}
```

Allowed `file_selection` values:

- `explicit`: set a non-null `file_id` verified by `get_mod_files`.
- `latest_active_main`: set `file_id` to null when the latest active MAIN file is appropriate.
- `user_choice_required`: set `file_id` to null; the download workflow must list files and obtain a choice before preparation.

## Producer rules

1. Use the canonical Mod URL returned by MCP.
2. Ensure `domain_name`, `mod_id`, and `mod_url` agree.
3. Include known Nexus dependencies and compatibility warnings.
4. Use `explicit` only when the exact file was verified and selected.
5. Never include output paths, game installation paths, Cookies, tokens, NXM links, keys, expiry values, CDN URLs, or browser Profile data.
6. State that `download-nexus-mods` must revalidate current Mod and file availability.

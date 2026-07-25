# Research-to-Download Handoff

Consume this contract only after the user has selected one Mod. Treat it as a routing aid, not download authorization or authoritative file metadata.

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

- `explicit`: `file_id` is non-null and was selected from verified Nexus file metadata.
- `latest_active_main`: `file_id` may be null; MCP may select the latest active MAIN file.
- `user_choice_required`: do not prepare. Call `get_mod_files` and obtain a selection.

## Validation

Before preparing:

1. Require `handoff_type == "nexus_download_candidate"` and `schema_version == "1.0"`.
2. Require one canonical `selection.mod_url`.
3. Verify that `domain_name`, `mod_id`, and the canonical URL agree.
4. Preserve dependency and compatibility warnings in the final result.
5. Revalidate Mod availability and file selection through `prepare_download` or `get_mod_files`.
6. Treat a changed, missing, archived, or removed file as a new decision point.

The handoff never supplies output paths, credentials, Cookies, NXM authorization, download URLs, installation paths, or permission to download dependencies.

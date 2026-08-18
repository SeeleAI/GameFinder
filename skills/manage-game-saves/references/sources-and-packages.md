# Sources and Standard Save Packages

## Research

Use `research_nexus_save_sources` and `research_speedrun_save_sources` only after resolving the exact Game Install Context. Rank completion-oriented candidates, but preserve progress/version/DLC/online-safety fields as claims. Freeze and compare source snapshots; a changed or removed candidate requires refreshed research.

Speedrun may legitimately report no Saves. Do not promote Tools, Splits, Patches, or unrelated resources into save candidates. When an interactive host blocks direct retrieval, use the explicit manual-handoff path rather than bypassing the site.

## Download

For Nexus, prepare the exact frozen candidate with `prepare_nexus_save_download`, prefer persistent Chromium, and complete its normal browser interaction. Bind the verified Nexus receipt with `record_nexus_save_download`. For a direct Speedrun resource use `download_speedrun_save`; for a user-downloaded file use `record_manual_save_download`.

Never expose temporary Nexus/CDN authorization. Require final bytes, SHA-256, source identity, archive check, and a verified Save Download Receipt.

## Inspect and normalize

- Existing local input: `inspect_save_input` → `normalize_save_package`.
- Verified download: `inspect_downloaded_save` → `normalize_downloaded_save_package`.

Review every payload candidate. Resolve ambiguity explicitly. Reject traversal, absolute paths, links, devices, duplicate paths, executable surprises, archive bombs, unsupported extraction, or changed original bytes.

Verify the resulting package with `verify_standard_save_package`. Standardization preserves provenance and packages exact bytes; it does not rewrite a game-specific binary format or prove account compatibility.

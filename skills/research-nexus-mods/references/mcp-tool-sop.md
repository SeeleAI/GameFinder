# Nexus MCP Research SOP

## Contents

- Preconditions
- Fixed discovery sequence
- Candidate verification
- Evidence mapping
- Failure and fallback
- Completion checklist

## Preconditions

Require one canonical game URL under `https://www.nexusmods.com/games/<slug>`. Keep this Skill read-only: never call `prepare_download`, `get_download_status`, or `download_mod_file`.

Call `health_check` only when tool availability or credential configuration is uncertain. Call `validate_credentials` after an authentication error or when quota/capability status matters; do not repeat it for every candidate.

## Fixed discovery sequence

1. Call `resolve_game(gameUrl)` and use its verified title, domain, ID, and canonical URL.
2. Call `search_mods(gameUrl, sort="downloads", count=20)` without a query. This is the all-game lifetime-download adoption baseline.
3. Call `search_mods(gameUrl, sort="unique_downloads", count=20)` when the server supports it. Keep unique-download ranking distinct from total downloads.
4. Call `search_mods(gameUrl, sort="endorsements", count=20)` for an independent endorsement baseline.
5. Call `list_feed_mods(gameUrl, feed="trending")` and `list_feed_mods(gameUrl, feed="latest_updated")` to surface recent candidates. Feed order is not an all-time rank.
6. Build 3–8 short feature queries from the requested capabilities and the verified ecosystem vocabulary. Examples: `utility trainer menu`, `debug framework loader`, `all in one`, `appearance model`, `autorun autowalk`.
7. For each feature query, call `search_mods` twice when useful:
   - `sort="relevance"` for semantic discovery;
   - `sort="downloads"` for adoption within the matching set.
8. Merge candidates by `(domainName, modId)`. Preserve every discovery channel and rank scope. Prefer a diverse pool of 10–30 candidates before selecting finalists.

Do not claim that a relevance-ranked result is popular. Do not claim that a keyword result set contains every conceptually related mod. Do not use search-engine order as a substitute for MCP ranking.

## Candidate verification

For each serious finalist:

1. Call `get_mod(modUrl)` for status, availability, full description, version, dates, total downloads, unique downloads, endorsements, and canonical URL.
2. Call `get_mod_files(modUrl)` for active/old/archived file state, filename, size, upload time, primary flag, and packaging clues.
3. Call `get_mod_requirements(modUrl)` for DLC requirements, Nexus dependencies, and reverse dependents.
4. Call `get_mod_changelogs(modUrl)` when the result exists; a missing changelog is an evidence gap, not a zero score.
5. Exclude removed/unavailable finalists from the current-usability verdict. Retain them only as clearly labeled design references when justified.
6. Browse the canonical Nexus page or author-linked documentation for permissions, compatibility, issues/support, source repository, explicit license, build instructions, and implementation facts that the MCP data does not prove.

Never infer a language solely from a `.dll`, `.asi`, or archive name. Use the implementation-identification contract.

## Evidence mapping

Use these MCP fields directly:

| Report claim | Required MCP evidence |
|---|---|
| Canonical identity | `resolve_game`, `get_mod.canonicalUrl` |
| Total/unique downloads | `get_mod.totalDownloads`, `get_mod.uniqueDownloads` |
| Endorsements | `get_mod.endorsements` |
| Current file availability | `get_mod_files.categoryName`, `isPrimary`, `uploadedAt` |
| Version and maintenance | `get_mod.version`, `updatedAt`, changelog |
| DLC/dependencies | `get_mod_requirements` |
| Candidate rank | `search_mods.rankScope`, requested `sort` |
| Coverage | tool `coverage`, `totalCount`, `warnings` |

The GraphQL candidate list may expose total downloads and endorsements but not unique downloads. Always call `get_mod` before publishing unique-download figures.

## Failure and fallback

Use fallback only after recording the MCP failure:

1. Retry one transient timeout or 5xx response once when the tool marks it retryable.
2. On `AUTH_MISSING` or `AUTH_INVALID`, stop Nexus API calls and ask for local credential repair. Do not ask the user to paste a Key.
3. On `RATE_LIMITED`, use already collected/cached data and report the quota limitation.
4. On a GraphQL schema error, use REST feeds for bounded discovery and label coverage `feed-only`; a static Nexus ranking adapter may be used only if the MCP exposes it successfully.
5. Use a site-restricted web search for Nexus candidates only when MCP discovery is unavailable or demonstrably lacks the requested semantic concept. Open and verify every candidate with MCP when possible.
6. Use browser/search normally for GitHub, licenses, author documentation, and current compatibility evidence outside Nexus structured API coverage.

Never hide the fallback. State which channel failed, what replaced it, and how that changes coverage and confidence.

## Completion checklist

- Exact game identity was verified by MCP.
- Candidate pool includes adoption, recency, and feature-specific channels.
- Every finalist has Mod details and file-state verification.
- Requirements and changelog were checked or explicitly unavailable.
- Metrics name their exact type and observation date.
- `rankScope`, coverage, warnings, and fallback are represented in the analysis.
- External source and license claims have direct author/maintainer evidence.
- The fixed report contract is complete.
- No research step called a download tool or inspected an archive.

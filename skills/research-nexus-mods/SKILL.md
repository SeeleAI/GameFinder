---
name: research-nexus-mods
description: Research, verify, compare, and recommend Nexus Mods for the exact game identified by a canonical Nexus game-page URL, using nexus-mods-server MCP first when available. Use for Nexus/N站 requests about popular, feature-rich, all-in-one, or development-reference mods, including verified mod links, functions, implementation type, language or loader evidence, compatibility, source licenses, community adoption, versatility, and development value. Require a URL under https://www.nexusmods.com/games/ followed by the game slug; do not download or install mods.
---

# Research Nexus Mods

Produce a current, evidence-backed Nexus Mod report for one unambiguous game. Use `nexus-mods-server` as the primary source for Nexus identity, candidates, rankings, metrics, files, changelogs, and requirements. Browse the web for author-linked source, licenses, permissions, compatibility claims, and evidence gaps because those facts change and are not all exposed by the API.

## Require an exact game page

Require a canonical Nexus game-page URL shaped like:

```text
https://www.nexusmods.com/games/<slug>
```

Normalize harmless variants by removing query parameters, fragments, and a trailing slash. Open the page and verify that it exists and represents a game. Read the official game title from the page; use the slug and title aliases only for later searches.

Do not accept a mod page, collection page, search result, non-Nexus URL, or game name alone as the game identity. If the exact game-page URL is missing or invalid, ask for it concisely before researching.

## Resolve the research profile

Accept these optional inputs when supplied:

```yaml
game_url: https://www.nexusmods.com/games/dyinglightthebeast
goal: balanced
features: [all-in-one, teleport, appearance]
game_version: current
source_preference: preferred
max_results: 5
```

Support four goals:

- `popular`: emphasize verified community-adoption metrics and current usability.
- `all-in-one`: emphasize coherent coverage of many relevant feature classes.
- `development-reference`: emphasize inspectable source, explicit license, architecture clarity, and build documentation.
- `balanced`: evaluate all dimensions and name separate winners. Use this when no goal is supplied.

Treat feature examples as capability classes rather than mandatory literal matches unless the user marks them required. Default `game_version` to the current public version, `source_preference` to `preferred`, and `max_results` to 5. Return 3–8 serious finalists when evidence supports them; never pad the list with weak matches.

## Read the research contracts

Before evaluating candidates, read:

- [references/mcp-tool-sop.md](references/mcp-tool-sop.md) for the fixed MCP-first discovery and verification sequence, coverage rules, and fallback boundary.
- [references/evaluation-framework.md](references/evaluation-framework.md) for discovery, evidence, metrics, and independent scoring rules.
- [references/implementation-identification.md](references/implementation-identification.md) for implementation, language, loader, and confidence classification.
- [references/report-contract.md](references/report-contract.md) for the required human-readable report and optional machine handoff.

## Research in layers

1. Call `resolve_game` with the exact game page URL before any candidate search.
2. Follow the query matrix in `mcp-tool-sop.md`: obtain all-game adoption rankings, recent/trending feeds, and multiple feature-query result sets with declared sort and rank scope.
3. Build a diverse candidate pool instead of collecting near-duplicates. For broad requests, cover an all-in-one runtime tool, in-game configuration UI, requested specialist features, data/content editors, and loaders or frameworks when they exist.
4. Call `get_mod`, `get_mod_files`, `get_mod_requirements`, and, when available, `get_mod_changelogs` for every serious finalist. Do not rank from search snippets or relevance order.
5. Browse finalist pages and author-linked sources only for API gaps such as permissions, issue/support evidence, repository, license, build documentation, and implementation details not established by file metadata.
6. Verify the finalists, classify their implementation with an evidence level, score each evaluation dimension independently, and select winners appropriate to the requested goal.

Do not call `prepare_download` or `download_mod_file`, and do not download archives or executables merely to identify the implementation. If public Nexus metadata and author-linked sources do not establish a language or framework, report it as unknown. This skill researches only; downloading and installation belong to a separate workflow.

## Verify every finalist

Record:

- Exact title and canonical Nexus mod URL.
- Page status, version, update date, supported game version or DLC, and staleness.
- Concise verified feature summary.
- Implementation type, language, loader/framework, dependencies, evidence, and confidence.
- Unique and total downloads, endorsements, rating when available, and observation date.
- Installation complexity, compatibility statements, support or issue signals, and safety risks.
- Author-linked source URL, explicit license, Nexus permissions, documentation, and buildability.

Never equate a public download with permission to reuse code or assets. An explicit repository license governs code reuse. Without one, recommend only behavioral or architectural observation.

For popularity claims, identify the exact metric and observation date. Search rank is not evidence. Missing or login-gated metrics must be marked unavailable rather than estimated.

Record the MCP source, `rankScope`, `coverage`, observation time, and warnings used to construct the candidate pool. Treat GraphQL relevance as semantic discovery only. Treat downloads, unique downloads, and endorsements as different metrics; call `get_mod` before reporting unique downloads.

## Keep conclusions separate

Always distinguish:

- **Community adoption**: observed downloads, endorsements, and ratings when available.
- **Usability**: current compatibility, maintenance, dependencies, install complexity, support signals, and user evidence; do not claim hands-on testing unless it occurred.
- **Versatility**: breadth, integration coherence, configurability, and compatibility of feature classes.
- **Development-reference value**: source, license, architecture, modularity, documentation, and buildability.

Do not collapse these into one overall score. The most downloaded, most versatile, and best development reference may be different projects. If no single mod covers the target, recommend the smallest complementary stack and assign one role to each component.

## Return the fixed report

Follow [references/report-contract.md](references/report-contract.md) exactly. Lead with the verified game identity and three verdicts:

1. Best current usability/community choice.
2. Most versatile or all-in-one choice.
3. Best development-reference choice.

The same mod may win more than one category. Include direct links beside claims and state evidence gaps, inference confidence, version limitations, licensing restrictions, and offline or anti-cheat risks.

Emit the optional machine-readable handoff only when the user requests it, another skill will consume it, or installation is explicitly the next workflow. Do not create or install files during ordinary research.

If `nexus-mods-server` is unavailable, returns an authentication/schema error, or lacks a required field, state the exact failure and use the bounded fallback in `mcp-tool-sop.md`. Do not silently begin with a general search engine when MCP is healthy.

## Safety boundary

Keep memory editing, DLL injection, trainers, and cheat tables in offline development or testing contexts. Recommend documented offline workflows, separate test saves, and backups. Do not help deploy cheats into competitive or online play.

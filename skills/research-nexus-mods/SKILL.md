---
name: research-nexus-mods
description: Research, verify, compare, and recommend Nexus Mods for the exact game identified by a canonical Nexus game-page URL. Use for Nexus/N站 requests about popular, feature-rich, all-in-one, or development-reference mods, including verified mod links, functions, implementation type, language or loader evidence, compatibility, source licenses, community adoption, versatility, and development value. Require a URL under https://www.nexusmods.com/games/ followed by the game slug; do not install mods.
---

# Research Nexus Mods

Produce a current, evidence-backed Nexus Mod report for one unambiguous game. Browse the web for every research run because files, metrics, versions, permissions, and compatibility change.

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

- [references/evaluation-framework.md](references/evaluation-framework.md) for discovery, evidence, metrics, and independent scoring rules.
- [references/implementation-identification.md](references/implementation-identification.md) for implementation, language, loader, and confidence classification.
- [references/report-contract.md](references/report-contract.md) for the required human-readable report and optional machine handoff.

## Research in layers

1. Use the verified game page to establish the game identity and enter its Nexus mod ecosystem.
2. Search Nexus listings and the web using the exact title, slug, abbreviations, requested capabilities, and ecosystem terms such as `all in one`, `utility`, `trainer`, `debug`, `menu`, `framework`, `loader`, `transmog`, `autorun`, `param`, and `tool`.
3. Build a diverse candidate pool instead of collecting near-duplicates. For broad requests, cover an all-in-one runtime tool, in-game configuration UI, requested specialist features, data/content editors, and loaders or frameworks when they exist.
4. Open each serious candidate's Nexus page. Do not rank from search snippets or result order.
5. Inspect the description, files, requirements, changelog, permissions, and author-linked source or documentation as available.
6. Verify the finalists, classify their implementation with an evidence level, score each evaluation dimension independently, and select winners appropriate to the requested goal.

Do not download archives or executables merely to identify the implementation. If public Nexus metadata and author-linked sources do not establish a language or framework, report it as unknown. This skill researches only; downloading and installation belong to a separate workflow.

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

## Safety boundary

Keep memory editing, DLL injection, trainers, and cheat tables in offline development or testing contexts. Recommend documented offline workflows, separate test saves, and backups. Do not help deploy cheats into competitive or online play.

# Nexus Mod Evaluation Framework

## Contents

- Discovery queries
- Evidence priority
- Candidate record
- Independent evaluation dimensions
- Hard gates
- Winner selection

## Discovery queries

Replace placeholders and vary synonyms rather than issuing every query mechanically.

```text
site:nexusmods.com/<game>/mods "<feature>"
site:nexusmods.com/<game>/mods ("all in one" OR utility OR trainer OR debug)
site:nexusmods.com/<game>/mods (menu OR framework OR loader)
site:nexusmods.com/<game>/mods (transmog OR appearance OR model)
site:nexusmods.com/<game>/mods (autorun OR autowalk OR autosprint)
"<mod title>" GitHub source license
"<mod title>" compatibility "<current game version>"
```

Also search the verified title, Nexus slug, abbreviations, sequel-number variants, localized titles, and community vocabulary.

## Evidence priority

Use evidence in this order:

1. Nexus description, files, changelog, requirements, permissions, metrics, and issue state.
2. Repository or documentation linked by the author.
3. Official loader or framework documentation.
4. Maintainer releases and issue discussions.
5. Community discussion only for discovery or clearly attributed user-experience signals.

Do not use search snippets, repost sites, or videos as sole support for core claims. Distinguish author claims, verified source facts, community reports, and analysis.

## Candidate record

Capture these fields for every finalist:

```text
title:
nexus_url:
page_status:
version_and_date:
supported_game_version:
verified_features:
implementation_type:
language:
loader_or_framework:
dependencies:
implementation_evidence:
implementation_confidence:
unique_downloads:
total_downloads:
endorsements:
rating:
metrics_observed_at:
source_url:
license:
nexus_permissions:
compatibility_and_support:
safety_and_save_risk:
evidence_gaps:
```

## Score independent dimensions

Use 1–5 scores only when evidence supports a meaningful comparison. Always include a short rationale. Mark unavailable evidence as `unknown`, not zero. Never calculate one overall score.

### Community adoption

Report raw metrics first. Consider unique downloads, total downloads, endorsements, rating when available, age, and observation date. Treat endorsement-to-unique-download ratio only as supporting context. Do not declare a mod usable solely because it is old and highly downloaded.

### Usability

Consider:

- Current game-version and DLC compatibility.
- Recency and maintenance activity.
- Installation complexity and dependency burden.
- Compatibility with common loaders and major overhauls.
- Nexus bugs, posts, or maintainer support signals when available.
- Community reception without claiming personal hands-on testing.

### Versatility

Consider:

- Number and relevance of distinct feature classes.
- Whether features share one coherent UI, runtime, or configuration model.
- Configurability and modular enable/disable behavior.
- Ecosystem compatibility and extensibility.

Raw feature count is insufficient. A curated integrated tool can outrank a fragile bundle of unrelated edits.

### Development-reference value

Consider:

- Inspectable source and an explicit reusable license.
- Architecture clarity and meaningful module boundaries.
- Identifiable implementation language and loader/framework.
- Build instructions, documentation, tests, and release traceability.
- Modularity, extension points, and current compatibility.

No explicit license means no recommendation for code reuse. Closed-source projects may still be behavior or UI references, but label that limitation prominently.

## Hard gates

- Removed or inaccessible file: do not call it the current best installable choice.
- Unsupported current patch: label it an older design reference.
- Unknown implementation: do not invent language or framework details.
- No explicit license: do not recommend copying code or assets.
- Online ban or save-corruption risk: surface it in the main verdict.
- Unavailable metrics: do not estimate them or infer rank from search order.

## Select winners

- `popular`: select the strongest current usability/community candidate, not merely the largest lifetime total.
- `all-in-one`: select the strongest versatility candidate.
- `development-reference`: select the strongest source-and-architecture candidate.
- `balanced`: name separate winners for usability/community, versatility, and development reference.

When no single mod is adequate, recommend the smallest complementary stack and explain each role.

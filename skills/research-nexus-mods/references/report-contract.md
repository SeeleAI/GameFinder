# Report Contract

## Contents

- Human-readable report
- Required comparison and technical-detail sections
- Evidence-gap rules
- Optional machine handoff

Use this Markdown structure for every result. Keep claims selective and source-linked. Return 3–8 finalists only when supported by evidence.

## Human-readable report

```markdown
# Nexus Mod research: <verified game title>

## Research scope

- Nexus game page: <canonical URL>
- Goal: <popular | all-in-one | development-reference | balanced>
- Requested capabilities: <list or none>
- Game version/DLC constraint: <value>
- Observed at: <date>

## Verdicts

| Verdict | Mod | Why | Important limitation |
|---|---|---|---|
| Best current usability/community choice | [name](url) | ... | ... |
| Most versatile/all-in-one choice | [name](url) | ... | ... |
| Best development reference | [name](url) | ... | ... |

The same project may appear in multiple rows. Use `No supported candidate` when evidence is insufficient.

## Candidate comparison

| Mod | Main functions | Implementation and framework | Community evidence | Usability | Versatility | Development-reference value |
|---|---|---|---|---|---|---|
| [name](url) | ... | type; language; loader; confidence | unique/total downloads; endorsements/rating; date | score + reason | score + reason | score + reason |

## Technical details

### <Mod name>

- Nexus page: <URL>
- Version and last update: <value>
- Supported game version/DLC: <value>
- Main functions: <concise summary>
- Implementation type: <type>
- Language: <value or unknown>
- Loader/framework: <value or unknown>
- Dependencies: <list or unknown>
- Implementation evidence and confidence: <value>
- Source and license: <URLs and license, or unavailable>
- Compatibility/support: <value>
- Suitable development references: <value>
- Limitations and risks: <value>

Repeat the technical-details block for each finalist.

## Complementary reference stack

Include only when no single mod covers the goal. Assign one clear role to each component.

## Evidence gaps and safety

- List unavailable metrics, inferred implementation claims, missing licenses, version uncertainty, and offline/anti-cheat/save warnings.
```

Do not omit required sections. Keep unavailable values as `unknown` or `not publicly available`; never fill them with estimates.

## Optional general research handoff

Emit this only when requested or when another research/development workflow will consume the result. Preserve unknown values as `null`. For an exact selected Mod that will be downloaded next, use `download-handoff.md` instead.

```json
{
  "schema_version": "1.0",
  "game": {
    "name": "<verified title>",
    "nexus_url": "https://www.nexusmods.com/games/<slug>"
  },
  "research": {
    "goal": "balanced",
    "features": [],
    "game_version": "current",
    "observed_at": "YYYY-MM-DD"
  },
  "verdicts": {
    "usability_community": "<mod URL or null>",
    "versatility": "<mod URL or null>",
    "development_reference": "<mod URL or null>"
  },
  "mods": [
    {
      "name": "<name>",
      "nexus_url": "<URL>",
      "version": "<value or null>",
      "features": [],
      "implementation": {
        "type": "<type>",
        "language": null,
        "loader_or_framework": null,
        "dependencies": [],
        "confidence": "unknown"
      },
      "metrics": {
        "unique_downloads": null,
        "total_downloads": null,
        "endorsements": null,
        "rating": null,
        "observed_at": "YYYY-MM-DD"
      },
      "source_url": null,
      "license": null,
      "scores": {
        "usability": null,
        "versatility": null,
        "development_reference": null
      },
      "limitations": []
    }
  ]
}
```

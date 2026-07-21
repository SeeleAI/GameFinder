# Implementation Identification

Classify the implementation conservatively. Record implementation type, language, loader/framework, dependencies, evidence, and confidence as separate fields.

## Evidence levels

- `verified`: author-linked source or build metadata directly establishes the claim.
- `documented`: the author or official requirement documentation states the claim, but source is unavailable.
- `inferred`: public file names, dependencies, or packaging support the claim without proving it.
- `unknown`: public evidence is insufficient or conflicting.

Use the weakest applicable level for a combined claim. For example, an ASI loader may be documented while the source language remains unknown.

## Implementation types

| Type | Typical public evidence | Safe conclusion |
|---|---|---|
| `script` | `.lua`, `.js`, `.py`, script-extender dependency, or source files | Name the language only when the extension or source is visible and tied to the mod |
| `native-plugin` | `.asi`, native `.dll`, injector or native loader requirement | Name the loader; do not assume C or C++ without source/build evidence |
| `managed-plugin` | .NET/Mono/BepInEx/MelonLoader documentation, assembly metadata, or C# project | Name C# or another language only when source/build metadata establishes it |
| `data-or-asset-replacement` | Loose game files, archives, textures, meshes, tables, params, or configuration replacements | Describe the modified data layer; do not call it code without evidence |
| `external-tool` | Standalone executable, trainer, editor, Cheat Engine table, or companion application | Identify the host/runtime separately from the game-side integration |
| `modpack` | Collection or merged package containing multiple authors' components | Describe aggregation and permissions; do not treat it as one architecture |
| `unknown` | Missing or conflicting public evidence | State what is known and leave language/framework unknown |

## Common inference traps

- `.asi` identifies a loadable plugin format, not a guaranteed source language.
- `.dll` may be native or managed; the extension alone proves neither.
- `.pak`, `.archive`, or similar containers may include data, assets, scripts, or binaries.
- A loader listed under requirements does not prove every included component uses the same language.
- Nexus availability does not imply public source or reuse permission.
- A GitHub link is not a reusable license; inspect the repository license explicitly.

## Required reporting shape

```text
Implementation type: native-plugin
Language: unknown
Loader/framework: ASI Loader
Dependencies: ...
Evidence: Nexus requirement names ASI Loader; no author-linked source found
Confidence: documented for loader, unknown for language
```

Do not download archives or execute binaries during ordinary research. If classification requires archive inspection, report the limitation and leave the claim unresolved.

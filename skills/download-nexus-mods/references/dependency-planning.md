# Dependency Download Planning

## Classify every requirement

| Kind | Download behavior |
|---|---|
| `nexus_mod` | Select and download an exact Nexus file unless independently satisfied. |
| `loader_runtime` | Download when missing or explicitly requested; installation needs a dedicated Loader Adapter. |
| `external_requirement` | Preserve URL/evidence and stop for manual handling; never fetch through an unrelated downloader. |
| `dlc` | Report as a game-store entitlement/content requirement; never treat as a Mod file. |

Only traverse hard requirements returned by Nexus. Do not include reverse dependents, optional companions, recommendations, translations, patches, or collections unless the user separately selects them.

## Normalize identity

Require the MCP resolver to map Nexus `gameId + modId` to a canonical Mod URL. Do not construct dependency URLs in the Skill when MCP reports an unmapped game ID or empty URL.

Detect cycles and enforce bounded depth. A cyclic, truncated, unavailable, or uncanonicalized required node blocks an installation-ready Download Plan.

## Select files

Use an explicit dependency file override when the user chose one. Otherwise, `plan_mod_download` may propose the latest active MAIN file, but the user must review that proposal before download.

Preserve requirement notes separately from file version. Notes are not guaranteed to be a machine-readable semantic-version constraint. If Nexus requirements, selected-file text, and current release metadata disagree, show all evidence and use the stricter compatible choice only after it is verified.

Never silently choose ARCHIVED, REMOVED, OLD, OPTIONAL, or MISCELLANEOUS files.

## Satisfied dependencies

Add a node to `satisfiedNodeIds` only when independent evidence establishes it for the target game instance:

- A Game Profile detects the exact Loader/runtime.
- A managed Installation Record identifies the dependency.
- A version-aware probe proves the installed version meets the constraint.

Presence with unknown version is not equivalent to version compatibility. Present the uncertainty and ask whether to download a current package.

## Approval

Display the complete Download Plan before the first file starts. Approval must cover the exact root file and dependency file list. A later file-selection change invalidates that approval and requires a new Plan.

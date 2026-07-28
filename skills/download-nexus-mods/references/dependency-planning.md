# Dependency Download Planning

## Classify every requirement

| Kind | Download behavior |
|---|---|
| `nexus_mod` | Select and download an exact Nexus file unless independently satisfied. |
| `loader_runtime` | Download when missing or explicitly requested; installation analyzes it through Contract V2 like any other dependency. A bundled installer may require the generic M3 controlled-installer capability. |
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

- Call `find_installed_nexus_mod` with the dependency's canonical Nexus URL, the exact target `gameRoot`, and its explicit numeric constraint when the requirement uses a supported form such as `v4.1.7+` or `>=4.1.7`.
- For `recordKind: file_transaction`, require `dependencySatisfaction.canMarkSatisfiedNode=true`. The tool rechecks every recorded owned file and tolerates only extra runtime-generated or unmanaged data.
- For `recordKind: controlled_installer`, require `versionConstraint.status` to be `satisfied` or `not_requested`, then call `probe_game_context` for the returned exact game root and matching registered Profile. Mark the node satisfied only when the expected Loader/runtime is currently detected.
- Preserve the returned Installation ID, Evidence Pack ID, Game Context ID, Nexus file ID, version source, and probe evidence in the Plan explanation.

Do not call `get_install_status` with guessed UUIDs. A historical record with a missing/modified owned file, failed version comparison, missing game root, unsupported natural-language constraint, or absent Loader probe does not satisfy the node. Presence with unknown version is not equivalent to version compatibility; present the uncertainty and ask whether to download a current package.

## Approval

Display the complete Download Plan before the first file starts. Approval must cover the exact root file and dependency file list. A later file-selection change invalidates that approval and requires a new Plan.

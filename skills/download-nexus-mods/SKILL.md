---
name: download-nexus-mods
description: Resolve required dependencies, plan exact Nexus file selections, download and verify one explicitly selected Mod plus its required downloadable dependencies, and produce Archive receipts and a Mod Bundle Manifest through nexus-mods-server MCP. Use when the user explicitly asks to download or save an exact Nexus Mod/file, including dependency-complete preparation for install-game-mods. Prefer persistent Chromium. Do not use for Mod discovery/comparison, installation, extraction, Vortex import, optional companion Mods, or Mod development.
---

# Download Nexus Mods

Prepare one selected Mod and its required downloadable dependency set. Use MCP for dependency resolution, planning, each single-file download, receipt verification, and Bundle creation; never reimplement these operations with shell or browser scripts.

## Route the request

Require explicit download intent and one canonical Mod URL:

```text
https://www.nexusmods.com/<game-domain>/mods/<mod-id>
```

Use `research-nexus-mods` while the unresolved question is which Mod to choose. Stop after verified downloads and Bundle creation; installation belongs to `install-game-mods`.

Read:

- [references/dependency-planning.md](references/dependency-planning.md) before resolving or selecting dependencies.
- [references/mcp-download-sop.md](references/mcp-download-sop.md) for the exact plan, download, polling, and Bundle sequence.
- [references/result-contract.md](references/result-contract.md) before reporting completion.
- [references/research-handoff.md](references/research-handoff.md) when consuming a Research handoff.

## Plan the complete required set

Establish:

```yaml
mod_url: https://www.nexusmods.com/stardewvalley/mods/2697
root_file_id: 115145 # optional when latest active MAIN is acceptable
dependency_file_overrides: [] # optional exact choices
satisfied_node_ids: [] # only independently proven local dependencies
output_directory: C:\absolute\path
backend: persistent_chromium
authorization_scope: root_only | root_and_required_dependencies
```

Use `authorization_scope=root_and_required_dependencies` only when the user explicitly requests installation or inclusion of prerequisites; otherwise use `root_only`. Call `resolve_mod_dependencies` when the graph needs explanation. Before passing any local dependency in `satisfiedNodeIds`, call `find_installed_nexus_mod` with its canonical Mod URL, exact target game root, and an explicit machine-readable version constraint when one exists; follow the returned current-verification guidance. Then call `plan_mod_download` with the authorization scope. Treat the returned graph, file selections, and `review.classification` as authoritative.

Follow the MCP review classification:

- `auto_safe`: continue without a separate approval turn when the root file is an unambiguous active MAIN selection, the Plan has no blockers or material choices, and it adds no unexpected files. A combined explicit download-and-install request may also auto-authorize routine required Nexus dependencies when every dependency is an unambiguous active MAIN file.
- `review_required`: stop for approval when the Plan introduces a material file/dependency choice, files beyond the user's authorized scope, archived/non-MAIN material, manual requirements, or meaningful uncertainty.
- `blocked`: stop when MCP reports a blocked, cyclic, truncated, unavailable, or unverifiable Plan.

For `review_required`, show:

- Root Mod/file.
- Every required Nexus Mod and Loader Runtime.
- Canonical Mod URLs, version notes, selected file IDs/versions, and selection reasons.
- Dependencies independently proven satisfied.
- DLC/external/manual requirements.
- Cycles, depth limits, unavailable nodes, blockers, and evidence gaps.
- `downloadPlanId` and expiry.

Do not confuse Plan validation with human approval: every run still freezes and verifies a Download Plan, but an `auto_safe` Plan proceeds in the same turn. Never guess Installation Record UUIDs or mark a dependency satisfied from its name alone. A `file_transaction` match may satisfy a node only when `canMarkSatisfiedNode=true`. A `controlled_installer` match remains a candidate until a fresh probe of the same game root detects the expected loader/runtime.

If the user explicitly insists on root-only download after seeing required dependencies, download only the root and report that the result is not an installation-ready Bundle.

## Download the authorized files

For each explicitly approved or `auto_safe` Download Plan item whose action is `download`, in dependency-first order:

1. Call `prepare_download` with its exact canonical `modUrl`, frozen `fileId`, and `backend="persistent_chromium"`.
2. Verify the prepared Mod/file matches the Plan.
3. Call `start_download` once.
4. Poll `get_download_status` to a terminal state.
5. Preserve the completed absolute Archive and receipt paths.

Do not substitute another file, drop a required dependency, or add optional/recommended Mods. Follow [references/mcp-download-sop.md](references/mcp-download-sop.md) for browser interaction and errors.

## Create the Bundle handoff

After every planned file completes, call:

```text
create_mod_bundle(downloadPlanId, receiptPaths, outputDirectory)
```

Bundle creation must reject missing, duplicate, extra, modified, or mismatched receipts. Call `inspect_mod_bundle(bundlePath)` when revalidating an existing handoff.

Return the Bundle path plus every Archive/receipt pair. Distinguish:

- `download_complete`: all downloadable requirements are present and no manual requirement remains.
- `download_complete_requirements_pending`: files are complete, but DLC/external/manual requirements still need resolution.

Do not claim that a downloaded Loader Runtime such as SMAPI is installed. The Bundle records acquisition and dependency order only.

## Preserve the stopping boundary

Do not extract, execute, install, enable, configure, import, or modify the game. Do not expose credentials, cookies, NXM authorization, temporary CDN URLs, `.part`, or `.crdownload` paths.

# Phase 6A Research/Download Skill Acceptance

Updated: 2026-07-25

## Scope

Phase 6A closes the research and download boundary before any installation Skill is designed:

- `research-nexus-mods` decides which Mod to choose and remains read-only.
- `download-nexus-mods` downloads one explicitly selected Mod file and stops at a verified archive plus receipt.
- `install-game-mods` does not exist yet. Neither Skill extracts, deploys, enables, imports, or installs.

Workspace sources:

- `skills/research-nexus-mods`
- `skills/download-nexus-mods`

Personal installed copies:

- `%USERPROFILE%\.codex\skills\research-nexus-mods`
- `%USERPROFILE%\.codex\skills\download-nexus-mods`

## Completed checks

- Both workspace Skills pass the official `quick_validate.py`.
- Both personal installed copies pass the same validator.
- All 7 Research files and all 5 Download files match their installed copies by SHA-256.
- Research denies all six browser/download side-effect tools.
- Download documents all five relevant download tools and eight terminal/interaction conditions.
- Producer and consumer `nexus_download_candidate` version 1.0 examples are structurally identical.
- `nexus-mods-server` TypeScript check, 62 normal tests, build, and 17-tool STDIO smoke pass.
- Real production MCP acceptance passed for Elden Ring Mod 9531 / File 47215:
  - bytes: `1,474,885`
  - SHA-256: `f3e339ea655b5eba4173f401005baef68506fa125de0b823dd27a733f94e4abd`
  - ZIP integrity: valid
  - backend: `persistent_chromium`
  - no extraction or installation

## Fresh-task black-box matrix

Codex tasks cache Skill metadata and MCP tool schemas at task start. Run these after opening a new task so the new `download-nexus-mods` Skill and the 17-tool MCP schema are loaded.

### A. Research-only routing

```text
Use research-nexus-mods for https://www.nexusmods.com/games/eldenring and find the most versatile current utility Mod. Do not download anything.
```

Pass when:

- Research triggers from the exact game URL.
- Only read-only discovery/detail tools are called.
- No dedicated Chromium, prepared session, archive, or output directory is created.

### B. Exact download routing

```text
Use download-nexus-mods to download file 47215 from https://www.nexusmods.com/eldenring/mods/9531 into a new folder under this workspace's outputs/mod-downloads.
```

Pass when:

- Download triggers without repeating broad candidate research.
- `persistent_chromium` is passed explicitly.
- The terminal result is `completed` with the expected file and receipt.
- No extraction, execution, installation, or Mod-manager import occurs.

### C. Research-to-Download handoff

```text
Research the most versatile Elden Ring utility Mod from https://www.nexusmods.com/games/eldenring. Show the finalists, and only after I select one, hand it to the download workflow.
```

Pass when:

- Research does not download while candidates remain ambiguous.
- One selected candidate produces a version 1.0 `nexus_download_candidate` handoff.
- Download revalidates Mod/file availability instead of trusting stale handoff metadata.

### D. Installation boundary

```text
Install the Mod archive that download-nexus-mods just produced.
```

Pass when:

- Neither Research nor Download claims installation capability.
- No game files, load order, registry, saves, or Mod-manager state are changed.
- The response identifies the verified archive and receipt as future installation inputs.

Phase 6A is complete after this fresh-task matrix passes or any discovered routing issue is fixed and retested.

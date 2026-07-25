---
name: download-nexus-mods
description: Download and verify one explicitly selected Nexus Mod archive from a canonical Nexus mod-page URL or a confirmed research handoff, using nexus-mods-server MCP. Use when the user explicitly asks to download or save an exact Mod or file, or continues from a chosen research-nexus-mods result. Prefer the persistent Chromium workflow for normal Nexus downloads. Do not use for Mod discovery or comparison, archive extraction, installation, Vortex import, or Mod development.
---

# Download Nexus Mods

Download exactly one user-selected Nexus file through the normal Nexus workflow, verify it, and return its archive and receipt. Treat this Skill as a stateful MCP orchestration procedure; do not reimplement downloading in shell scripts or browser automation.

## Route the request

Require explicit download intent and one canonical Mod URL shaped like:

```text
https://www.nexusmods.com/<game-domain>/mods/<mod-id>
```

Accept the URL directly or from a confirmed `research-nexus-mods` handoff. Normalize harmless query parameters and fragments through MCP. Do not accept a game page, collection, search result, arbitrary Nexus URL, or game name as the download identity.

Use `research-nexus-mods` instead when the user is still asking which Mod is best, popular, versatile, compatible, or suitable as a development reference. If a combined request asks to find and download a Mod, finish research first and obtain an unambiguous selection before preparing a download. Do not silently choose among multiple finalists.

If the user asks to install, extract, enable, deploy, or import a Mod, limit this workflow to downloading and verification. State that installation belongs to a separate workflow that is not implemented by this Skill.

## Read the download contracts

Before calling download tools, read:

- [references/mcp-download-sop.md](references/mcp-download-sop.md) for file selection, backend choice, the exact MCP sequence, polling, interaction recovery, cancellation, and errors.
- [references/research-handoff.md](references/research-handoff.md) when consuming a Research→Download handoff.
- [references/result-contract.md](references/result-contract.md) for receipt validation and the final response.

## Confirm the target

Establish:

```yaml
mod_url: https://www.nexusmods.com/eldenring/mods/9531
file_id: 47215 # optional
output_directory: C:\absolute\path # optional
backend: persistent_chromium
```

- Treat `mod_url` as mandatory.
- Treat `file_id` as optional only when selecting the latest active MAIN file is acceptable.
- Call `get_mod_files` before preparing when variants, optional files, compatibility branches, old versions, language packs, or explicit user constraints could materially change the choice.
- Never silently select an archived, removed, OLD, OPTIONAL, or MISCELLANEOUS file.
- If the output directory is omitted, create a run-specific directory under the current workspace at `outputs/mod-downloads/<game-domain>/mod-<mod-id>/`. Resolve it to an absolute path and report it.
- Never use a game installation directory, home-directory root, drive root, or shared browser Profile directory as the download destination.

## Run one download

1. Confirm explicit user intent, canonical Mod identity, file selection policy, and absolute output directory.
2. Call `prepare_download` with `backend="persistent_chromium"` unless the user explicitly requests the native/NXM path.
3. Verify that the prepared response matches the requested canonical Mod and `fileId`, or the documented latest-active-MAIN policy. Preparation alone does not authorize a different file.
4. Call `start_download(sessionId, outputDirectory)` once.
5. Poll `get_download_status(sessionId)` until completion, a user-interaction state, a terminal failure, or cancellation.
6. When interaction is required, keep the same session and follow `mcp-download-sop.md`. Never ask for credentials, 2FA codes, cookies, tokens, NXM keys, or CAPTCHA answers in chat.
7. On `completed`, validate the receipt with `result-contract.md`.
8. Return the verified archive path, receipt path, file identity, byte count, SHA-256, archive check, backend, and any warnings.

Do not claim success from a browser click, a partial file, or a nonterminal status. Do not expose `.part`, `.crdownload`, temporary URLs, NXM authorization, Cookie values, or CDN query parameters.

## Preserve the stopping boundary

Stop after the verified archive and non-secret receipt exist. Do not:

- Extract the archive.
- Execute any included binary or script.
- Copy files into a game directory.
- Modify load order, configuration, saves, or registry state.
- Import into Vortex or another manager.
- Claim that the Mod is installed, enabled, compatible, or working in game.

The verified receipt is the handoff artifact for a future installation Skill.

## Handle cancellation and ambiguity

Call `cancel_download` only when the user asks to cancel or the active workflow must be stopped to honor a replacement request. Do not cancel a completed download.

Pause before preparation when the exact Mod is ambiguous. Pause before start when the prepared file differs from the user's explicit file selection. After preparation, do not broaden the operation to additional dependencies or complementary Mods without separate explicit download intent for each file.

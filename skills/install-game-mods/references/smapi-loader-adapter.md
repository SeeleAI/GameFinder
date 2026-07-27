# SMAPI Loader Adapter Design

## Identity and scope

Reserve Adapter ID:

```text
smapi-loader-installer
```

Recognize only a verified SMAPI distribution whose source identity is the official Stardew Valley Nexus Mod `2400` or an explicitly trusted official SMAPI release. Do not classify it as `smapi-folder-mod`.

Phase 6B-4.1 supports dependency resolution and downloading, but does not yet execute SMAPI installation. Until this Adapter is implemented, return a blocking “Loader Adapter unavailable” result when SMAPI is missing.

## Required analysis

Before implementation, fixture-test the real current Archive and establish:

- Distribution version and target Stardew versions.
- Platform-specific installer entry.
- Signed/attested source evidence when available.
- Noninteractive command contract and exit codes.
- Exact files/configuration written for install, update, and uninstall.
- Existing SMAPI version detection.
- Game process and privilege requirements.

Official SMAPI releases document an installer intended for scripted/mod-manager use and a `--no-prompt` option. Execution must still be modeled as a dedicated operation with bounded arguments, captured output, timeout, and post-state verification; never as arbitrary Agent-provided command text.

## Future operation

Add a constrained engine operation such as:

```yaml
kind: run_trusted_loader_installer
adapter: smapi-loader-installer
source_archive_sha256: ...
platform: win32
game_root: frozen-instance-root
arguments:
  - --no-prompt
pre_state: detected-loader-snapshot
expected_post_state:
  loader_id: smapi
  minimum_version: ...
```

The engine, not the Skill, selects the executable and arguments from Adapter code. Require:

- Explicit plan approval.
- Game stopped and per-instance lock held.
- No shell interpolation.
- Installer child-process containment and timeout.
- Journaled stdout/stderr summary without secrets.
- Post-install detection of `StardewModdingAPI.exe` and version.
- Backup or the official uninstaller path sufficient for rollback.

Do not implement this operation until real-Archive tests prove deterministic install and recovery behavior.

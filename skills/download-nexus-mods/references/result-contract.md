# Download Result Contract

## Required validation

Accept completion only when MCP returns:

```text
state: completed
backend: persistent_chromium | native
canonicalModUrl: canonical Nexus Mod URL
modId: positive integer
fileId: positive integer
fileName: non-temporary filename
absolutePath: absolute final archive path
receiptPath: absolute receipt path
bytes: positive integer
sha256: 64 lowercase hexadecimal characters
completedAt: timestamp
archiveCheck.valid: true | null
```

Reject a result when:

- State is not `completed`.
- The Mod or file identity differs from the prepared selection.
- The final path ends in `.part` or `.crdownload`.
- `archiveCheck.valid` is `false`.
- A claimed final path or receipt path is not absolute.
- The receipt exposes an NXM URL, Cookie, authorization header, key, expiry, or temporary CDN URL.

`archiveCheck.valid=null` means the format has no implemented structural validator. Report that limitation; do not rewrite it as a successful integrity check.

## Human-readable result

Return:

```markdown
Downloaded and verified:

- Mod: [name](canonical Mod URL)
- File: filename (fileId)
- Saved archive: absolute path
- Receipt: absolute path
- Size: bytes
- SHA-256: value
- Archive check: value and detail
- Backend: value
- Compatibility/dependency warnings: values or none

The archives were not extracted, executed, installed, enabled, or imported into a Mod manager.
```

Do not report browser Profile paths, staging paths, temporary URLs, authorization values, or credentials.

## Dependency-complete Bundle

For a dependency-aware run, also require:

```text
bundleId: UUID
bundlePath: absolute JSON path
bundleHash: SHA-256
state: download_complete | download_complete_requirements_pending
archives: one entry per planned download
installOrder: dependency-first node IDs
manualRequirements: explicit list
```

Return every Archive and receipt pair, the Bundle path/hash, satisfied dependency nodes, manual requirements, and warnings. `download_complete_requirements_pending` is not installation-ready until the listed requirements are resolved.

## Installation handoff boundary

The only future installation inputs produced by this Skill are:

- Verified absolute archive path.
- Verified receipt path.
- Canonical Mod URL, domain, modId, and fileId.
- File name, bytes, SHA-256, and archive-check result.
- Preserved dependencies and compatibility warnings.

`install-game-mods` may consume one Archive/receipt pair or a verified Bundle Manifest. It must independently inspect every selected Archive, verify dependency satisfaction and install order, identify the exact game instance and Adapter, display each frozen Install Plan, and obtain approval. Download completion is not installation approval.

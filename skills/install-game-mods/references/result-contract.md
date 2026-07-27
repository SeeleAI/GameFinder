# Installation Result Contract

## Plan review

Before apply, return:

```markdown
Installation plan ready:

- Mod/package: name, UniqueID, version
- Nexus source: canonical Mod URL and file ID
- Archive: absolute path and SHA-256
- Game: profile and exact root
- Adapter: ID and version
- Planned writes:
  - operation kind → target relative path
- Conflicts: values or none
- Dependencies/warnings: values or none
- Verification: static requirements; runtime support or limitation
- Plan: planId, expiresAt

The game directory has not been changed. Apply this exact plan?
```

Do not hide target paths or blocking conflicts. Do not include manager staging, backup, lock, browser Profile, Cookie, or temporary authorization paths.

## Successful apply

Accept apply success only when MCP returns an `installationId`, `transactionId`, committed operation outcomes, and passed static verification.

After `verify_mod_install`, return:

```markdown
Installation completed:

- Mod/package: name, UniqueID, version
- Game: profile and exact root
- Installation ID: value
- Transaction ID: value
- Installed targets: relative paths
- Static verification: passed with summary
- Runtime verification: passed | failed | not run
- Warnings: values or none
```

When runtime verification is not run, add:

```text
The files are installed and statically verified, but successful in-game loading has not yet been proven.
```

## Failure

Return:

- Stable error code and message.
- Affected plan or transaction ID when available.
- Whether any game write began.
- Whether automatic rollback completed.
- Returned `nextAction`.
- Any path conflicts, dependency evidence, or recovery requirement.

Never report “installed” after a failed or nonterminal apply. Never expose secrets or internal backup object paths.

## Durable handoff

Treat `installationId` as the durable identity for status, verification, and future uninstall planning. Do not replace it with Archive path, folder name, `planId`, or guessed Mod identity.

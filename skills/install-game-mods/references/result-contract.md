# Installation Result Contract

## Plan review

Before apply, return:

```markdown
Installation plan ready:

- Mod/package: name, unique ID, version
- Nexus source: canonical Mod URL and file ID
- Archive: absolute path and SHA-256
- Game: identity and exact root
- Strategy: verified Method, legacy compatibility provider, or Agent Proposal
- Planned writes: operation kind and target relative path
- Conflicts: values or none
- Risk and reversibility: values
- Verification: static requirements and runtime limitation
- Plan: planId, expiresAt, approvalDigest

The game directory has not been changed. Apply this exact plan?
```

Do not hide target paths, unresolved choices, or blocking conflicts. Do not expose browser profiles, cookies, authorization, staging, backup, or lock paths.

## Successful file apply

Accept success only when MCP returns an `installationId`, `transactionId`, committed operation outcomes, and passed static verification. Then call `verify_mod_install(installationId)`.

Report:

- Mod/package and exact game root;
- Installation and transaction IDs;
- installed targets;
- static verification result;
- runtime verification result;
- warnings.

When runtime verification is `not-run`, say: “文件已安装并通过静态验证，但尚未证明游戏内成功加载。”

## Successful controlled-installer apply

Accept success only when `executionKind` is `installer`, the V2 record state is `installed`, static verification passed, and `unexpectedChanges` is empty. Report the installer entry identity and hash, declared roots, observed changes, process exit result, recovery status, Installation/transaction IDs, and refreshed Game Context ID when present.

Do not pass a controlled-installer V2 record to the legacy `verify_mod_install` tool. Do not claim in-game success until a later runtime check proves it.

## Failure

Return the stable error code, affected Plan or transaction, whether game writes began, rollback/recovery state, conflicts or missing evidence, and `nextAction`.

Never report “installed” after failed or nonterminal apply. Treat `installationId` as the durable identity for status, verification, dependency relationships, and future uninstall planning.

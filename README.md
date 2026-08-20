# GameFinder

GameFinder is a local Codex toolkit for researching Nexus Mods, downloading verified archives, installing and uninstalling managed file Mods, managing Windows game saves, and developing game Mods with reusable project knowledge.

The repository contains two cooperating parts:

- `nexus-mods-server`: a local STDIO MCP server that owns Nexus access, evidence, immutable plans, transactional writes, verification, and recovery;
- `skills`: Codex Skills that select the appropriate MCP workflow and preserve the safety and reporting contract.

## Repository layout

```text
GameFinder/
|-- .codex/
|   `-- config.toml                 Project-local MCP configuration
|-- docs/                           Architecture and implementation notes
|-- nexus-mods-server/              TypeScript MCP server
|-- skills/
|   |-- develop-game-mods/          Mod research, implementation, and project scaffolding
|   |-- download-nexus-mods/        Verified Nexus downloads and dependency bundles
|   |-- install-game-mods/          Evidence-driven transactional installation
|   |-- manage-game-saves/          Backup, restore, replacement, and slot import
|   |-- research-nexus-mods/        Nexus discovery and comparison
|   `-- uninstall-game-mods/        Managed file-Mod removal and verification
`-- README.md
```

All repository-owned Skills live under `skills/`. In particular, `develop-game-mods` is located at `skills/develop-game-mods`; the former top-level `develop-game-mods/` layout is obsolete.

## Capabilities

| Area | Current support |
|---|---|
| Nexus research | Game identity, Mod search, rankings, files, changelogs, and requirements |
| Downloads | Native/NXM and persistent Chromium flows, receipts, dependency plans, and Bundle Manifests |
| Installation | Contract V2 evidence, reusable Methods, bounded file operations, controlled installers, rollback, and verification |
| Uninstallation | Public inspect/plan/get/apply/verify tools for committed managed file transactions, including dependent and dirty-file blockers |
| Game saves | Composable discovery Recipes, packages, verified backups, restore, Adapter-validated replacement, Elden Ring slot import, Ghost of Tsushima PC v49 exact replacement, rescue, rollback, and runtime evidence |
| Mod development | Minimal project memory, interface research, bounded probes, implementation guidance, and reusable cross-game references |

The MCP classifies immutable write plans as:

- `auto_safe` / `apply_now`: bounded work may continue in the same turn;
- `review_required` / `request_confirmation`: a material risk or choice requires confirmation;
- `blocked` / `stop`: the plan must not be applied.

`reviewMode` defaults to `auto_safe`. This does not bypass blockers or transaction guards.

## Local setup

Requirements:

- Windows 10 or 11;
- Node.js 20 or newer;
- pnpm 11.x;
- a Nexus API key for API-backed Nexus operations;
- Playwright Chromium only when using the persistent-browser workflow.

Build and test the MCP server:

```powershell
cd nexus-mods-server
pnpm install
pnpm check
pnpm test
pnpm build
```

For browser-backed downloads, also run:

```powershell
pnpm setup:browser
```

The project-local `.codex/config.toml` starts the built server through `dist/index.js`. Paths in that file are machine-specific; update `command`, `args`, and `cwd` when cloning to another machine. Keep `NEXUS_API_KEY` in the environment rather than committing its value.

Install or update a Skill by copying its complete directory from `skills/<skill-name>` to `%USERPROFILE%\.codex\skills\<skill-name>`, then start a new Codex task so Skill and MCP discovery use the new files.

See [nexus-mods-server/README.md](nexus-mods-server/README.md) for server setup, Nexus login, browser behavior, MCP workflows, and acceptance checks.

## Safety model

Game and save writes remain inside MCP-owned transactional workflows. Plans bind exact evidence, targets, preconditions, expiry, and review metadata; apply tools accept immutable IDs rather than mutable operations. Protected paths, stale state, running processes, active dependents, dirty managed files, and recovery-required transactions remain hard blockers.

Local downloads, runtime state, browser profiles, credentials, and generated outputs should not be committed.

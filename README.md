# GameFinder

GameFinder is a local toolkit for AI agents, combining a STDIO MCP server with reusable Agent Skills for researching Nexus Mods, downloading verified archives, installing and uninstalling managed file Mods, managing Windows game saves, and developing game Mods with reusable project knowledge.

The repository contains two cooperating parts:

- `nexus-mods-server`: a local STDIO MCP server that owns Nexus access, evidence, immutable plans, transactional writes, verification, and recovery;
- `skills`: reusable Agent Skills that select the appropriate MCP workflow and preserve the safety and reporting contract.

## Installation instructions for AI agents

When a user asks to "install GameFinder" (including "安装 GameFinder"), install it for the AI agent application or CLI hosting the current conversation, unless the user explicitly names another target. Identify the host from the current session's host information. The target is the application, not its model or model provider: OpenCode using an OpenAI model is still an OpenCode installation.

The presence of `.codex/` in this repository, existing agent directories on the machine, and tool-specific examples do not identify the current host. If the target cannot be determined reliably, ask the user which tool to install for before changing agent configuration; there is no default target of Codex.

Unless the user requests project-level installation, use the target tool's user-level installation scope. "Global installation" means installation for the current user in that target tool across projects; it does not mean installation for Codex or for every agent on the machine. For project-level installation, use the specified project's configuration and skill locations.

Use the target tool's supported MCP configuration format and skill discovery locations, consulting its current official documentation when needed. Modify only configuration for the selected target and preserve existing servers, models, permissions, and unrelated settings. If the tool uses a shared skill directory, explain that other tools may also discover those skills. If MCP or skill support is unavailable, report that limitation and any partial installation instead of choosing another host.

## Repository layout

```text
GameFinder/
|-- .codex/
|   `-- config.toml                 Maintainer's Codex-local development configuration
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

The optional `agents/openai.yaml` files under skill directories provide OpenAI-specific display metadata. They do not make the workflows in `SKILL.md` exclusive to OpenAI tools.

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

Configure the built STDIO MCP server (`nexus-mods-server/dist/index.js`) in the selected target tool, using the actual Node.js executable, server path, and working directory on the installation machine. Keep `NEXUS_API_KEY` in the environment or a credential reference supported by the target tool rather than committing its value.

Install or update the Skills by copying their complete directories from `skills/<skill-name>` into the target tool's supported skill discovery location. Preserve each skill's `SKILL.md`, references, scripts, assets, and optional metadata.

The project-local `.codex/config.toml` is the maintainer's Codex development configuration and applies only to Codex. It is not a general installation entry point and does not determine the user's installation target. Its paths, including the Node.js executable, belong to the maintainer's machine; configure the selected tool for the actual environment instead of copying those paths.

### Installation completion

Verify both the server and the target client: complete a STDIO MCP connection, discover the server's tools, call `health_check`, and check that the target tool can discover the installed Skills. Copying files or building the server alone does not establish that GameFinder is usable in the target tool.

Report the installation target and scope, the actual MCP configuration and skill locations changed, server connection and skill discovery results, and any required restart or new session. If client loading cannot yet be verified, report that configuration is installed and client verification is pending. Report Nexus credential and browser-login readiness separately from installation status.

See [nexus-mods-server/README.md](nexus-mods-server/README.md) for server setup, Nexus login, browser behavior, MCP workflows, and acceptance checks.

## Safety model

Game and save writes remain inside MCP-owned transactional workflows. Plans bind exact evidence, targets, preconditions, expiry, and review metadata; apply tools accept immutable IDs rather than mutable operations. Protected paths, stale state, running processes, active dependents, dirty managed files, and recovery-required transactions remain hard blockers.

Local downloads, runtime state, browser profiles, credentials, and generated outputs should not be committed.

---
name: develop-game-mods
description: Initialize minimal game-mod project knowledge scaffolds, research implementation routes and interfaces, and implement, port, debug, or extend mods across different games, loaders, languages, editors, and asset forms. Use when Codex is asked to create a new mod development project, investigate how a requested mod feature could work, analyze game/SDK/template/existing-mod references, perform concrete mod development, or preserve reusable interface, experiment, and pitfall knowledge. Do not use for merely discovering, downloading, or installing third-party mods.
---

# Develop Game Mods

Treat game-mod development as an evidence-driven loop. Standardize how the project remembers facts and experiments, not how every game's source tree must look.

## Select the request mode

Classify the current request, not the whole project:

- **Init**: Create a new Mod development project or its initial framework.
- **Research**: Investigate interfaces, references, technical routes, feasibility, or safe probes for a concrete requirement.
- **Do**: Implement, modify, port, debug, deploy, or verify a concrete Mod feature.
- Combine modes when the request requires it. `Init` is normally one-time; `Research` and `Do` may alternate as requirements change.

Before acting, inspect the target repository, its instructions, current structure, dirty state, toolchain files, documentation, and user-provided references. Preserve existing conventions and unrelated changes.

## Init

Read [references/init-framework.md](references/init-framework.md).

1. Confirm the project name, game, and destination.
2. Refuse to overwrite an existing project.
3. Create only the minimal project memory:
   - `PROJECT.md`
   - `.gitignore`
   - `docs/interface-matrix.md`
   - `docs/experiments.md`
   - `docs/pitfalls.md`
4. Use `scripts/init_mod_project.py` when this standard scaffold matches the request.
5. Add source, resource, build, packaging, or deployment directories only when the Mod form or authoritative ecosystem template already justifies them.
6. Do not guess a C++, Lua, native-plugin, asset, or script layout when the technical route is not known.

Do not run Init against an established repository. Adopt its current structure instead.

## Research

Read [references/research-and-probing.md](references/research-and-probing.md). Read [references/evidence-from-existing-mods.md](references/evidence-from-existing-mods.md) only when the prior cases help interpret the task.

For a ReShade/DataCollector camera Provider, DCCameraPacket, projection-normal, FOV, or camera/world-normal task, also read [references/reshade-camera-provider.md](references/reshade-camera-provider.md).

Use this progressive lookup:

1. Search the project's `docs/interface-matrix.md` for the exact or adjacent capability.
2. Check the entry's game/tool version, evidence state, source, limitations, and last verification date.
3. Search current source, `docs/experiments.md`, `docs/pitfalls.md`, Git history, logs, and supplied references.
4. If project knowledge is insufficient, apply the broader evidence ladder in `research-and-probing.md`.
5. Prefer authoritative declarations and locally working examples over name-based guesses.
6. When static evidence is insufficient, design the smallest safe, reversible probe that answers one primary question.
7. Stop when evidence is sufficient to choose an implementation route or the next bounded probe.

Return a requirement-scoped conclusion: candidate routes, evidence state, recommended route, risks, logging/verification plan, and unresolved questions. Write reusable findings back to the project:

- capabilities and interfaces -> `docs/interface-matrix.md`
- raw tests and observations -> `docs/experiments.md`
- repeatable errors and validated traps -> `docs/pitfalls.md`

Treat matrix entries as cached leads, not permanent truth. Actual compile and runtime evidence wins.

## Do

Read [references/development-patterns.md](references/development-patterns.md) only for patterns relevant to the requested feature.

For a ReShade/DataCollector camera Provider implementation or debug task, also read [references/reshade-camera-provider.md](references/reshade-camera-provider.md) and revalidate its ABI assumptions against the target DataCollector source.

1. Read the current requirement, applicable Research result, project conventions, and related evidence.
2. Work within the current game, loader, editor, language, and repository structure. Do not impose a generic source architecture.
3. Implement the requested behavior with failure handling and cleanup proportional to its risk.
4. Add an observable trace appropriate to the runtime: loader log, console, HUD message, structured event, or dedicated log file.
5. Make the trace distinguish input/load success, state transitions, chosen interfaces, critical identities/parameters, failure points, retries, fallbacks, cleanup, and rollback where relevant.
6. Avoid per-frame log spam; log transitions, failures, bounded heartbeats, and important external operations.
7. Build, deploy, and verify in proportion to risk and available tooling.
8. Update only the affected project knowledge files.

Do not require a separate prior Research turn for a known, small change. If implementation exposes a critical unknown, perform a bounded Research fallback, record the evidence, and continue unless user authority or a material design choice is missing.

## Evidence discipline

Use these states consistently:

- `Confirmed`: directly supported by declaration plus compile/runtime evidence, or equivalent authoritative proof.
- `Probable`: strong evidence exists but the exact target context is not fully verified.
- `Hypothesis`: plausible and testable, not yet verified.
- `Known-bad`: failed, dangerous, or incompatible in the recorded context.
- `Stale / needs revalidation`: version or environment drift may invalidate the result.

Record scope with every durable lesson: game version, tool/loader version, language or inheritance context, source, and last verification date when available.

## Non-universal patterns

State machines, watchdogs, adapter layers, transactions, ownership markers, safe teleport pipelines, heartbeats, and rollback are conditional techniques, not mandatory architecture. Apply them only when the feature's lifecycle and risk justify them.

Never copy another game's native hashes, coordinates, models, loader bindings, or receiver assumptions without target-game evidence.

## Skill resources

- [references/init-framework.md](references/init-framework.md): minimal initialization and when to add ecosystem-specific structure.
- [references/research-and-probing.md](references/research-and-probing.md): progressive research, evidence, safe probes, and stop conditions.
- [references/development-patterns.md](references/development-patterns.md): conditional implementation and reliability patterns.
- [references/evidence-from-existing-mods.md](references/evidence-from-existing-mods.md): evidence boundaries and lessons from the four source projects.
- [references/reshade-camera-provider.md](references/reshade-camera-provider.md): cross-game DCC2 camera Provider profiles, architecture, coordinate conversion, probing, diagnostics, and acceptance criteria.
- `scripts/init_mod_project.py`: one-time minimal project initializer.
- `assets/project-core/`: neutral project-memory templates used by the initializer.

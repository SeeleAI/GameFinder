# Conditional Development Patterns

## Contents

1. Applicability
2. Environment and portability
3. Experiments and evidence
4. Long-running runtime behavior
5. Mutations and ownership
6. Teleport and spatial changes
7. Logging, cleanup, build, and documentation

## Applicability

These patterns came from runtime behavior Mods but are not universal architecture. Apply only when the current feature has the matching lifecycle, risk, or failure mode. Asset replacement, editor-authored content, data-only Mods, and official packaging projects may need very different structures.

## Environment and portability

- Inventory the installed game, patch, loader, SDK, compiler/editor, dependencies, logs, and reload path before selecting a stack.
- Separate reusable behavior from game bindings and game data. Port the behavior design; re-prove receivers, tasks, models, coordinates, hashes, and loader APIs.
- Prototype in the fastest safe layer. Escalate to a typed script or native layer only when lifecycle, access, stability, or performance requires it.
- Prefer an independent source repository and explicit deployment when the ecosystem permits it.
- Study working local implementations before guessing: game declarations, SDK, installed Mods, decompilation/types, then documentation.

## Experiments and evidence

- Build an interface matrix for unknown capability surfaces.
- Progress from read-only inspection to one reversible mutation, read-back verification, and then full behavior.
- Make each experiment answer one primary question.
- Distinguish input failure, compile failure, load failure, nil/wrong receiver, silent no-op, engine override, and native crash.
- Preserve failed paths with their scope, parameters, observation, and alternative.
- Keep stable and experimental paths separate until evidence supports promotion.
- Split visually similar symptoms into independent mechanisms before changing multiple systems.

## Long-running runtime behavior

Use these only for persistent or multi-stage behaviors:

- Model behavior as explicit states when preparation, cooldown, transition, verification, or recovery matter.
- Insert quiet windows when the engine must release an old task before teleport, swap, seat, mount, or new task dispatch.
- Base watchdogs on actual position, speed, target distance, and last progress, not only elapsed time.
- Distinguish one-shot commands, transient requests, and durable state. Reapply or heartbeat only when runtime evidence shows engine ownership overwrites the request.
- Bound every retry by count or time and define fallback, rollback, and terminal behavior.
- Reacquire players and entities after model, session, world, death, mount, or loader lifecycle changes. Compare stable identity where available.
- Use Safe Mode for payloads that may crash the process.

Do not introduce a state machine or adapter layer for a simple static data or resource change.

## Mutations and ownership

For destructive or structural changes:

```text
preserve old state
-> create/apply new candidate
-> verify
-> transfer ownership
-> clean up only Mod-owned old state
```

- Track entities, items, abilities, cameras, hooks, and temporary resources created by the Mod.
- Do not delete player-owned, quest-owned, persistent, base-game, or other-Mod state merely because it is currently referenced.
- Provide cleanup for Stop, Abort, reload, shutdown, and partial failure when the runtime supports it.
- Prefer reversible probes before inventory, save-state, model, or world mutations.

## Teleport and spatial changes

When spatial safety matters:

1. start from an official or verified anchor;
2. request streaming/collision if required;
3. query navigation or safe placement;
4. correct ground height;
5. reject invalid vectors and excessive vertical deltas;
6. account for mount, vehicle, attachment, and world transitions;
7. verify actual placement;
8. retry only within a bound;
9. fail at a known-safe state instead of brute forcing.

Support runtime rejection markers and durable blacklists when human testing repeatedly identifies unsafe destinations. Do not copy coordinate datasets between games.

## Logging and traceability

Choose a trace supported by the runtime. Record enough to distinguish:

- callback/load success;
- mode or state transition;
- interface and receiver;
- critical identity and parameters;
- failure location and reason;
- retry, fallback, cleanup, and rollback.

Log transitions rather than every frame. Add bounded heartbeats only when silence would make a long-running failure impossible to diagnose.

## Build, deploy, and verification

- Build or compile before deployment when the toolchain permits it.
- Know whether hot reload is supported and when restart is required.
- Verify deployed artifacts, loader logs, and runtime behavior separately.
- For binary or decompiled workflows, consider rebuild, static-load, hash, or re-disassembly checks.
- Keep runtime binaries, SDKs, caches, logs, and saves out of source control unless the repository is intentionally a controlled deployment bundle.

## Documentation discipline

Separate:

- current implementation;
- confirmed observation;
- hypothesis;
- known-bad path;
- stale guidance.

Update documentation when code or runtime evidence contradicts it. Use weighted/no-repeat randomization and recorded rejection data when diversity must remain testable.

# Research and Probing

## Contents

1. Research contract
2. Progressive lookup
3. Evidence ladder
4. Capability matrix
5. Safe probes
6. Stop conditions
7. Knowledge write-back

## Research contract

Define the current requirement independently of previous requirements:

- desired player-visible behavior;
- target game/version and platform;
- current Mod project and runtime;
- supplied references;
- constraints and non-goals;
- what evidence would be sufficient to proceed.

Research is requirement-scoped. It may revisit a capability when the game, loader, receiver, or version changes.

## Progressive lookup

### Level 1: project capability cache

Search `docs/interface-matrix.md` for:

- the exact capability;
- prerequisite capabilities;
- adjacent systems;
- known receiver or lifecycle constraints;
- previously rejected paths.

Treat matches as leads. Check version, source, evidence state, last verification, and current code before reuse.

### Level 2: project evidence

Search:

- current source and configuration;
- build/deploy scripts;
- `docs/experiments.md`;
- `docs/pitfalls.md`;
- logs and crash reports;
- Git commits, reversions, and diffs;
- user-provided Mods, templates, repositories, and documentation.

Prefer current code over stale summaries. Preserve contradictory evidence rather than silently choosing one.

### Level 3: general playbook

When project knowledge is insufficient, widen the search using the evidence ladder below.

## Evidence ladder

Prefer higher-quality and target-matching evidence:

1. Game or toolchain declarations: source, SDK headers, schemas, official editor templates, generated type definitions.
2. A locally installed, working Mod using the same game version and runtime.
3. Official documentation and primary toolchain documentation.
4. Maintained source code from a mature compatible Mod.
5. Decompilation, RTTI, NativeDB, reflection, resource browsers, or symbol/type dumps.
6. Community reports used as leads, not sole proof.
7. Name-based inference used only to design a test.
8. A minimal runtime probe when static evidence cannot settle behavior.

For current tools, loaders, game patches, and online documentation, verify current versions rather than relying on memory.

## Interface ownership checks

Before copying a call, verify:

- declaring type and inheritance;
- required receiver;
- parameter and return types;
- sync, latent, async, callback, or task behavior;
- callback owner;
- entity/session/world lifetime;
- thread or tick restrictions;
- whether the example targets a player, NPC, vehicle, resource, editor object, or another state.

Similar names do not establish compatible ownership or lifecycle.

## Capability matrix

Organize entries by reusable capability. Record:

- capability;
- game/runtime;
- interface, resource, type, receiver, or entry point;
- evidence state;
- applicable versions;
- limitations and lifecycle;
- source;
- last verification;
- related experiment.

Use `Confirmed`, `Probable`, `Hypothesis`, `Known-bad`, or `Stale / needs revalidation`.

## Safe probes

Use the least risky probe that distinguishes the competing hypotheses:

1. read-only enumeration or type inspection;
2. callback-first log proving input and load paths;
3. one receiver and one interface;
4. one reversible mutation;
5. read-back verification;
6. bounded cleanup or rollback;
7. full behavior only after the smaller probe succeeds.

Make one probe answer one primary question. Separate input, compile, load, receiver, API, and gameplay-effect failures.

For crash-prone native or RTTI paths, start in safe mode: construct and describe objects without dispatching the payload. Do not repeat a proven crash path without new evidence.

## Research output

Provide:

- concise requirement restatement;
- candidate routes and their evidence states;
- recommended route and why;
- known risks and version assumptions;
- smallest next implementation or probe;
- log and verification plan;
- unresolved questions that materially affect implementation.

Clearly distinguish inference from observation.

## Stop conditions

Stop broad research when one of these holds:

- a route is confirmed enough to implement safely;
- a bounded probe is the only efficient next evidence source;
- all viable routes depend on a missing user choice or unavailable authority;
- the remaining uncertainty does not change the next implementation step.

Do not research indefinitely to eliminate every unknown.

## Knowledge write-back

Write reusable capability conclusions to `interface-matrix.md`.

Write raw attempts, parameters, logs, and observations to `experiments.md`.

Write repeatable symptoms, root causes, verified fixes, and scoped prohibitions to `pitfalls.md`.

If evidence is version-sensitive or incomplete, label it. Do not promote a hypothesis to a pitfall merely because it sounds plausible.

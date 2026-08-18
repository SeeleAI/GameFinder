# Evidence from Existing Mod Projects

## Purpose

Record the provenance and limits of the first-version development patterns. These cases are examples, not game adapters.

## GTA V AutoDriver

### Stack

ScriptHookVDotNet, C#, deployed DLLs, and a hand-edited IL snapshot.

### Evidence

- 58 Git commits captured repeated task, movement, teleport, vehicle-swap, and combat experiments.
- A handoff document recorded current behavior, rejected paths, native signatures, and build steps.
- Current documentation also contained stale test guidance that contradicted newer behavior.

### Reusable lessons

- Stop active driving tasks and wait before teleport/swap; physics-level braking did not solve the same transition problem.
- Use explicit phases and quiet windows for long-running behavior.
- Record known-bad paths to prevent repeated experiments.
- Verify decompiled/binary edits through rebuild, static load, deployed artifact checks, and runtime logs.
- Cross-check prose against current code and Git history.

## Red Dead Redemption 2 AutoDriver

### Stack

Native ScriptHookRDR2 C++ `.asi`, SDK natives, build/deploy PowerShell, runtime JSON data.

### Evidence

- 20 early Git commits covered migration assessment, native proof-of-life, speed probes, and teleport data extraction.
- Later source and research contained substantial uncommitted evolution; Git alone was incomplete.

### Reusable lessons

- Behavior concepts may port while the original DLL, loader API, and coordinate data do not.
- Test one native/parameter surface at a time.
- Movement requests may be transient and overwritten by task ownership.
- Preserve story/persistent mounts; promote and clean up only Mod-managed entities.
- Use logs and bounded staged states for mount, seat, vehicle, and model experiments.
- Separate visually related problems, such as letterbox removal and idle-camera activation.

## The Witcher 3 AutoDriver

### Stack

WitcherScript, Mod loader discovery, input settings, game-native actions and states.

### Evidence

- 22 commits showed interface discovery, compile failures, input binding fixes, movement experiments, and later teleport/god-mode work.
- Project notes and agent notes recorded language and API-ownership pitfalls.

### Reusable lessons

- Verify the declaring class, receiver, inheritance, callback owner, and latent semantics before copying calls.
- A loader-visible script path and live input configuration may both be required.
- A timeout is not a watchdog unless it measures actual progress.
- Engine player controllers may ignore or overwrite APIs that work for NPCs.
- Record compiler-specific symptoms, root causes, and scoped fixes in pitfalls.

## Cyberpunk 2077 AutoDirector

### Stack

CET Lua prototype with an intended progression toward redscript/Codeware and RED4ext only when required.

### Evidence

- The repository had no commits at inspection time; versioned source and research notes served as the development trail.
- It separated `src/`, `scripts/`, and `docs/` and deployed source into the live CET Mod directory.

### Reusable lessons

- Treat multiple runtime/resource/native layers as optional parts of one project, not mandatory separate Mods.
- Start with the fastest observable prototype layer.
- Use an independent source repository plus deployment mapping.
- Progress from read-only equipment inspection to reversible mutation and rollback.
- Compare stable entity identity rather than language wrapper identity.
- A direct quest-parameter dispatch caused a native crash; later research used safe object-construction probes.
- Structured rejection markers can turn human testing into durable blacklists.

## Evidence boundaries

- Native hashes, exact paths, hotkeys, models, coordinates, SDK versions, and timing values remain game-specific.
- An observed technique is not universal merely because it worked in multiple runtime behavior Mods.
- Current code and direct runtime evidence outrank stale summaries.
- The original consolidated experience list remains a planning artifact outside the Skill; this reference contains only the provenance needed during use.

# Init Framework

## Purpose

Initialize durable project memory without pretending that all game Mods share a source layout.

## Required inputs

Confirm:

- project name;
- target game;
- destination directory;
- whether the destination already contains a project;
- any already-known loader, editor, SDK, official template, or Mod form.

If the destination is ambiguous and choosing it would materially change the result, ask. Never initialize over an established repository.

## Minimal scaffold

Create:

```text
<ModProject>/
├── PROJECT.md
├── .gitignore
└── docs/
    ├── interface-matrix.md
    ├── experiments.md
    └── pitfalls.md
```

This is a knowledge scaffold, not a permanent schema. Later development may rename, split, or reorganize it.

## What each file owns

### PROJECT.md

Record stable context:

- game and Mod identity;
- current loader, SDK, editor, compiler, and toolchain;
- repository and runtime/deployment locations;
- build, deploy, launch, reload, and log-viewing procedures;
- current repository conventions;
- local or external reference artifacts.

Do not freeze the first feature request as an immutable project scope.

### docs/interface-matrix.md

Record reusable capabilities and their evidence. Prefer capability names such as "get current player", "resolve safe ground position", or "register input" over one-off product feature names.

### docs/experiments.md

Record raw experiments, including failures and contradictions. Split it later if scale demands it.

### docs/pitfalls.md

Record stable, scoped errors that are worth preventing from recurring.

## Using the initializer

Run:

```text
python <skill>/scripts/init_mod_project.py <project-name> --path <parent-directory> --game "<game>"
```

The initializer:

- creates a new project directory under the supplied parent;
- allows an already-created empty target directory;
- refuses any non-empty target;
- copies UTF-8 templates;
- does not create source directories or a validator.

## Adding ecosystem-specific structure

Add directories only after evidence identifies the Mod form. Prefer, in order:

1. an official game/editor template;
2. a loader or SDK template;
3. a locally working mature Mod with a compatible purpose;
4. the target repository's established convention;
5. a small custom layout justified by the current need.

Possible structures include runtime scripts, native plugins, resource projects, data patches, binary patches, server plugins, editor projects, and hybrid packages. Do not make `src/`, `scripts/`, `dist/`, `assets/`, or any internal layering mandatory.

## Adopting an existing project

Do not run Init. Instead:

1. inspect the existing layout and instructions;
2. locate equivalent project knowledge if it already exists;
3. add only missing memory files when useful and authorized;
4. avoid reorganizing source merely to resemble this scaffold.

## Local paths and deploy targets

Avoid committing machine-specific absolute paths when the ecosystem supports local configuration. Some Mod toolchains require fixed or generated project paths; follow their authoritative conventions rather than imposing a generic manifest.

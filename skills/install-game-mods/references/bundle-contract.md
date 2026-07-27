# Mod Bundle Installation Contract

## Validate first

Call `inspect_mod_bundle(bundlePath)`. Require:

- Absolute Manifest path and matching `bundlePath`.
- Valid Bundle hash.
- Valid receipt and Archive hash for every entry.
- One root node.
- Dependency-first `installOrder`.
- No unexpected Archive.

`download_complete` means downloadable material is complete, not installed. `download_complete_requirements_pending` blocks dependent installation until every manual requirement is resolved.

## Process entries

For each node in `installOrder`:

1. Check whether a Game Profile or managed Installation Record proves it satisfied.
2. Skip only with evidence; record the reason.
3. Require an implemented Adapter for an unsatisfied Archive.
4. Plan, display, approve, apply, and verify as a separate transaction.
5. Stop before dependents if the node fails or remains incompatible.

Generate Plans sequentially. Earlier dependency writes may change filesystem pre-state, so do not freeze all Install Plans at once.

## Loader runtimes

Treat `loader_runtime` as a distinct package class. A normal Mod-folder Adapter must not claim it. If no Loader Adapter is implemented, return a blocked dependency result with the Archive and requirement evidence; do not execute the bundled installer.

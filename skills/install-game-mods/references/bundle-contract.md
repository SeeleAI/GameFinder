# Mod Bundle Installation Contract

## Validate first

Call `inspect_mod_bundle(bundlePath)`. Require an absolute Manifest path, valid Bundle hash, valid receipt and Archive hash for every downloadable node, one root node, dependency-first `installOrder`, and no unexpected Archive.

`download_complete` means material is present, not installed. A pending manual requirement still blocks dependents.

## Process entries

For each node in `installOrder`:

1. Check whether a current Dynamic Game Context or managed Installation Record proves it satisfied.
2. Skip only with evidence and record the reason.
3. Prepare an Evidence Pack and query Methods.
4. Reuse a verified Method or derive a bounded Agent Proposal.
5. Freeze, display, approve, apply, and verify as a separate transaction.
6. Stop before dependents if the node fails or remains below the dependent's required verification level.

Generate Plans sequentially because earlier dependency writes change filesystem pre-state.

## Loader runtimes

Treat `loader_runtime` as an installation requirement, not a special reason to demand a Mod-specific Adapter. Analyze and plan it through the same Evidence, Context, Method, and Proposal flow.

M2 can execute bounded file-tree operations. A loader distribution that requires its bundled installer must stop with `OPERATION_CAPABILITY_MISSING` until M3 provides controlled `run_bundled_installer`. Preserve the Bundle, Evidence, and Context so the workflow can resume.

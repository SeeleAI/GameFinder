# Contract V2 Agentic Installation SOP

## 1. Establish the target context

Require an exact absolute `gameRoot`.

Call `list_game_profiles` before constructing a Context. If the exact game identity or Nexus domain matches a registered profile, use it:

```text
probe_game_context(gameRoot, legacyProfileId)
```

Do not replace a stable profile/game ID with a Nexus numeric game ID. Use explicit Context fields only when no registered profile matches. For an unseen game, first collect local evidence for:

- stable game identity and Nexus domain;
- one or more existing game-root-relative anchor paths;
- the smallest justified writable roots;
- protected roots and live Mod roots;
- known game or loader processes when available.

Then call `probe_game_context` with the explicit fields. Never declare the whole game root writable merely to make planning succeed. Save the returned `gameContextId` and hash.

## 2. Prepare evidence

For each Archive:

```text
prepare_install_evidence(
  archivePath,
  receiptPath,
  gameContextId
)
```

For a Bundle node, do not manually copy paths out of the Manifest:

```text
prepare_install_evidence(
  bundlePath,
  bundleNodeId,
  gameContextId
)
```

The server verifies the Bundle hash, receipts, Archive hashes, exact node, and dependency-first index. It marks prior nodes satisfied only from the Bundle's original satisfied set or successful local controlled-installer Records.

Review Nexus identity, Archive SHA-256, inventory, package units, package roots, detected dependencies, and ambiguities. Resolve only choices that materially change the install result.

## 3. Resolve or infer a method

Call:

```text
query_install_methods(evidencePackId, gameContextId)
```

Read `proposalReadiness`, `operationCapabilities`, and `contextAdvisories` before selecting a strategy:

- `reprobe_with_legacy_profile`: call `probe_game_context` with the returned `legacyProfileId`, then prepare a new Evidence Pack bound to that Context and query again.
- `stop_before_proposal`: preserve Evidence and Context, report every blocker and stop. Do not call `submit_install_proposal`.
- `select_verified_method`: call `instantiate_install_method(methodId, methodRevision, evidencePackId, gameContextId, packageUnitId)` with the exact verified candidate and current package unit. Do not rebuild or edit the Method's operations manually.
- `construct_agent_file_proposal`: research and construct the smallest evidence-backed file Proposal.
- `construct_agent_installer_proposal`: research the exact non-interactive invocation, smallest declared write roots, timeout, allowed exit codes, and required postconditions for the hashed bundled entry.

Prefer an exact verified Method candidate. A legacy Adapter candidate is compatibility evidence, not exclusive planning authority.

If no candidate matches, do not stop with `ADAPTER_NOT_FOUND`. Inspect the Evidence Pack and Game Context, consult authoritative package documentation when needed, and derive the smallest bounded Proposal supported by evidence.

M2 supports a self-contained package root copied with `install_tree`, or a bounded file mapping using `ensure_directory`, `install_new_file`, and `replace_file`. Bind an inferred proposal as:

```yaml
strategyBinding:
  origin: agent_proposal
  methodId: null
  methodRevision: null
  methodHash: null
  legacyAdapterBinding: null
```

Every operation needs an exact source path from the selected package unit and an exact game-root-relative target. Use `exclusive_tree` only when the whole target directory belongs to this Mod; otherwise use `installed_file_set`. Never use `layered_path` for an M2 `install_tree`.

For a manifest-free `root-overlay` Package Unit:

- Treat the Unit as a bounded source tree, not proof of the target root. Confirm the mapping from authoritative author documentation and the current Dynamic Game Context.
- Map every regular Archive file explicitly. Each `sourceRelativePath` must exactly match an Evidence inventory file and remain inside the selected package root.
- Add `ensure_directory` operations before child files when a required parent may be absent. Use null source and ownership; an already-existing shared directory is preserved and not claimed.
- Use `install_new_file` only for an absent target with `installed_file_set` ownership.
- Use `replace_file` only when replacement is explicitly required. Classify the Proposal as high risk; the Plan must show the existing target and the executor must capture a verified backup.
- Order parent directories before their children. Do not freeze a mapping whose parent is neither an existing real directory nor an earlier `ensure_directory` target.
- Keep every individual target inside an evidence-backed writable root. Never declare the whole game directory writable merely because the Archive is laid out relative to it.
- Do not use `install_tree` to merge into an existing shared directory. Use exact file mappings so ownership, verification, rollback, and future uninstall remain file-specific.

A verified application may learn the complete multi-operation mapping as one Method. For a raw root overlay, expect the learned Method to include exact source-layout signals and a Nexus source-identity selector so an unrelated overlay cannot reuse it accidentally.

Never invent `packageUnitId`, `packageRoot`, entry hashes, evidence IDs, or installer fields. If Evidence has no selectable package unit, stop according to `proposalReadiness`.

For an analyzed `self-contained-folder` whose signals identify one non-installer portable executable:

- Confirm from author documentation that the tool is deployed by placing its files in an arbitrary or isolated directory.
- Use `install_tree`, never `run_bundled_installer`; installation must not launch the executable.
- Accept `packageRoot="."` as the exact whole-Archive package root.
- Choose a new isolated writable target directory, keep actual game-content roots protected, and use `exclusive_tree` ownership when the complete target belongs to the tool.
- Preserve offline-only or anti-cheat warnings in the result. Deployment success does not authorize or imply launching the tool.

For `run_bundled_installer`, use exactly one installer operation and only the entry path and SHA-256 present in Evidence. Use `native` only for a staged `.exe`, `fixed-script-runner` only for a staged `.js`, and `dotnet` only when authoritative evidence proves that runtime. Keep `environmentPolicy: minimal`, classify risk as `high`, declare only the smallest game-root-relative paths evidenced by real Evidence/Context IDs, and require at least one concrete postcondition. A bounded installer root may be outside the ordinary Mod writable root (for example, one loader executable beside the game), but it can never overlap a protected root. Never put credentials, browser state, or shell syntax in arguments.

Use `terminalMode: redirected_stdio` by default. Select `terminalMode: pseudoterminal` only when authoritative installer behavior or a prior captured failure proves that the program requires a real Windows console even for its non-interactive invocation. Confirm that `operationCapabilities.runBundledInstaller.terminalModes.pseudoterminal.state` is `available`. The current backend is Windows ConPTY, supplies no keystrokes or secrets, and does not make an interactive installer autonomously answerable; if the installer still requires material input, stop and redesign the Proposal rather than scripting guesses.

## 4. Validate and freeze

Call only when the matching readiness flag is true: `canSubmitFileProposal` for file operations or `canSubmitInstallerProposal` for a controlled installer.

```text
submit_install_proposal(evidencePackId, gameContextId, draft)
freeze_install_plan(proposalId, reviewMode="auto_safe")
```

Before apply, show:

- Mod/package identity and Nexus source;
- exact Archive and target game root;
- Method binding or `agent_proposal`;
- every operation kind and target;
- conflicts and unresolved choices;
- risk and reversibility;
- `planId`, expiry, and the complete `review` object (`classification`, `reasonCodes`, `policyVersion`, `reviewDigest`, `nextAction`, and `requestScope`).

State that the game directory is unchanged. Treat the returned `review` as authoritative. The default mode is `auto_safe`; pass `always_review` only when the user explicitly requests a preview/confirmation gate. Do not synthesize or rewrite `reasonCodes`, `reviewDigest`, or `nextAction`.

## 5. Apply and verify

For `review.nextAction: apply_now`, continue immediately. For `request_confirmation`, continue only after the user approves the exact current Plan. For `stop`, do not apply:

```text
apply_agentic_install_plan(planId)
```

Apply accepts no paths or operations. It revalidates immutable bindings and delegates writes to a lock, process guard, verified staging, backup, side-effect observation, verification, and recovery path.

For `executionKind: file`, call `verify_mod_install(installationId)`. For `executionKind: installer`, use the returned V2 record: success requires `state: installed`, `verification.static: passed`, and an empty `unexpectedChanges` list. Report the selected terminal mode; pseudoterminal output is a bounded, sanitized combined terminal stream in `stdout`, while `stderr` is empty because ConPTY does not preserve separate streams. A refreshed Dynamic Game Context is returned for registered profiles so the next Bundle node sees newly installed loaders.

Inspect `methodLearning` after every successful apply:

- a successful `agent_proposal` should create a revisioned Method, promote it through `session_approved` to `local_verified`, and append a successful Method Outcome;
- a successful `learned_method` reuse should append another Outcome to the same Method revision;
- a non-null learning warning means the installation committed but reusable knowledge did not persist; report that distinction and do not claim warm-start readiness.

Every warm start still prepares fresh Evidence and Context, re-queries Method scope, calls `instantiate_install_method`, freezes a new Plan, and classifies it independently. A learned Method never bypasses fresh planning or risk classification.

## 6. Stable error behavior

| Error | Action |
|---|---|
| `GAME_CONTEXT_REQUIRED` | Re-probe the exact root with real anchors and bounded path policy. |
| `EVIDENCE_CONFLICT` | Recreate Evidence from the exact Archive and receipt. |
| `METHOD_STALE` / `METHOD_QUARANTINED` | Re-query; do not reuse the old Method binding. |
| `PROPOSAL_INVALID` | Correct source selection, target boundary, ownership, or bindings. |
| `USER_CHOICE_REQUIRED` | Ask only for the reported material choice, then submit a new Proposal. |
| `OPERATION_CAPABILITY_MISSING` | Stop before game writes; report the missing generic executor capability. |
| `PROCESS_SIDE_EFFECT_SCOPE_UNPROVEN` | Do not widen roots speculatively; gather better evidence and freeze a new Plan. |
| `INSTALL_CONFLICT` / `PROTECTED_PATH` | Report the exact conflict; never bypass path policy. |
| `PLAN_STALE` | Re-freeze, display, and reclassify; continue automatically only if the new Plan is `auto_safe`. |
| `GAME_PROCESS_RUNNING` | Ask the user to close the reported process. |
| `VERIFY_FAILED` | Do not claim success; report rollback or recovery state. |
| `RECOVERY_REQUIRED` | Recover the exact transaction with `rollback_mod_install`. |

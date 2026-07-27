# Contract V2 Agentic Installation SOP

## 1. Establish the target context

Require an exact absolute `gameRoot`.

When a registered legacy profile is available:

```text
probe_game_context(gameRoot, legacyProfileId)
```

For an unseen game, first collect local evidence for:

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

Review Nexus identity, Archive SHA-256, inventory, package units, package roots, detected dependencies, and ambiguities. Resolve only choices that materially change the install result.

## 3. Resolve or infer a method

Call:

```text
query_install_methods(evidencePackId, gameContextId)
```

Prefer an exact verified Method candidate. A legacy Adapter candidate is compatibility evidence, not exclusive planning authority.

If no candidate matches, do not stop with `ADAPTER_NOT_FOUND`. Inspect the Evidence Pack and Game Context, consult authoritative package documentation when needed, and derive the smallest bounded Proposal supported by evidence.

M2 supports one self-contained package root copied with `install_tree` under a declared writable root. Bind an inferred proposal as:

```yaml
strategyBinding:
  origin: agent_proposal
  methodId: null
  methodRevision: null
  methodHash: null
  legacyAdapterBinding: null
```

Every operation needs an exact source path from the selected package unit and an exact game-root-relative target. Use `exclusive_tree` only when the whole target directory belongs to this Mod; otherwise use `installed_file_set`. Never use `layered_path` for an M2 `install_tree`.

If installation requires an executable installer, submit no fake file-copy plan. M2 must return `OPERATION_CAPABILITY_MISSING`; M3 will add bounded `run_bundled_installer`.

## 4. Validate and freeze

Call:

```text
submit_install_proposal(evidencePackId, gameContextId, draft)
freeze_install_plan(proposalId)
```

Before asking for approval, show:

- Mod/package identity and Nexus source;
- exact Archive and target game root;
- Method binding or `agent_proposal`;
- every operation kind and target;
- conflicts and unresolved choices;
- risk and reversibility;
- `planId`, expiry, and approval digest.

State that the game directory is unchanged. Do not apply in the same turn that first reveals the Plan unless the user already approved that exact `planId`.

## 5. Apply and verify

After explicit approval:

```text
apply_agentic_install_plan(planId)
verify_mod_install(installationId)
```

Apply accepts no paths or operations. It revalidates immutable bindings and delegates writes to the existing lock, backup, journal, verification, and rollback engine.

## 6. Stable error behavior

| Error | Action |
|---|---|
| `GAME_CONTEXT_REQUIRED` | Re-probe the exact root with real anchors and bounded path policy. |
| `EVIDENCE_CONFLICT` | Recreate Evidence from the exact Archive and receipt. |
| `METHOD_STALE` / `METHOD_QUARANTINED` | Re-query; do not reuse the old Method binding. |
| `PROPOSAL_INVALID` | Correct source selection, target boundary, ownership, or bindings. |
| `USER_CHOICE_REQUIRED` | Ask only for the reported material choice, then submit a new Proposal. |
| `OPERATION_CAPABILITY_MISSING` | Stop before game writes; report the missing generic executor capability. |
| `INSTALL_CONFLICT` / `PROTECTED_PATH` | Report the exact conflict; never bypass path policy. |
| `PLAN_STALE` | Re-freeze, display, and obtain new approval. |
| `GAME_PROCESS_RUNNING` | Ask the user to close the reported process. |
| `VERIFY_FAILED` | Do not claim success; report rollback or recovery state. |
| `RECOVERY_REQUIRED` | Recover the exact transaction with `rollback_mod_install`. |

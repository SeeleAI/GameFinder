# MCP Uninstall SOP

## Resolve the Installation Record

Use a supplied `installationId` directly. Otherwise call:

```text
find_installed_nexus_mod(
  modUrl=<canonical Nexus Mod URL>,
  gameRoot=<exact absolute game root>
)
```

Accept only one active `file_transaction` match whose current verification is not failed. Never guess a historical UUID. Controlled-installer candidates are outside this Skill.

## Inspect

Call:

```text
inspect_mod_uninstall(installationId)
```

Continue only when `eligible` is true and `blockers` is empty.

- `DEPENDENTS_EXIST`: refuse removal and list each active dependent Installation ID and Nexus identity. Do not automatically remove dependents.
- `INSTALLATION_DIRTY`: stop and report the affected managed paths. Do not force-delete or overwrite user changes.
- `UNINSTALL_BLOCKED`: report the record state and stop.

The inspection is advisory current state, not a review classification and not a frozen plan.

## Freeze and review

Call:

```text
plan_mod_uninstall(installationId, reviewMode="auto_safe")
get_mod_uninstall_plan(uninstallPlanId)
```

Use the second call as the classification display source. Show:

- target Mod and Installation ID;
- exact game root;
- Installation Record revision and inspection hash;
- each delete, restore, and empty-directory action;
- retained parent paths and exact retained file paths;
- `lifecycle.state`, reason, transaction ID when present, and expiry;
- exact `uninstallPlanId`;
- complete `review` object: `classification`, `reasonCodes`, `policyVersion`, `reviewDigest`, `nextAction`, and `requestScope`.

The immutable Plan's `status` records its creation state. Use the separately derived `lifecycle.state` as the current state. Classify only when lifecycle is `planned`.

Treat the returned `review` as authoritative. The default mode is `auto_safe`; pass `always_review` only when the user explicitly requests a preview/confirmation gate. Do not synthesize or rewrite its classification or digest.

## Apply and verify

For `review.nextAction: apply_now`, call immediately. For `request_confirmation`, call only after confirmation. For `stop`, do not apply:

```text
apply_mod_uninstall(uninstallPlanId)
verify_mod_uninstall(installationId)
```

Apply rechecks dependents and frozen state. On `PLAN_STALE` or expiry, generate, display, and classify a new Plan. A new dependent or changed managed file is `blocked`; never transfer the earlier classification.

Accept completion only when lifecycle is `committed`, the apply record is `uninstalled` or `uninstalled_with_retained_data`, and verification returns `passed: true`.

If apply fails or reports recovery required, stop all writes and report the transaction ID and exact MCP error. Do not invoke install rollback or repair files manually.

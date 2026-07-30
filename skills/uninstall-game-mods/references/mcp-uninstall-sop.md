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

The inspection is advisory current state, not approval and not a frozen plan.

## Freeze and review

Call:

```text
plan_mod_uninstall(installationId)
get_mod_uninstall_plan(uninstallPlanId)
```

Use the second call as the approval display source. Show:

- target Mod and Installation ID;
- exact game root;
- Installation Record revision and inspection hash;
- each delete, restore, and empty-directory action;
- retained parent paths and exact retained file paths;
- `lifecycle.state`, reason, transaction ID when present, and expiry;
- exact `uninstallPlanId`.

The immutable Plan's `status` records its creation state. Use the separately derived `lifecycle.state` as the current state. Request approval only when lifecycle is `planned`.

Stop for explicit approval. General permission to manage Mods is not approval of an unseen plan.

## Apply and verify

After approval call:

```text
apply_mod_uninstall(uninstallPlanId)
verify_mod_uninstall(installationId)
```

Apply rechecks dependents and frozen state. On `PLAN_STALE`, expiry, a new dependent, or changed files, stop and generate a new plan; never transfer old approval.

Accept completion only when lifecycle is `committed`, the apply record is `uninstalled` or `uninstalled_with_retained_data`, and verification returns `passed: true`.

If apply fails or reports recovery required, stop all writes and report the transaction ID and exact MCP error. Do not invoke install rollback or repair files manually.

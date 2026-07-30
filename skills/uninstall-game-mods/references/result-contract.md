# Uninstall Result Contract

## Approval request

Before apply, report:

```markdown
Uninstall plan ready:

- Mod/source: name or Nexus identity
- Installation: installationId and record revision
- Game root: exact absolute path
- Actions: every delete, restore, and empty-directory operation
- Retained directories: exact paths or none
- Retained files: exact file paths or none
- Dependencies: no active dependents
- Plan: uninstallPlanId, lifecycle state and reason, expiresAt

The game directory has not been changed. Apply this exact plan?
```

Do not hide restore operations, retained paths, blockers, or expiry.

## Success

Report:

- Installation and uninstall transaction IDs;
- final record state;
- removed owned paths and restored paths;
- retained unmanaged parent paths and exact file paths;
- verification result and failed checks, if any.

Say “uninstalled” only when lifecycle is `committed` and `verify_mod_uninstall` returns `passed: true`. `uninstalled_with_retained_data` means the managed Mod files were removed while the explicitly reported unmanaged files remain.

## Blocked or failed

Report the stable error code, target Installation ID, affected paths or dependents, whether an Uninstall Plan existed, whether game writes began, transaction ID when available, and `nextAction`.

Never turn a blocked or failed uninstall into success by deleting paths outside MCP.

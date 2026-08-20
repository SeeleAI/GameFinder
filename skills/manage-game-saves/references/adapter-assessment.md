# Adapter requirement assessment

Assess a concrete operation, not a game in general. After the target Save Context and any external Standard Save Package V2 are verified, call `assess_save_adapter_requirement` with the exact operation and any source/target slot selection. Set `allowWholeUnitFallback` only when broader whole-unit replacement is genuinely acceptable; a safe but broader fallback is reported as `recommended`.

- `backup` and `restore-exact-bytes` preserve opaque bytes and do not require a format Adapter.
- For replacement/import, review `requirement`, `adapterAvailability`, `extensionTarget`, reason codes, missing capabilities, scope, evidence, and both allow flags.
- `not_required` permits the generic path only within the frozen scope. `recommended` permits it but the later Plan must expose its broader impact.
- `required+matched` must use the matched Adapter workflow. A validation-only Adapter may authorize the existing generic transaction kernel only when its exact scoped capability says so and every source/target payload passes Adapter validation; this is still Adapter-backed, not a downgrade to extension-based compatibility. `required+missing` returns an immutable Development Brief; stop the import and develop/verify that Adapter separately.
- `undetermined` permits continued read-only inspection and Compatibility mapping but blocks every real Replacement Plan.

Use `get_save_adapter_requirement_assessment` to re-read and hash-verify the result. When a brief was returned, use `get_save_adapter_development_brief` with its `briefId`.

The assessment distinguishes missing Resolver, Location Strategy, Layout Family, Recipe, and format-Adapter capabilities. Fix the indicated declarative/generic layer before proposing game-specific binary code. File extensions, author instructions, equal prefixes, and failure to find an account ID in common encodings are not positive compatibility evidence.

Compatibility must bind the current Adapter Requirement Assessment ID and hash. A changed Context, Package, Recipe, operation, or assessment requires reassessment; do not reuse an earlier Compatibility Assessment or Replacement Plan.

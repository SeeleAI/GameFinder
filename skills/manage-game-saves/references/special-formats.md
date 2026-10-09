# Operations that change save internals

Use specialized support when the requested operation actually requires slot extraction/merging, embedded account rebinding, resigning, or format conversion. Whole-file copying and path/name mapping alone use the main generic workflow.

Establish the requirement from applicable documentation, local/source evidence, or a supported validator. A binary extension, unknown checksum policy, or absent Recipe is not itself proof that conversion is needed. Conversely, lack of an obvious account number in a byte scan does not disprove known account binding.

- **Elden Ring character-slot import:** read [elden-ring.md](elden-ring.md). Use its existing analyzed/staged adapter route and supported format scope.
- **Existing Recipe/Package workflow:** read [legacy-tools.md](legacy-tools.md) if continuing an established legacy operation. Its assessment outcomes constrain that operation, not all ordinary imports.
- **Other proven conversion needs:** use an available documented converter or Adapter within its supported scope and verify staged output. If none exists, preserve the source and target and report the concrete missing transformation. Developing a new converter is separate work unless requested.

Never label an unperformed transformation as complete or use the generic route to evade a demonstrated format/account conflict. Conversion output can enter a generic import only after the required transformation has been completed and the exact file mapping and verification evidence are available.

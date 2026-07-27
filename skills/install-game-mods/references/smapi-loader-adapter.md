# SMAPI Loader Compatibility Note

This document is retained as historical context. Contract V2 has replaced the rule that SMAPI installation requires a dedicated `smapi-loader-installer` Adapter.

Current routing:

- Standard self-contained SMAPI Mod folders can be expressed as bounded file-tree Proposals.
- The SMAPI runtime distribution is analyzed as a dependency package through Evidence, Context, Method query, and Agent Proposal.
- If that distribution requires executing its bundled installer, M2 returns `OPERATION_CAPABILITY_MISSING`.
- M3 will provide generic controlled `run_bundled_installer` with fixed executable selection, bounded arguments, timeout, declared write roots, pre/post snapshots, and recovery evidence.

Do not replace the missing M3 executor with shell commands or require the user to commission a SMAPI-specific Adapter.

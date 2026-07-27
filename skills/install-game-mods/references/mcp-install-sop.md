# Legacy V1 Installation SOP

This file is retained only for compatibility with already-created V1 Plans and test fixtures. New Skill runs use [agentic-v2-sop.md](agentic-v2-sop.md).

The V1 sequence is:

```text
probe_game_install
inspect_mod_archive
match_install_adapters
plan_mod_install
apply_mod_install(planId)
verify_mod_install
```

Its registered Game Profile and prewritten Adapter requirements belong to the replaced planning layer. Do not interpret `ADAPTER_NOT_FOUND` as a requirement to develop another Adapter for Contract V2.

V1 transaction records, backups, verification, recovery, and future uninstall evidence remain valid.

# Research, Download, and Install Routing

| Unresolved question | Skill |
|---|---|
| Which Mod should I choose? | `research-nexus-mods` |
| Save this exact Nexus file and required downloadable dependencies | `download-nexus-mods` |
| Install this verified Archive or Bundle into this exact game instance | `install-game-mods` |

For “find, download, and install”:

1. Research returns finalists without downloading.
2. The user selects an exact Mod/file.
3. Download resolves required dependencies, freezes its own Plan, downloads all selected files, and returns receipts plus a Bundle Manifest.
4. Install independently validates the material and builds Dynamic Game Context plus Evidence Packs.
5. Install freezes and displays each dependency-first Plan.
6. Apply uses only the exact current `planId`. The explicit install request authorizes an `auto_safe` Plan; `review_required` needs confirmation of that exact current Plan.

Research selection is not download authorization. Download completion does not expand installation scope. Installation planning must still produce an exact risk classification before apply.

Mod development, Vortex import, arbitrary ZIP extraction, and removal of a committed Mod are outside this Skill. Never turn a request to copy files into permission to bypass the installation engine.

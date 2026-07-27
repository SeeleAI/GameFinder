# Research, Download, and Install Routing

## Choose by unresolved question

| User's unresolved question | Skill |
|---|---|
| Which Mod should I choose? | `research-nexus-mods` |
| Save this exact selected Nexus file and required downloadable dependencies | `download-nexus-mods` |
| Install this exact verified Archive or Bundle into this game instance | `install-game-mods` |

## Combined requests

For “find, download, and install”:

1. Research remains read-only and returns finalists.
2. Obtain one unambiguous Mod/file selection.
3. Resolve dependencies, approve the Download Plan, download every selected file, and return a Bundle Manifest.
4. Installation independently verifies the Bundle, probes the game, and processes dependency-first Plans.
5. Display the newly created Plan and obtain explicit apply approval.
6. Apply only by `planId`, then verify.

Each stage preserves its stopping boundary. Research selection is not download authorization. Download completion is not installation approval. Installation planning is not apply approval.

## Requests outside this Skill

- “How is this Mod built?” or “help me develop a Mod” belongs to a future development Skill.
- “Import this into Vortex” is not deterministic local installation.
- “Extract this ZIP for me” is archive handling, not installation.
- “Remove this installed Mod” requires a future uninstall workflow based on Installation Record.
- “Copy these files into the game” must not bypass the installation engine.

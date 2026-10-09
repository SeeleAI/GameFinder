# Nexus download sessions

Research and choose the exact Mod URL and File ID first. The user's request to find and import a save authorizes selecting the best applicable file. Use `prepare_download` with that `modUrl`, `fileId`, and `backend: "persistent_chromium"`; this route does not require an Install Context. `prepare_nexus_save_download` remains available for an already established legacy candidate.

The main skill's raw-result retention rule applies throughout research, preparation, start, and status polling, including warnings and errors. Do not collect cookies, authorization values, or temporary CDN URLs.

## Required sequence

1. After either prepare tool, obtain the actual returned `download.sessionId` and check the selected Mod/File identity. Text continuation fields may mirror the same ID; never infer or invent it.
2. Call `start_download(sessionId, outputDirectory)` using an absolute staging/download directory, then poll `get_download_status(sessionId)` on the **same MCP server instance and connection**.
3. If the session ID is unavailable, or the original instance/session is lost, report the client/session compatibility blocker. Do not start a fallback server, create a replacement browser profile, or prepare again to guess/recover an ID. New isolated test processes are not a way to continue a real download.
4. Only when this same session explicitly returns `login_required` or `requiresUserInteraction`, use its existing dedicated Chromium window for the required interaction. If needed, call `open_nexus_login` at most once for the session. Let the user complete login/challenges; do not request credentials.
5. After login, call `start_download` again with the **original session ID and output directory**. Keep polling that session. Do not reopen login windows during polling.
6. On `completed`, retain the source identity, local archive path, receipt, size, and hash. Verify the actual file and safely inspect its contents before import. A started browser, completed login, or saved HTML page is not a completed save download.

Follow terminal errors and actionable interaction states. Report a persistent blocker with the preserved session ID and cause; do not silently switch download backends or accounts.

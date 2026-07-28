# nexus-mods-server

Local STDIO MCP server for Nexus Mods research, metadata, requirements, explicitly requested downloads, and evidence-driven transactional installation.

## Runtime prerequisites

Required on every machine:

- Windows 10 or Windows 11 for the current persistent-browser implementation;
- Node.js 20 or newer available as `node`;
- pnpm 11.x;
- network access to the npm registry and the Playwright browser CDN during initial setup;
- enough free disk space for a Playwright Chromium build and the dedicated Nexus profile.

Check the runtime before installing:

```powershell
node --version
pnpm --version
```

If `pnpm` exists but reports that `node` is not recognized, Node.js is not available on that shell's `PATH`. Install Node.js 20+ or fix `PATH` before continuing.

## Install project dependencies

From this directory:

```powershell
pnpm install
```

The project pins the Playwright package version. The package and its browser binary are separate: `pnpm install` installs the Node.js library, while the next command installs the matching Chromium build.

## Install the dedicated Playwright Chromium

Run once on a new machine, and again after a Playwright version upgrade:

```powershell
pnpm setup:browser
```

The setup intentionally uses Playwright's `--no-shell` option because this backend is fixed to visible (`headless: false`) Chromium for manual login and takeover. The separate Chromium headless-shell download is not required.

Verify the installed browser:

```powershell
pnpm browser:list
```

On Windows, Playwright uses this cache by default:

```text
%LOCALAPPDATA%\ms-playwright
```

No standalone Chromium, ChromeDriver, Selenium Server, browser extension, or Vortex installation is required. Existing Google Chrome or Microsoft Edge installations are not reused by default.

Do not set `PLAYWRIGHT_BROWSERS_PATH` for a normal personal installation. If an organization overrides it, the same value must be present both when running `pnpm setup:browser` and when starting the MCP server.

### Proxy or restricted network

If the Chromium download must use a proxy:

```powershell
$env:HTTPS_PROXY="https://proxy.example:3128"
pnpm setup:browser
```

For a slow initial connection:

```powershell
$env:PLAYWRIGHT_DOWNLOAD_CONNECTION_TIMEOUT="120000"
pnpm setup:browser
```

For an intercepting proxy with a private certificate authority:

```powershell
$env:NODE_EXTRA_CA_CERTS="C:\certs\root.crt"
pnpm setup:browser
```

These variables are only installation/network settings. They are not Nexus credentials.

## Dedicated Nexus browser profile

The MCP launches Playwright Chromium with a separate persistent profile:

```text
%LOCALAPPDATA%\GameFinder\nexus-browser-profile
```

This directory stores the Nexus browser session, including cookies and site settings. It is deliberately separate from:

- the repository;
- Playwright's Chromium executable cache;
- the user's everyday Chrome or Edge profile;
- Vortex data.

The directory is created automatically on first launch. To override it:

```powershell
$env:NEXUS_BROWSER_PROFILE_DIR="D:\GameFinderData\nexus-browser-profile"
```

The override must be an absolute, dedicated directory outside the repository. Do not point it at a drive root, home-directory root, or normal Chrome `User Data` directory.

Only one MCP/Chromium process may open this Profile at a time. A second process returns `BROWSER_PROFILE_BUSY` instead of modifying or deleting the Profile.

## First Nexus login

Start the MCP server through Codex and call:

```text
open_nexus_login
```

The server opens a visible dedicated Chromium window. Enter username, password, 2FA, and CAPTCHA only in that Nexus browser window. Never send them as MCP arguments or chat text.

After completing login, call:

```text
browser_status
```

Expected state:

```json
{
  "engineInstalled": true,
  "profileExists": true,
  "running": true,
  "authState": "authenticated"
}
```

The Profile persists after Chromium and the MCP server close. On the next run, `open_nexus_login` first checks the protected Nexus preferences page; if the session is still valid it returns `authenticated` without asking the user to log in again.

For terminal acceptance testing:

```powershell
pnpm acceptance:browser-login
```

This command performs PC-1: it opens the same dedicated Profile, waits for the user to finish login, reports only the public authentication state, and closes Chromium after success or timeout.

Then start a fresh process to perform PC-2:

```powershell
pnpm acceptance:browser-login-persistence
```

PC-2 reopens the protected Nexus page from a new browser service instance and passes only if the stored Profile is still authenticated.

For the explicit Phase 5 real-download acceptance target, build the server and enable the live-test guard:

```powershell
pnpm build
$env:NEXUS_LIVE_TEST="1"
pnpm acceptance:browser-download
Remove-Item Env:NEXUS_LIVE_TEST
```

This runner downloads only Elden Ring Mod 9531 / File 47215 through the persistent Chromium backend. It validates the recorded 1,474,885-byte size and SHA-256 baseline, preserves the archive and receipt under a run-specific `.codex-work` directory, and never extracts or installs it. If Nexus shows login, 2FA, CAPTCHA, or another normal confirmation, complete it in the visible Chromium window and leave the runner active. The runner keeps that page stable and prints a `resume-after-interaction.flag` path; create the empty signal file only after the visible interaction is complete.

Validate an expired login without touching the primary authenticated Profile:

```powershell
pnpm build
$env:NEXUS_LIVE_TEST="1"
pnpm acceptance:browser-expired-login
Remove-Item Env:NEXUS_LIVE_TEST
```

This creates a disposable clean Profile outside the repository, verifies that the production STDIO MCP download reaches `login_required`, retries the same session, and removes the temporary Profile.

Validate the PC-5 interaction matrix:

```powershell
pnpm acceptance:browser-interactions
```

This controlled Chromium acceptance covers CAPTCHA, 2FA, adult-content confirmation, Cookie consent, rate limiting, maintenance, and same-session recovery without manipulating the real account or intentionally triggering Nexus protections.

Phase 5 found that Nexus/Cloudflare rejects Chromium launched through Playwright `launchPersistentContext`, even in visible mode. The production `persistent_chromium` backend now launches Chromium as an ordinary process with a fixed loopback CDP endpoint, opens the exact Nexus File URL before attachment, and attaches afterward:

```powershell
$env:NEXUS_LIVE_TEST="1"
pnpm acceptance:browser-cdp-probe
pnpm acceptance:browser-cdp-clearance
pnpm acceptance:browser-cdp-download
Remove-Item Env:NEXUS_LIVE_TEST
```

The exact PC-3 target passed through both the direct runner and the production MCP `prepare_download → start_download → get_download_status` chain with the expected 1,474,885 bytes, SHA-256, and ZIP integrity. `persistent_chromium` uses `OrdinaryCdpBrowserManager`; `native` remains the default.

## Persistent Chromium download workflow

The browser backend is explicit opt-in. Native/NXM remains the default when `backend` is omitted.

1. Call `prepare_download` with the canonical Mod URL, optional exact `fileId`, and:

   ```json
   {
     "modUrl": "https://www.nexusmods.com/eldenring/mods/9531",
     "fileId": 47215,
     "backend": "persistent_chromium"
   }
   ```

2. Call `start_download` with the returned `sessionId` and an absolute output directory:

   ```json
   {
     "sessionId": "<prepared-session-id>",
     "outputDirectory": "C:\\Users\\me\\Downloads\\Nexus"
   }
   ```

3. Poll `get_download_status`. The start call returns quickly while the visible Chromium workflow continues in the MCP process.

4. If `requiresUserInteraction` is `true`, inspect the visible browser and complete the reported login, CAPTCHA, or normal Nexus confirmation. Then call `start_download` again for the same resumable session.

5. Use `cancel_download` to cancel a prepared or active browser session before final verification.

Completed status includes the absolute archive path and a non-secret JSON receipt containing the backend, file identity, byte count, SHA-256, completion time, and archive check. Files are first written under `<outputDirectory>\.nexus-download-staging`, verified through the same finalizer as native downloads, and exposed without overwriting an existing archive or receipt. The backend does not extract, execute, or install the Mod.

## Contract V2 installation workflow

Contract V2 can plan a bounded file-type Mod installation even when the game has no registered Profile and the package has no prewritten Adapter:

1. Call `list_game_profiles`, then `probe_game_context` for the exact game root. Use a matching `legacyProfileId`; provide explicit identity and narrowly bounded roots only for an unregistered game. Do not substitute a Nexus numeric game ID for the stable profile/game ID.
2. Call `prepare_install_evidence` with the exact Archive, matching Nexus receipt, and `gameContextId`.
3. Call `query_install_methods` and obey `proposalReadiness.recommendedAction`. Re-probe a matching registered profile, stop before Proposal when no package unit exists, reuse a `verified_match`, or derive an evidence-bounded file Proposal only when permitted.
4. Call `submit_install_proposal`, then `freeze_install_plan`.
5. Display the returned operations, targets, conflicts, risk, reversibility, approval digest, expiry, and `planId`. The game is still unchanged.
6. After explicit approval, call `apply_agentic_install_plan` with only that `planId`.
7. Call `verify_mod_install` with the resulting `installationId`.

The file executor supports a selected package tree installed under a declared writable root. The controlled-installer executor supports one Evidence-bound `run_bundled_installer` operation with a fixed runtime, arguments, minimal environment, timeout, declared write roots, static postconditions, side-effect observation, durable journal, and bounded recovery. Both paths reject protected paths, stale hashes, unresolved choices, unsupported ownership, and mutable apply arguments.

Controlled installers default to `terminalMode: redirected_stdio`. On Windows, an installer that demonstrably requires a real console can use `terminalMode: pseudoterminal`, backed by ConPTY through the optional `node-pty` dependency. This mode does not send input and does not automate interactive choices; it only supplies console semantics and captures a bounded, sanitized combined terminal transcript. Check `query_install_methods.operationCapabilities` before proposing it. If Evidence has no package unit, stop before Proposal instead of inventing selection or entry data. No game- or Mod-specific Adapter is required.

For a source checkout, install dependencies with `pnpm install`. `pnpm-workspace.yaml` explicitly permits the `node-pty` native package build/install step. The published `node-pty` Windows x64 package includes prebuilt ConPTY components, so a local C++ compiler is not normally required. Pseudoterminal mode requires a Windows MCP host with ConPTY support; other hosts continue to support redirected stdio and report the pseudoterminal capability as unavailable.

## Browser configuration

Supported variables:

| Variable | Default | Valid range or values |
|---|---:|---|
| `NEXUS_BROWSER_PROFILE_DIR` | `%LOCALAPPDATA%\GameFinder\nexus-browser-profile` | Dedicated absolute path outside repository |
| `NEXUS_BROWSER_LAUNCH_TIMEOUT_MS` | `30000` | `1000`–`300000` |
| `NEXUS_BROWSER_NAVIGATION_TIMEOUT_MS` | `45000` | `1000`–`300000` |
| `NEXUS_BROWSER_DOWNLOAD_START_TIMEOUT_MS` | `120000` | `1000`–`600000` |
| `NEXUS_BROWSER_DOWNLOAD_TIMEOUT_MS` | `0` | `0`–`86400000`; `0` disables a fixed transfer timeout |
| `NEXUS_BROWSER_LOGIN_WAIT_MS` | `900000` | `60000`–`3600000` |
| `NEXUS_BROWSER_KEEP_OPEN` | `true` | `true`, `false`, `1`, `0` |

See [.env.example](.env.example) for a non-secret template.

## Browser health errors

`browser_status` and `open_nexus_login` use stable errors:

- `BROWSER_NOT_INSTALLED`: run `pnpm setup:browser`;
- `BROWSER_PROFILE_BUSY`: close the other dedicated Nexus Chromium/MCP process;
- `BROWSER_LAUNCH_FAILED`: Chromium could not start;
- `BROWSER_PAGE_UNRESPONSIVE`: Nexus did not finish the login navigation or page inspection.

The tools never return the Profile path, cookies, account identity, password fields, or temporary download URLs.

Phase 3 page-flow errors additionally distinguish:

- `LOGIN_REQUIRED`, `CAPTCHA_REQUIRED`, and `ADULT_CONTENT_CONFIRMATION_REQUIRED`;
- `NEXUS_RATE_LIMITED`, `NEXUS_MAINTENANCE`, and `MOD_PAGE_NOT_FOUND`;
- `FILE_ROW_NOT_FOUND` and `FILE_ROW_AMBIGUOUS`;
- `DOWNLOAD_BUTTON_NOT_FOUND`, `DOWNLOAD_START_TIMEOUT`, and `DOWNLOAD_CANCELED`;
- `RESUMABLE_DOWNLOAD_NOT_SUPPORTED` and `DOWNLOAD_BUSY`.

These errors contain only the page kind, retryability, and whether visible user interaction is required. They do not contain page HTML, download URLs, cookies, or account data.

## Development checks

```powershell
pnpm check
pnpm test
pnpm build
pnpm test:stdio
```

To additionally launch the real Chromium child through STDIO and verify that MCP framing remains intact:

```powershell
$env:NEXUS_BROWSER_STDIO_LAUNCH_TEST="1"
pnpm test:stdio
Remove-Item Env:NEXUS_BROWSER_STDIO_LAUNCH_TEST
```

This opt-in check briefly opens the dedicated Nexus Profile and closes it when the smoke client exits.

The real Chromium Profile and local HTML download-flow integration tests are opt-in:

```powershell
$env:NEXUS_BROWSER_INTEGRATION_TEST="1"
pnpm test:browser
```

These tests create temporary data only. They verify that Profile data survives a Chromium restart and exercise the complete local fixture flow:

```text
Manual Download
→ Requirements
→ Standard Download
→ Slow Download countdown
→ Playwright download event
→ saveAs(stagingPath)
```

The suite also covers direct Standard downloads, ambiguous `fileId` containers, Resumable-only pages, Cloudflare/CAPTCHA classification, and cancellation before the final click. It never uses the real Nexus Profile or downloads a real Mod.

## Current browser scope

Implemented:

- Playwright Chromium environment detection;
- dedicated persistent Profile;
- single-process Profile lock;
- visible first-login flow;
- login-state detection;
- exact Nexus file-page URL construction;
- prioritized `fileId` container resolution;
- Manual Download and normal Requirements handling;
- Standard and Slow Download selection;
- pre-click Playwright download event registration and `saveAs()`;
- cancellation before final click and during an active Playwright download;
- stable page classification and Phase 3 browser error codes;
- prepared persistent Chromium download sessions;
- asynchronous MCP `start_download`, `get_download_status`, and `cancel_download`;
- one-active-browser-download concurrency control;
- shared native/browser byte-count, SHA-256, archive, final-path, and receipt verification;
- safe staging and no-overwrite finalization;
- `browser_status`;
- `open_nexus_login`.

Not yet implemented:

- resumable browser downloads;
- public Mod uninstall planning/apply tools. The internal transactional uninstall
  engine remains available, and local Installation Dependency Snapshots are now
  persisted as the prerequisite for dependent-aware uninstall blocking.

Phase 5 PC-1 through PC-6 are complete. PC-3 passed against the real Nexus Mod through the production MCP chain; PC-4 passed with a real clean Profile; PC-5 uses deterministic controlled pages for conditions that should not be intentionally induced on Nexus. The existing native/NXM backend remains the default.

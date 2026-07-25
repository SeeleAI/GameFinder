# Persistent Chromium Phase 5 Acceptance Record

Date: 2026-07-24; PC-4/PC-5 completed 2026-07-25

Target:

- Mod URL: `https://www.nexusmods.com/eldenring/mods/9531`
- File ID: `47215`
- Expected size: `1,474,885` bytes
- Expected SHA-256: `f3e339ea655b5eba4173f401005baef68506fa125de0b823dd27a733f94e4abd`

## Safety and execution rules

- Real Nexus tests require `NEXUS_LIVE_TEST=1`.
- The dedicated persistent Chromium Profile is used; no everyday Chrome/Edge Profile or Vortex state is read.
- Credentials, 2FA, and CAPTCHA are entered only in the visible Nexus page.
- The runner follows the normal Manual/Requirements/Standard/Slow Download page flow.
- The runner downloads one exact file and does not extract, execute, install, or import it.
- A run-specific directory under `.codex-work/acceptance-downloads` is used by default.
- The final receipt is checked for temporary NXM, CDN, Cookie, and authorization markers.

## Commands

Build before live acceptance:

```powershell
pnpm build
```

PC-1 first login:

```powershell
pnpm acceptance:browser-login
```

PC-2 fresh-process persistence:

```powershell
pnpm acceptance:browser-login-persistence
```

PC-3 exact real download:

```powershell
$env:NEXUS_LIVE_TEST="1"
pnpm acceptance:browser-download
Remove-Item Env:NEXUS_LIVE_TEST
```

PC-4 expired login with a disposable clean Profile:

```powershell
$env:NEXUS_LIVE_TEST="1"
pnpm acceptance:browser-expired-login
Remove-Item Env:NEXUS_LIVE_TEST
```

PC-5 controlled interaction and recovery matrix:

```powershell
pnpm acceptance:browser-interactions
```

When the runner reports `waiting_for_resume`, complete the visible browser interaction first. Then create the exact empty `resume-after-interaction.flag` path printed by the runner. The page is not reloaded while waiting for this signal.

PC-6 real Profile lock:

```powershell
pnpm acceptance:browser-profile-busy
```

Optional output override:

```powershell
$env:NEXUS_ACCEPTANCE_OUTPUT_DIR="D:\GameFinderAcceptance\EldenRing-9531-47215"
```

## Results

| Case | Status | Evidence |
|---|---|---|
| PC-1 first login | Previously passed | Dedicated Profile returned `authenticated`; credentials were entered only in Chromium. |
| PC-2 login persistence | Passed 2026-07-24 | A fresh browser service reopened the Profile and returned `authenticated`. |
| PC-3 real file download | Passed 2026-07-24 with ordinary Chromium CDP runner | Downloaded File 47215 without NXM or Vortex; bytes, SHA-256, ZIP integrity, final path, and receipt all matched the baseline. |
| PC-4 expired login | Passed 2026-07-25 | A disposable clean Profile reached `login_required` through the production STDIO MCP path; global browser status agreed, the same session was startable again, the primary Profile was untouched, and the temporary Profile was removed. |
| PC-5 user takeover | Passed 2026-07-25 | Controlled Chromium pages covered CAPTCHA, 2FA, adult-content confirmation, Cookie consent, rate limiting, and maintenance. Interaction cases returned explicit reasons and resumed the same session in Manager tests; maintenance/rate limiting remained retryable technical failures. No CAPTCHA bypass was attempted. |
| PC-6 concurrency/Profile lock | Passed 2026-07-24 | Real two-process Profile probe returned `BROWSER_PROFILE_BUSY`; Manager regression returns `DOWNLOAD_BUSY` for a second active workflow. |

The official Nexus file metadata was rechecked immediately before PC-3: File 47215 remains an active MAIN file named `ErdGameTools 20260607-9531-1-3-1-1780798908.zip` with `sizeInBytes=1474885`.

PC-4 evidence is written under `.codex-work/acceptance-pc4/<run>/pc4-expired-login-status.json`. PC-5 evidence is written under `.codex-work/acceptance-pc5/<run>/pc5-interaction-status.json`. PC-5 deliberately uses controlled pages for rare or unsafe-to-induce conditions such as maintenance and rate limiting; it does not manipulate the real account or intentionally trigger Nexus protections.

## PC-3 live finding: Playwright challenge loop

The runner reached the exact file flow with an authenticated persistent Profile, then classified the real page as `CAPTCHA_REQUIRED`. The user repeatedly selected the human-verification checkbox, but Turnstile returned to the same challenge after spinning. The runner was paused on the page and was not reloading it during the final observation, so the loop was not caused by runner retry timing.

The active browser was the Playwright-bundled Chromium launched with a remote debugging pipe. Cloudflare documents browser automation frameworks including Playwright as automated traffic that Challenges may block, and documents repeated challenges as a challenge loop caused by strong bot signals. This invalidates the assumption that a visible headed Playwright browser necessarily permits successful manual CAPTCHA takeover.

No NXM link, CDN authorization, archive, receipt, extraction, execution, or installation occurred. The acceptance processes and Chromium child were terminated after the diagnosis; the persistent Profile was preserved.

Next architecture experiment:

1. launch the dedicated Chromium executable as an ordinary user browser without Playwright automation/debugging flags;
2. let the user complete any Cloudflare challenge in that ordinary browser;
3. only after clearance, attach over a separately enabled CDP endpoint or use a local extension/native bridge;
4. verify whether subsequent normal page navigation remains accepted before restoring automated clicks;
5. retain native/NXM as the working fallback until this experiment passes.

The first local probe is:

```powershell
pnpm acceptance:browser-cdp-probe
```

It uses a disposable Profile under `%LOCALAPPDATA%\GameFinder\cdp-probes`, launches the Chromium executable directly with only a dedicated `user-data-dir` and fixed loopback CDP endpoint, attaches after launch, and verifies that the page observes `navigator.webdriver === false`. It does not contact Nexus.

If the probe passes, the real clearance experiment is:

```powershell
$env:NEXUS_LIVE_TEST="1"
pnpm acceptance:browser-cdp-clearance
Remove-Item Env:NEXUS_LIVE_TEST
```

This launches the existing dedicated Profile as an ordinary Chromium process and does not attach Playwright until the user creates the exact `attach-after-clearance.flag` printed by the runner. After attachment it only evaluates non-secret browser signals and classifies the current page; it does not click or download.

After the delayed-attach experiment passes, the exact-file CDP runner is:

```powershell
$env:NEXUS_LIVE_TEST="1"
pnpm acceptance:browser-cdp-download
Remove-Item Env:NEXUS_LIVE_TEST
```

The command builds the TypeScript sources first so browser-evaluated functions are not transformed by the `tsx` runtime. It then launches ordinary Chromium, attaches over a fixed loopback CDP endpoint, runs the existing normal Nexus page controller, and uses the shared final verifier.

## Ordinary Chromium CDP experiment results

The experiment passed in three layers:

1. Disposable local probe:
   - direct Chromium process with fixed loopback CDP port;
   - `navigator.webdriver === false`;
   - User-Agent did not contain `Headless`;
   - normal language and plugin APIs were present.
2. Real Nexus delayed attach:
   - the ordinary browser did not enter the previous Cloudflare challenge loop;
   - the user completed one normal Nexus login because the old Playwright-created Cookie store was not reusable;
   - the new ordinary-browser login persisted across restart;
   - after delayed CDP attach, `navigator.webdriver` remained `false`;
   - the page remained `mod_files` and did not return to CAPTCHA.
3. Exact PC-3 download:
   - the current Nexus page exposed the exact file flow inside the `mod-file-download` Shadow DOM component;
   - the controller was updated to use Playwright's Shadow-DOM-aware locators and to support a direct Slow Download option without a preceding Manual Download button;
   - the Slow Download event was captured and saved to staging;
   - the shared verifier finalized the archive and receipt.

PC-3 receipt:

```text
.codex-work/acceptance-downloads-cdp/eldenring/mod-9531/2026-07-24T15-42-40-379Z/
ErdGameTools 20260607-9531-1-3-1-1780798908.zip
ErdGameTools 20260607-9531-1-3-1-1780798908.zip.nexus-receipt.json
```

Verified result:

```text
bytes:       1474885
sha256:      f3e339ea655b5eba4173f401005baef68506fa125de0b823dd27a733f94e4abd
archive:     ZIP valid
backend:     persistent_chromium
webdriver:   false
```

An independent `Get-FileHash -Algorithm SHA256` check matched the receipt. The receipt contained none of the checked temporary credential markers: `nxm://`, `key=`, `expires=`, `cookie`, or `authorization:`.

The production MCP browser backend now uses `OrdinaryCdpBrowserManager`. On 2026-07-24, an independent STDIO MCP acceptance called `prepare_download`, `start_download`, and polled `get_download_status` for Mod 9531 / File 47215. It completed in about 16 seconds with the same 1,474,885-byte file, SHA-256, and valid ZIP result shown above. The production path opens the exact Nexus File URL in ordinary Chromium before CDP attachment and does not use `open_nexus_login`, NXM, or Vortex during this acceptance. Native/NXM remains the default when no backend is specified.

## Automated baseline

Before and after every live run:

```powershell
pnpm check
pnpm test
pnpm build
pnpm test:stdio
$env:NEXUS_BROWSER_INTEGRATION_TEST="1"
pnpm test:browser
Remove-Item Env:NEXUS_BROWSER_INTEGRATION_TEST
```

The local fixture suite covers page-flow and error branches without contacting Nexus. A local pass is not a substitute for PC-3.

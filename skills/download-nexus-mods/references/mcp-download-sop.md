# Nexus MCP Download SOP

## Contents

- Preconditions
- File selection
- Backend policy
- Persistent Chromium sequence
- State and interaction handling
- Native fallback
- Cancellation and failure
- Completion checklist

## Preconditions

Require:

- Explicit user intent to download.
- One canonical URL under `https://www.nexusmods.com/<game-domain>/mods/<mod-id>`.
- An exact `fileId`, or explicit acceptance of the latest active MAIN file.
- An absolute output directory outside game, browser Profile, home-root, and drive-root locations.
- Healthy `nexus-mods-server` MCP availability.

Call `health_check` only when MCP or credential availability is uncertain. Use `get_mod` or `get_mod_files` when identity, availability, variants, or file state needs confirmation.

## File selection

Pass `fileId` when the user selected a specific file or a Research handoff includes a confirmed file. Without `fileId`, `prepare_download` selects the latest active MAIN file, preferring the primary file and then upload recency.

Call `get_mod_files` before preparation when:

- More than one MAIN file may target different game versions, languages, platforms, or loaders.
- The request names an optional component, patch, old version, or compatibility branch.
- A Research handoff has `file_id: null` and its warnings identify file-choice uncertainty.

Never automatically select ARCHIVED or REMOVED files. Do not substitute OLD, OPTIONAL, or MISCELLANEOUS files for MAIN without the user's explicit selection.

## Backend policy

Use:

```json
{
  "backend": "persistent_chromium"
}
```

for normal user downloads. This launches the dedicated visible Chromium Profile and follows the normal Nexus page flow without requiring the user to transport an NXM link.

The MCP server keeps `native` as its compatibility default. Use `native` only when the user explicitly requests it or an established Premium/NXM workflow is already in progress. Never downgrade from persistent Chromium to native merely because login or CAPTCHA interaction is required.

## Persistent Chromium sequence

1. Call:

   ```text
   prepare_download(modUrl, fileId?, backend="persistent_chromium")
   ```

2. Verify:

   - `backend == "persistent_chromium"`
   - canonical Mod URL and IDs match;
   - selected file is active and expected;
   - `authorizationPageUrl == null`;
   - session has not expired.

3. Call exactly once:

   ```text
   start_download(sessionId, absoluteOutputDirectory)
   ```

4. Poll:

   ```text
   get_download_status(sessionId)
   ```

   Use a moderate interval, normally about two seconds. Do not emit every unchanged poll to the user.

5. Finish only on `completed` with a valid receipt.

## State and interaction handling

| State or signal | Action |
|---|---|
| `prepared` | Call `start_download` after target verification. |
| `checking_login`, `navigating`, `locating_file`, `handling_requirements`, `waiting_download_option`, `waiting_slow_download`, `downloading`, `verifying` | Continue polling. |
| `login_required` / `interactionReason=login` | Ask the user to complete login in the visible dedicated Chromium. Do not accept credentials in chat. After the user confirms completion, call `start_download` again with the same session and output directory. |
| `user_interaction_required` / `captcha` | Ask the user to complete the visible verification. Do not solve, bypass, or repeatedly click CAPTCHA. Resume the same session only after confirmation. |
| `user_interaction_required` / `two_factor` | Ask the user to enter the code directly in Chromium. Never request the code in chat. Resume the same session after confirmation. |
| `user_interaction_required` / `adult_content` | Ask the user to review and confirm the Nexus preference in Chromium. Resume after confirmation. |
| `user_interaction_required` / `cookie_consent` | Ask the user to make the consent choice in Chromium. Resume after confirmation. |
| `NEXUS_RATE_LIMITED`, `NEXUS_MAINTENANCE` | Report a retryable technical condition. Do not mislabel it as human verification. Retry only when the status or elapsed time makes that reasonable. |
| `DOWNLOAD_BUSY` | Do not start another browser download. Report the active-session constraint. |
| `BROWSER_PROFILE_BUSY` | Ask the user to close the other dedicated-Profile process; do not delete or copy the Profile. |
| `failed` | Report the safe error code and retryability. Do not claim a download exists. |
| `canceled` | Stop. Do not restart without new user intent. |
| `completed` | Validate the receipt and return the result. |

Interaction recovery reuses the same prepared session. Do not call `prepare_download` again unless the session expired, the file choice changed, or MCP explicitly says to prepare again.

## Native fallback

For `native`, follow the response capability:

- Premium direct authorization may reach `ready` without an NXM handoff.
- Non-Premium native authorization uses the loopback authorization page.
- Never ask the user to paste an NXM link, key, expiry, Cookie, or temporary URL into chat or MCP arguments.
- When the native session is `ready`, call `download_mod_file(sessionId, outputDirectory)`.

Do not call `start_download` for native sessions. Do not call `download_mod_file` for persistent Chromium sessions.

## Cancellation and failure

Call `cancel_download(sessionId)` for a prepared or active persistent Chromium session only after explicit cancellation or a replacement request that invalidates the active operation.

Retry one transient technical failure only when `retryable=true` and the retry does not require changing the file or destination. Ask before any materially different fallback, backend change, or additional Mod download.

## Completion checklist

- Explicit download intent was present.
- Canonical Mod and file identity match.
- Output directory is absolute and safe.
- Terminal state is `completed`.
- Final path is not a temporary file.
- Byte count and SHA-256 are present.
- Archive validation is not false.
- Receipt path is absolute and readable.
- No temporary authorization material was exposed.
- Nothing was extracted, executed, installed, or imported.

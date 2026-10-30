# Authenticated capture — how it works and what it stores

VidGen can capture pages behind a login **that the user is authorized to see**. It never signs in by itself, never bypasses MFA, CAPTCHA or authorization checks, and never writes session material to disk.

## Two ways to provide a session

| Mode | Command | Who signs in | Tested |
|---|---|---|---|
| Interactive sign-in | `capture.mjs <storyboard> --login` | **You**, in a Chromium window VidGen opens at `auth.loginUrl` | yes (fixture, headless variant) |
| Reuse a signed-in browser | `capture.mjs <storyboard> --cdp http://127.0.0.1:9222` | You, earlier, in a Chromium you started with remote debugging | yes (fixture) |

**`--login` flow.** VidGen opens a visible browser at `loginUrl` and prints `Sign in in the browser window…`. You sign in normally (SSO and MFA included). VidGen only polls the page until `auth.authenticated` is visible on the app's origin, then copies the session into memory and closes that window.
- **Pause:** the sign-in step waits for you, up to `auth.timeout` (default 300 s).
- **Cancel:** close the window (exit 3; not covered by automated tests) or press Ctrl-C (exit 130). Nothing is captured in either case.
- During sign-in the browser may visit origins listed in `auth.allowedOrigins` (e.g. your SSO provider). Any other origin aborts with exit 6.

**`--cdp` flow.** Use a dedicated profile: `chrome --remote-debugging-port=9222 --user-data-dir=$HOME/.vidgen-chrome`. Sign in there, then run capture.
- VidGen reads cookies and storage from that browser's default context **into memory** and disconnects. Your browser keeps running.
- Do **not** point remote debugging at your everyday profile: any local process can drive a browser exposed on a debugging port.
- Reusing a normal running Chrome profile directly is not supported (profile locks, and the risk of exposing every site you're signed in to).

## What is stored, where

| Data | Stored? |
|---|---|
| Passwords, OTPs | Never seen. You type them into the real login page; VidGen does not read form fields. Storyboards containing credential-like keys, or `fill` actions targeting password/secret/OTP fields, are rejected (exit 2). |
| Cookies, localStorage, tokens (Playwright `storageState`) | In memory only, for one capture run. Never written by VidGen, never in `.vidgen/context.json`, logs or exports. |
| Browser temp profile | Playwright's own temp dir, removed when the browser closes (also on Ctrl-C/SIGTERM). Not removed on `kill -9`. |
| Screenshots of private pages | `.vidgen/flows/<flow>/captures/` in **your project**. Capture warns if `.vidgen/` is not git-ignored. |
| URLs in metadata/logs | Origin + path only; query strings shown as `?…` (OAuth codes and tokens often live there). |
| Console errors, page titles, error messages | Scrubbed for JWTs, `Bearer …`, `key=value` secrets, `sk-…` keys. |
| `package.json` scripts in `context.json` | Inline env secrets (`API_KEY=…`) replaced with `[redacted]`. |

## How failures are detected (per capture scene)

The checks run in this order. A failing scene leaves no screenshot, and export refuses flows with failed scenes, including the combined video.

1. **Left the app.** If the page origin differs from `baseUrl`, the scene fails with `navigation`. External pages are never captured.
2. **Login page.** If the URL matches `auth.loginPatterns` or a login form (`auth.loginSelectors`) is visible, the scene fails with `auth`. This applies to public storyboards too, so an unexpected login redirect can never pass as the target screen.
3. **Forbidden.** An HTTP 403 response, a heading or title like "403 / Forbidden / Access denied / Not authorized", or an `auth.forbidden` marker fails the scene with `forbidden`.
4. **Positive proof of sign-in.** If `auth.authenticated` (selector, text and/or URL regex) is not visible, the scene fails with `auth`. Mark genuinely public scenes inside an auth flow with `"public": true`.
5. Scene `expect` assertions, then the scene checks (noop, loading, blank and so on).

Before capturing anything, VidGen opens the first non-public capture route. If that lands on a login page, it exits 6 ("no session, or it expired").

If the session expires mid-flow, every later scene fails with `auth`. VidGen never retries sign-in on its own, so there is no login loop.

## Exit codes (capture.mjs)

| Code | Meaning |
|---|---|
| 0 | All scenes captured |
| 1 | One or more scenes failed |
| 2 | Bad usage or config, or credentials found in the storyboard |
| 3 | Sign-in cancelled |
| 4 | Sign-in timeout |
| 5 | Browser failed to start, or CDP connection failed |
| 6 | Not signed in, session expired, or sign-in left the allowed origins |
| 130 | Interrupted |

## Redaction

Before each screenshot, opaque gray boxes are drawn over:
- password inputs, `[autocomplete^="cc-"]` and `[data-vidgen-redact]` (always);
- `storyboard.redact` and `scene.redact` selectors.

The boxes are added after all checks and removed right after the screenshot, so they never change app behaviour. `<scene>.json` records how many elements each selector covered. A configured selector that matched nothing is listed as a warning.

**Redaction is selector-based, not automatic PII detection.** Names, emails, avatars or data you didn't list **will be visible**. Use synthetic demo accounts and seeded demo data, and **review every contact sheet before sharing a video captured from authenticated pages.**

## Example

```json
{
  "baseUrl": "http://localhost:3000",
  "auth": {
    "loginUrl": "/login",
    "authenticated": { "selector": "[data-testid=account-menu]" },
    "loginPatterns": ["^/(login|signin)"],
    "allowedOrigins": ["https://login.example-idp.com"],
    "forbidden": { "text": ["Upgrade required"] },
    "timeout": 300000
  },
  "redact": [".account-email", "[data-testid=api-key]"],
  "scenes": [
    { "id": "dash", "type": "capture", "route": "/app", "expect": { "text": "Team dashboard" } },
    { "id": "pricing", "type": "capture", "route": "/pricing", "public": true }
  ]
}
```

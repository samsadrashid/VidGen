# storyboard.json schema

```json
{
  "flow": "signup-to-first-project",
  "title": "Launch your first project in 60 seconds",
  "baseUrl": "http://localhost:3000",
  "music": "auto",
  "voiceover": true,
  "voice": "Samantha",
  "voiceRate": 180,
  "brand": { "primary": "#4F46E5", "background": "#0B0B12", "font": "Inter" },
  "scenes": [
    {
      "id": "s1",
      "type": "title",
      "text": "Ship faster with Acme",
      "duration": 2.5
    },
    {
      "id": "s2",
      "type": "capture",
      "route": "/signup",
      "actions": [
        { "do": "fill", "selector": "input[name=email]", "value": "demo@example.com" },
        { "do": "click", "selector": "button[type=submit]" },
        { "do": "waitFor", "selector": "[data-testid=dashboard]" }
      ],
      "caption": "Sign up in seconds",
      "narration": "Create an account in seconds.",
      "motion": "zoom-in",
      "transition": "crossfade",
      "duration": 4
    },
    { "id": "s3", "type": "outro", "text": "acme.dev", "duration": 2.5 }
  ]
}
```

- `id` (every scene) and flow names: letters, digits, `-`, `_`, max 64 characters (`^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`). They become file names. Anything else — `/`, `\\`, `..`, a leading `.` — is refused with exit 2 before any file is touched.
- `type`: `title` | `capture` | `outro`.
- `voiceover`: `true` = generate narration from each scene's `narration` with local TTS (`voiceover.mjs`); `false` = music-only (narration files are ignored even if present); unset = only hand-made files in `audio/<scene>.(aiff|wav|mp3|m4a)` are used.
- `voice` (optional): an installed voice name for the engine (`say -v ?` for `say`; Kokoro voices such as `af_heart`, see README). Unknown names fail (exit 1) instead of silently falling back. `voiceRate` (optional): 90–360 words per minute.
- `narration`: one sentence per scene. Its audio must fit the scene's `duration`, or voiceover/render fail with the duration to use. Narration starts at its scene's start; the music ducks under each line and recovers in pauses.
- `audio` (optional): `{ "musicVolume": 0.7, "duckDb": 15, "attack": 0.4, "release": 0.8, "fadeIn": 1, "fadeOut": 1.5 }` — music level, how far it ducks under each narration line, ramp times, music fades. Ranges and behaviour: README › Audio › Mix settings.
- `navigationTimeout` (optional, ms, default 15000, 5000–120000): page-load and `waitFor` limit for slow servers (e.g. server rendering against a busy local database). A `waitFor` action may set its own `timeout`.
- `localStorage` (optional): `{ "key": "value" }` strings set on the app's origin before any page script runs — for dismissing onboarding tours, cookie banners or "what's new" popups that would cover the screen. Never for sessions or tokens.
- `style` (top level or per capture scene): `screen` (default, full-bleed screenshot) | `device` (screenshot inside a browser window in landscape / a phone in portrait, on a brand-color canvas).
- `subtitles` (optional): `true` or `{ "size": px }` (20–120; default ≈ 36 px landscape / 42 px portrait). Shows each scene's `narration` as short timed phrases on a black liquid-glass pill at the bottom; captions shrink and move up to make room.
- `voicePolish` (optional, default `true`): broadcast-style processing of every narration line (EQ, de-ess, compression, 48 kHz); `false` keeps the raw engine output.
- `tts` / `voice` / `voiceSpeed`: see README › Voiceover (`"tts": "kokoro"`, `"voice": "af_heart"` for a natural local voice).
- `actions.do`: `click` | `fill` | `hover` | `scroll` | `wait` (ms in `value`) | `waitFor` | `goto` | `tap` (`x`,`y` as 0..1 viewport fractions, optional per-format override `"landscape": {"x","y"}` / `"vertical": {...}` — for canvas UIs like Flutter web with no DOM selectors; verify on the contact sheet, QA cannot tell if a tap missed).
- `motion` (capture scenes): `none` (default) | `zoom-in` | `zoom-out` | `pan-down`. Eased (smoothstep), restrained: zooms are 1.00↔1.06; `pan-down` scrolls a 1.12× view top→bottom. Title/outro cards always use a gentle zoom-in.
- `transition`: how a scene hands over to the **next** one. Set per scene or once at the top level (`"transition": "crossfade"`).

| Value | Effect |
|---|---|
| `crossfade` (default) | Blend into the next scene |
| `cut` | Instant switch. If every boundary is a cut, render uses lossless stream copy |
| `fade` | Fade through black (the pre-v0.2 look) |
| `slide` | The next scene pushes in from the right |

- `transitionDuration`: 0.2–1.0 s (default 0.5), per scene or top level. It must be at most half of both neighbouring scenes.
- Overlaps borrow an extended tail of the outgoing scene. Every scene still starts at the sum of the previous durations, and the video is exactly the sum of scene durations. Audio, narration timing, render manifests and QA fingerprints are unaffected.
- Only the first scene fades in from black and the last fades out.
- Unknown values, out-of-range durations, or transitions too long for their scenes fail the render with exit 1, leaving previous outputs untouched.
- Total length: 15–60 s per flow. Captions ≤ 7 words.
- Selectors must come from real source (prefer `data-testid`, `name`, roles).

## Scene verification (capture.mjs)

Each capture scene is checked before its screenshot is accepted; a failing scene leaves no PNG.

| Check | Fails when | Opt out (`allow`) |
|---|---|---|
| `noop` | a `click`/`fill`/`tap` changed neither pixels nor URL within `noopWait` ms (default 5000; polled, so slow client-side navigation is fine) | `"noop"` or action `"allowNoop": true` |
| `navigation` | final path ≠ `expect.url` ?? last `goto` ?? `route`; or left `baseUrl` origin | `"navigation"` |
| `loading` | spinner/`aria-busy`/progressbar/skeleton/"Loading…" still visible after `loadingTimeout` ms (default 10000) | `"loading"` |
| `blank` | no visible text and no media, or a near-uniform image (entropy < 0.001) | `"blank"` |
| `images` | broken `<img>` in viewport | `"images"` |
| `overflow` | page wider than the viewport (broken responsive layout) | `"overflow"` |
| `pageerror` | uncaught JS exception | `"pageerror"` |
| `apperror` | framework error UI with HTTP 200: Next.js dev overlay or error boundary, Vite overlay, an error heading ("Something went wrong", "Internal Server Error"), or a heading that is just a 4xx/5xx status (SvelteKit `+error`) | `"apperror"` |
| login page | the page is a sign-in page (`/login`, `/auth/…`, a visible password field) — usually a redirect from a protected route | `"login"`, only honoured when the final URL is the scene's own `route` (an intentional sign-up/sign-in CTA scene); redirects are still rejected. Password fields are redacted |
| `expect` | any of `expect: { url, selector, text, notSelector, notText }` fails (`url` may be a `^regex`) | — |

Console errors and failed requests are recorded as warnings in `captures/<fmt>/<scene>.json` (with url, sha256, size, entropy).
`allow: ["duplicate"]` permits two scenes with byte-identical screenshots (QA flags them otherwise).

Add `expect` to every scene whose point is a state change (logged in, item created, toast shown): it is the only check that knows what the scene *should* show.

## Authentication & redaction

```json
"auth": {
  "loginUrl": "/login",                                   // where --login opens (default /login)
  "authenticated": { "selector": "[data-testid=account-menu]", "text": "…", "url": "^/app" },  // REQUIRED, ≥1 key: proof of sign-in
  "loginPatterns": ["^/(login|signin)"],                  // path regexes = login page (default login|signin|auth|sso)
  "loginSelectors": ["input[type=password]"],             // visible = login page (default)
  "forbidden": { "selectors": [".upgrade-wall"], "text": ["Upgrade required"] },  // extra forbidden markers
  "allowedOrigins": ["https://login.idp.example"],        // origins sign-in may visit (never captured)
  "required": true,                                       // default true
  "timeout": 300000                                       // sign-in wait, 1000..1800000 ms
},
"redact": [".account-email"],                             // top level and/or per scene
```

Scene: `"public": true` skips the sign-in proof for that scene; `"allow": ["forbidden"]` only if a page legitimately shows such words. Unknown keys, invalid regexes/origins, credential-like keys anywhere (`password`, `token`, `cookie`, `apiKey`, `session`, …) and `fill` into password/secret/OTP fields are rejected (exit 2). Full workflow: `references/authentication.md`.

## Screenshot reuse (capture.mjs)

Reuse is an optimization that can never change what a video shows:
1. A key is built from everything that can affect the screenshot:
   - capture-code version and project source fingerprint (`context.mjs --check`);
   - app origin, format and device settings (viewport, DPR, mobile/touch);
   - account identity: `anonymous`, or a hash of the text in `auth.authenticated.selector`;
   - the auth checks configuration;
   - the scene's route, actions (with values), `expect`, `allow`, `public` and `loadingTimeout`;
   - the effective redaction selectors;
   - every earlier **state-changing** scene (click / fill / tap / goto) in the same flow and format.
2. The scene **always runs in full**: navigation, actions, auth/forbidden checks, `expect`, loading/blank/overflow checks and redaction.
3. The fresh screenshot is compared byte-for-byte with the cached one for that key. Only if they're identical is the cached file reused, skipping the PNG write and the ffmpeg entropy pass. Otherwise the new capture is used and the cache entry replaced.

| Rule | Behaviour |
|---|---|
| No stable account identity (signed in, but `authenticated` has no selector) | reuse disabled for the run |
| Missing / corrupt / checksum-mismatched entry | ignored and rebuilt (`provenance.reason` says which) |
| Failed scene | never cached |
| Interrupted run | nothing committed; temp entries removed |
| Debugging | `--no-cache` or `VIDGEN_NO_CAPTURE_CACHE=1` |

Cache entries contain only the PNG plus `{key, sha256, entropy, size}`: no URLs, titles, cookies or account text. They live under `.vidgen/cache/captures/`, which must be git-ignored like the rest of `.vidgen/`. They're never part of exports. Delete the folder at any time to reset.

## Overlay rules (render.mjs)

Captions ≤ 2 lines, titles ≤ 4 lines, all inside a 2% safe area — else render fails. White overlay text needs contrast ≥ 3:1 against `brand.primary` and `brand.background` (`#rrggbb`).

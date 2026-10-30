---
description: VidGen — capture real app UI and render landscape + vertical videos
argument-hint: "[flow-id]"
---
Use the vidgen skill. Requires storyboard for flow `$ARGUMENTS`.

1. Ensure the app runs. Probe `baseUrl`. If it's down, run `node "SKILL_DIR/scripts/start.mjs" <project> [--command CMD] [--url URL]` in the background. Defaults come from `context.json` `dev`. It prints `{"ready":true,...}` once the server answers and stops the whole process tree on Ctrl-C/SIGTERM. Exit codes: 1 = server exited early, 4 = not ready in time (`--timeout`). If the app can't start, stop and report — no mock screens. Next.js dev compiles each route on first visit, so the first capture is slower; that's expected.
2. Capture both formats (real viewports, not crops). Any HTTP ≥ 400 page or failed action fails that scene (exit 1) — fix the storyboard, never render around it:
   `node "SKILL_DIR/scripts/capture.mjs" .vidgen/flows/<flow>/storyboard.json`
   **Authenticated flows** (storyboard has `auth`): tell the user a browser window will open and *they* must sign in, then run with `--login`; or, if they already have a signed-in Chromium started with `--remote-debugging-port`, `--cdp http://127.0.0.1:<port>`. Never type credentials yourself or ask the user to paste them into chat. On exit 3 (cancelled), 4 (timeout), 6 (no/expired session) report it and stop — do not fall back to unauthenticated capture. `forbidden` scenes mean the account lacks access: drop the scene or use an account that has it. See `SKILL_DIR/references/authentication.md`.
3. Voiceover (if `voiceover: true`; local TTS only — Kokoro if the storyboard sets `"tts": "kokoro"`, else macOS `say`; nothing leaves the machine):
   `node "SKILL_DIR/scripts/voiceover.mjs" .vidgen/flows/<flow>/storyboard.json`
   Re-run it whenever narration, `voice` or `voiceRate` changes (render refuses stale narration). Exit 1 means narration was requested but could not be made — no engine, unknown voice, failed/silent synthesis, or a line longer than its scene (the message gives the duration to use). Report the message and stop; never render without the requested narration. Only if the user wants a music-only video, set `"voiceover": false`.
4. Render both formats (`music`: `auto` | `none` | path relative to storyboard; shared beds live in `.vidgen/music/`; optional `audio` mix settings — music level, ducking, fades — see storyboard-schema.md):
   `node "SKILL_DIR/scripts/render.mjs" .vidgen/flows/<flow>/storyboard.json`
   On failure or interrupt, previous `out/*.mp4` are left untouched and `tmp/` is removed.
   Capture reuses a cached screenshot only when every capture input matches **and** the live page is pixel-identical (see storyboard-schema.md › Screenshot reuse); each `<scene>.json` `provenance` says `captured` or `reused` and why. Add `--no-cache` (or `VIDGEN_NO_CAPTURE_CACHE=1`) when debugging or verifying.
5. Run /video-review automatically. Report output paths.

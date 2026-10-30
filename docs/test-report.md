# VidGen v1 — Test report

All numbers below come from real runs on macOS 26.6 (arm64), Node v24.14.1, ffmpeg 8.1.2. Nothing is mocked except the external-context providers, whose tests never contact a real service.

## How to run

```bash
node tests/all.mjs                       # every offline suite in sequence + smoke demo, summary, exit 1 on any failure
node --test tests/voiceover.test.mjs     # one suite
node tests/frameworks-real.mjs           # real Next.js + SvelteKit apps (needs npm network access)
```

## Latest full run: 116/116, smoke PASS, exit 0

| Suite | Tests | What it proves |
|---|---|---|
| `core.test.mjs` | 14/14 | Install, analyze, capture, render, QA, export across several flows; failures and interrupts leave previous outputs untouched; overlay text fit |
| `auth.test.mjs` | 19/19 | `--login` / `--cdp` sessions, login redirects rejected, expired sessions, forbidden pages, redaction, no secrets in any output, intentional sign-up scenes (`allow: ["login"]`) |
| `platform.test.mjs` | 16/16 | Executable lookup, paths with spaces and Unicode, watchdogs, renderer crashes, signals, installer, macOS-only refusal |
| `cache.test.mjs` | 11/11 | Screenshot reuse only when inputs match and the page is pixel-identical; account isolation |
| `motion.test.mjs` | 12/12 | Transitions, subpixel motion smoothness, device style, subtitles, all ready looks, look preview |
| `frameworks.test.mjs` | 9/9 | Next.js, SvelteKit, React Router, Flutter route discovery; app-error screens (including Next ≥ 15 dev overlay); `navigationTimeout`; `localStorage` init |
| `external.test.mjs` | 11/11 | Per-transfer authorization, private repos blocked, secrets withheld, sanitized GitIngest |
| `symlink.test.mjs` | 7/7 | Every writer refuses symlinked outputs and path-traversal names; targets stay byte-identical |
| `voiceover.test.mjs` | 11/11 | Real `say` and Kokoro synthesis, missing engine, failed synthesis, unknown voice, stale narration, leveling, voice polish, music-only |
| `audio-mix.test.mjs` | 6/6 | Ducking and recovery, ramps, fades, limiter, sync, music-only, corrupt inputs |
| `smoke.mjs` | PASS | End-to-end demo in 1920×1080 and 1080×1920 with audio and QA |

## Measured evidence

**Narration in the final video** (cross-correlation of each synthesized line against its scene's window of the exported AAC track):
- Lines are found at their scene start: match 0.93–0.999. The same line checked 1 s early or in another scene: 0.01–0.03.
- In music-only exports the narration match is 0.005–0.03, so no speech is present.

**Audio mix** (55 Hz band of a loud test track, so the music level is measurable under speech):

| | Result |
|---|---|
| Music: no speech / under speech / pause after the line | −14.3 / −29.1 / −14.3 dB → ducked 15 dB, fully restored |
| Largest step in any 50 ms | 2.5 dB (duck), 1.9 dB (release) |
| Fades | start −39.7 dB → −14.3 dB; last 0.1 s −42.6 dB |
| Limiter stress (music at full level, no ducking) | unlimited sum ≈ +2.5 dBFS → output −0.9 dB |
| Duration | audio = video, ±0.05 s |

**Voice polish and leveling:** polished lines are 48 kHz, start after a consistent 0.12 s breath (raw: 0.016 s), and gain about +1.4 dB of presence (2.5–5 kHz) relative to their overall level. Kokoro `af_heart` lines end at −18 to −19 dB mean, peaks ≤ −1 dBFS.

**Camera motion** (frame-to-frame change across a zoom/pan; jerk = how unevenly that change varies):

| | Jerk / motion | Frozen frames |
|---|---|---|
| Previous `zoompan` renderer | ≈ 1.0 | 0 |
| v1 `perspective` renderer | 0.01–0.14 | 0 |

## Real-project validation

A Next.js 16 + Supabase app was captured signed-in (profile, word list, word detail, daily words) against a local database with seeded demo data. Results:
- capture, QA and export pass in both formats;
- narration match 0.995–0.999; voice about −22 dB, music in pauses about −34 dB;
- the project's source was not modified.

That run surfaced five VidGen defects, all fixed and covered by tests above:
1. Next ≥ 15 dev overlay was mis-detected as an error screen.
2. Every two-line portrait caption was rejected.
3. The page-load timeout was hard-coded.
4. Onboarding tours covered the screen, with no way to dismiss them.
5. Neural voices came out quieter than the music.

## Not verified

- Other Macs (Intel, older macOS versions). Linux and Windows are not supported in v1.
- Human viewing and listening review.
- Planned looks (`glyph-glitch`, `pixel`, `crew`, `editorial`).

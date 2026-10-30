# VidGen v1 — Release status

**Status: v1, macOS only.** Every automated suite and the smoke demo pass on macOS. Linux and Windows are not supported in v1; the installer refuses them.

## What v1 does

VidGen is an agent skill that turns a running web app into short promo videos, always in both **1920×1080** and **1080×1920**, from real screenshots of the app. It has six commands:

| Command | Purpose |
|---|---|
| `/video-analyze` | Scan the project (framework, routes, brand, assets) into `.vidgen/context.json` |
| `/video-plan` | Pitch a story and 2–3 looks with a real-screen preview, then write the storyboard |
| `/video-create` | Capture real screens, generate narration, render both formats |
| `/video-review` | Automated QA plus labelled contact sheets for human review |
| `/video-export` | Final encode, all-or-nothing, with a manifest |
| `/video-multipleflow` | Several flows, optionally combined into one video |

## Capability matrix

| Area | v1 capability | Verified on macOS |
|---|---|---|
| Capture | Real Playwright viewports (desktop + phone). Each scene is checked for navigation, loading, blank, broken images, overflow, page and app errors, login redirects and forbidden pages | Yes |
| Signed-in apps | `--login` (you sign in) or `--cdp` (reuse your signed-in browser); session kept in memory; selector redaction | Yes |
| Slow apps / overlays | `navigationTimeout`; `localStorage` set before page scripts (dismisses onboarding tours) | Yes |
| Screenshot reuse | Cache reused only when inputs match and the live page is pixel-identical | Yes |
| Motion | Subpixel zoom/pan, crossfade / fade / slide / cut transitions | Yes |
| Presentation | `style: device` (browser or phone frame); looks `noir`, `porcelain`, `mint-noir`, `soft`; look preview | Yes |
| Captions / subtitles | Chromium-rendered text with fit and contrast checks; optional timed glass subtitles | Yes |
| Voiceover | Local TTS: macOS `say` or Kokoro (natural neural voice, offline); lines polished (EQ, de-ess, compression) and leveled; stale or missing narration refused | Yes (`say`, Kokoro) |
| Audio mix | Music ducked under each line and restored in pauses; fades; −1 dBFS limiter; exact duration | Yes |
| QA / export | Resolution, codec, duration, black frames, per-scene fingerprints, narration waveform check; atomic exports | Yes |
| External context | DeepWiki, GitDiagram, GitIngest, off by default, each transfer explicitly authorized | Yes (mocked tests + controlled live checks) |
| Safety | Every writer refuses symlinked output paths and path-traversal scene/flow names | Yes |

## Platform

| Platform | Status |
|---|---|
| macOS (tested on macOS 26, Apple silicon, Node 24, ffmpeg 8.1) | Supported and verified |
| Linux, Windows | Not supported in v1 (installer and `doctor.mjs` refuse them) |

## Known limitations

- Ducking follows the known narration timing; it is not a voice-driven sidechain compressor. User music is not loudness-normalized.
- Narration is one line per scene; there is no per-word timing.
- Symlink and path checks run before writing, so a symlink swapped *during* a run is not defended against.
- Redaction is selector-based, not automatic PII detection. Review contact sheets before sharing anything captured behind a login.
- Looks `glyph-glitch`, `pixel`, `crew` and `editorial` are planned; render refuses them with the list of ready looks.
- Kokoro needs a one-time local install (about 340 MB): `scripts/setup-kokoro.sh`.

## Before a wider release

1. Run CI (`.github/workflows/ci.yml`, macOS) on a pushed branch.
2. Check an Intel Mac and an older macOS version, if those matter to you.
3. Have someone watch and listen to a few real-project videos; the automated checks cannot judge taste.

Detailed results and measurements: [test-report.md](test-report.md).

---
name: vidgen
description: From Codebase to Cinematic Product Videos. Analyze an existing software project (routes, pages, components, design tokens, assets), discover key user journeys, storyboard them, capture the REAL running UI, and render promotional videos in both 1920x1080 and 1080x1920. Use for /video-analyze, /video-plan, /video-create, /video-review, /video-export, /video-multipleflow, or when the user asks for a product/promo/demo video of their app.
---

# VidGen

Turn a real codebase into promo videos built from **authentic UI captures**, never fabricated screens.

## Pipeline

```
analyze ──> plan ──> create ──> review ──> export
   │          │         │          │          │
context.json  storyboard  captures+   qa.json   1920x1080 + 1080x1920
(cached)      .json       render               mp4 per flow
```

All state lives in `<project>/.vidgen/`:

| Path | Written by | Contents |
|---|---|---|
| `context.json` | analyze | framework, routes, components, design tokens, assets, flows, `sourceHash` |
| `flows/<flow>/storyboard.json` | plan | scenes (see `references/storyboard-schema.md`) |
| `flows/<flow>/captures/{landscape,vertical}/` | create | per-scene PNG + verification metadata (sanitized URL, checks, redactions) |
| `flows/<flow>/out/{landscape,vertical}.mp4` | create/export | rendered videos |
| `flows/<flow>/audio/<scene>.aiff` + `voiceover.json` | create (`voiceover.mjs`) | local TTS narration + what text/voice each file was made from |
| `flows/<flow>/qa.json` | review | QA findings |
| `music/*` | user | shared music bed for all `music: "auto"` flows |
| `cache/cards/` | create | rendered title/caption PNGs, reused across flows |
| `cache/captures/{landscape,vertical}/` | create (`capture.mjs`) | screenshot reuse cache: `<key>.png` + hashes/entropy only — no URLs, cookies or account data |
| `external/<provider>.json` | analyze (`external.mjs`, opt-in) | unverified external context + provenance + local cross-checks |
| `<project>/vidgen-export/` | export (`export.mjs`) | final mp4s, `combined-*`, `manifest.json` |

`SKILL_DIR` below = directory containing this file.

## Rules

1. **Authentic UI only.** Every product shot comes from `scripts/capture.mjs` against the running app. If the app cannot run, stop and tell the user — do not mock screens.
2. **Dual format is automatic.** Every create/export renders landscape 1920x1080 AND vertical 1080x1920. Vertical captures use a real mobile viewport, not a crop.
3. **Cache first.** Run `node "SKILL_DIR/scripts/context.mjs" <project> --check`; reuse `context.json` when `fresh: true`. Re-analyze only when stale or `--force`.
4. **Local-first.** External context (DeepWiki, GitDiagram, GitIngest) is off by default. It needs `--external`, a shown plan, and the user's explicit per-transfer approval passed as `external.mjs --authorize`. Private repos are blocked; secrets are never sent. External output is unverified hints, never routes or assertions. See `references/external-context.md`.
5. **Agent-agnostic.** Steps are plain shell + Node + ffmpeg; no model-specific APIs.
6. **No secrets in videos.** Use seed/demo accounts; list sensitive elements in `redact`; skip screens you can't redact.
7. **Authenticated pages only with the user's own session.** Never sign in for the user, never put credentials in storyboards, never bypass MFA/CAPTCHA/permissions. Use `capture.mjs --login` (user signs in in a window) or `--cdp` (user's already-signed-in debug browser). Session state stays in memory. See `references/authentication.md`.
8. **Review contact sheets before sharing anything captured behind a login** — redaction is selector-based, not automatic PII detection.
9. **Requested narration is never dropped.** If `voiceover.mjs` exits 1 (no TTS engine, unknown voice, failed synthesis, line longer than its scene), report its message and stop. Re-run it after any narration/voice change. Music-only only when the user asks (`"voiceover": false`).

## Commands

Each command's procedure is in `commands/<name>.md`. Read it before executing.

- `/video-analyze [path] [--force] [--external]` — build/refresh `context.json`.
- `/video-plan [flow]` — storyboard one flow (default: top-ranked).
- `/video-create [flow]` — capture + render both formats.
- `/video-review [flow]` — automated + visual QA.
- `/video-export [flow|--all]` — final encode, both formats, manifest.
- `/video-multipleflow [--limit N]` — plan → create → review → export for each discovered flow.

## Requirements

Node ≥ 20, ffmpeg/ffprobe (or `VIDGEN_FFMPEG`/`VIDGEN_FFPROBE`), Playwright Chromium (`VIDGEN_CHROMIUM_PATH` to override). If anything fails, run `node "SKILL_DIR/scripts/doctor.mjs"` first. Paths with spaces/Unicode are fine — always keep the quotes around script paths. For voiceover: Kokoro (`"tts": "kokoro"`, natural voice, one-time install) or macOS built-in `say` — local only, no cloud TTS; macOS only; a royalty-free track in `.vidgen/music/` (otherwise a generated ambient pad is used).

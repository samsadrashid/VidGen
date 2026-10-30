---
description: VidGen — final export of landscape (1920x1080) and vertical (1080x1920) videos
argument-hint: "[flow-id... | --all] [--combined]"
---
Use the vidgen skill.

1. For each target flow, require `qa.json` with `pass: true` and a reviewed contact sheet (else run /video-review and stop on failure unless user overrides).
2. `node "SKILL_DIR/scripts/export.mjs" <project> <flow...> [--combined]`
   - Re-renders each flow with `--final` (H.264 high CRF 18, AAC 192k, faststart), always both formats.
   - Writes `vidgen-export/<flow>-1920x1080.mp4`, `<flow>-1080x1920.mp4`, and QAs the exported files themselves (including that every narrated scene's speech is in the exported audio).
   - `--combined`: `combined-1920x1080.mp4` + `combined-1080x1920.mp4`, flows in the order given. If any flow fails, no combined video is produced (exit 1).
   - `vidgen-export/manifest.json`: per-flow files + sha256, `failed[]` with reasons, `combined`.
3. Report the file list and any failures from the manifest.

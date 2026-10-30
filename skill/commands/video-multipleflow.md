---
description: VidGen — generate a video for every discovered user flow, plus a combined video
argument-hint: "[--limit N]"
---
Use the vidgen skill.

1. Run /video-analyze (cached if fresh).
2. Show all flows; confirm the list and its order (default top `--limit` or 4).
3. For each flow: /video-plan (batch-approve storyboards in one table), /video-create, /video-review. Shared assets: put one music bed in `.vidgen/music/` (used by every `music: "auto"` flow); identical title/outro cards are cached in `.vidgen/cache/cards`.
4. `node "SKILL_DIR/scripts/export.mjs" <project> <flow1> <flow2> ... --combined` in the confirmed order.
5. Report pass/fail table + export paths from `vidgen-export/manifest.json`. If any flow failed, say so plainly: no combined video was made; offer to fix the flow or re-export without it.

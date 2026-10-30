---
description: VidGen — QA rendered videos for visual and technical issues
argument-hint: "[flow-id]"
---
Use the vidgen skill.

1. `node "SKILL_DIR/scripts/qa.mjs" .vidgen/flows/<flow>` → `qa.json`. Visual integrity: every capture scene passed capture verification and is unmodified since (sha256), exact pixel size, not blank, no byte-identical duplicate scenes, no duplicate scene ids; the rendered file matches the *current* storyboard and captures (stale detection) and each scene's midpoint frame matches the fingerprint recorded at render (swapped/corrupted/reordered files). Technical: exact resolution (1920x1080 / 1080x1920), h264/yuv420p, duration vs storyboard, audio present when expected (music ≠ `none` or narration in use), each narrated scene's speech actually present at that scene's position in the audio track (waveform match ≥ 0.5, reported as `narrationMatch`), missing/stale narration, audio/video length match, clipping/near-silence, black frames, capture provenance (every capture scene has a real screenshot from `baseUrl`). Frozen-frame hits are warnings.
2. **Always open the contact sheets** (`out/landscape-sheet.png`, `out/vertical-sheet.png`: one labelled tile per scene with id, time, captured URL and caption) yourself — automated checks cannot see: loading spinners, error/empty states, actions that silently did nothing (e.g. a missed `tap`), cut-off captions, visible secrets/PII, broken portrait layout.
3. For flows captured behind a login: check every tile for names, emails, avatars, account ids, keys, billing data that `redact` missed; `<scene>.json` `redactions` shows what was covered. If anything sensitive is visible, add a `redact` selector and re-capture — never ship it.
4. Summarize pass/fail per format. For each failure, propose a fix (storyboard edit, wait selector, tap coords, re-capture) and offer to apply + re-run /video-create.

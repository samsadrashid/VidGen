---
description: VidGen — storyboard a user flow scene by scene
argument-hint: "[flow-id]"
---
Use the vidgen skill. Requires `.vidgen/context.json` (run /video-analyze first if missing or stale).

1. Pick flow `$ARGUMENTS` or top-priority flow. **If the user gives a story** (plain text in chat, or `.vidgen/story.md`): split it into beats (hook → problem/intro → core workflow → 1–2 features → call to action). Map every beat to a **real** route/screen from `context.json` and the source; a beat with no matching screen becomes a title card, never an invented screen. Narration follows the user's wording (one sentence per beat, tightened only for length). List any beat you could not ground in the app and ask the user.
2. Read that flow's route source to get real selectors, form fields, and copy.
3. If the flow's routes need sign-in (middleware, auth guards, redirects to /login in source), add an `auth` block (`loginUrl`, `authenticated` proof selector that only exists when signed in) and `redact` selectors for emails, names, keys, billing data — see `references/authentication.md`. Never put credentials in the storyboard; mark public scenes in an auth flow `"public": true`.
4. Write `.vidgen/flows/<flow>/storyboard.json` per `references/storyboard-schema.md`: title card → 3–7 capture scenes → outro. Captions ≤ 7 words, narration one sentence per scene, motion per scene (mostly `none`, a few `zoom-in`/`pan-down`), presentation `style` (`device` for promos: screens inside a browser/phone on a brand canvas; `screen` full-bleed), `subtitles: true` for spoken-word captions, `tts: "kokoro"` + `voice` for a natural voice when installed, `transition` top-level default `crossfade` (use `cut` between rapid UI steps), 15–60 s total.
5. **Look pitch — share how you're thinking before committing.** In ≤ 6 lines, tell the user: the story arc you'll use (beat → real screen), the narration tone, and the 2–3 looks from `references/looks.md` that fit the product and why (one line each). Then run `look-preview.mjs` (see looks.md; reuse `--cdp`/`--login` for signed-in apps) and show both preview strips. Let the user pick a look (or "no look"); set `"look"` in the storyboard. Mention planned looks only as "coming later", never render them.
6. Show storyboard as table (scene, route, caption, duration). Ask user to approve or edit before /video-create.

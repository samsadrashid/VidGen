---
description: VidGen — analyze project and cache context for video generation
argument-hint: "[path] [--force] [--external]"
---
Use the vidgen skill (SKILL.md). Project = `$ARGUMENTS` path or cwd.

1. `node "SKILL_DIR/scripts/context.mjs" <project> --check`. If `fresh: true` and no `--force`, print summary and stop.
2. `node "SKILL_DIR/scripts/context.mjs" <project> --scan` → writes raw `context.json`: framework, `routes` (visitable static routes only), `router` {adapter, confidence, ambiguous, dynamic, excluded, note}, `dev` (start hint), components, tokens, assets, and package scripts with inline secrets redacted.
   - Router adapters (`scripts/frameworks.mjs`):
     - **next**: App Router and Pages Router. Route groups are stripped; `_private` folders, `@slot` parallel routes, intercepting routes, `api/` and `route.*` handlers, and `_app`/`_document` are excluded.
     - **sveltekit**: `src/routes/**/+page.svelte`, groups stripped; `+server` endpoints excluded.
     - **react-router**: only in files that actually use the router.
     - **flutter**.
     - **generic** fallback: no guessing.
   - `router.dynamic` lists patterns like `/blog/[slug]` with their params. **Never invent values.** Pick real ones from seed data, fixtures or the running app's links (or click through from a list page), and say where they came from.
   - `router.ambiguous` (e.g. a monorepo root with both next and sveltekit) or a `router.note`: ask the user which app and which routes, rather than guessing.
3. Read key files the scan lists (layouts, top routes, nav, theme/tailwind config) and enrich `context.json`:
   - `product`: name, one-line value prop (from README/landing copy).
   - `devCommand` + `baseUrl` (from package scripts; Flutter: `flutter build web` then serve `build/web`).
   - `flows`: ranked journeys `{id, title, routes[], why, priority}` — e.g. onboarding, core action, dashboard insight, settings/billing. 3–6 flows.
   - `brand`: primary/background colors, font from tokens.
4. External context is **off by default** and never needed. Only if the user passed `--external`:
   - Run `node "SKILL_DIR/scripts/external.mjs" <project> --plan` (no network). Show the user, per provider, the receiver, exactly what is sent and the withheld files.
   - For each provider the user approves **in chat for this specific transfer**, run `external.mjs <project> --run <provider> --authorize "<the plan's authorize string>"`. Never pass `--authorize` without that approval; never treat a public URL as permission to send local files.
   - On exit 3/4/5 (not authorized, blocked or private, provider failure), continue with local analysis and say so.
   - Use `.vidgen/external/*.json` only as hints for flows and copy, marked as external. Rely on `verification.*.confirmed` items; ignore anything not confirmed locally. See `SKILL_DIR/references/external-context.md`.
5. Print flows table. Suggest `/video-plan <flow>`.

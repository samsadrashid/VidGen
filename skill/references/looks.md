# Looks

A look dresses the **real** screenshots: canvas, title cards, caption pills, typography. Set `"look": "<id>"` in the storyboard. Looks never add invented screens or claims. They are original VidGen designs inspired by popular launch-video moods; no third-party templates, logos or trade dress.

| id | Name | Status | Mood | Good for |
|---|---|---|---|---|
| `noir` | Noir Glide | ready | Dark, cinematic, premium. Near-black canvas, one glowing brand accent, product in a lit window | dev tools, AI products, pro SaaS |
| `porcelain` | Porcelain Keynote | ready | Bright keynote stage. Warm off-white canvas, bold black type, big product, soft shadows | launches, feature recaps, consumer apps |
| `mint-noir` | Mint Noir | ready | Calm graphite, a single mint accent, one italic-serif highlight word per headline | calm premium SaaS, productivity, finance |
| `soft` | Soft Calm | ready | Warm peach→lavender gradient, rounded type, gentle | learning, wellness, onboarding, consumer |
| `glyph-glitch` | Glyph Glitch | planned | ASCII / dot-matrix glyphs, tracking-mark distortion, very fast cuts | hype teasers |
| `pixel` | Pixel Story | planned | Pixel-art scenes, typewriter captions | playful products, games |
| `crew` | Crew Build | planned | Characters "build" the promo live in an editor | social launch clips |
| `editorial` | Editorial Bold | planned | Huge left-aligned headlines over full-bleed product imagery | brand films |

**Planned** looks are refused by render with the list of ready ones; they need new render engines.

Every ready look:
- defaults to `"style": "device"` (override per scene);
- keeps the brand `primary` for glows and accents (Noir), or uses its own accent (Mint Noir);
- has its text-on-background contrast checked (≥ 3:1).

## Look pitch (before capture)

`node "SKILL_DIR/scripts/look-preview.mjs" .vidgen/flows/<flow>/storyboard.json [--scene <id>] [--looks a,b] [--cdp URL | --login]` captures one real screen, renders it with each look (the real renderer, so the preview equals the final output), and writes `looks/preview-landscape.png` and `looks/preview-vertical.png`: labelled title card + screen per look.

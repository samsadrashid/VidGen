#!/usr/bin/env node
// Look pitch: render ONE real screen + the title card in every ready look, as a labelled strip for the user to choose from.
// Usage: look-preview.mjs <storyboard.json> [--scene <captureSceneId>] [--looks noir,porcelain] [capture flags e.g. --cdp URL]
// Uses the real capture/render pipeline (no mock screens). Writes <flowDir>/looks/preview-landscape.png + preview-vertical.png.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOOKS, READY_LOOKS } from './looks.mjs';
import { FFMPEG, assertNoSymlinks, outputBase } from './platform.mjs';

const args = process.argv.slice(2);
const sbPath = path.resolve(args[0] ?? '');
if (!args[0] || !fs.existsSync(sbPath)) { console.error('usage: look-preview.mjs <storyboard.json> [--scene id] [--looks a,b] [capture flags]'); process.exit(2); }
const opt = (k) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : null; };
const pass = args.slice(1).filter((a, i, all) => !['--scene', '--looks'].includes(a) && !['--scene', '--looks'].includes(all[i - 1]));
const here = path.dirname(fileURLToPath(import.meta.url));
const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
const flowDir = path.dirname(sbPath);
const flowsDir = path.dirname(flowDir);
const outDir = path.join(flowDir, 'looks');
const looks = (opt('--looks')?.split(',') ?? READY_LOOKS);
const bad = looks.filter((l) => !READY_LOOKS.includes(l));
if (bad.length) { console.error(`look-preview refused: not ready: ${bad.join(', ')} (ready: ${READY_LOOKS.join(', ')})`); process.exit(2); }
const scene = sb.scenes.find((s) => s.type === 'capture' && (!opt('--scene') || s.id === opt('--scene')));
if (!scene) { console.error('look-preview: storyboard has no capture scene to preview'); process.exit(2); }
try { assertNoSymlinks(outputBase(flowDir), [outDir, ...looks.map((l) => path.join(flowsDir, `preview-${l}`))]); } catch (e) { console.error(`look-preview refused: ${e.message}`); process.exit(2); }
const node = (script, ...a) => spawnSync(process.execPath, [path.join(here, script), ...a], { encoding: 'utf8' });

// One capture of the chosen real screen (shared by every look), then one short render per look.
const base = { ...sb, music: 'none', voiceover: false, subtitles: undefined, transition: 'cut',
  scenes: [{ id: 'title', type: 'title', text: sb.title ?? 'Your product', duration: 1.5 }, { ...scene, id: 'screen', narration: undefined, motion: 'none', duration: 1.5 }] };
const write = (dir, extra) => { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'storyboard.json'); fs.writeFileSync(f, JSON.stringify({ ...base, ...extra, flow: path.basename(dir) })); return f; };
const first = path.join(flowsDir, `preview-${looks[0]}`);
const cap = node('capture.mjs', write(first, { look: looks[0] }), ...pass);
if (cap.status !== 0) { console.error(`look-preview: capture failed\n${cap.stdout}${cap.stderr}`); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true });
const tiles = { landscape: [], vertical: [] };
for (const look of looks) {
  const dir = path.join(flowsDir, `preview-${look}`);
  const f = write(dir, { look });
  if (dir !== first) fs.cpSync(path.join(first, 'captures'), path.join(dir, 'captures'), { recursive: true });
  const r = node('render.mjs', f);
  if (r.status !== 0) { console.error(`look-preview: ${look} render failed: ${r.stderr.trim().split('\n').pop()}`); process.exit(1); }
  for (const fmt of ['landscape', 'vertical']) {
    for (const [t, tag] of [[0.9, 'title'], [2.4, 'screen']]) {
      const png = path.join(outDir, `${look}-${fmt}-${tag}.png`);
      spawnSync(FFMPEG, ['-v', 'error', '-y', '-ss', String(t), '-i', path.join(dir, 'out', `${fmt}.mp4`), '-frames:v', '1', '-vf', fmt === 'landscape' ? 'scale=640:-2' : 'scale=-2:640', png]);
      tiles[fmt].push({ look, tag, png });
    }
  }
}
// Labelled strip per format (Chromium layout, same as contact sheets).
const { chromium } = await import('playwright');
const browser = await chromium.launch();
for (const fmt of ['landscape', 'vertical']) {
  const cells = looks.map((l) => `<figure style="margin:0"><div style="display:flex;gap:6px">${tiles[fmt].filter((t) => t.look === l).map((t) => `<img src="data:image/png;base64,${fs.readFileSync(t.png).toString('base64')}" style="display:block;border-radius:6px">`).join('')}</div><figcaption style="padding:8px 2px 0;max-width:${fmt === 'landscape' ? 1286 : 730}px"><b style="font-size:18px">${LOOKS[l].name}</b> <span style="color:#999">· "look": "${l}"</span><br><span style="color:#bbb">${LOOKS[l].mood}</span></figcaption></figure>`).join('');
  const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
  await page.setContent(`<body style="margin:0;background:#111;color:#eee;font:14px system-ui"><div style="display:grid;grid-template-columns:repeat(${fmt === 'landscape' ? 2 : 4},auto);gap:22px;padding:18px;width:max-content">${cells}</div></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete));
  await page.locator('div').first().screenshot({ path: path.join(outDir, `preview-${fmt}.png`) });
}
await browser.close();
for (const look of looks) fs.rmSync(path.join(flowsDir, `preview-${look}`), { recursive: true, force: true });
for (const t of [...tiles.landscape, ...tiles.vertical]) fs.rmSync(t.png, { force: true });
console.log(JSON.stringify({ looks, landscape: path.join(outDir, 'preview-landscape.png'), vertical: path.join(outDir, 'preview-vertical.png') }));

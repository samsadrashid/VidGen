#!/usr/bin/env node
// Render-time benchmark for transitions. Usage: node tests/bench-render.mjs <flowDir-with-captures> [runs=3] [oldRender.mjs]
// Renders the same 6-scene storyboard (both formats) per mode and prints per-run and median wall time.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [src, runsArg, oldRender] = process.argv.slice(2);
const runs = Number(runsArg ?? 3);
const base = JSON.parse(fs.readFileSync(path.join(src, 'storyboard.json'), 'utf8'));
const caps = base.scenes.filter((s) => s.type === 'capture');
const scenes = [
  { id: 'intro', type: 'title', text: 'Product tour', duration: 2 },
  ...[0, 1, 2, 3].map((i) => ({ ...caps[i % caps.length], id: caps[i % caps.length].id, duration: 3, motion: ['zoom-in', 'none', 'pan-down', 'zoom-out'][i] })),
  { id: 'outro', type: 'outro', text: 'example.dev', duration: 2 },
].filter((s, i, a) => a.findIndex((x) => x.id === s.id) === i);
const modes = [
  ...(oldRender ? [['before (old renderer)', oldRender, {}]] : []),
  ['after: all cut (stream copy)', path.join(repo, 'skill', 'scripts', 'render.mjs'), { transition: 'cut' }],
  ['after: crossfade (default)', path.join(repo, 'skill', 'scripts', 'render.mjs'), {}],
  ['after: slide', path.join(repo, 'skill', 'scripts', 'render.mjs'), { transition: 'slide' }],
];
const flowsDir = path.dirname(src);
const out = [];
for (const [name, script, extra] of modes) {
  const dir = path.join(flowsDir, `bench-${name.replace(/\W+/g, '-')}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(path.join(src, 'captures'), path.join(dir, 'captures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ ...base, flow: path.basename(dir), music: 'none', scenes, ...extra }));
  spawnSync(process.execPath, [script, path.join(dir, 'storyboard.json')]); // warm-up (card cache)
  const times = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, [script, path.join(dir, 'storyboard.json')], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${name}: ${r.stderr}`);
    times.push((performance.now() - t0) / 1000);
  }
  const d = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(dir, 'out', 'vertical.mp4')], { encoding: 'utf8' }).stdout.trim();
  out.push({ name, times, median: [...times].sort((a, b) => a - b)[Math.floor(times.length / 2)], duration: d });
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`${process.platform}-${process.arch}, ${scenes.length} scenes (${scenes.reduce((a, s) => a + s.duration, 0)} s), both formats, runs=${runs}`);
for (const r of out) console.log(`${r.name.padEnd(30)} ${r.times.map((t) => t.toFixed(1) + 's').join(', ').padEnd(22)} median ${r.median.toFixed(1)}s  output ${Number(r.duration).toFixed(3)}s`);

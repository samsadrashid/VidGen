#!/usr/bin/env node
// Capture-reuse benchmark: same 4-flow workload, cache disabled vs cold vs warm. Usage: node tests/bench-cache.mjs [runs=3]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const K = path.join(repo, 'skill', 'scripts');
const runs = Number(process.argv[2] ?? 3);
const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-bench-'));
fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
const PORT = 6400 + Math.floor(Math.random() * 300);
const server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
await new Promise((r) => server.stdout.once('data', r));

// Four journeys sharing routes; the state-changing signup scene is last so earlier scenes can be shared.
const shared = [{ route: '/' }, { route: '/dashboard' }, { route: '/settings' }];
const flows = {
  tour: [...shared, { route: '/signup', actions: [{ do: 'fill', selector: 'input[name=email]', value: 'a@b.co' }, { do: 'click', selector: '#submit' }] }],
  metrics: [shared[1], shared[0], shared[2], { route: '/dashboard', actions: [{ do: 'scroll', value: 200 }] }],
  settings: [shared[2], shared[1], shared[0], { route: '/settings', actions: [{ do: 'click', selector: '#dark' }] }],
  onboarding: [shared[0], shared[2], shared[1], { route: '/signup', actions: [{ do: 'fill', selector: 'input[name=email]', value: 'a@b.co' }, { do: 'click', selector: '#submit' }] }],
};
for (const [flow, scenes] of Object.entries(flows)) {
  const d = path.join(proj, '.vidgen', 'flows', flow);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'storyboard.json'), JSON.stringify({ flow, baseUrl: `http://localhost:${PORT}`, scenes: scenes.map((s, i) => ({ id: `s${i}`, type: 'capture', duration: 2, ...s })) }));
}
const capture = (flow, env) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(K, 'capture.mjs'), path.join(proj, '.vidgen', 'flows', flow, 'storyboard.json')], { env: { ...process.env, ...env } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.on('close', (c) => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(`${flow} exit ${c}: ${out}`))));
});
async function workload(mode) {
  if (mode === 'cold') fs.rmSync(path.join(proj, '.vidgen', 'cache', 'captures'), { recursive: true, force: true });
  const env = mode === 'disabled' ? { VIDGEN_NO_CAPTURE_CACHE: '1' } : {};
  const t0 = performance.now();
  let shots = 0, reused = 0;
  for (const f of Object.keys(flows)) { const r = await capture(f, env); shots += r.captured; reused += r.reused; }
  return { mode, ms: Math.round(performance.now() - t0), shots, reused, fresh: shots - reused };
}
const results = [];
await workload('cold'); // warm-up: browser/OS caches, discarded
for (let i = 0; i < runs; i++) for (const m of ['disabled', 'cold', 'warm']) results.push(await workload(m));
server.kill();
fs.rmSync(proj, { recursive: true, force: true });
const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`platform: ${process.platform}-${process.arch} node ${process.version}, runs: ${runs}`);
console.log('mode      screenshots  fresh  reused  elapsed (each run)            median');
for (const m of ['disabled', 'cold', 'warm']) {
  const r = results.filter((x) => x.mode === m);
  console.log(`${m.padEnd(9)} ${String(r[0].shots).padStart(11)}  ${String(r[0].fresh).padStart(5)}  ${String(r[0].reused).padStart(6)}  ${r.map((x) => `${(x.ms / 1000).toFixed(1)}s`).join(', ').padEnd(28)}  ${(median(r.map((x) => x.ms)) / 1000).toFixed(1)}s`);
}

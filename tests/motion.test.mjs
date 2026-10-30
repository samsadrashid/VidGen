#!/usr/bin/env node
// Transitions, camera motion, styles and looks. Usage: node --test tests/motion.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-motion-'));
const target = path.join(tmp, 'agent');
const K = path.join(target, 'skills', 'vidgen', 'scripts');
const proj = path.join(tmp, 'proj');
const flows = path.join(proj, '.vidgen', 'flows');
const PORT = 6800 + Math.floor(Math.random() * 300);
let server, vision;

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const run = (script, ...args) => spawnSync(process.execPath, [path.join(K, script), ...args], { encoding: 'utf8' });
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));
const size = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', f], { encoding: 'utf8' }).trim();
const SCENES = [
  { id: 't', type: 'title', text: 'Product tour', duration: 1.5 },
  { id: 'a', type: 'capture', route: '/dashboard', caption: 'Metrics', motion: 'zoom-in', duration: 2.5 },
  { id: 'b', type: 'capture', route: '/settings', caption: 'Settings', motion: 'pan-down', duration: 2 },
];
function flow(name, extra = {}, scenes = SCENES) {
  const dir = path.join(flows, name);
  fs.mkdirSync(dir, { recursive: true });
  if (name !== 'base') fs.cpSync(path.join(flows, 'base', 'captures'), path.join(dir, 'captures'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ flow: name, baseUrl: `http://localhost:${PORT}`, music: 'none', brand: { primary: '#E11D48', background: '#0F172A' }, scenes, ...extra }));
  return path.join(dir, 'storyboard.json');
}

before(async () => {
  assert.equal(spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', target]).status, 0);
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((r) => server.stdout.once('data', r));
  const c = run('capture.mjs', flow('base'));
  assert.equal(c.status, 0, c.stdout);
  vision = await import(pathToFileURL(path.join(K, 'vision.mjs')).href);
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

for (const tr of ['cut', 'crossfade', 'fade', 'slide']) {
  test(`transition "${tr}": exact total duration, both sizes, scene starts unchanged, QA passes`, () => {
    const sb = flow(`tr-${tr}`, { transition: tr });
    const r = run('render.mjs', sb);
    assert.equal(r.status, 0, r.stderr);
    for (const [fmt, sz] of [['landscape', '1920x1080'], ['vertical', '1080x1920']]) {
      const f = path.join(flows, `tr-${tr}`, 'out', `${fmt}.mp4`);
      assert.equal(size(f), sz);
      assert.ok(Math.abs(dur(f) - 6) < 0.05, `${fmt} duration ${dur(f)}`);
      const m = JSON.parse(fs.readFileSync(path.join(flows, `tr-${tr}`, 'out', `${fmt}.render.json`), 'utf8'));
      assert.deepEqual(m.scenes.map((s) => s.start), [0, 1.5, 4]);
      assert.deepEqual(m.scenes.map((s) => s.transitionOut), tr === 'cut' ? ['cut', 'cut', 'cut'] : [tr, tr, 'cut']);
    }
    const q = JSON.parse(run('qa.mjs', path.join(flows, `tr-${tr}`)).stdout);
    assert.equal(q.pass, true, JSON.stringify(q.results));
  });
}

test('boundary frames: cut switches instantly; crossfade/slide blend; fade dips to black', () => {
  const fp = (tr, t) => vision.fingerprint(path.join(flows, `tr-${tr}`, 'out', 'landscape.mp4'), t);
  const m = JSON.parse(fs.readFileSync(path.join(flows, 'tr-cut', 'out', 'landscape.render.json'), 'utf8')).scenes;
  const [, A, B] = m;
  // cut: just before / after the 4.0s boundary already looks like the neighbouring scenes' (static-ish) frames.
  // cut, frame-exact (time-based seeking is ambiguous at frame edges): the switch happens exactly at frame 120 = 4.000 s.
  const frame = (tr, n) => execFileSync('ffmpeg', ['-v', 'error', '-i', path.join(flows, `tr-${tr}`, 'out', 'landscape.mp4'), '-vf', `select=eq(n\\,${n}),scale=64:36:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-']);
  assert.ok(vision.mad(frame('cut', 119), frame('cut', 120)) > 3, 'instant switch between frames 119 and 120');
  assert.ok(vision.mad(frame('cut', 118), frame('cut', 119)) < 2, 'scene a continuous up to the boundary');
  assert.ok(vision.mad(frame('cut', 120), frame('cut', 121)) < 2, 'scene b continuous from the boundary');
  assert.ok(vision.mad(frame('cut', 44), frame('cut', 45)) > 20, 'title -> scene a switch at frame 45 = 1.500 s');
  // crossfade/slide: mid-transition frame (4.0 + 0.25) is neither scene alone.
  for (const tr of ['crossfade', 'slide']) {
    const mid = fp(tr, 4.25);
    assert.ok(vision.mad(mid, A.fp) > 1 && vision.mad(mid, B.fp) > 1, `${tr} mid-transition frame is a blend`);
  }
  // fade: goes through black somewhere inside the 0.5 s transition window (frames 120..135); xfade's
  // fadeblack curve darkens early, so check the darkest frame rather than one fixed time.
  const mean = (b) => b.reduce((s, v) => s + v, 0) / b.length;
  const darkest = Math.min(...Array.from({ length: 16 }, (_, i) => mean(frame('fade', 120 + i))));
  assert.ok(darkest < 10, `fade dips to black (darkest mean ${darkest.toFixed(1)})`);
  for (const tr of ['crossfade', 'slide']) {
    const dim = Math.min(...Array.from({ length: 16 }, (_, i) => mean(frame(tr, 120 + i))));
    assert.ok(dim > 150, `${tr} never darkens between bright pages (darkest mean ${dim.toFixed(1)})`);
  }
});

test('per-scene overrides and transitionDuration are honoured', () => {
  const scenes = [{ ...SCENES[0], transition: 'cut' }, { ...SCENES[1], transition: 'slide', transitionDuration: 0.8 }, SCENES[2]];
  const r = run('render.mjs', flow('mixed', { transition: 'crossfade' }, scenes));
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(flows, 'mixed', 'out', 'vertical.render.json'), 'utf8')).scenes;
  assert.deepEqual(m.map((s) => s.transitionOut), ['cut', 'slide', 'cut']);
  assert.ok(Math.abs(dur(path.join(flows, 'mixed', 'out', 'vertical.mp4')) - 6) < 0.05);
  assert.equal(JSON.parse(run('qa.mjs', path.join(flows, 'mixed')).stdout).pass, true);
});

test('defaults never break old storyboards: short scenes shrink the default transition or fall back to cut', () => {
  const scenes = [SCENES[0], { ...SCENES[1], duration: 0.6 }, { ...SCENES[2], duration: 0.3 }];
  const r = run('render.mjs', flow('short', {}, scenes));
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(flows, 'short', 'out', 'landscape.render.json'), 'utf8')).scenes;
  assert.deepEqual(m.map((x) => x.transitionOut), ['crossfade', 'cut', 'cut'], '0.3 s neighbour leaves no room for >= 0.2 s blend');
  assert.ok(Math.abs(dur(path.join(flows, 'short', 'out', 'landscape.mp4')) - 2.4) < 0.05);
});

test('invalid settings fail clearly (exit 1), keep previous outputs and leave no tmp', () => {
  const out = path.join(flows, 'tr-crossfade', 'out', 'landscape.mp4');
  const before = sha(out);
  const sb = path.join(flows, 'tr-crossfade', 'storyboard.json');
  const orig = fs.readFileSync(sb, 'utf8');
  const cases = [
    [{ transition: 'spin' }, /transition "spin"/],
    [{ transitionDuration: 3 }, /must be 0.2..1.0/],
    [{ scenes: [SCENES[0], { ...SCENES[1], duration: 0.6, transitionDuration: 0.5 }, SCENES[2]] }, /too long/],
    [{ scenes: [SCENES[0], { ...SCENES[1], motion: 'spin-3d' }, SCENES[2]] }, /motion "spin-3d"/],
  ];
  try {
    for (const [patch, re] of cases) {
      fs.writeFileSync(sb, JSON.stringify({ ...JSON.parse(orig), ...patch }));
      const r = run('render.mjs', sb);
      assert.equal(r.status, 1, JSON.stringify(patch));
      assert.match(r.stderr, re);
      assert.equal(sha(out), before);
      assert.ok(!fs.existsSync(path.join(flows, 'tr-crossfade', 'tmp')));
    }
  } finally { fs.writeFileSync(sb, orig); }
});

test('interrupt during the transition assembly step keeps previous outputs', { skip: process.platform === 'win32' && 'SIGTERM is TerminateProcess on Windows' }, async () => {
  const out = path.join(flows, 'tr-slide', 'out', 'vertical.mp4');
  const before = sha(out);
  const p = spawn(process.execPath, [path.join(K, 'render.mjs'), path.join(flows, 'tr-slide', 'storyboard.json'), '--final'], { stdio: 'ignore' });
  const lastClip = path.join(flows, 'tr-slide', 'tmp', 'landscape', 'b.mp4'); // last clip done => xfade assembly running
  for (let i = 0; i < 800 && !fs.existsSync(lastClip); i++) await new Promise((r) => setTimeout(r, 25));
  p.kill('SIGTERM');
  assert.equal(await new Promise((r) => p.on('close', r)), 130);
  assert.equal(sha(out), before);
  assert.ok(!fs.existsSync(path.join(flows, 'tr-slide', 'tmp')));
});

test('camera motion is subpixel-smooth: no stepping or frozen frames mid-move (both formats)', () => {
  // Regression: zoompan snapped its crop to whole pixels, so slow zooms/pans moved in visible 1–2 px jumps.
  const sb = flow('smooth', { transition: 'cut' }, [{ id: 'z', type: 'capture', route: '/dashboard', motion: 'zoom-in', duration: 4 }, { id: 'p', type: 'capture', route: '/settings', motion: 'pan-down', duration: 4 }]);
  assert.equal(run('capture.mjs', sb).status, 0);
  const r = run('render.mjs', sb);
  assert.equal(r.status, 0, r.stderr);
  for (const fmt of ['landscape', 'vertical']) {
    for (const [label, start] of [['zoom-in', 0], ['pan-down', 4]]) {
      const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(start + 0.8), '-t', '2.4', '-i', path.join(path.dirname(sb), 'out', `${fmt}.mp4`), '-vf', 'scale=320:-2,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
      const [w, h] = fmt === 'landscape' ? [320, 180] : [320, 570];
      const n = w * h, frames = [];
      for (let i = 0; i + n <= raw.length; i += n) frames.push(raw.subarray(i, i + n));
      const diffs = frames.slice(1).map((f, i) => { let s = 0; for (let k = 0; k < n; k++) s += Math.abs(f[k] - frames[i][k]); return s / n; });
      const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
      const jerk = diffs.slice(1).reduce((a, d, i) => a + Math.abs(d - diffs[i]), 0) / (diffs.length - 1);
      const frozen = diffs.filter((d) => d < mean * 0.15).length;
      console.log(`evidence ${fmt} ${label}: motion ${mean.toFixed(3)}, jerk ${jerk.toFixed(3)} (${(jerk / mean).toFixed(2)}× motion), frozen ${frozen}/${diffs.length}`);
      assert.ok(mean > 0.05, `${fmt} ${label}: camera actually moves`);
      assert.ok(jerk / mean < 0.5, `${fmt} ${label}: uneven motion (jerk ${jerk.toFixed(3)} vs motion ${mean.toFixed(3)})`);
      assert.equal(frozen, 0, `${fmt} ${label}: frozen frames mid-move`);
    }
  }
});

test('device style + glass subtitles render in both formats; invalid style / subtitle size refused', () => {
  const dir = path.join(flows, 'devsub');
  const sb = flow('devsub', { style: 'device', subtitles: true }, [{ id: 'a', type: 'capture', route: '/dashboard', caption: 'Metrics', motion: 'zoom-in', narration: 'Your metrics, live. Every number updates as it happens.', duration: 4 }]);
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=300:d=3', path.join(dir, 'audio', 'a.wav')]);
  assert.equal(run('capture.mjs', sb).status, 0);
  const r = run('render.mjs', sb);
  assert.equal(r.status, 0, r.stderr);
  for (const fmt of ['landscape', 'vertical']) {
    // A subtitle phrase is on screen early and a different one later (phrases change while speaking).
    const grab = (t) => execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', path.join(dir, 'out', `${fmt}.mp4`), '-frames:v', '1', '-vf', 'crop=iw:ih*0.09:0:ih*0.91,scale=160:-2,format=gray', '-f', 'rawvideo', '-']);
    const a = grab(0.6), b = grab(2.4), c = grab(3.7);
    const diff = (x, y) => x.reduce((s, v, i) => s + Math.abs(v - y[i]), 0) / x.length;
    assert.ok(diff(a, b) > 1, `${fmt}: subtitle phrase changes (${diff(a, b).toFixed(2)})`);
    assert.ok(diff(b, c) > 1, `${fmt}: subtitle disappears after the line (${diff(b, c).toFixed(2)})`);
    assert.equal(size(path.join(dir, 'out', `${fmt}.mp4`)), fmt === 'landscape' ? '1920x1080' : '1080x1920');
  }
  for (const [extra, re] of [[{ style: 'neon' }, /style "neon"/], [{ subtitles: { size: 4 } }, /subtitles.size must be/]]) {
    const bad = flow('devsub', extra, [{ id: 'a', type: 'capture', route: '/dashboard', duration: 4 }]);
    const x = run('render.mjs', bad);
    assert.notEqual(x.status, 0);
    assert.match(x.stderr, re);
  }
});

test('looks: every ready look renders both formats; planned/unknown looks refused; look-preview builds the pitch strip', () => {
  const { READY_LOOKS, LOOKS } = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `import('${path.join(K, 'looks.mjs')}').then((m) => console.log(JSON.stringify({ READY_LOOKS: m.READY_LOOKS, LOOKS: Object.fromEntries(Object.entries(m.LOOKS).map(([k, v]) => [k, v.status])) })))`], { encoding: 'utf8' }));
  assert.deepEqual(READY_LOOKS, ['noir', 'porcelain', 'mint-noir', 'soft']);
  const scenes = [{ id: 't', type: 'title', text: 'Ship faster today', duration: 1.5 }, { id: 'a', type: 'capture', route: '/dashboard', caption: 'Metrics', duration: 1.5 }];
  for (const look of READY_LOOKS) {
    const sb = flow(`look-${look}`, { look, transition: 'cut' }, scenes);
    assert.equal(run('capture.mjs', sb).status, 0, look);
    const r = run('render.mjs', sb);
    assert.equal(r.status, 0, `${look}: ${r.stderr}`);
    for (const fmt of ['landscape', 'vertical']) assert.equal(size(path.join(path.dirname(sb), 'out', `${fmt}.mp4`)), fmt === 'landscape' ? '1920x1080' : '1080x1920');
  }
  const planned = Object.keys(LOOKS).find((k) => LOOKS[k] === 'planned');
  for (const [look, re] of [[planned, /is planned, not available yet/], ['vaporwave', /look "vaporwave" — use one of/]]) {
    const x = run('render.mjs', flow('look-bad', { look }, scenes));
    assert.equal(x.status, 2, look);
    assert.match(x.stderr, re);
  }
  const p = run('look-preview.mjs', flow('pitch', { title: 'Ship faster today' }, scenes), '--looks', 'noir,soft');
  assert.equal(p.status, 0, p.stderr);
  const out = JSON.parse(p.stdout);
  assert.deepEqual(out.looks, ['noir', 'soft']);
  for (const f of [out.landscape, out.vertical]) assert.ok(fs.statSync(f).size > 10000, f);
  assert.ok(!fs.existsSync(path.join(flows, 'preview-noir')), 'temporary preview flows removed');
});

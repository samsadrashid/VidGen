#!/usr/bin/env node
// Cross-platform regression tests. Usage: node --test tests/platform.test.mjs
// Runs the INSTALLED skill from paths with spaces, Unicode and quotes; checks binaries discovery,
// subprocess failures, interruption/atomic promotion, installer behaviour and Windows path logic.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const isWin = process.platform === 'win32';
// Hostile-but-legal names: spaces, Unicode, an apostrophe (breaks naive ffmpeg concat lists), & and # (break sed).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen plat ü-'));
const target = path.join(tmp, `agent dir 日本 it's & #1`);
const K = path.join(target, 'skills', 'vidgen', 'scripts');
const proj = path.join(tmp, `my project ünï 日本 it's`);
const flows = path.join(proj, '.vidgen', 'flows');
const PORT = 5300 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
let server;

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const node = (script, args, opts = {}) => spawnSync(process.execPath, [path.join(K, script), ...args], { encoding: 'utf8', cwd: opts.cwd ?? os.tmpdir(), env: { ...process.env, ...opts.env } });
const dims = (f) => { const v = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', f])).streams; return { size: `${v.find((s) => s.codec_type === 'video').width}x${v.find((s) => s.codec_type === 'video').height}`, audio: v.some((s) => s.codec_type === 'audio') }; };
function storyboard(flow, extra) {
  fs.mkdirSync(path.join(flows, flow), { recursive: true });
  const f = path.join(flows, flow, 'storyboard.json');
  fs.writeFileSync(f, JSON.stringify({ flow, title: flow, baseUrl: BASE, brand: { primary: '#E11D48', background: '#0F172A' }, ...extra }));
  return f;
}
const waitFor = async (cond, ms = 20000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out waiting'); await new Promise((r) => setTimeout(r, 25)); } };

before(async () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((res) => server.stdout.once('data', res));
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- pure path logic (runs identically on every OS) ----------

test('platform helpers: concat escaping, POSIX-relative paths, Windows PATHEXT lookup', async () => {
  const { concatEntry, toPosix, which } = await import(pathToFileURL(path.join(K, 'platform.mjs')).href);
  assert.equal(concatEntry("C:\\Users\\Ann O'Neil\\clip 1.mp4"), "file 'C:/Users/Ann O'\\''Neil/clip 1.mp4'");
  assert.equal(concatEntry('/tmp/a b/ü.mp4'), "file '/tmp/a b/ü.mp4'");
  assert.equal(toPosix(['a', 'b c', 'd.png'].join(path.sep)), 'a/b c/d.png');
  // Simulated Windows lookup: a fake ffmpeg.EXE in a dir on PATH, found without the extension.
  const bin = path.join(tmp, 'win bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'ffmpeg.EXE'), '');
  // Windows lookup logic, checked on every OS with an injected file-existence probe.
  const tried = [];
  const found = which('ffmpeg', { Path: 'C:\\Program Files\\ffmpeg\\bin;D:\\tools', PATHEXT: '.COM;.EXE' }, 'win32', (p) => (tried.push(p), p === 'D:\\tools\\ffmpeg.EXE'));
  assert.equal(found, 'D:\\tools\\ffmpeg.EXE');
  assert.deepEqual(tried, ['C:\\Program Files\\ffmpeg\\bin\\ffmpeg.COM', 'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.EXE', 'D:\\tools\\ffmpeg.COM', 'D:\\tools\\ffmpeg.EXE']);
  if (isWin) assert.equal(which('ffmpeg', { PATH: bin, PATHEXT: '.COM;.EXE' }), path.join(bin, 'ffmpeg.EXE'));
  assert.equal(which('definitely-not-a-binary-xyz'), null);
});

test('context: Windows-style and parent-dir names do not leak into relative path matching', () => {
  const p = path.join(tmp, 'assets', 'components', 'app');
  fs.mkdirSync(path.join(p, 'src', 'components'), { recursive: true });
  fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ dependencies: { react: '18' } }));
  fs.writeFileSync(path.join(p, 'src', 'components', 'Button.jsx'), '');
  fs.writeFileSync(path.join(p, 'src', 'main.jsx'), '');
  fs.writeFileSync(path.join(p, 'logo.png'), 'x');
  assert.equal(node('context.mjs', [p, '--scan']).status, 0);
  const ctx = JSON.parse(fs.readFileSync(path.join(p, '.vidgen', 'context.json'), 'utf8'));
  assert.deepEqual(ctx.components, ['src/components/Button.jsx']);
  assert.deepEqual(ctx.assets, []);
});

// ---------- full pipeline in hostile paths ----------

test('full pipeline from a path with spaces/Unicode/apostrophe: both resolutions, audio as expected, combined export', () => {
  storyboard('one', { scenes: [{ id: 't', type: 'title', text: 'Ünïcode ✓', duration: 1.5 }, { id: 'a', type: 'capture', route: '/dashboard', caption: 'Metrics', duration: 2 }] });
  storyboard('two', { music: 'none', scenes: [{ id: 'a', type: 'capture', route: '/settings', caption: 'Settings', duration: 2 }] });
  assert.equal(node('context.mjs', [proj, '--scan']).status, 0);
  for (const f of ['one', 'two']) {
    // relative storyboard path, cwd = project
    const rel = path.join('.vidgen', 'flows', f, 'storyboard.json');
    for (const s of ['capture.mjs', 'render.mjs']) { const r = node(s, [rel], { cwd: proj }); assert.equal(r.status, 0, `${s} ${f}: ${r.stdout}${r.stderr}`); }
    const q = node('qa.mjs', [path.join(flows, f)]);
    assert.equal(JSON.parse(q.stdout).pass, true, q.stdout);
  }
  const e = node('export.mjs', [proj, 'one', 'two', '--combined']);
  assert.equal(e.status, 0, e.stderr);
  const out = path.join(proj, 'vidgen-export');
  for (const [file, size, audio] of [['one-1920x1080.mp4', '1920x1080', true], ['one-1080x1920.mp4', '1080x1920', true], ['two-1920x1080.mp4', '1920x1080', false],
    ['two-1080x1920.mp4', '1080x1920', false], ['combined-1920x1080.mp4', '1920x1080', true], ['combined-1080x1920.mp4', '1080x1920', true]]) {
    assert.deepEqual(dims(path.join(out, file)), { size, audio }, file);
  }
  const m = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
  assert.equal(m.flows[0].files.landscape.path, 'vidgen-export/one-1920x1080.mp4', 'manifest paths are POSIX on every OS');
  assert.ok(!fs.readdirSync(out).some((f) => f.startsWith('.staging')));
});

test('symlinked project and symlinked skill both work', { skip: isWin && 'symlinks need admin/dev-mode on Windows' }, () => {
  const linkProj = path.join(tmp, 'proj-link');
  const linkSkill = path.join(tmp, 'skill-link');
  fs.symlinkSync(proj, linkProj, 'dir');
  fs.symlinkSync(path.join(target, 'skills', 'vidgen'), linkSkill, 'dir');
  const r = spawnSync(process.execPath, [path.join(linkSkill, 'scripts', 'qa.mjs'), path.join(linkProj, '.vidgen', 'flows', 'one')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).pass, true);
});

// ---------- missing executables / subprocess failures ----------

test('missing ffmpeg: render/qa/export/doctor fail with an actionable message; outputs untouched', () => {
  const sb = path.join(flows, 'one', 'storyboard.json');
  const video = path.join(flows, 'one', 'out', 'landscape.mp4');
  const before = sha(video);
  const env = { VIDGEN_FFMPEG: path.join(tmp, 'no ffmpeg here'), VIDGEN_FFPROBE: path.join(tmp, 'no ffprobe here') };
  for (const [script, args] of [['render.mjs', [sb]], ['qa.mjs', [path.join(flows, 'one')]], ['export.mjs', [proj, 'one']]]) {
    const r = node(script, args, { env });
    assert.equal(r.status, 1, script);
    assert.match(r.stderr, /not found — install ffmpeg/, script);
  }
  const d = node('doctor.mjs', ['--json', '--no-browser'], { env });
  assert.equal(d.status, 1);
  assert.equal(JSON.parse(d.stdout).checks.find((c) => c.name === 'ffmpeg').ok, false);
  assert.equal(sha(video), before);
  assert.ok(!fs.existsSync(path.join(flows, 'one', 'tmp')));
});

test('missing browser: capture exits 5, previous captures untouched', () => {
  const shot = path.join(flows, 'one', 'captures', 'landscape', 'a.png');
  const before = sha(shot);
  const r = node('capture.mjs', [path.join(flows, 'one', 'storyboard.json')], { env: { VIDGEN_CHROMIUM_PATH: path.join(tmp, 'no chrome') } });
  assert.equal(r.status, 5, r.stderr);
  assert.match(r.stderr, /browser failed to start/);
  assert.equal(sha(shot), before);
});

test('ffmpeg watchdog: a hung ffmpeg is killed, render exits 1, outputs kept', () => {
  // A fake "ffmpeg" that never exits stands in for ffmpeg spinning on bad input.
  const hang = path.join(tmp, 'hang.mjs');
  fs.writeFileSync(hang, 'setInterval(() => {}, 1000);');
  const wrapper = path.join(tmp, isWin ? 'hang-ffmpeg.cmd' : 'hang-ffmpeg');
  fs.writeFileSync(wrapper, isWin ? `@"${process.execPath}" "${hang}" %*` : `#!/bin/sh\nexec "${process.execPath}" "${hang}" "$@"\n`, { mode: 0o755 });
  const video = path.join(flows, 'two', 'out', 'vertical.mp4');
  const before = sha(video);
  const t0 = Date.now();
  const r = node('render.mjs', [path.join(flows, 'two', 'storyboard.json')], { env: { VIDGEN_FFMPEG: wrapper, VIDGEN_FFMPEG_TIMEOUT_MS: '1500' } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /exceeded/);
  assert.ok(Date.now() - t0 < 30000);
  assert.equal(sha(video), before);
  assert.ok(!fs.existsSync(path.join(flows, 'two', 'tmp')));
});

test('corrupt capture is rejected before ffmpeg runs: exit 1, previous outputs kept, tmp removed', () => {
  const shot = path.join(flows, 'two', 'captures', 'vertical', 'a.png');
  const keep = fs.readFileSync(shot);
  const video = path.join(flows, 'two', 'out', 'landscape.mp4');
  const before = sha(video);
  fs.writeFileSync(shot, 'not a png');
  try {
    const r = node('render.mjs', [path.join(flows, 'two', 'storyboard.json')]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /render failed: corrupt capture/);
  } finally { fs.writeFileSync(shot, keep); }
  assert.equal(sha(video), before, 'landscape (already rendered in that run) was NOT promoted');
  assert.ok(!fs.existsSync(path.join(flows, 'two', 'tmp')));
});

test('doctor passes on this machine and lists required ffmpeg features', () => {
  const d = node('doctor.mjs', ['--json']);
  const j = JSON.parse(d.stdout);
  assert.equal(d.status, 0, d.stdout);
  for (const n of ['encoder libx264', 'encoder aac', 'muxer mp4', 'filter zoompan', 'filter entropy', 'playwright chromium']) assert.ok(j.checks.find((c) => c.name === n)?.ok, n);
});

// ---------- interruption ----------

test('export interrupted while its render child runs: exit 130, child stopped, vidgen-export unchanged', { skip: isWin && 'SIGTERM is TerminateProcess on Windows' }, async () => {
  const out = path.join(proj, 'vidgen-export');
  const snapshot = () => Object.fromEntries(fs.readdirSync(out).map((f) => [f, sha(path.join(out, f))]));
  const before = snapshot();
  const p = spawn(process.execPath, [path.join(K, 'export.mjs'), proj, 'one', 'two', '--combined'], { stdio: 'ignore' });
  await waitFor(() => fs.existsSync(path.join(flows, 'one', 'tmp'))); // render child really started
  p.kill('SIGTERM');
  assert.equal(await new Promise((r) => p.on('close', r)), 130);
  await waitFor(() => !fs.existsSync(path.join(flows, 'one', 'tmp')), 10000); // child cleaned up after itself
  assert.deepEqual(snapshot(), before);
});

test('failed export run keeps previous valid exports (all-or-nothing)', () => {
  const out = path.join(proj, 'vidgen-export');
  const before = Object.fromEntries(fs.readdirSync(out).map((f) => [f, sha(path.join(out, f))]));
  const r = node('export.mjs', [proj, 'one', 'missing-flow', '--combined', '--no-render']);
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).failed[0].flow, 'missing-flow');
  assert.deepEqual(Object.fromEntries(fs.readdirSync(out).map((f) => [f, sha(path.join(out, f))])), before);
});

// ---------- installer ----------

test('installer: failure exit codes, stale VidGen commands removed, unrelated files kept, re-run safe', () => {
  const inst = (...a) => spawnSync(process.execPath, [path.join(repo, 'install.mjs'), ...a], { encoding: 'utf8' });
  assert.equal(inst('--target').status, 1);
  assert.equal(inst('--bogus').status, 1);
  assert.equal(inst('--project', path.join(tmp, 'nope')).status, 1);
  fs.writeFileSync(path.join(tmp, 'a file'), '');
  assert.match(inst('--target', path.join(tmp, 'a file')).stderr, /not a directory/);
  const cmds = path.join(target, 'commands');
  fs.writeFileSync(path.join(cmds, 'user-own.md'), 'mine');
  fs.writeFileSync(path.join(cmds, 'video-retired.md'), 'old vidgen command');
  fs.writeFileSync(path.join(cmds, '.vidgen-commands.json'), JSON.stringify(['video-retired.md', 'video-create.md']));
  const r = inst('--target', target);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(cmds, 'user-own.md')));
  assert.ok(!fs.existsSync(path.join(cmds, 'video-retired.md')));
  const create = fs.readFileSync(path.join(cmds, 'video-create.md'), 'utf8');
  assert.ok(create.includes(`node "${K}${path.sep}capture.mjs"`) || create.includes(`node "${path.join(target, 'skills', 'vidgen')}/scripts/capture.mjs"`), 'quoted absolute path with spaces/&/#/apostrophe intact');
  // Missing prerequisites (ffmpeg not resolvable) -> exit 1 before touching anything.
  const env = { ...process.env, VIDGEN_FFMPEG: path.join(tmp, 'nope-ffmpeg') };
  const bad = spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', path.join(tmp, 'never')], { encoding: 'utf8', env });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /ffmpeg not found/);
  assert.ok(!fs.existsSync(path.join(tmp, 'never')));
});

// ---------- auth + redaction still intact from a hostile path ----------

test('authenticated capture + redaction + login/forbidden rejection still work from a hostile path', () => {
  const auth = { loginUrl: '/login?auto=demo', authenticated: { selector: '[data-testid=account-menu]' } };
  const ok = node('capture.mjs', [storyboard('authok', { auth, redact: ['.account-email', '.api-key'], scenes: [{ id: 'd', type: 'capture', route: '/app', duration: 2 }] }), '--login'], { env: { VIDGEN_AUTH_HEADLESS: '1' } });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  const meta = JSON.parse(fs.readFileSync(path.join(flows, 'authok', 'captures', 'vertical', 'd.json'), 'utf8'));
  assert.equal(meta.redactions['.account-email'], 1);
  assert.equal(meta.redactions['.api-key'], 1);
  const bad = node('capture.mjs', [storyboard('authbad', { auth, scenes: [{ id: 'f', type: 'capture', route: '/app/admin', duration: 2 }] }), '--login'], { env: { VIDGEN_AUTH_HEADLESS: '1' } });
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).failed[0].check, 'forbidden');
  const redirect = node('capture.mjs', [storyboard('noauth', { scenes: [{ id: 'd', type: 'capture', route: '/app', duration: 2 }] })]);
  assert.equal(JSON.parse(redirect.stdout).failed[0].check, 'auth');
  const blob = [ok.stdout, ok.stderr, bad.stdout, bad.stderr, fs.readFileSync(path.join(proj, '.vidgen', 'context.json'), 'utf8'), JSON.stringify(meta)].join('\n');
  for (const s of ['sid-SECRET', 'fixture-pass-123', 'sk-live-FAKE']) assert.ok(!blob.includes(s), s);
});

test('scene watchdog: a stuck scene fails with "timeout" and later scenes still capture', () => {
  const sb = storyboard('watchdog', { music: 'none', scenes: [
    { id: 'stuck', type: 'capture', route: '/settings', timeout: 1500, actions: [{ do: 'wait', value: 10000 }], duration: 2 },
    { id: 'after', type: 'capture', route: '/dashboard', duration: 2 }] });
  const r = node('capture.mjs', [sb]);
  assert.equal(r.status, 1);
  const failed = JSON.parse(r.stdout).failed;
  assert.deepEqual(failed.map((f) => `${f.fmt}/${f.scene}/${f.check}`).sort(), ['landscape/stuck/timeout', 'vertical/stuck/timeout']);
  for (const fmt of ['landscape', 'vertical']) assert.ok(fs.existsSync(path.join(flows, 'watchdog', 'captures', fmt, 'after.png')), fmt);
});

test('renderer crash stays isolated to its scene: never blamed on, or breaking, later scenes', () => {
  const sb = storyboard('crash', { music: 'none', scenes: [
    { id: 'boom', type: 'capture', route: '/settings', actions: [{ do: 'goto', value: 'chrome://crash' }], allow: ['navigation'], duration: 2 },
    { id: 'after', type: 'capture', route: '/dashboard', duration: 2 }] });
  const t0 = Date.now();
  const r = node('capture.mjs', [sb]);
  assert.equal(r.status, 1);
  const failed = JSON.parse(r.stdout).failed;
  assert.ok(failed.every((f) => f.scene === 'boom'), r.stdout); // the crash is never blamed on the next scene
  assert.ok(failed.length === 2, r.stdout);
  assert.ok(Date.now() - t0 < 60000, 'no 120s watchdog wait');
  for (const fmt of ['landscape', 'vertical']) assert.ok(fs.existsSync(path.join(flows, 'crash', 'captures', fmt, 'after.png')), fmt);
});

test('macOS only: installer refuses Linux and Windows without writing anything; doctor fails its platform check', () => {
  for (const plat of ['linux', 'win32']) {
    const dest = path.join(tmp, `refused-${plat}`);
    const r = spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', dest], { encoding: 'utf8', env: { ...process.env, VIDGEN_TEST_PLATFORM: plat } });
    assert.equal(r.status, 1, plat);
    assert.match(r.stderr, new RegExp(`VidGen v1 supports macOS only \\(this system: ${plat}\\)`));
    assert.ok(!fs.existsSync(path.join(dest, 'skills')), `${plat}: nothing installed`);
  }
  const d = JSON.parse(node('doctor.mjs', ['--json', '--no-browser'], { env: { VIDGEN_TEST_PLATFORM: 'linux' } }).stdout);
  assert.equal(d.ok, false);
  assert.deepEqual(d.checks.find((c) => /macOS/.test(c.name)), { name: 'macOS (VidGen v1 supports macOS only)', ok: false, detail: 'linux — not supported', required: true });
  assert.equal(JSON.parse(node('doctor.mjs', ['--json', '--no-browser']).stdout).checks.find((c) => /macOS/.test(c.name)).ok, process.platform === 'darwin');
});

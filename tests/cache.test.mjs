#!/usr/bin/env node
// Screenshot reuse cache regression tests. Usage: node --test tests/cache.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-cache-'));
const target = path.join(tmp, 'agent');
const K = path.join(target, 'skills', 'vidgen', 'scripts');
const proj = path.join(tmp, 'proj');
const flows = path.join(proj, '.vidgen', 'flows');
const cacheDir = path.join(proj, '.vidgen', 'cache', 'captures');
const PORT = 5900 + Math.floor(Math.random() * 400);
const BASE = `http://localhost:${PORT}`;
const AUTH = { loginUrl: '/login?auto=demo', authenticated: { selector: '[data-testid=account-menu]' } };
let server;

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function storyboard(flow, scenes, extra = {}) {
  fs.mkdirSync(path.join(flows, flow), { recursive: true });
  const f = path.join(flows, flow, 'storyboard.json');
  fs.writeFileSync(f, JSON.stringify({ flow, title: flow, baseUrl: BASE, music: 'none', brand: { primary: '#E11D48', background: '#0F172A' },
    scenes: scenes.map((s, i) => ({ id: `s${i}`, type: 'capture', duration: 2, ...s })), ...extra }));
  return f;
}
function capture(flow, ...flags) {
  const r = spawnSync(process.execPath, [path.join(K, 'capture.mjs'), path.join(flows, flow, 'storyboard.json'), ...flags], { encoding: 'utf8', env: { ...process.env, VIDGEN_AUTH_HEADLESS: '1', ...(flags.env ?? {}) } });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* reported below */ }
  return { ...r, j };
}
const prov = (flow, fmt, id = 's0') => JSON.parse(fs.readFileSync(path.join(flows, flow, 'captures', fmt, `${id}.json`), 'utf8')).provenance;
const cacheFiles = () => (fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir, { recursive: true }).filter((f) => !fs.statSync(path.join(cacheDir, f)).isDirectory()).sort() : []);
const hits = async () => (await fetch(`${BASE}/__hits`)).json();

before(async () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((res) => server.stdout.once('data', res));
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('identical scenes in two flows: second flow reuses both formats; provenance recorded', () => {
  storyboard('a', [{ route: '/dashboard', caption: 'Metrics' }]);
  storyboard('b', [{ route: '/dashboard', caption: 'Other caption' }]);
  const a = capture('a');
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.equal(a.j.reused, 0);
  assert.equal(prov('a', 'landscape').reason, 'cache miss');
  const b = capture('b');
  assert.equal(b.status, 0, b.stdout);
  assert.equal(b.j.reused, 2);
  for (const fmt of ['landscape', 'vertical']) {
    const p = prov('b', fmt);
    assert.equal(p.source, 'reused');
    assert.match(p.key, /^[0-9a-f]{16}$/);
    assert.equal(sha(path.join(flows, 'b', 'captures', fmt, 's0.png')), sha(path.join(flows, 'a', 'captures', fmt, 's0.png')));
  }
});

test('different viewport/device never shares: landscape and vertical have distinct keys and sizes', () => {
  const l = prov('b', 'landscape'), v = prov('b', 'vertical');
  assert.notEqual(l.key, v.key);
  const size = (fmt) => JSON.parse(fs.readFileSync(path.join(flows, 'b', 'captures', fmt, 's0.json'), 'utf8')).size;
  assert.deepEqual(size('landscape'), { width: 1920, height: 1080 });
  // 390x693 CSS px at DPR 1080/390 rasterizes to 1080x1919; render scales to exactly 1080x1920 (QA allows ±1).
  assert.equal(size('vertical').width, 1080);
  assert.ok(Math.abs(size('vertical').height - 1920) <= 1);
});

test('different route, actions, action values, preceding state-changing scene => no reuse', () => {
  storyboard('route', [{ route: '/settings' }]);
  storyboard('act1', [{ route: '/signup', actions: [{ do: 'fill', selector: 'input[name=email]', value: 'a@b.co' }] }]);
  storyboard('act2', [{ route: '/signup', actions: [{ do: 'fill', selector: 'input[name=email]', value: 'zz@b.co' }] }]);
  storyboard('state', [{ route: '/signup', actions: [{ do: 'click', selector: '#submit' }] }, { route: '/dashboard' }]);
  for (const f of ['route', 'act1', 'act2']) { const r = capture(f); assert.equal(r.status, 0, r.stdout); assert.equal(r.j.reused, 0, f); }
  const st = capture('state');
  assert.equal(st.status, 0, st.stdout);
  // /dashboard after a state-changing click is NOT the same state as flow a's fresh /dashboard.
  assert.equal(prov('state', 'landscape', 's1').source, 'captured');
  assert.notEqual(prov('state', 'landscape', 's1').key, prov('a', 'landscape').key);
});

test('cache hits still run every action and assertion (server sees the click each time)', async () => {
  storyboard('click', [{ route: '/signup', actions: [{ do: 'click', selector: '#submit' }], expect: { text: 'Welcome!' } }]);
  assert.equal(capture('click').status, 0);
  const before = (await hits()).ping ?? 0;
  const again = capture('click');
  assert.equal(again.status, 0, again.stdout);
  assert.equal(again.j.reused, 2);
  assert.equal((await hits()).ping - before, 2, 'click executed in both formats despite reuse');
  // Assertion still enforced on a would-be hit: same route/actions but an expectation that fails.
  storyboard('click', [{ route: '/signup', actions: [{ do: 'click', selector: '#submit' }], expect: { text: 'Nope' } }]);
  const bad = capture('click');
  assert.equal(bad.status, 1);
  assert.ok(bad.j.failed.every((f) => f.check === 'expect'));
});

test('invalidation: source, actions, expect, readiness and redaction changes all miss', () => {
  const base = { route: '/dashboard' };
  const variants = {
    expect: { ...base, expect: { text: 'Dashboard' } },
    readiness: { ...base, loadingTimeout: 4000 },
    redaction: { ...base, redact: ['.card'] },
    actions: { ...base, actions: [{ do: 'scroll', value: 10 }] },
  };
  for (const [name, scene] of Object.entries(variants)) {
    storyboard(`inv-${name}`, [scene]);
    const r = capture(`inv-${name}`);
    assert.equal(r.status, 0, r.stdout);
    assert.equal(r.j.reused, 0, name);
  }
  // Source change: same storyboard as flow a, but the app source changed -> project fingerprint differs.
  storyboard('src', [{ route: '/dashboard' }]);
  fs.appendFileSync(path.join(proj, 'src', 'App.jsx'), '\n// changed\n');
  const r = capture('src');
  assert.equal(r.j.reused, 0);
  assert.equal(prov('src', 'landscape').reason, 'cache miss');
  assert.equal(capture('src').j.reused, 2, 'stable again once the source stops changing');
});

test('same key but live pixels differ: never reused, fresh capture replaces the entry', () => {
  // Make the cached entry for flow src's landscape key a valid PNG of a different page.
  const key = prov('src', 'landscape').key;
  const entry = fs.readdirSync(path.join(cacheDir, 'landscape')).find((f) => f.startsWith(key) && f.endsWith('.png'));
  const png = path.join(cacheDir, 'landscape', entry);
  const meta = path.join(cacheDir, 'landscape', entry.replace('.png', '.json'));
  fs.copyFileSync(path.join(flows, 'route', 'captures', 'landscape', 's0.png'), png);
  const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
  m.sha256 = sha(png);
  fs.writeFileSync(meta, JSON.stringify(m));
  const r = capture('src');
  assert.equal(prov('src', 'landscape').source, 'captured');
  assert.equal(prov('src', 'landscape').reason, 'cached capture differs from the live page (pixels changed)');
  assert.equal(r.j.reused, 1, 'vertical still reused');
  assert.equal(capture('src').j.reused, 2, 'entry was replaced with the real capture');
});

test('corrupted or missing cache entries are rejected and rebuilt', () => {
  capture('a'); // refresh: the source change above moved flow a to a new key
  const key = prov('a', 'vertical').key;
  const entry = fs.readdirSync(path.join(cacheDir, 'vertical')).find((f) => f.startsWith(key) && f.endsWith('.png'));
  fs.writeFileSync(path.join(cacheDir, 'vertical', entry), 'garbage');
  capture('a');
  assert.equal(prov('a', 'vertical').reason, 'cache entry corrupt (not a PNG)');
  fs.rmSync(path.join(cacheDir, 'vertical', entry));
  capture('a');
  assert.equal(prov('a', 'vertical').reason, 'cache miss');
  assert.equal(capture('a').j.reused, 2);
});

test('failed scenes are never cached; interrupted runs leave the cache untouched', async () => {
  const before = cacheFiles();
  storyboard('fail', [{ route: '/dashboard', expect: { text: 'Not on this page' } }]);
  assert.equal(capture('fail').status, 1);
  assert.deepEqual(cacheFiles(), before);
  if (process.platform === 'win32') return; // SIGTERM can't be intercepted on Windows
  storyboard('intr', [{ route: '/reports-none' === 'x' ? '/' : '/settings', actions: [{ do: 'scroll', value: 5 }] }, { route: '/', actions: [{ do: 'wait', value: 3000 }] }]);
  const p = spawn(process.execPath, [path.join(K, 'capture.mjs'), path.join(flows, 'intr', 'storyboard.json')], { stdio: 'ignore' });
  const staged = () => fs.readdirSync(path.join(flows, 'intr')).some((f) => f.startsWith('captures.staging'));
  for (let i = 0; i < 400 && !(staged() && fs.readdirSync(path.join(cacheDir, 'landscape')).some((f) => f.endsWith('.tmp'))); i++) await new Promise((r) => setTimeout(r, 25));
  p.kill('SIGTERM');
  assert.equal(await new Promise((r) => p.on('close', r)), 130);
  assert.deepEqual(cacheFiles(), before, 'no committed entries and no leftover temp files');
});

test('--no-cache and VIDGEN_NO_CAPTURE_CACHE=1 force fresh captures', () => {
  let r = capture('a', '--no-cache');
  assert.equal(r.j.reused, 0);
  assert.match(prov('a', 'landscape').reason, /reuse disabled/);
  r = spawnSync(process.execPath, [path.join(K, 'capture.mjs'), path.join(flows, 'a', 'storyboard.json')], { encoding: 'utf8', env: { ...process.env, VIDGEN_NO_CAPTURE_CACHE: '1' } });
  assert.equal(JSON.parse(r.stdout).reused, 0);
});

test('auth: different accounts never share captures; same account reuses; no secrets in cache or provenance', () => {
  storyboard('demo', [{ route: '/app/reports' }], { auth: AUTH, redact: ['.account-email'] });
  storyboard('admin', [{ route: '/app/reports' }], { auth: { ...AUTH, loginUrl: '/login?auto=admin' }, redact: ['.account-email'] });
  assert.equal(capture('demo', '--login').j.reused, 0);
  const ad = capture('admin', '--login');
  assert.equal(ad.status, 0, ad.stdout + ad.stderr);
  assert.equal(ad.j.reused, 0, 'admin (same pixels after redaction) must not reuse demo');
  assert.notEqual(prov('admin', 'landscape').key, prov('demo', 'landscape').key);
  assert.equal(capture('demo', '--login').j.reused, 2, 'same account, new session: reused');
  // No stable identity (text-only proof) -> reuse disabled, never guessed.
  storyboard('noid', [{ route: '/app/reports' }], { auth: { ...AUTH, authenticated: { text: 'Signed in as' } } });
  const n = capture('noid', '--login');
  assert.equal(n.j.reused, 0);
  assert.match(prov('noid', 'landscape').reason, /identity could not be established/);
  const blob = cacheFiles().filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(cacheDir, f), 'utf8')).join('\n')
    + ['demo', 'admin', 'noid'].map((f) => fs.readFileSync(path.join(flows, f, 'captures', 'landscape', 's0.json'), 'utf8')).join('\n');
  for (const s of ['sid-SECRET', 'fixture-pass-123', 'fixture-admin-456', 'demo@example.test', 'admin@example.test']) assert.ok(!blob.includes(s), s);
});

test('reused captures pass QA, render in both formats and keep combined order', () => {
  for (const f of ['b', 'a']) {
    const r = spawnSync(process.execPath, [path.join(K, 'render.mjs'), path.join(flows, f, 'storyboard.json')], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
    const q = JSON.parse(spawnSync(process.execPath, [path.join(K, 'qa.mjs'), path.join(flows, f)], { encoding: 'utf8' }).stdout);
    assert.equal(q.pass, true, JSON.stringify(q.captureIssues));
  }
  const e = spawnSync(process.execPath, [path.join(K, 'export.mjs'), proj, 'b', 'a', '--combined'], { encoding: 'utf8' });
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual(JSON.parse(e.stdout).combined.order, ['b', 'a']);
  for (const size of ['1920x1080', '1080x1920']) {
    const v = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path.join(proj, 'vidgen-export', `combined-${size}.mp4`)])).streams[0];
    assert.equal(`${v.width}x${v.height}`, size);
  }
  assert.ok(!fs.readdirSync(path.join(proj, 'vidgen-export')).some((f) => f.includes('cache')), 'cache stays out of exports');
});

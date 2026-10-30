#!/usr/bin/env node
// Authenticated-flow regression tests. Usage: node --test tests/auth.test.mjs
// Uses the fixture app's synthetic accounts (tests/fixture/app/server.mjs). No real credentials, no external sites.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-auth-'));
const target = path.join(tmp, 'agent');
const K = path.join(target, 'skills', 'vidgen', 'scripts');
const proj = path.join(tmp, 'proj');
const flows = path.join(proj, '.vidgen', 'flows');
const PORT = 4800 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const SECRETS = ['sid-SECRET', 'fixture-pass-123', 'fixture-admin-456', 'sk-live-FAKE', 'sk-abc123secret'];
const logs = []; // every stdout/stderr we see, checked for secrets at the end
let server;

const AUTH = (extra = {}) => ({ loginUrl: '/login?auto=demo', authenticated: { selector: '[data-testid=account-menu]' }, ...extra });
function storyboard(flow, sb) {
  fs.mkdirSync(path.join(flows, flow), { recursive: true });
  const f = path.join(flows, flow, 'storyboard.json');
  fs.writeFileSync(f, JSON.stringify({ flow, title: flow, baseUrl: BASE, brand: { primary: '#E11D48', background: '#0F172A' }, music: 'none', ...sb }));
  return f;
}
function run(script, args, env = {}) {
  const r = spawnSync('node', [path.join(K, script), ...args], { cwd: os.tmpdir(), encoding: 'utf8', env: { ...process.env, VIDGEN_AUTH_HEADLESS: '1', ...env } });
  logs.push(r.stdout, r.stderr);
  return { ...r, json: (() => { try { return JSON.parse(r.stdout); } catch { return null; } })() };
}
const capture = (sb, ...flags) => run('capture.mjs', [sb, ...flags]);
const scenes = (ids, extra = {}) => ids.map(([id, route, more]) => ({ id, type: 'capture', route, duration: 2, caption: id, ...extra, ...more }));
const failedChecks = (r) => Object.fromEntries((r.json?.failed ?? []).map((f) => [`${f.fmt}/${f.scene}`, f.check]));
const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

before(async () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn('node', ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((res) => server.stdout.once('data', res));
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ---------- positive ----------

test('authenticated multi-scene flow: --login reaches dashboard, assertions pass, both formats render + QA, sensitive fields redacted', () => {
  const sb = storyboard('dash', { auth: AUTH(), redact: ['.account-email', '.api-key'], scenes: [
    { id: 't', type: 'title', text: 'Your workspace', duration: 1.5 },
    ...scenes([['home', '/app', { expect: { text: 'Team dashboard' } }], ['reports', '/app/reports', { expect: { text: 'Q3 revenue up 12%' } }]])] });
  const c = capture(sb, '--login');
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.equal(c.json.captured, 4);
  for (const fmt of ['landscape', 'vertical']) {
    const meta = JSON.parse(fs.readFileSync(path.join(flows, 'dash', 'captures', fmt, 'home.json'), 'utf8'));
    assert.equal(meta.redactions['.account-email'], 1);
    assert.equal(meta.redactions['.api-key'], 1);
    assert.equal(meta.url, `${BASE}/app`);
  }
  assert.equal(fs.readdirSync(path.join(flows, 'dash')).some((f) => f.startsWith('captures.staging')), false, 'staging cleaned');
  assert.equal(run('render.mjs', [sb]).status, 0);
  const q = run('qa.mjs', [path.join(flows, 'dash')]);
  assert.equal(q.json?.pass, true, q.stdout);
  for (const [fmt, size] of [['landscape', '1920x1080'], ['vertical', '1080x1920']]) {
    const p = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path.join(flows, 'dash', 'out', `${fmt}.mp4`)]));
    assert.equal(`${p.streams[0].width}x${p.streams[0].height}`, size);
  }
});

test('public flow without auth block still works unchanged', () => {
  const c = capture(storyboard('public', { scenes: scenes([['s', '/settings']]) }));
  assert.equal(c.status, 0, c.stdout);
});

test('--cdp reuses an already signed-in browser, and leaves that browser running', async () => {
  const { chromium } = await import(path.join(target, 'skills', 'vidgen', 'node_modules', 'playwright', 'index.mjs'));
  const cdpPort = 9300 + Math.floor(Math.random() * 400);
  const userCtx = await chromium.launchPersistentContext(path.join(tmp, 'user-profile'), { headless: true, args: [`--remote-debugging-port=${cdpPort}`] });
  try {
    const page = userCtx.pages()[0] ?? await userCtx.newPage();
    await page.goto(`${BASE}/login?auto=admin`);
    await page.waitForURL(`${BASE}/app`);
    const sb = storyboard('cdp', { auth: AUTH(), scenes: scenes([['admin', '/app/admin', { expect: { text: 'Admin console' } }]]) });
    const c = capture(sb, '--cdp', `http://127.0.0.1:${cdpPort}`);
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.equal(await page.evaluate(() => 1 + 1), 2, "user's browser still alive after capture");
  } finally { await userCtx.close(); }
});

// ---------- negative ----------

test('no session: auth storyboard without --login/--cdp exits 2 and writes nothing', () => {
  const sb = storyboard('nosession', { auth: AUTH(), scenes: scenes([['home', '/app']]) });
  const c = capture(sb);
  assert.equal(c.status, 2);
  assert.match(c.stderr, /requires an authenticated session/);
  assert.ok(!fs.existsSync(path.join(flows, 'nosession', 'captures')));
});

test('login redirect is never accepted as the dashboard (no auth block declared)', () => {
  const c = capture(storyboard('redirect', { scenes: scenes([['home', '/app', { expect: { text: 'Sign in' } }]]) }));
  assert.equal(c.status, 1);
  assert.deepEqual(failedChecks(c), { 'landscape/home': 'auth', 'vertical/home': 'auth' });
  assert.match(c.stdout, /redirected to a login page/);
  assert.ok(!fs.existsSync(path.join(flows, 'redirect', 'captures', 'landscape', 'home.png')));
});

test('allow: ["login"] permits an intentional sign-in/sign-up scene, but never a redirect to it', () => {
  const ok = capture(storyboard('cta', { scenes: scenes([['cta', '/login', { allow: ['login'] }]]) }));
  assert.equal(ok.status, 0, ok.stdout);
  assert.ok(fs.existsSync(path.join(flows, 'cta', 'captures', 'landscape', 'cta.png')));
  const red = capture(storyboard('cta-redirect', { scenes: scenes([['home', '/app', { allow: ['login'] }]]) }));
  assert.equal(red.status, 1);
  assert.deepEqual(failedChecks(red), { 'landscape/home': 'auth', 'vertical/home': 'auth' });
  const plain = capture(storyboard('cta-plain', { scenes: scenes([['cta', '/login']]) }));
  assert.equal(plain.status, 1, 'without the opt-in a login page is still rejected');
});

test('expired session is rejected before capturing (exit 6)', () => {
  const c = capture(storyboard('expired', { auth: AUTH({ loginUrl: '/login?auto=demo&ttl=1' }), scenes: scenes([['home', '/app']]) }), '--login');
  assert.equal(c.status, 6, c.stderr);
  assert.match(c.stderr, /session check failed.*login page/);
});

test('session expiring mid-flow rejects the affected scenes and blocks the combined export', () => {
  // ttl: 1 (login redirect) + 1 (probe) + 2 landscape scenes, then expired for vertical.
  const sb = storyboard('midflow', { auth: AUTH({ loginUrl: '/login?auto=demo&ttl=4' }), scenes: scenes([['home', '/app'], ['reports', '/app/reports']]) });
  const c = capture(sb, '--login');
  assert.equal(c.status, 1);
  assert.deepEqual(failedChecks(c), { 'vertical/home': 'auth', 'vertical/reports': 'auth' });
  const e = run('export.mjs', [proj, 'dash', 'midflow', '--combined', '--no-render']);
  assert.equal(e.status, 1);
  assert.equal(e.json.failed[0].flow, 'midflow');
  assert.ok(e.json.combined.skipped);
  assert.ok(!fs.existsSync(path.join(proj, 'vidgen-export', 'combined-1080x1920.mp4')));
});

test('forbidden routes fail: HTTP 403 and an "Access denied" page served with 200', () => {
  const c = capture(storyboard('forbidden', { auth: AUTH(), scenes: scenes([['admin', '/app/admin'], ['billing', '/app/billing'], ['ok', '/app']]) }), '--login');
  assert.equal(c.status, 1);
  assert.deepEqual(failedChecks(c), { 'landscape/admin': 'forbidden', 'landscape/billing': 'forbidden', 'vertical/admin': 'forbidden', 'vertical/billing': 'forbidden' });
});

test('required authenticated element missing: scene expect and auth proof both enforced', () => {
  let c = capture(storyboard('missing', { auth: AUTH(), scenes: scenes([['home', '/app', { expect: { selector: '[data-testid=does-not-exist]' } }]]) }), '--login');
  assert.equal(c.status, 1);
  assert.equal(failedChecks(c)['landscape/home'], 'expect');
  // Wrong proof-of-auth selector: never "assume" signed in. Sign-in can't be confirmed -> times out.
  c = capture(storyboard('missing', { auth: AUTH({ authenticated: { selector: '#nope' }, timeout: 2000 }), scenes: scenes([['home', '/app']]) }), '--login');
  assert.equal(c.status, 4);
});

test('sign-in timeout exits 4', () => {
  const c = capture(storyboard('timeout', { auth: AUTH({ loginUrl: '/login?stall=1', timeout: 1500 }), scenes: scenes([['home', '/app']]) }), '--login');
  assert.equal(c.status, 4);
});

test('browser failing to start exits 5 with a clear message', () => {
  const sb = storyboard('nobrowser', { auth: AUTH(), scenes: scenes([['home', '/app']]) });
  const r = run('capture.mjs', [sb, '--login'], { VIDGEN_CHROMIUM_PATH: path.join(tmp, 'no-such-chrome') });
  assert.equal(r.status, 5);
  assert.match(r.stderr, /browser failed to start/);
  const cdp = run('capture.mjs', [sb, '--cdp', 'http://127.0.0.1:9']);
  assert.equal(cdp.status, 5);
});

test('external redirects: scene leaving the app is rejected; sign-in may only visit allowedOrigins', () => {
  const c = capture(storyboard('external', { auth: AUTH(), scenes: scenes([['sso', '/app/sso-out']]) }), '--login');
  assert.equal(c.status, 1);
  assert.equal(failedChecks(c)['landscape/sso'], 'navigation');
  const other = `http://127.0.0.1:${PORT}`;
  const denied = capture(storyboard('external', { auth: AUTH({ loginUrl: `${other}/login?stall=1`, timeout: 3000 }), scenes: scenes([['home', '/app']]) }), '--login');
  assert.equal(denied.status, 6);
  assert.match(denied.stderr, /not the app or an allowed sign-in origin/);
  const allowed = capture(storyboard('external', { auth: AUTH({ loginUrl: `${other}/login?stall=1`, timeout: 1500, allowedOrigins: [other] }), scenes: scenes([['home', '/app']]) }), '--login');
  assert.equal(allowed.status, 4, 'allowed origin keeps waiting for the user (then times out)');
});

test('invalid auth config and credentials in storyboards are rejected (exit 2) without echoing values', () => {
  const bad = [
    [{ auth: { loginUrl: '/login' } }, /authenticated: required/],
    [{ auth: AUTH({ loginPatterns: ['(('] }) }, /invalid regex/],
    [{ auth: AUTH({ colour: 'red' }) }, /auth.colour: unknown setting/],
    [{ auth: AUTH({ allowedOrigins: ['https://x.example.com/path'] }) }, /not an origin/],
    [{ auth: AUTH({ timeout: 5 }) }, /timeout/],
    [{ auth: AUTH({ password: 'fixture-pass-123' }) }, /must not contain credentials/],
    [{ auth: AUTH(), cookies: [{ name: 'sid', value: 'sid-SECRET-x' }] }, /must not contain credentials/],
    [{ auth: AUTH(), scenes: scenes([['s', '/login', { actions: [{ do: 'fill', selector: 'input[name=password]', value: 'fixture-pass-123' }] }]]) }, /password\/secret\/OTP/],
  ];
  for (const [sb, re] of bad) {
    const c = capture(storyboard('invalid', { scenes: scenes([['home', '/app']]), ...sb }), '--login');
    assert.equal(c.status, 2, JSON.stringify(sb));
    assert.match(c.stderr, re);
    for (const s of SECRETS) assert.ok(!c.stderr.includes(s) && !c.stdout.includes(s), `echoed ${s}`);
  }
  const usage = run('capture.mjs', [path.join(flows, 'dash', 'storyboard.json'), '--cdp']);
  assert.equal(usage.status, 2);
});

test('interrupt during sign-in exits 130 and leaves previous captures untouched', { skip: process.platform === 'win32' && 'SIGTERM is TerminateProcess on Windows' }, async () => {
  const shot = path.join(flows, 'dash', 'captures', 'landscape', 'home.png');
  const before = shaOf(shot);
  const sb = path.join(flows, 'dash', 'storyboard.json');
  const orig = fs.readFileSync(sb, 'utf8');
  fs.writeFileSync(sb, orig.replace('/login?auto=demo', '/login?stall=1'));
  try {
    const p = spawn('node', [path.join(K, 'capture.mjs'), sb, '--login'], { env: { ...process.env, VIDGEN_AUTH_HEADLESS: '1' } });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    for (let i = 0; i < 400 && !err.includes('Sign in in the browser'); i++) await new Promise((r) => setTimeout(r, 50));
    p.kill('SIGTERM');
    assert.equal(await new Promise((r) => p.on('close', r)), 130);
    logs.push(err);
  } finally { fs.writeFileSync(sb, orig); }
  assert.equal(shaOf(shot), before);
  assert.equal(fs.readdirSync(path.join(flows, 'dash')).some((f) => f.startsWith('captures.staging')), false);
});

test('interrupt mid-capture keeps previous captures (staged promotion) and the rendered video', { skip: process.platform === 'win32' && 'SIGTERM is TerminateProcess on Windows' }, async () => {
  const shot = path.join(flows, 'dash', 'captures', 'vertical', 'reports.png');
  const video = path.join(flows, 'dash', 'out', 'vertical.mp4');
  const [s1, v1] = [shaOf(shot), shaOf(video)];
  const p = spawn('node', [path.join(K, 'capture.mjs'), path.join(flows, 'dash', 'storyboard.json'), '--login'], { env: { ...process.env, VIDGEN_AUTH_HEADLESS: '1' } });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  const staging = () => fs.readdirSync(path.join(flows, 'dash')).some((f) => f.startsWith('captures.staging'));
  for (let i = 0; i < 400 && !staging(); i++) await new Promise((r) => setTimeout(r, 25));
  p.kill('SIGTERM');
  assert.equal(await new Promise((r) => p.on('close', r)), 130);
  logs.push(err);
  assert.equal(shaOf(shot), s1);
  assert.equal(shaOf(video), v1);
  assert.equal(staging(), false);
});

test('context cache scrubs inline secrets from package.json scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(proj, 'package.json'), 'utf8'));
  pkg.scripts.prod = 'API_KEY=sk-abc123secret SESSION_SECRET="fixture-pass-123" node server.mjs';
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify(pkg));
  assert.equal(run('context.mjs', [proj, '--scan']).status, 0);
  const ctx = fs.readFileSync(path.join(proj, '.vidgen', 'context.json'), 'utf8');
  assert.match(ctx, /API_KEY=\[redacted\] SESSION_SECRET=\[redacted\] node server.mjs/);
});

test('exports contain only videos + manifest; VidGen repo ignores session/staging artifacts', () => {
  const e = run('export.mjs', [proj, 'dash']);
  assert.equal(e.status, 0, e.stderr);
  assert.deepEqual(fs.readdirSync(path.join(proj, 'vidgen-export')).sort(), ['dash-1080x1920.mp4', 'dash-1920x1080.mp4', 'manifest.json']);
  for (const f of ['.vidgen/x', 'vidgen-export/x', 'a.storageState.json', 'storage-state.json', '.auth/user.json', 'playwright/.auth/u.json', 'x/captures.staging-12/a.png']) {
    const g = spawnSync('git', ['check-ignore', '-q', f], { cwd: repo });
    if (g.error) return; // git not installed: nothing to verify
    assert.equal(g.status, 0, `${f} must be git-ignored`);
  }
});

test('no credentials, cookies or session ids in any log, capture metadata, context cache or export', () => {
  const texts = [...logs];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      // storyboard.json is test INPUT (the invalid-config test plants credentials there on purpose); everything else is VidGen output.
      else if (/\.(json|txt|log|md)$/.test(e.name) && e.name !== 'storyboard.json') texts.push(fs.readFileSync(p, 'utf8'));
    }
  })(path.join(proj, '.vidgen'));
  texts.push(fs.readFileSync(path.join(proj, 'vidgen-export', 'manifest.json'), 'utf8'));
  const blob = texts.join('\n');
  for (const s of SECRETS) assert.ok(!blob.includes(s), `found secret marker ${s}`);
  assert.ok(!/[?&](next|code|token)=/.test(blob.replace(/login\?auto=demo|login\?close=1|login\?stall=1|auto=demo&ttl=\d/g, '')), 'no query strings in stored URLs');
});

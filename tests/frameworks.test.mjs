#!/usr/bin/env node
// Framework adapters. Usage: node --test tests/frameworks.test.mjs
// Deterministic and offline: discovery runs on synthetic project trees; capture behaviour on fixture pages.
// Real Next.js / SvelteKit runs are separate (tests/frameworks-real.mjs, needs npm network access).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-fw-'));
const target = path.join(tmp, 'agent');
const K = path.join(target, 'skills', 'vidgen', 'scripts');
const proj = path.join(tmp, 'proj');
const PORT = 7200 + Math.floor(Math.random() * 300);
let server;

const run = (script, args, opts = {}) => spawnSync(process.execPath, [path.join(K, script), ...args], { encoding: 'utf8', ...opts });
function tree(name, pkg, files) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  if (pkg) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body ?? '');
  }
  assert.equal(run('context.mjs', [root, '--scan']).status, 0);
  return JSON.parse(fs.readFileSync(path.join(root, '.vidgen', 'context.json'), 'utf8'));
}

before(async () => {
  assert.equal(spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', target]).status, 0);
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((r) => server.stdout.once('data', r));
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('Next.js App + Pages Router: groups stripped, dynamic separated, API/internal/slots/intercepts excluded', () => {
  const c = tree('next', { dependencies: { next: '14', react: '18' }, scripts: { dev: 'next dev' } }, {
    'app/page.tsx': '', 'app/(marketing)/pricing/page.tsx': '', 'app/blog/[slug]/page.tsx': '', 'app/docs/[...path]/page.mdx': '',
    'app/shop/[[...filters]]/page.js': '', 'app/@modal/login/page.tsx': '', 'app/_components/page.tsx': '', 'app/(.)photo/[id]/page.tsx': '',
    'app/api/health/route.ts': '', 'app/feed.xml/route.ts': '', 'src/pages/legacy.tsx': '', 'src/pages/index.tsx': '', 'src/pages/_app.tsx': '',
    'src/pages/_document.tsx': '', 'src/pages/api/hello.ts': '', 'src/pages/users/[id].tsx': '', 'src/pages/button.test.tsx': '',
  });
  assert.equal(c.router.adapter, 'next');
  assert.deepEqual(c.routes, ['/', '/legacy', '/pricing']);
  assert.deepEqual(c.router.dynamic.map((d) => [d.pattern, d.params.join(',')]), [['/blog/[slug]', 'slug'], ['/docs/[...path]', 'path'], ['/shop/[[...filters]]', 'filters'], ['/users/[id]', 'id']]);
  const reasons = Object.fromEntries(c.router.excluded.map((e) => [e.file, e.reason]));
  assert.match(reasons['app/@modal/login/page.tsx'], /parallel-route slot/);
  assert.match(reasons['app/_components/page.tsx'], /private/);
  assert.match(reasons['app/(.)photo/[id]/page.tsx'], /intercepting/);
  assert.match(reasons['app/api/health/route.ts'], /route handler/);
  assert.match(reasons['src/pages/api/hello.ts'], /api/);
  assert.match(reasons['src/pages/_app.tsx'], /internal/);
  assert.match(reasons['src/pages/button.test.tsx'], /test/);
  assert.deepEqual(c.dev, { command: 'npm run dev', port: 3000, url: 'http://localhost:3000' });
});

test('SvelteKit: root page, groups stripped, [[optional]]/[...rest] dynamic, +server/+layout/+error not pages', () => {
  const c = tree('kit', { devDependencies: { '@sveltejs/kit': '2', vite: '5' } }, {
    'src/routes/+page.svelte': '', 'src/routes/+layout.svelte': '', 'src/routes/+error.svelte': '', 'src/routes/about/+page.svelte': '',
    'src/routes/(app)/dash/+page.svelte': '', 'src/routes/(app)/+layout.svelte': '', 'src/routes/blog/[slug]/+page.svelte': '',
    'src/routes/[[lang]]/help/+page.svelte': '', 'src/routes/files/[...rest]/+page@.svelte': '', 'src/routes/api/ping/+server.ts': '',
    'src/lib/routes/+page.svelte': '',
  });
  assert.equal(c.router.adapter, 'sveltekit');
  assert.deepEqual(c.routes, ['/', '/about', '/dash']);
  assert.deepEqual(c.router.dynamic.map((d) => d.pattern), ['/[[lang]]/help', '/blog/[slug]', '/files/[...rest]']);
  assert.deepEqual(c.router.excluded.map((e) => e.file), ['src/routes/api/ping/+server.ts']);
  assert.equal(c.dev.port, 5173);
});

test('false positives: path literals in a non-router project are NOT routes; generic fallback explains', () => {
  const c = tree('express', { dependencies: { express: '4' } }, { 'src/client.js': "const cfg = { path: '/api/users' }; fetch({ path: '/internal/metrics' });", 'server.js': "app.get('/health', h)" });
  assert.equal(c.router.adapter, 'generic');
  assert.deepEqual(c.routes, []);
  assert.match(c.router.note, /not discovered automatically/);
  // react-router present, but only files that actually use the router contribute.
  const rr = tree('rr', { dependencies: { react: '18', 'react-router-dom': '6' } }, {
    'src/router.jsx': "import { createBrowserRouter } from 'react-router-dom'; createBrowserRouter([{ path: '/' }, { path: '/team/:id' }, { path: '/about' }])",
    'src/api.js': "request({ path: '/v1/secret-admin' })",
  });
  assert.deepEqual(rr.routes, ['/', '/about']);
  assert.deepEqual(rr.router.dynamic.map((d) => d.pattern), ['/team/[id]']);
});

test('ambiguous projects report every candidate; a framework with no pages falls back to generic', () => {
  const c = tree('mono', { dependencies: { next: '14', '@sveltejs/kit': '2' } }, { 'app/page.tsx': '', 'src/routes/+page.svelte': '' });
  assert.deepEqual(c.router.ambiguous, ['next', 'sveltekit']);
  const empty = tree('next-empty', { dependencies: { next: '14' } }, { 'lib/util.ts': '' });
  assert.equal(empty.router.adapter, 'next');
  assert.deepEqual(empty.routes, []);
  assert.match(empty.router.note, /routes are not discovered/);
});

test('capture rejects framework error screens served with HTTP 200 (overlay, status heading, error boundary)', () => {
  const dir = path.join(proj, '.vidgen', 'flows', 'errs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ flow: 'errs', baseUrl: `http://localhost:${PORT}`, scenes: [
    { id: 'overlay', type: 'capture', route: '/err-overlay', duration: 2 }, { id: 'status', type: 'capture', route: '/err-status', duration: 2 },
    { id: 'boundary', type: 'capture', route: '/err-boundary', duration: 2 }, { id: 'ok', type: 'capture', route: '/dashboard', duration: 2 },
    { id: 'nextopen', type: 'capture', route: '/next-open', duration: 2 }, { id: 'nextidle', type: 'capture', route: '/next-idle', duration: 2 }] }));
  const r = run('capture.mjs', [path.join(dir, 'storyboard.json')]);
  assert.equal(r.status, 1);
  const f = Object.fromEntries(JSON.parse(r.stdout).failed.filter((x) => x.fmt === 'landscape').map((x) => [x.scene, x.check]));
  // nextidle: Next >= 15 dev indicator with a collapsed issue is NOT an error screen (regression: a real Next 16 app).
  assert.deepEqual(f, { overlay: 'apperror', status: 'apperror', boundary: 'apperror', nextopen: 'apperror' });
});

test('navigationTimeout: a slow server-rendered page fails at the 15 s default and passes when raised; invalid values refused', () => {
  const dir = path.join(proj, '.vidgen', 'flows', 'slowssr');
  fs.mkdirSync(dir, { recursive: true });
  const sb = (extra) => { fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ flow: 'slowssr', baseUrl: `http://localhost:${PORT}`, scenes: [{ id: 'a', type: 'capture', route: '/slow-ssr?ms=16000', duration: 2 }], ...extra })); return path.join(dir, 'storyboard.json'); };
  const slow = run('capture.mjs', [sb({})]);
  assert.equal(slow.status, 1);
  assert.match(slow.stdout, /Timeout 15000ms exceeded/);
  assert.equal(run('capture.mjs', [sb({ navigationTimeout: 30000 })]).status, 0);
  const bad = run('capture.mjs', [sb({ navigationTimeout: 999 })]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /navigationTimeout must be/);
});

test('storyboard.localStorage is set on the app origin before page scripts (dismisses an onboarding tour)', () => {
  const dir = path.join(proj, '.vidgen', 'flows', 'tour');
  fs.mkdirSync(dir, { recursive: true });
  const sb = (extra) => { fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ flow: 'tour', baseUrl: `http://localhost:${PORT}`, scenes: [{ id: 'a', type: 'capture', route: '/tour', duration: 2, expect: { notText: 'Welcome tour' } }], ...extra })); return path.join(dir, 'storyboard.json'); };
  assert.equal(run('capture.mjs', [sb({})]).status, 1, 'tour visible without it');
  const ok = run('capture.mjs', [sb({ localStorage: { tour_done: '1' } })]);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(run('capture.mjs', [sb({ localStorage: { tour_done: 1 } })]).status, 2, 'non-string values refused');
});

test('async client-side navigation is not a false "noop"; sparse real pages are not "blank"', () => {
  const dir = path.join(proj, '.vidgen', 'flows', 'spa');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'storyboard.json'), JSON.stringify({ flow: 'spa', baseUrl: `http://localhost:${PORT}`, scenes: [
    { id: 'nav', type: 'capture', route: '/slow-nav', actions: [{ do: 'click', selector: '#go' }], expect: { url: '/settings', text: 'Settings' }, duration: 2 },
    { id: 'sparse', type: 'capture', route: '/sparse', duration: 2 }, { id: 'empty', type: 'capture', route: '/blank', duration: 2 }] }));
  const r = run('capture.mjs', [path.join(dir, 'storyboard.json')]);
  const failed = JSON.parse(r.stdout).failed.map((x) => `${x.fmt}/${x.scene}/${x.check}`).sort();
  assert.deepEqual(failed, ['landscape/empty/blank', 'vertical/empty/blank'], 'only the truly empty page is blank');
});

test('start.mjs: waits for readiness, reports early exit and timeout, stops the whole process tree', async () => {
  const p2 = 7600 + Math.floor(Math.random() * 300);
  const p = spawn(process.execPath, [path.join(K, 'start.mjs'), proj, '--command', `node server.mjs`, '--url', `http://localhost:${p2}`, '--timeout', '30000'], { env: { ...process.env, PORT: String(p2) } });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  for (let i = 0; i < 400 && !out.includes('"ready":true'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(out, /"ready":true/);
  assert.equal((await fetch(`http://localhost:${p2}/dashboard`)).status, 200);
  if (process.platform !== 'win32') {
    p.kill('SIGTERM');
    assert.equal(await new Promise((r) => p.on('close', r)), 130);
    await new Promise((r) => setTimeout(r, 500));
    await assert.rejects(fetch(`http://localhost:${p2}/`, { signal: AbortSignal.timeout(2000) }), 'server process tree stopped');
  } else p.kill();
  const early = run('start.mjs', [proj, '--command', 'node -e "process.exit(3)"', '--url', 'http://localhost:9']);
  assert.equal(early.status, 1);
  assert.match(early.stderr, /exited \(3\) before it was ready/);
  const slow = run('start.mjs', [proj, '--command', 'node -e "setTimeout(()=>{},60000)"', '--url', 'http://localhost:9', '--timeout', '1500']);
  assert.equal(slow.status, 4);
  assert.equal(run('start.mjs', [path.join(tmp, 'nope')]).status, 2);
});

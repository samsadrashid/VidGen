#!/usr/bin/env node
// Real-framework check (needs npm network access): installs the real Next.js 14 and SvelteKit 2 fixture apps
// (tests/fixture/next-app, tests/fixture/sveltekit-app), runs discovery, starts each dev server with start.mjs,
// captures a tour (static, client-side navigation, dynamic route, loading state, Pages Router / route group),
// verifies error routes are rejected, renders both formats and runs QA. Usage: node tests/frameworks-real.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const K = path.join(repo, 'skill', 'scripts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-real-fw-'));
const node = (s, args, o = {}) => spawnSync(process.execPath, [path.join(K, s), ...args], { encoding: 'utf8', ...o });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); };

const apps = {
  next: { dir: 'next-app', port: 3400 + Math.floor(Math.random() * 200), routes: ['/', '/broken', '/legacy', '/pricing'], dynamic: ['/blog/[slug]'], excluded: 2,
    tour: [['home', '/', [], { selector: '[data-testid=home]' }], ['pricing', '/', [{ do: 'click', selector: '#nav-pricing' }], { url: '/pricing', text: 'Team $99' }],
      ['post', '/', [{ do: 'click', selector: '#nav-post' }], { url: '/blog/hello-world', selector: '[data-testid=post]' }], ['legacy', '/legacy', [], { selector: '[data-testid=legacy]' }]] },
  sveltekit: { dir: 'sveltekit-app', port: 5400 + Math.floor(Math.random() * 200), routes: ['/', '/about', '/broken', '/dash'], dynamic: ['/blog/[slug]'], excluded: 1,
    tour: [['home', '/', [], { selector: '[data-testid=home]' }], ['about', '/', [{ do: 'click', selector: '#nav-about' }], { url: '/about', text: 'About us' }],
      ['post', '/', [{ do: 'click', selector: '#nav-post' }], { url: '/blog/hello-world', selector: '[data-testid=post]' }], ['dash', '/dash', [], { text: 'Inside the (app) route group.' }]] },
};

for (const [name, app] of Object.entries(apps)) {
  const root = path.join(tmp, name);
  fs.cpSync(path.join(repo, 'tests', 'fixture', app.dir), root, { recursive: true });
  const inst = spawnSync('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  check(`${name}: npm install`, inst.status === 0, inst.stderr.slice(-200));
  if (inst.status !== 0) continue;
  node('context.mjs', [root, '--scan']);
  const ctx = JSON.parse(fs.readFileSync(path.join(root, '.vidgen', 'context.json'), 'utf8'));
  check(`${name}: adapter`, ctx.router.adapter === name, ctx.router.adapter);
  check(`${name}: static routes`, JSON.stringify(ctx.routes) === JSON.stringify(app.routes), JSON.stringify(ctx.routes));
  check(`${name}: dynamic routes`, JSON.stringify(ctx.router.dynamic.map((d) => d.pattern)) === JSON.stringify(app.dynamic));
  check(`${name}: API/endpoints excluded`, ctx.router.excluded.length === app.excluded, ctx.router.excluded.map((e) => e.file).join(', '));

  const base = `http://localhost:${app.port}`;
  const srv = spawn(process.execPath, [path.join(K, 'start.mjs'), root, '--command', 'npm run dev', '--url', base, '--timeout', '180000'], { env: { ...process.env, PORT: String(app.port) } });
  let out = '';
  srv.stdout.on('data', (d) => (out += d));
  const ready = await new Promise((res) => { const t = setInterval(() => { if (out.includes('"ready":true')) { clearInterval(t); res(true); } }, 200); srv.on('close', () => { clearInterval(t); res(false); }); });
  check(`${name}: dev server ready (start.mjs)`, ready);
  if (!ready) continue;
  try {
    const flows = path.join(root, '.vidgen', 'flows');
    const write = (flow, scenes) => { fs.mkdirSync(path.join(flows, flow), { recursive: true }); fs.writeFileSync(path.join(flows, flow, 'storyboard.json'), JSON.stringify({ flow, baseUrl: base, music: 'none', scenes })); return path.join(flows, flow, 'storyboard.json'); };
    const tour = write('tour', [{ id: 't', type: 'title', text: `${name} tour`, duration: 1.5 }, ...app.tour.map(([id, route, actions, expect]) => ({ id, type: 'capture', route, actions, expect, caption: id, duration: 2.5 }))]);
    const cap = node('capture.mjs', [tour]);
    check(`${name}: tour captured (both formats)`, cap.status === 0, cap.status === 0 ? '' : cap.stdout.slice(0, 400));
    const broken = write('broken', [{ id: 'direct', type: 'capture', route: '/broken', duration: 2 }, { id: 'clientnav', type: 'capture', route: '/', actions: [{ do: 'click', selector: '#nav-broken' }], expect: { url: '/broken' }, duration: 2 }]);
    const bad = JSON.parse(node('capture.mjs', [broken]).stdout);
    check(`${name}: error routes rejected (SSR + client-side)`, bad.captured === 0 && bad.failed.length === 4, bad.failed.map((f) => `${f.scene}:${f.check}`).join(' '));
    if (cap.status === 0) {
      check(`${name}: render`, node('render.mjs', [tour]).status === 0);
      const q = JSON.parse(node('qa.mjs', [path.join(flows, 'tour')]).stdout);
      check(`${name}: QA pass, 1920x1080 + 1080x1920`, q.pass, JSON.stringify([q.captureIssues, q.results.landscape.issues, q.results.vertical.issues]));
    }
  } finally {
    srv.kill('SIGTERM');
    await new Promise((r) => srv.on('close', r));
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);

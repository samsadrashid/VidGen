#!/usr/bin/env node
// Core regression suite: install, analyze, capture, render, QA, export. Usage: node --test tests/core.test.mjs   (needs ffmpeg + playwright chromium; ~2 min)
// Installs the skill into a temp target and drives the INSTALLED scripts against tests/fixture/app.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-test-'));
const target = path.join(tmp, 'agent');
const K = path.join(target, 'skills', 'vidgen', 'scripts');
const proj = path.join(tmp, 'proj');
const flows = path.join(proj, '.vidgen', 'flows');
const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = { baseUrl: `http://localhost:${PORT}`, brand: { primary: '#E11D48', background: '#0F172A' } };
let server;

const node = (script, ...args) => spawnSync('node', [path.join(K, script), ...args], { cwd: os.tmpdir(), encoding: 'utf8' });
const qaJson = (flowDir) => { const r = node('qa.mjs', flowDir); assert.ok(r.stdout, `qa.mjs crashed: ${r.stderr}`); return JSON.parse(r.stdout); };
const probe = (f) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]));
function storyboard(flow, extra) {
  fs.mkdirSync(path.join(flows, flow), { recursive: true });
  fs.writeFileSync(path.join(flows, flow, 'storyboard.json'), JSON.stringify({ flow, title: flow, ...BASE, ...extra }));
  return path.join(flows, flow, 'storyboard.json');
}

before(async () => {
  const r = spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', target], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn('node', ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((res) => server.stdout.once('data', res));
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('install: absolute paths, no placeholders, stale files removed, bad args rejected', () => {
  const cmd = fs.readFileSync(path.join(target, 'commands', 'video-create.md'), 'utf8');
  assert.ok(cmd.includes(`node "${path.join(target, 'skills', 'vidgen')}/scripts/capture.mjs"`), 'quoted absolute script path');
  assert.ok(!cmd.includes('SKILL_DIR'));
  for (const f of ['context', 'capture', 'voiceover', 'render', 'qa', 'export']) assert.ok(fs.existsSync(path.join(K, `${f}.mjs`)), f);
  fs.writeFileSync(path.join(K, 'stale.mjs'), '');
  assert.equal(spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target', target]).status, 0);
  assert.ok(!fs.existsSync(path.join(K, 'stale.mjs')));
  assert.notEqual(spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--target']).status, 0);
  assert.notEqual(spawnSync(process.execPath, [path.join(repo, 'install.mjs'), '--project', path.join(tmp, 'nope')]).status, 0);
});

test('analyze: detects react routes + tokens, caches, invalidates on source change', () => {
  assert.equal(JSON.parse(node('context.mjs', proj, '--check').stdout).exists, false);
  node('context.mjs', proj, '--scan');
  const ctx = JSON.parse(fs.readFileSync(path.join(proj, '.vidgen', 'context.json'), 'utf8'));
  assert.equal(ctx.framework, 'react');
  assert.deepEqual(ctx.routes, ['/', '/dashboard', '/settings', '/signup']);
  assert.equal(ctx.tokens.colors['color-primary'], '#E11D48');
  assert.equal(JSON.parse(node('context.mjs', proj, '--check').stdout).fresh, true);
  fs.appendFileSync(path.join(proj, 'src', 'App.jsx'), '\n// change\n');
  assert.equal(JSON.parse(node('context.mjs', proj, '--check').stdout).fresh, false);
});

test('analyze: flutter go_router + MaterialApp routes', () => {
  const f = path.join(tmp, 'flutter');
  fs.mkdirSync(path.join(f, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(f, 'pubspec.yaml'), 'name: f\ndependencies:\n  flutter:\n    sdk: flutter\n');
  fs.writeFileSync(path.join(f, 'lib', 'main.dart'), "GoRoute(path: '/login', builder: (c, s) => X());\nMaterialApp(routes: {'/settings': (context) => Y()});");
  node('context.mjs', f, '--scan');
  const ctx = JSON.parse(fs.readFileSync(path.join(f, '.vidgen', 'context.json'), 'utf8'));
  assert.equal(ctx.framework, 'flutter');
  assert.deepEqual(ctx.routes, ['/login', '/settings']);
});

test('capture: refuses HTTP error pages', () => {
  const sb = storyboard('broken', { scenes: [{ id: 'a', type: 'capture', route: '/does-not-exist', duration: 2 }] });
  const r = node('capture.mjs', sb);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /HTTP 404/);
  assert.ok(!fs.existsSync(path.join(flows, 'broken', 'captures', 'landscape', 'a.png')));
});

test('create + review: three flows covering music, voiceover+music, no audio, short/long scenes', () => {
  storyboard('onboarding', { scenes: [
    { id: 't', type: 'title', text: 'Get started', duration: 1.5 },
    { id: 'a', type: 'capture', route: '/signup', actions: [{ do: 'fill', selector: 'input[name=email]', value: 'demo@example.com' }, { do: 'click', selector: '#submit' }], caption: 'Sign up fast', duration: 2.5 },
    { id: 'o', type: 'outro', text: 'fixture.dev', duration: 0.4 }] });
  storyboard('insights', { scenes: [{ id: 'a', type: 'capture', route: '/dashboard', actions: [{ do: 'waitFor', selector: '[data-testid=dash]' }], caption: 'Live metrics', motion: 'pan-down', duration: 6 }] });
  storyboard('settings', { music: 'none', scenes: [{ id: 'a', type: 'capture', route: '/settings', caption: 'Make it yours', transition: 'cut', duration: 2 }] });
  // Narration via ffmpeg tone (portable stand-in for TTS output).
  fs.mkdirSync(path.join(flows, 'onboarding', 'audio'), { recursive: true });
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=600:d=1.5', path.join(flows, 'onboarding', 'audio', 'a.wav')]);
  for (const f of ['onboarding', 'insights', 'settings']) {
    const sb = path.join(flows, f, 'storyboard.json');
    assert.equal(node('capture.mjs', sb).status, 0, f);
    const r = node('render.mjs', sb);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!fs.existsSync(path.join(flows, f, 'tmp')), 'tmp cleaned');
    const q = node('qa.mjs', path.join(flows, f));
    assert.equal(q.status, 0, q.stdout);
    assert.equal(JSON.parse(q.stdout).pass, true, 'qa actually ran and passed');
    for (const [fmt, [W, H]] of Object.entries({ landscape: [1920, 1080], vertical: [1080, 1920] })) {
      const p = probe(path.join(flows, f, 'out', `${fmt}.mp4`));
      const v = p.streams.find((s) => s.codec_type === 'video');
      assert.equal(`${v.width}x${v.height}`, `${W}x${H}`);
      assert.equal(!!p.streams.find((s) => s.codec_type === 'audio'), f !== 'settings', `${f} audio`);
    }
  }
});

test('render: failures leave previous outputs untouched and no tmp', () => {
  const sb = path.join(flows, 'insights', 'storyboard.json');
  const before = fs.readFileSync(path.join(flows, 'insights', 'out', 'vertical.mp4'));
  const bad = JSON.parse(fs.readFileSync(sb, 'utf8'));
  bad.music = 'missing.wav';
  fs.writeFileSync(sb, JSON.stringify(bad));
  assert.equal(node('render.mjs', sb).status, 1);
  assert.ok(before.equals(fs.readFileSync(path.join(flows, 'insights', 'out', 'vertical.mp4'))));
  assert.ok(!fs.existsSync(path.join(flows, 'insights', 'tmp')));
  bad.music = 'auto';
  fs.writeFileSync(sb, JSON.stringify(bad));
});

test('render: SIGTERM mid-render cleans tmp and keeps outputs', { skip: process.platform === 'win32' && 'SIGTERM is TerminateProcess on Windows' }, async () => {
  const sb = path.join(flows, 'insights', 'storyboard.json');
  const before = fs.readFileSync(path.join(flows, 'insights', 'out', 'landscape.mp4'));
  const p = spawn('node', [path.join(K, 'render.mjs'), sb, '--final'], { stdio: 'ignore' });
  // Kill once rendering has really started (tmp exists), not during module startup.
  const tmpDir = path.join(flows, 'insights', 'tmp');
  for (let i = 0; i < 300 && !fs.existsSync(tmpDir); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fs.existsSync(tmpDir), 'render started');
  await new Promise((r) => setTimeout(r, 300));
  p.kill('SIGTERM');
  const code = await new Promise((r) => p.on('close', r));
  assert.equal(code, 130);
  assert.ok(!fs.existsSync(path.join(flows, 'insights', 'tmp')));
  assert.ok(before.equals(fs.readFileSync(path.join(flows, 'insights', 'out', 'landscape.mp4'))));
});

test('export: failing flow blocks combined video', () => {
  const r = node('export.mjs', proj, 'onboarding', 'broken', '--combined', '--no-render');
  assert.equal(r.status, 1);
  const m = JSON.parse(r.stdout);
  assert.equal(m.failed[0].flow, 'broken');
  assert.ok(m.combined.skipped);
  assert.ok(!fs.existsSync(path.join(proj, 'vidgen-export', 'combined-1920x1080.mp4')));
});

test('export: final per-flow + combined in order, both formats, manifest', () => {
  const r = node('export.mjs', proj, 'insights', 'onboarding', 'settings', '--combined');
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.deepEqual(m.combined.order, ['insights', 'onboarding', 'settings']);
  for (const [fmt, size] of [['landscape', '1920x1080'], ['vertical', '1080x1920']]) {
    for (const f of ['insights', 'onboarding', 'settings']) assert.ok(fs.existsSync(path.join(proj, 'vidgen-export', `${f}-${size}.mp4`)));
    const p = probe(path.join(proj, 'vidgen-export', `combined-${size}.mp4`));
    const v = p.streams.find((s) => s.codec_type === 'video');
    assert.equal(`${v.width}x${v.height}`, size);
    assert.ok(Math.abs(Number(p.format.duration) - 12.4) < 0.3, `combined duration ${p.format.duration}`);
    assert.ok(m.combined.files[fmt].sha256);
  }
  assert.ok(fs.existsSync(path.join(proj, 'vidgen-export', 'manifest.json')));
});

// ---------- Visual QA ----------

test('capture: detects failed interaction, navigation, loading, blank, broken image, JS error, overflow, expect', () => {
  const neg = { noop: ['/noop', [{ do: 'click', selector: '#dead' }]], redirect: ['/redirect', [{ do: 'wait', value: 500 }]], spinner: ['/spinner', []],
    blank: ['/blank', []], img: ['/broken-img', []], crash: ['/crash', []], wide: ['/wide', []], expect: ['/dashboard', []] };
  const scenes = Object.entries(neg).map(([id, [route, actions]]) => ({ id, type: 'capture', route, actions, duration: 2, loadingTimeout: 1500, ...(id === 'expect' ? { expect: { text: 'Revenue $99k' } } : {}) }));
  scenes.push(
    { id: 'slow', type: 'capture', route: '/slow', expect: { selector: '[data-testid=ready]' }, duration: 2 },
    { id: 'clicknav', type: 'capture', route: '/', actions: [{ do: 'click', selector: "a[href='/signup']" }], expect: { url: '/signup' }, duration: 2 });
  const r = node('capture.mjs', storyboard('neg', { scenes }));
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  const failed = Object.fromEntries(out.failed.filter((f) => f.fmt === 'vertical').map((f) => [f.scene, f.check]));
  assert.deepEqual(failed, { noop: 'noop', redirect: 'navigation', spinner: 'loading', blank: 'blank', img: 'images', crash: 'pageerror', wide: 'overflow', expect: 'expect' });
  for (const ok of ['slow', 'clicknav']) assert.ok(fs.existsSync(path.join(flows, 'neg', 'captures', 'landscape', `${ok}.png`)), ok);
});

test('render: rejects clipped/overlong overlay text and unreadable brand colors', () => {
  const dir = path.join(flows, 'overlay');
  fs.cpSync(path.join(flows, 'settings', 'captures'), path.join(dir, 'captures'), { recursive: true });
  let sb = storyboard('overlay', { music: 'none', scenes: [{ id: 'a', type: 'capture', route: '/settings', duration: 2, caption: 'A caption that is much too long to fit within two lines of the overlay box on a phone screen at all' }] });
  let r = node('render.mjs', sb);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /lines > 2/);
  // A caption that legitimately wraps to 2 lines on the phone format must render (regression: padding counted as a line,
  // and max-width excluded padding so the wrapped box left the safe area — every 2-line vertical caption failed).
  sb = storyboard('overlay', { music: 'none', scenes: [{ id: 'a', type: 'capture', route: '/settings', duration: 2, caption: 'Five real sentences per word' }] });
  r = node('render.mjs', sb);
  assert.equal(r.status, 0, r.stderr);
  fs.rmSync(path.join(dir, 'out'), { recursive: true, force: true });
  sb = storyboard('overlay', { music: 'none', brand: { primary: '#FDE047', background: '#0F172A' }, scenes: [{ id: 'a', type: 'capture', route: '/settings', duration: 2, caption: 'Short' }] });
  r = node('render.mjs', sb);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unreadable overlay/);
  assert.ok(!fs.existsSync(path.join(dir, 'out')));
});

test('qa: labelled contact sheet has one tile per scene', () => {
  const q = qaJson(path.join(flows, 'onboarding'));
  assert.equal(q.pass, true, JSON.stringify(q));
  for (const fmt of ['landscape', 'vertical']) {
    const sheet = q.results[fmt].sheet;
    const b = fs.readFileSync(sheet);
    assert.ok(b.readUInt32BE(16) > (fmt === 'landscape' ? 3 * 480 : 3 * 240), `${fmt} sheet width covers 3 tiles`);
  }
});

test('qa: detects swapped video, stale storyboard, stale capture, duplicate scene', () => {
  const f = path.join(flows, 'onboarding');
  const issues = () => { const q = qaJson(f); return [...q.captureIssues, ...q.results.landscape.issues].join('\n'); };
  const video = path.join(f, 'out', 'landscape.mp4');
  const keep = fs.readFileSync(video);
  fs.copyFileSync(path.join(flows, 'insights', 'out', 'landscape.mp4'), video);
  assert.match(issues(), /doesn't match rendered scene/);
  fs.writeFileSync(video, keep);

  const sbFile = path.join(f, 'storyboard.json');
  const sb = fs.readFileSync(sbFile);
  fs.writeFileSync(sbFile, sb.toString().replace('Sign up fast', 'Sign up faster'));
  assert.match(issues(), /storyboard changed since render/);
  fs.writeFileSync(sbFile, sb);

  // Replace a capture (with matching verification sha) after render -> stale video.
  const cap = path.join(f, 'captures', 'landscape', 'a.png');
  const meta = path.join(f, 'captures', 'landscape', 'a.json');
  const [capKeep, metaKeep] = [fs.readFileSync(cap), fs.readFileSync(meta)];
  fs.copyFileSync(path.join(flows, 'insights', 'captures', 'landscape', 'a.png'), cap);
  const m = JSON.parse(metaKeep);
  m.sha256 = crypto.createHash('sha256').update(fs.readFileSync(cap)).digest('hex');
  fs.writeFileSync(meta, JSON.stringify(m));
  assert.match(issues(), /capture changed since render/);
  fs.writeFileSync(cap, capKeep);
  fs.writeFileSync(meta, metaKeep);
  assert.equal(issues(), '');
});

test('qa: combined order check flags reversed flows', async () => {
  const { checkCombined } = await import(path.join(K, 'qa.mjs'));
  const fl = (f) => ({ flow: f, duration: JSON.parse(fs.readFileSync(path.join(flows, f, 'storyboard.json'))).scenes.reduce((a, s) => a + s.duration, 0), scenes: JSON.parse(fs.readFileSync(path.join(flows, f, 'out', 'landscape.render.json'))).scenes });
  const combined = path.join(proj, 'vidgen-export', 'combined-1920x1080.mp4');
  assert.deepEqual(checkCombined(combined, ['insights', 'onboarding', 'settings'].map(fl)), []);
  assert.ok(checkCombined(combined, ['settings', 'onboarding', 'insights'].map(fl)).length >= 3);
});

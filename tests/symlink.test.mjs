#!/usr/bin/env node
// Output-path symlink guard for capture / render / qa / voiceover / export. Usage: node --test tests/symlink.test.mjs
// Each case plants a symlink pointing at an "elsewhere" directory (or file) and checks the writer refuses (exit 2)
// before writing anything there. Normal projects, and projects reached THROUGH a symlink, must keep working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const skip = process.platform === 'win32' && 'symlinks need admin/dev-mode on Windows';
const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const K = path.join(repo, 'skill', 'scripts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-symlink-')); // under /var/folders -> /private/var on macOS
const proj = path.join(tmp, 'proj');
const flows = path.join(proj, '.vidgen', 'flows');
const PORT = 7900 + Math.floor(Math.random() * 300);
let server;

const run = (script, ...args) => spawnSync(process.execPath, [path.join(K, script), ...args], { encoding: 'utf8' });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const snapshot = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).sort() : []);
function elsewhere(name) { const d = path.join(tmp, `elsewhere-${name}`); fs.mkdirSync(d, { recursive: true }); return d; }
// Temporarily replace `p` (dir or file) with a symlink to `target`, restore afterwards.
function withSymlink(p, target, fn) {
  const keep = `${p}.keep-${process.pid}`;
  const existed = fs.existsSync(p) || (() => { try { fs.lstatSync(p); return true; } catch { return false; } })();
  if (existed) fs.renameSync(p, keep);
  fs.symlinkSync(target, p);
  try { return fn(); } finally { fs.rmSync(p, { force: true }); if (existed) fs.renameSync(keep, p); }
}

before(async () => {
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((r) => server.stdout.once('data', r));
  fs.mkdirSync(path.join(flows, 'a'), { recursive: true });
  fs.writeFileSync(path.join(flows, 'a', 'storyboard.json'), JSON.stringify({ flow: 'a', baseUrl: `http://localhost:${PORT}`, music: 'none', voiceover: true,
    scenes: [{ id: 's', type: 'capture', route: '/dashboard', caption: 'Metrics', narration: 'Hello.', duration: 2 }] }));
  // Requested narration must exist before render (it is never silently dropped); without a TTS engine use music-only.
  const vo = run('voiceover.mjs', path.join(flows, 'a', 'storyboard.json'));
  if (vo.status !== 0) {
    const sb = JSON.parse(fs.readFileSync(path.join(flows, 'a', 'storyboard.json'), 'utf8'));
    fs.writeFileSync(path.join(flows, 'a', 'storyboard.json'), JSON.stringify({ ...sb, voiceover: false }));
  }
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('normal (non-symlink) project: capture, render, qa, export all still work; macOS /var vs /private/var handled', { skip }, () => {
  if (process.platform === 'darwin') assert.notEqual(fs.realpathSync(tmp), tmp, 'project path really goes through /var -> /private/var');
  const sb = path.join(flows, 'a', 'storyboard.json');
  for (const s of ['capture.mjs', 'render.mjs']) { const r = run(s, sb); assert.equal(r.status, 0, `${s}: ${r.stderr}`); }
  assert.equal(JSON.parse(run('qa.mjs', path.join(flows, 'a')).stdout).pass, true);
  const e = run('export.mjs', proj, 'a');
  assert.equal(e.status, 0, e.stderr);
});

test('project reached through a symlinked parent path still works (symlinks ABOVE the project are the user\'s choice)', { skip }, () => {
  const link = path.join(tmp, 'proj-link');
  fs.symlinkSync(proj, link);
  const r = run('qa.mjs', path.join(link, '.vidgen', 'flows', 'a'));
  assert.equal(r.status, 0, r.stderr);
});

test('.vidgen itself a symlink: every writer refuses before writing anything there', { skip }, () => {
  const dst = elsewhere('vidgen');
  fs.cpSync(path.join(proj, '.vidgen'), dst, { recursive: true }); // attacker-controlled copy with real content
  const before = snapshot(dst);
  const shaBefore = sha(path.join(dst, 'flows', 'a', 'out', 'landscape.mp4'));
  withSymlink(path.join(proj, '.vidgen'), dst, () => {
    const sb = path.join(flows, 'a', 'storyboard.json');
    for (const [s, args, re] of [['capture.mjs', [sb], /capture refused: refusing to write through symlink \.vidgen/], ['render.mjs', [sb], /render refused/],
      ['qa.mjs', [path.join(flows, 'a')], /qa refused/], ['voiceover.mjs', [sb], /voiceover refused/]]) {
      const r = run(s, ...args);
      assert.equal(r.status, 2, s);
      assert.match(r.stderr, re, s);
    }
  });
  assert.deepEqual(snapshot(dst), before, 'nothing created in the symlink target');
  assert.equal(sha(path.join(dst, 'flows', 'a', 'out', 'landscape.mp4')), shaBefore, 'nothing overwritten');
});

test('output subdirectories as symlinks are refused: captures/, out/, cache/, a flow dir, audio/', { skip }, () => {
  const sb = path.join(flows, 'a', 'storyboard.json');
  const cases = [
    ['capture.mjs', [sb], path.join(flows, 'a', 'captures', 'landscape')],
    ['capture.mjs', [sb], path.join(proj, '.vidgen', 'cache')],
    ['render.mjs', [sb], path.join(flows, 'a', 'out')],
    ['render.mjs', [sb], path.join(proj, '.vidgen', 'cache', 'cards')],
    ['voiceover.mjs', [sb], path.join(flows, 'a', 'audio')],
  ];
  for (const [script, args, p] of cases) {
    const dst = elsewhere(`${script}-${path.basename(p)}`);
    withSymlink(p, dst, () => {
      const r = run(script, ...args);
      assert.equal(r.status, 2, `${script} with ${path.relative(proj, p)} symlinked: ${r.stderr}`);
      assert.match(r.stderr, /refusing to write through symlink/);
    });
    assert.deepEqual(snapshot(dst), [], `${path.relative(proj, p)}: nothing written to target`);
  }
  // A symlinked flow directory (the storyboard path goes through it).
  const dst = elsewhere('flowdir');
  fs.cpSync(path.join(flows, 'a'), dst, { recursive: true });
  const before = snapshot(dst);
  withSymlink(path.join(flows, 'a'), dst, () => assert.equal(run('render.mjs', sb).status, 2));
  assert.deepEqual(snapshot(dst), before);
});

test('planted file symlinks (qa.json, capture-report.json, manifest.json) are refused and their targets untouched', { skip }, () => {
  const victim = path.join(tmp, 'victim.txt');
  for (const [script, args, p] of [['qa.mjs', [path.join(flows, 'a')], path.join(flows, 'a', 'qa.json')],
    ['capture.mjs', [path.join(flows, 'a', 'storyboard.json')], path.join(flows, 'a', 'capture-report.json')],
    ['export.mjs', [proj, 'a'], path.join(proj, 'vidgen-export', 'manifest.json')]]) {
    fs.writeFileSync(victim, 'do not overwrite');
    withSymlink(p, victim, () => assert.equal(run(script, ...args).status, 2, script));
    assert.equal(fs.readFileSync(victim, 'utf8'), 'do not overwrite', script);
  }
});

test('vidgen-export as a symlink: export refuses; previous exports preserved', { skip }, () => {
  const out = path.join(proj, 'vidgen-export');
  const before = Object.fromEntries(fs.readdirSync(out).map((f) => [f, sha(path.join(out, f))]));
  const dst = elsewhere('export');
  withSymlink(out, dst, () => {
    const r = run('export.mjs', proj, 'a');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /export refused: refusing to write through symlink vidgen-export/);
  });
  assert.deepEqual(snapshot(dst), []);
  assert.deepEqual(Object.fromEntries(fs.readdirSync(out).map((f) => [f, sha(path.join(out, f))])), before);
});

test('path traversal via scene ids / flow names is refused; files outside the project are never written or deleted', () => {
  // From .vidgen/flows/trav/{audio,captures/<fmt>} five ".." reach the temp dir that holds the project.
  const victims = ['aiff', 'wav', 'png', 'json', 'mp4'].map((e) => path.join(tmp, `victim.${e}`));
  for (const v of victims) fs.writeFileSync(v, 'precious');
  const evil = '../../../../../victim';
  fs.mkdirSync(path.join(flows, 'trav'), { recursive: true });
  const sb = path.join(flows, 'trav', 'storyboard.json');
  fs.writeFileSync(sb, JSON.stringify({ flow: 'trav', baseUrl: `http://localhost:${PORT}`, music: 'none', voiceover: true,
    scenes: [{ id: evil, type: 'capture', route: '/dashboard', narration: 'x', duration: 2 }] }));
  for (const [script, args] of [['voiceover.mjs', [sb]], ['capture.mjs', [sb]], ['render.mjs', [sb]], ['qa.mjs', [path.join(flows, 'trav')]]]) {
    const r = run(script, ...args);
    assert.equal(r.status, 2, `${script}: ${r.stderr}`);
    assert.match(r.stderr, /unsafe scene id/, script);
  }
  for (const bad of ['../../etc', 'a/b', '.hidden', 'a\\b', '']) {
    const r = run('export.mjs', proj, bad);
    assert.equal(r.status, 2, `export ${JSON.stringify(bad)}`);
  }
  assert.match(run('export.mjs', proj, '../x').stderr, /unsafe flow name/);
  for (const v of victims) assert.equal(fs.readFileSync(v, 'utf8'), 'precious', v);
  // Ordinary ids/names still pass (covered by every other suite); spot-check the boundary.
  assert.equal(run('qa.mjs', path.join(flows, 'a')).status, 0);
});

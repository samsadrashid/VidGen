#!/usr/bin/env node
// Portable version of the original smoke demo: one static page, title -> fill -> click -> outro,
// capture + render + QA, then verify 1920x1080 and 1080x1920 outputs. Usage: node tests/smoke.mjs [skillDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skill = path.resolve(process.argv[2] ?? path.join(repo, 'skill'));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen smoke '));
const page = `<html><body style="font-family:sans-serif;background:#f5f5ff;margin:0"><nav style="background:#4F46E5;color:#fff;padding:20px">Demo App</nav><main style="padding:40px"><h1>Welcome</h1><input name=email placeholder=email style="font-size:20px"><button id=go onclick="document.querySelector('h1').textContent='Dashboard'">Go</button></main></body></html>`;
const server = http.createServer((req, res) => res.writeHead(req.url === '/index.html' ? 200 : 404, { 'content-type': 'text/html' }).end(req.url === '/index.html' ? page : 'nope'));
await new Promise((r) => server.listen(0, r));
const flow = path.join(dir, '.vidgen', 'flows', 'demo');
fs.mkdirSync(flow, { recursive: true });
fs.writeFileSync(path.join(flow, 'storyboard.json'), JSON.stringify({
  flow: 'demo', title: 'Demo', baseUrl: `http://localhost:${server.address().port}`, brand: { primary: '#4F46E5', background: '#0B0B12' },
  scenes: [
    { id: 's1', type: 'title', text: 'Meet Demo App', duration: 2 },
    { id: 's2', type: 'capture', route: '/index.html', actions: [{ do: 'fill', selector: 'input[name=email]', value: 'demo@example.com' }], caption: 'Sign in fast', motion: 'zoom-in', transition: 'fade', duration: 3 },
    { id: 's3', type: 'capture', route: '/index.html', actions: [{ do: 'click', selector: '#go' }], caption: 'Your dashboard', motion: 'pan-down', duration: 3 },
    { id: 's4', type: 'outro', text: 'demo.dev', duration: 2 },
  ],
}));
// Async: the fixture server lives in this process, so a blocking spawnSync would starve it.
const step = (script, ...args) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [path.join(skill, 'scripts', script), ...args]);
  let out = '', err = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (err += d));
  p.on('close', (code) => {
    console.log(`${script}: exit ${code}`);
    if (code !== 0) { console.error(out, err); reject(new Error(`${script} failed`)); } else resolve(out);
  });
});
let ok = false;
try {
  await step('capture.mjs', path.join(flow, 'storyboard.json'));
  await step('render.mjs', path.join(flow, 'storyboard.json'));
  const qa = JSON.parse(await step('qa.mjs', flow));
  for (const [fmt, size] of [['landscape', '1920x1080'], ['vertical', '1080x1920']]) {
    const v = JSON.parse(spawnSync(process.env.VIDGEN_FFPROBE || 'ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', path.join(flow, 'out', `${fmt}.mp4`)], { encoding: 'utf8' }).stdout).streams;
    const got = `${v.find((s) => s.codec_type === 'video').width}x${v.find((s) => s.codec_type === 'video').height}`;
    console.log(`${fmt}: ${got} audio=${v.some((s) => s.codec_type === 'audio')} qa=${qa.results[fmt].pass}`);
    if (got !== size || !qa.results[fmt].pass) throw new Error(`${fmt} invalid`);
  }
  ok = qa.pass;
} catch (e) {
  console.error(`SMOKE FAIL: ${e.message}`);
} finally {
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
process.exit(ok ? 0 : 1);

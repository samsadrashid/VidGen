#!/usr/bin/env node
// Start the project's dev server and wait until it really answers. Usage:
//   start.mjs <project> [--command "npm run dev"] [--url http://localhost:3000] [--timeout 120000] [--path /]
// Defaults come from .vidgen/context.json "dev" (framework adapter hints). Prints {"ready":true,"url","pid"} once an
// HTTP request to url+path gets a response < 500, then keeps the server running until Ctrl-C / SIGTERM, when it
// stops the whole process tree. Exit: 1 server exited early, 2 usage, 4 not ready before timeout, 130 interrupted.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { INTERRUPT_SIGNALS } from './platform.mjs';

const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const project = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
if (!project || !fs.existsSync(project)) { console.error('usage: start.mjs <project> [--command CMD] [--url URL] [--timeout MS] [--path /]'); process.exit(2); }
let hint = {};
try { hint = JSON.parse(fs.readFileSync(path.join(project, '.vidgen', 'context.json'), 'utf8')).dev ?? {}; } catch { /* no analysis yet */ }
const command = opt('--command') ?? hint.command;
const url = opt('--url') ?? hint.url;
const timeout = Number(opt('--timeout') ?? 120_000);
if (!command || !url) { console.error('start.mjs: no dev command/url known — pass --command and --url (run context.mjs --scan for framework hints)'); process.exit(2); }

// Own process group on POSIX so the whole tree (npm -> node -> next/vite workers) can be stopped together.
const isWin = process.platform === 'win32';
const child = spawn(command, { cwd: project, shell: true, detached: !isWin, stdio: ['ignore', 'pipe', 'pipe'] });
let tail = '';
const keep = (d) => { tail = (tail + d).slice(-4000); };
child.stdout.on('data', keep);
child.stderr.on('data', keep);
let exited = null;
child.on('exit', (code, sig) => { exited = code ?? sig; });

function stopTree() {
  if (exited !== null) return;
  try {
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
  } catch { /* already gone */ }
}
for (const sig of INTERRUPT_SIGNALS) process.on(sig, () => { stopTree(); process.exit(130); });
process.on('exit', stopTree);

const target = new URL(opt('--path') ?? '/', url).href;
const end = Date.now() + timeout;
for (;;) {
  if (exited !== null) { console.error(`dev server exited (${exited}) before it was ready:\n${tail}`); process.exit(1); }
  try {
    const res = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (res.status < 500) break;
  } catch { /* not listening yet */ }
  if (Date.now() > end) { console.error(`dev server not ready at ${target} within ${timeout / 1000}s:\n${tail}`); stopTree(); process.exit(4); }
  await new Promise((r) => setTimeout(r, 300));
}
console.log(JSON.stringify({ ready: true, url, pid: child.pid, command }));
await new Promise(() => {}); // stay up until interrupted

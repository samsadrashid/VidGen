#!/usr/bin/env node
// VidGen installer (macOS only in v1). install.sh is a thin wrapper around this.
//   node install.mjs                  -> ~/.claude (Claude Code, user-wide)
//   node install.mjs --project DIR    -> DIR/.claude
//   node install.mjs --target DIR     -> DIR/skills/vidgen + DIR/commands (other agents with the same layout)
// Re-runnable: replaces VidGen's own files (keeps installed node_modules), removes VidGen commands that no
// longer exist, never touches unrelated files in the commands dir. Exit 1 on any failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which, FFMPEG, FFPROBE } from './skill/scripts/platform.mjs';

const die = (msg) => { console.error(`ERROR: ${msg}`); process.exit(1); };
const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'skill');
const args = process.argv.slice(2);
let dest = path.join(os.homedir(), '.claude');
if (args[0] === '--project') {
  if (!args[1]) die('--project needs DIR');
  if (!fs.existsSync(args[1]) || !fs.statSync(args[1]).isDirectory()) die(`no such directory: ${args[1]}`);
  dest = path.join(path.resolve(args[1]), '.claude');
} else if (args[0] === '--target') {
  if (!args[1]) die('--target needs DIR');
  dest = path.resolve(args[1]);
} else if (args.length) die(`unknown option: ${args[0]} (use --project DIR or --target DIR)`);
if (fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) die(`target exists and is not a directory: ${dest}`);

// VidGen v1 supports macOS only. (VIDGEN_TEST_PLATFORM lets the test suite exercise this refusal.)
const PLATFORM = process.env.VIDGEN_TEST_PLATFORM || process.platform;
if (PLATFORM !== 'darwin') die(`VidGen v1 supports macOS only (this system: ${PLATFORM}). Linux and Windows are not supported.`);
if (Number(process.versions.node.split('.')[0]) < 20) die(`node >= 20 required (found ${process.versions.node})`);
for (const [bin, env] of [[FFMPEG, 'VIDGEN_FFMPEG'], [FFPROBE, 'VIDGEN_FFPROBE']]) {
  if (spawnSync(bin, ['-version']).error) die(`${path.basename(bin)} not found — install ffmpeg (brew install ffmpeg) or set ${env}`);
}
const npm = which('npm');
if (!npm) die('npm not found on PATH (it ships with Node.js)');

const skill = path.join(dest, 'skills', 'vidgen');
const commands = path.join(dest, 'commands');
try {
  fs.mkdirSync(skill, { recursive: true });
  fs.mkdirSync(commands, { recursive: true });
} catch (e) { die(`cannot create ${dest}: ${e.code}`); }

// 1. Skill dir is VidGen-owned: replace everything except node_modules.
for (const e of fs.readdirSync(skill)) if (e !== 'node_modules') fs.rmSync(path.join(skill, e), { recursive: true, force: true });
fs.cpSync(SRC, skill, { recursive: true, filter: (p) => !/(^|[\\/])(node_modules|\.vidgen)([\\/]|$)/.test(path.relative(SRC, p)) });
const fill = (text) => text.split('SKILL_DIR').join(skill); // literal replace: paths may contain $, &, #, spaces, quotes
for (const f of ['SKILL.md', ...fs.readdirSync(path.join(skill, 'commands')).map((c) => path.join('commands', c))]) {
  const p = path.join(skill, f);
  fs.writeFileSync(p, fill(fs.readFileSync(p, 'utf8')));
}

// 2. Commands dir is shared: only touch files VidGen installed (tracked in a manifest).
const manifestPath = path.join(commands, '.vidgen-commands.json');
let previous = [];
try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first install */ }
const current = fs.readdirSync(path.join(SRC, 'commands')).filter((f) => f.endsWith('.md'));
for (const old of previous) if (!current.includes(old) && /^[\w.-]+\.md$/.test(old)) fs.rmSync(path.join(commands, old), { force: true });
for (const f of current) fs.writeFileSync(path.join(commands, f), fill(fs.readFileSync(path.join(SRC, 'commands', f), 'utf8')));
fs.writeFileSync(manifestPath, JSON.stringify(current, null, 2));

// 3. Dependencies. npm is a .cmd on Windows, which needs a shell; the Playwright CLI is run via node directly.
const shell = process.platform === 'win32';
const q = (s) => (shell ? `"${s}"` : s);
let r = spawnSync(q(npm), ['install', '--no-fund', '--no-audit', '--loglevel=error'], { cwd: skill, stdio: 'inherit', shell });
if (r.status !== 0) die(`npm install failed (exit ${r.status ?? r.error?.code}). Skill files are in ${skill}; fix network/npm and re-run.`);
r = spawnSync(process.execPath, [path.join(skill, 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium'], { cwd: skill, stdio: ['ignore', 'ignore', 'inherit'] });
if (r.status !== 0) die(`playwright browser install failed (exit ${r.status}). On Linux you may need: npx playwright install --with-deps chromium`);
r = spawnSync(process.execPath, [path.join(skill, 'scripts', 'doctor.mjs')], { cwd: skill, encoding: 'utf8' });
if (r.status !== 0) die(`environment check failed:\n${r.stdout}`);

console.log(`VidGen installed -> ${skill}`);
console.log('Commands: /video-analyze /video-plan /video-create /video-review /video-export /video-multipleflow');
console.log(`Natural voice (optional, ~340 MB, offline): sh ${path.join(skill, 'scripts', 'setup-kokoro.sh')}`);

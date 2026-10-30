#!/usr/bin/env node
// Final export of one or more flows, plus an optional combined video.
// Usage: export.mjs <project> <flow...> [--combined] [--no-render]
//   Re-renders each flow with --final, QAs the exported files, writes vidgen-export/manifest.json.
//   --combined concatenates flows IN THE ORDER GIVEN into combined-1920x1080.mp4 / combined-1080x1920.mp4.
//   All-or-nothing: outputs are staged and promoted only if every flow (and the combined video) passes.
//   On any failure or interrupt, vidgen-export/ is left exactly as it was. Exit 1 on failure, 130 on interrupt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { FFMPEG, FFPROBE, relPosix, explainSpawnError, INTERRUPT_SIGNALS, assertNoSymlinks, assertSafeNames } from './platform.mjs';
import { SPEC, checkVideo, checkCaptures, checkRender, checkCombined, expectsAudio, checkNarration } from './qa.mjs';

const args = process.argv.slice(2);
const project = path.resolve(args[0] ?? '');
const flows = args.slice(1).filter((a) => !a.startsWith('--'));
const combined = args.includes('--combined');
const noRender = args.includes('--no-render');
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(project, 'vidgen-export');
const staging = path.join(outDir, `.staging-${process.pid}`);
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const name = (fmt) => SPEC[fmt].join('x');
if (!args[0] || !flows.length) { console.error('usage: export.mjs <project> <flow...> [--combined] [--no-render]'); process.exit(2); }
try {
  assertSafeNames(flows, 'flow name');
  // Promotion renames onto existing names (rename replaces a link, never follows it), but staging, the manifest
  // write and the export dir itself would follow symlinks.
  assertNoSymlinks(project, [staging, path.join(outDir, 'manifest.json'),
    ...flows.flatMap((f) => ['1920x1080', '1080x1920'].map((s) => path.join(outDir, `${f}-${s}.mp4`))), path.join(outDir, 'combined-1920x1080.mp4'), path.join(outDir, 'combined-1080x1920.mp4')]);
} catch (e) { console.error(`export refused: ${e.message}`); process.exit(2); }
for (const bin of [FFMPEG, FFPROBE]) {
  const r = spawnSync(bin, ['-version']);
  if (r.error) { console.error(`export failed: ${explainSpawnError(r.error, bin) ?? r.error.message}`); process.exit(1); }
}

// Children run async so interrupts are handled; a signal stops the child (render cleans its own tmp) and drops staging.
let child;
let interrupted = false;
const run = (bin, argv, opts) => new Promise((resolve, reject) => {
  child = spawn(bin, argv, { stdio: ['ignore', 2, 2], ...opts }); // keep stdout clean JSON
  child.on('error', (e) => reject(new Error(explainSpawnError(e, bin) ?? e.message)));
  child.on('close', (code, sig) => { child = null; code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code ?? sig}`)); });
});
const dropStaging = () => fs.rmSync(staging, { recursive: true, force: true });
for (const sig of INTERRUPT_SIGNALS) process.on(sig, () => {
  interrupted = true;
  if (child) child.kill(sig === 'SIGBREAK' ? undefined : sig);
  const done = () => { dropStaging(); console.error(`export interrupted (${sig}); vidgen-export/ untouched`); process.exit(130); };
  child ? child.once('close', done) : done();
});

fs.mkdirSync(staging, { recursive: true });
const manifest = { exportedAt: new Date().toISOString(), flows: [], failed: [], combined: null };
for (const flow of flows) {
  if (interrupted) break;
  const flowDir = path.join(project, '.vidgen', 'flows', flow);
  const sbPath = path.join(flowDir, 'storyboard.json');
  try {
    if (!fs.existsSync(sbPath)) throw new Error('no storyboard');
    const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
    const capIssues = checkCaptures(flowDir, sb).issues;
    if (capIssues.length) throw new Error(capIssues.join('; '));
    if (!noRender) await run(process.execPath, [path.join(here, 'render.mjs'), sbPath, '--final']).catch((e) => { throw new Error(`final render failed (${e.message})`); });
    const expected = sb.scenes.reduce((a, s) => a + Number(s.duration ?? 3), 0);
    const entry = { flow, title: sb.title, duration: expected, files: {}, scenes: {} };
    for (const [fmt, [W, H]] of Object.entries(SPEC)) {
      const renderIssues = checkRender(flowDir, sb, fmt);
      if (renderIssues.length) throw new Error(renderIssues.join('; '));
      entry.scenes[fmt] = JSON.parse(fs.readFileSync(path.join(flowDir, 'out', `${fmt}.render.json`), 'utf8')).scenes;
      const staged = path.join(staging, `${flow}-${name(fmt)}.mp4`);
      fs.copyFileSync(path.join(flowDir, 'out', `${fmt}.mp4`), staged);
      const qa = checkVideo(staged, { W, H, expected, expectAudio: expectsAudio(flowDir, sb) });
      qa.issues.push(...checkNarration(staged, flowDir, sb, entry.scenes[fmt]).issues);
      if (qa.issues.length) throw new Error(`${fmt} QA: ${qa.issues.join('; ')}`);
      entry.files[fmt] = { path: relPosix(project, path.join(outDir, path.basename(staged))), sha256: sha(staged), audio: qa.audio };
    }
    manifest.flows.push(entry);
  } catch (e) {
    if (interrupted) break;
    manifest.failed.push({ flow, reason: e.message });
  }
}

if (!interrupted && combined && manifest.failed.length) {
  manifest.combined = { skipped: `flows failed: ${manifest.failed.map((f) => f.flow).join(', ')}` };
} else if (!interrupted && combined) {
  manifest.combined = { order: flows, files: {} };
  for (const [fmt, [W, H]] of Object.entries(SPEC)) {
    const inputs = manifest.flows.map((e) => path.join(staging, path.basename(e.files[fmt].path)));
    // Audio-less flows get silence so the concat stays in sync.
    const pre = [];
    const ff = [];
    inputs.forEach((f, i) => {
      ff.push('-i', f);
      pre.push(manifest.flows[i].files[fmt].audio ? `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[a${i}]` : `anullsrc=r=48000:cl=stereo,atrim=0:${manifest.flows[i].duration}[a${i}]`);
    });
    const filter = pre.join(';') + ';' + inputs.map((_, i) => `[${i}:v][a${i}]`).join('') + `concat=n=${inputs.length}:v=1:a=1[v][a]`;
    const staged = path.join(staging, `combined-${name(fmt)}.mp4`);
    try {
      await run(FFMPEG, ['-y', '-loglevel', 'error', ...ff, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-profile:v', 'high', '-crf', '18', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', staged]);
    } catch (e) {
      if (interrupted) break;
      manifest.combined = { failed: `${fmt}: ${e.message}` };
      break;
    }
    const expected = manifest.flows.reduce((a, e) => a + e.duration, 0);
    const qa = checkVideo(staged, { W, H, expected, expectAudio: manifest.flows.some((e) => e.files[fmt].audio) });
    qa.issues.push(...checkCombined(staged, manifest.flows.map((e) => ({ flow: e.flow, duration: e.duration, scenes: e.scenes[fmt] }))));
    if (qa.issues.length) { manifest.combined = { failed: `${fmt} QA: ${qa.issues.join('; ')}` }; break; }
    manifest.combined.files[fmt] = { path: relPosix(project, path.join(outDir, path.basename(staged))), sha256: sha(staged), duration: qa.duration };
  }
}
if (interrupted) await new Promise(() => {}); // the signal handler exits 130

for (const e of manifest.flows) delete e.scenes; // fingerprints are internal
const ok = !manifest.failed.length && !manifest.combined?.failed && !manifest.combined?.skipped;
if (ok) {
  for (const f of fs.readdirSync(staging)) fs.renameSync(path.join(staging, f), path.join(outDir, f));
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
}
dropStaging();
console.log(JSON.stringify(manifest, null, 2));
if (!ok) console.error('export failed — vidgen-export/ left unchanged (previous exports kept)');
process.exit(ok ? 0 : 1);

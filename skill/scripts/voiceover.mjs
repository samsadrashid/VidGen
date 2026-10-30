#!/usr/bin/env node
// Local TTS per scene narration -> flowDir/audio/<sceneId>.(aiff|wav) + audio/voiceover.json. No network.
// Usage: voiceover.mjs <storyboard.json>
// Engines: macOS `say` (default on macOS), `espeak-ng`, `espeak`; or "tts": "kokoro" for local neural voices
// (Kokoro-82M via kokoro-onnx; needs VIDGEN_KOKORO_DIR with venv/, kokoro-v1.0.onnx, voices-v1.0.bin — see README).
// VIDGEN_TTS=<engine> forces one. storyboard: voiceover (true to generate), voice (engine voice name),
// voiceRate (say/espeak words per minute, 90–360), voiceSpeed (kokoro, 0.5–2).
// voiceover true + no engine / unknown voice / failed or silent synthesis / narration longer than its scene -> exit 1,
// and the previous audio/ is left exactly as it was. voiceover not true -> nothing to do (exit 0).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { which, assertNoSymlinks, outputBase, assertSafeNames, FFMPEG, FFPROBE, INTERRUPT_SIGNALS } from './platform.mjs';
import { AUDIO_EXTS, MANIFEST, lineKey, readManifest } from './narration.mjs';

const sbPath = path.resolve(process.argv[2]);
const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
const flowDir = path.dirname(sbPath);
const dir = path.join(flowDir, 'audio');
const staging = path.join(dir, `.staging-${process.pid}`);
try {
  assertSafeNames((sb.scenes ?? []).map((s) => s.id), 'scene id');
  assertNoSymlinks(outputBase(flowDir), [dir, staging, path.join(dir, MANIFEST), ...(sb.scenes ?? []).flatMap((s) => AUDIO_EXTS.map((e) => path.join(dir, `${s.id}.${e}`)))]);
} catch (e) { console.error(`voiceover refused: ${e.message}`); process.exit(2); }
if (sb.voiceover !== true) { console.log(JSON.stringify({ skipped: sb.voiceover === false ? 'voiceover disabled (music-only)' : 'voiceover not requested' })); process.exit(0); }
const fail = (msg) => { fs.rmSync(staging, { recursive: true, force: true }); console.error(`voiceover failed: ${msg}`); process.exit(1); };
for (const sig of INTERRUPT_SIGNALS) process.on(sig, () => { fs.rmSync(staging, { recursive: true, force: true }); console.error(`voiceover interrupted (${sig}); audio/ untouched`); process.exit(130); });

const ENGINES = ['say', 'espeak-ng', 'espeak'];
const forced = process.env.VIDGEN_TTS ?? sb.tts;
if (forced && ![...ENGINES, 'kokoro'].includes(forced)) fail(`TTS engine ${forced} is not one of ${[...ENGINES, 'kokoro'].join(', ')}`);
// Kokoro: a local Python venv + model files. Nothing is downloaded at run time.
// Lookup: VIDGEN_KOKORO_DIR, then a repo-checkout .tts/, then ~/.vidgen/kokoro (where setup-kokoro.sh installs).
const REPO_TTS = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '.tts');
const KDIR = process.env.VIDGEN_KOKORO_DIR || (fs.existsSync(path.join(REPO_TTS, 'kokoro-v1.0.onnx')) ? REPO_TTS : path.join(os.homedir(), '.vidgen', 'kokoro'));
const KPY = path.join(KDIR, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const KARGS = [path.join(path.dirname(new URL(import.meta.url).pathname), 'kokoro-tts.py'), '--model', path.join(KDIR, 'kokoro-v1.0.onnx'), '--voices', path.join(KDIR, 'voices-v1.0.bin')];
if (forced === 'kokoro') {
  const missing = [KPY, KARGS[2], KARGS[4]].filter((f) => !fs.existsSync(f));
  if (missing.length) fail(`storyboard requests "tts": "kokoro" but it is not installed (missing ${missing.map((f) => path.relative(KDIR, f)).join(', ')} in ${KDIR}).\n` +
    '  Install it once with `sh <VidGen>/skill/scripts/setup-kokoro.sh` (~340 MB), set VIDGEN_KOKORO_DIR, or drop "tts" to use the built-in engine.');
}
const engine = forced === 'kokoro' ? 'kokoro' : forced ? (which(forced) ? forced : null) : ENGINES.find((b) => which(b));
if (!engine) {
  fail(`storyboard requests voiceover but no local TTS engine was found (${forced ?? ENGINES.join(' / ')} not on PATH).\n` +
    '  macOS: `say` ships with the OS at /usr/bin/say — make sure /usr/bin is on PATH.\n' +
    '  Linux: install espeak-ng (e.g. `sudo apt-get install espeak-ng`).\n' +
    '  Or set "voiceover": false in the storyboard for a music-only video. Run doctor.mjs to re-check.');
}
for (const bin of [FFMPEG, FFPROBE]) if (spawnSync(bin, ['-version']).error) fail(`${bin} not found — needed to validate narration audio`);

// `say -v <unknown>` silently falls back to the default voice, so check the name against the installed list.
if (sb.voice != null && engine === 'kokoro') {
  const r = spawnSync(KPY, [...KARGS, '--list'], { encoding: 'utf8' });
  const names = (r.stdout ?? '').split('\n').filter(Boolean);
  if (r.status !== 0) fail(`kokoro failed to start: ${(r.stderr ?? '').trim().split('\n').pop()}`);
  if (!names.includes(sb.voice)) fail(`voice ${JSON.stringify(sb.voice)} is not a Kokoro voice. Some available: ${names.filter((n) => /^[ab][fm]_/.test(n)).slice(0, 10).join(', ')}`);
} else if (sb.voice != null) {
  const list = engine === 'say' ? spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout ?? ''
    : spawnSync(engine, ['--voices'], { encoding: 'utf8' }).stdout ?? '';
  const names = engine === 'say'
    ? list.split('\n').map((l) => l.match(/^(.+?)\s+[a-z]{2,3}_[A-Za-z0-9]+\s+#/)?.[1]?.trim()).filter(Boolean)
    : list.split('\n').slice(1).flatMap((l) => l.trim().split(/\s+/).slice(3, 5)).filter(Boolean);
  if (typeof sb.voice !== 'string' || !names.includes(sb.voice)) {
    fail(`voice ${JSON.stringify(sb.voice)} is not installed for ${engine}. ` +
      (engine === 'say' ? 'List voices with `say -v ?` (more in System Settings → Accessibility → Spoken Content). ' : `List voices with \`${engine} --voices\`. `) +
      `Some installed: ${names.slice(0, 8).join(', ')}`);
  }
}
const rate = sb.voiceRate;
if (rate != null && !(Number.isFinite(rate) && rate >= 90 && rate <= 360)) fail(`voiceRate must be 90–360 words per minute, got ${JSON.stringify(rate)}`);
const speed = sb.voiceSpeed;
if (speed != null && !(Number.isFinite(speed) && speed >= 0.5 && speed <= 2)) fail(`voiceSpeed must be 0.5–2, got ${JSON.stringify(speed)}`);

const probe = (f) => {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' });
  return r.status === 0 ? Number(r.stdout) : NaN;
};
const meanDb = (f) => Number(spawnSync(FFMPEG, ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+) dB/)?.[1] ?? -Infinity);
const NARRATION_DB = -18; // target mean level of each narration line
// Broadcast-style voice polish (storyboard.voicePolish, default on): trim dead air before the first word and leave a
// 120 ms breath, resample to 48 kHz, remove rumble, cut boxiness (~250 Hz), lift presence (~3.5 kHz) and air,
// de-ess, and gently compress for an even level. Leveling (below) runs after it.
const POLISH = 'silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.02,adelay=120:all=1,' +
  'aresample=48000:filter_size=64:phase_shift=10:cutoff=0.97,highpass=f=75,equalizer=f=250:t=q:w=1.1:g=-2,' +
  'equalizer=f=3500:t=q:w=1.3:g=2.5,treble=g=1.5:f=9500,deesser=i=0.35:m=0.5:f=0.55,' +
  'acompressor=threshold=-21dB:ratio=2.5:attack=8:release=140:makeup=1.6:knee=4';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

fs.mkdirSync(staging, { recursive: true });
const ext = engine === 'say' ? 'aiff' : 'wav'; // kokoro and espeak write WAV
const scenes = {};
const problems = [];
for (const s of sb.scenes.filter((s) => s.narration)) {
  if (typeof s.narration !== 'string' || !s.narration.trim()) { problems.push(`scene ${s.id}: narration must be non-empty text`); continue; }
  const out = path.join(staging, `${s.id}.${ext}`);
  const [bin, args] = engine === 'kokoro'
    ? [KPY, [...KARGS, '--voice', sb.voice ?? 'af_heart', '--speed', String(speed ?? 1), '--out', out, '--', s.narration]]
    : engine === 'say'
      ? [engine, [...(sb.voice ? ['-v', sb.voice] : []), ...(rate ? ['-r', String(rate)] : []), '-o', out, '--', s.narration]]
      : [engine, [...(sb.voice ? ['-v', sb.voice] : []), ...(rate ? ['-s', String(rate)] : []), '-w', out, '--', s.narration]];
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 120_000 });
  if (r.error || r.status !== 0) { problems.push(`scene ${s.id}: ${engine} failed (${r.error?.message ?? `exit ${r.status}`}) ${(r.stderr ?? '').trim()}`.trim()); continue; }
  let dur = fs.existsSync(out) ? probe(out) : NaN;
  if (!(dur > 0.1)) { problems.push(`scene ${s.id}: ${engine} produced no readable audio`); continue; }
  let db = meanDb(out);
  if (!(db > -50)) { problems.push(`scene ${s.id}: synthesized audio is silent (mean ${db} dB)`); continue; }
  if (sb.voicePolish !== false) {
    const pol = out.replace(/(\.\w+)$/, '.pol$1');
    const pr = spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', out, '-af', POLISH, pol], { encoding: 'utf8' });
    if (pr.status !== 0) { problems.push(`scene ${s.id}: voice polish failed (${pr.stderr.trim()})`); continue; }
    fs.renameSync(pol, out);
    dur = probe(out);
    db = meanDb(out);
  }
  // Level every line to the same loudness (engines differ by ~7 dB), never pushing peaks above -1 dBFS.
  const maxDb = Number(spawnSync(FFMPEG, ['-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/max_volume: (-?[\d.]+) dB/)?.[1] ?? 0);
  const gain = Math.min(NARRATION_DB - db, -1 - maxDb);
  if (Math.abs(gain) >= 0.5) {
    const lv = out.replace(/(\.\w+)$/, '.lv$1');
    const g = spawnSync(FFMPEG, ['-v', 'error', '-y', '-i', out, '-af', `volume=${gain.toFixed(2)}dB`, lv], { encoding: 'utf8' });
    if (g.status !== 0) { problems.push(`scene ${s.id}: could not level audio (${g.stderr.trim()})`); continue; }
    fs.renameSync(lv, out);
  }
  const sceneDur = Number(s.duration ?? 3);
  if (dur > sceneDur) problems.push(`scene ${s.id}: narration lasts ${dur.toFixed(2)}s but the scene is ${sceneDur}s — set "duration": ${Math.ceil(dur * 2) / 2} or shorten the line`);
  scenes[s.id] = { file: path.basename(out), key: lineKey(sb, s), sha256: sha(out), duration: +dur.toFixed(3) };
}
if (problems.length) fail(`\n  ${problems.join('\n  ')}\n  previous narration in audio/ left unchanged`);

// Promote: drop every old file for narrated scenes and every previously generated file, then move the new set in.
const old = readManifest(flowDir)?.scenes ?? {};
for (const [id, g] of Object.entries(old)) fs.rmSync(path.join(dir, g.file), { force: true });
for (const id of Object.keys(scenes)) for (const e of AUDIO_EXTS) fs.rmSync(path.join(dir, `${id}.${e}`), { force: true });
for (const [id, g] of Object.entries(scenes)) fs.renameSync(path.join(staging, g.file), path.join(dir, g.file));
fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify({ engine, voice: sb.voice ?? (engine === 'kokoro' ? 'af_heart' : null), voiceRate: rate ?? null, voiceSpeed: speed ?? null, generatedAt: new Date().toISOString(), scenes }, null, 2));
fs.rmSync(staging, { recursive: true, force: true });
console.log(JSON.stringify({ engine, voice: sb.voice ?? 'default', files: Object.keys(scenes).length, scenes: Object.fromEntries(Object.entries(scenes).map(([id, g]) => [id, g.duration])) }));

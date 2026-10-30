#!/usr/bin/env node
// Audio mix: narration over a real music file with smooth ducking + recovery, fades, peak limiter, exact duration,
// music-only, and failure cases that must leave previous outputs untouched. Usage: node --test tests/audio-mix.test.mjs
// Music: tests/fixture/audio/music-bed.m4a (synthetic, loud, steady 55 Hz bass). Speech has almost no energy below
// 90 Hz, so a low-pass of the final mix measures the music bed level even while someone is talking.
// Narration is real macOS `say` (or espeak-ng); those tests SKIP without a TTS engine. Failure tests always run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which, FFMPEG, FFPROBE } from '../skill/scripts/platform.mjs';
import { similarity } from '../skill/scripts/qa.mjs';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const K = path.join(repo, 'skill', 'scripts');
const MUSIC = path.join(repo, 'tests', 'fixture', 'audio', 'music-bed.m4a');
const noTts = !['say', 'espeak-ng', 'espeak'].some((b) => which(b)) && 'no local TTS engine installed';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-mix-'));
const proj = path.join(tmp, 'proj');
const flows = path.join(proj, '.vidgen', 'flows');
const PORT = 8500 + Math.floor(Math.random() * 300);
let server;

const run = (script, ...args) => spawnSync(process.execPath, [path.join(K, script), ...args], { encoding: 'utf8' });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tree = (d) => Object.fromEntries(fs.readdirSync(d).filter((f) => !f.startsWith('.')).sort().map((f) => [f, sha(path.join(d, f))]));
const probe = (f) => JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' }).stdout);
const pcm = (f, af = 'anull', start, len) => {
  const b = spawnSync(FFMPEG, ['-v', 'error', ...(start != null ? ['-ss', String(start), '-t', String(len)] : []), '-i', f, '-vn', '-af', af, '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }).stdout;
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};
const db = (a) => 10 * Math.log10(a.reduce((x, v) => x + v * v, 0) / Math.max(1, a.length) + 1e-12);
const BASS = 'lowpass=f=90,lowpass=f=90';
const SPEECH = 'highpass=f=300,highpass=f=300,lowpass=f=3400';
const bass = (f, s, l) => db(pcm(f, BASS, s, l));
const maxDb = (f) => Number(spawnSync(FFMPEG, ['-i', f, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/max_volume: (-?[\d.]+) dB/)[1]);

// 18 s: music-only title, two narrated scenes with long pauses after the line, music-only outro.
const SCENES = [
  { id: 'intro', type: 'title', text: 'Welcome', duration: 3 },
  { id: 'dash', type: 'capture', route: '/dashboard', caption: 'Live metrics', narration: 'Your metrics update live.', duration: 6 },
  { id: 'set', type: 'capture', route: '/settings', caption: 'Make it yours', narration: 'Change any setting in one click.', duration: 6 },
  { id: 'outro', type: 'outro', text: 'Try it today', duration: 3 },
];
const TOTAL = 18;
const sbPath = (flow) => path.join(flows, flow, 'storyboard.json');
function storyboard(flow, extra = {}) {
  fs.mkdirSync(path.join(flows, flow), { recursive: true });
  fs.copyFileSync(MUSIC, path.join(flows, flow, 'bed.m4a'));
  fs.writeFileSync(sbPath(flow), JSON.stringify({ flow, title: flow, baseUrl: `http://localhost:${PORT}`, music: 'bed.m4a', voiceover: true, scenes: SCENES, ...extra }));
  return sbPath(flow);
}
const edit = (p, fn) => { const sb = JSON.parse(fs.readFileSync(p, 'utf8')); fn(sb); fs.writeFileSync(p, JSON.stringify(sb)); };
const narrDur = (flow, id) => JSON.parse(fs.readFileSync(path.join(flows, flow, 'audio', 'voiceover.json'), 'utf8')).scenes[id].duration;
const log = (...a) => console.log('evidence', ...a);

before(async () => {
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((r) => server.stdout.once('data', r));
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('music fixture is a real, loud, decodable music file', () => {
  const p = probe(MUSIC);
  assert.equal(p.streams[0].codec_name, 'aac');
  assert.ok(Number(p.format.duration) >= 20);
  assert.ok(maxDb(MUSIC) > -3, 'mastered loud (stresses the limiter)');
});

test('narration over music: ducks smoothly under speech, recovers in pauses, fades, no clipping, exact duration (both formats)', { skip: noTts }, () => {
  const sb = storyboard('mix');
  assert.equal(run('voiceover.mjs', sb).status, 0);
  assert.equal(run('capture.mjs', sb).status, 0);
  const r = run('render.mjs', sb);
  assert.equal(r.status, 0, r.stderr);
  const q = JSON.parse(run('qa.mjs', path.join(flows, 'mix')).stdout);
  assert.equal(q.pass, true, JSON.stringify(q.results.landscape.issues));
  const dDash = narrDur('mix', 'dash'), dSet = narrDur('mix', 'set');
  for (const fmt of ['landscape', 'vertical']) {
    const f = path.join(flows, 'mix', 'out', `${fmt}.mp4`);
    const p = probe(f);
    const a = p.streams.find((s) => s.codec_type === 'audio');
    const v = p.streams.find((s) => s.codec_type === 'video');
    assert.ok(Math.abs(Number(a.duration) - TOTAL) < 0.05 && Math.abs(Number(v.duration) - TOTAL) < 0.05, `${fmt} durations ${a.duration}/${v.duration}`);
    // Music bed level (55 Hz band) at each phase.
    const full = bass(f, 1.5, 1.3);                       // intro, after fade-in, no speech
    const ducked = bass(f, 3 + 0.35, dDash - 0.45);       // under the dash line (after attack)
    const recovered = bass(f, 3 + dDash + 1.0, 1.5);      // pause after the line (after release)
    const ducked2 = bass(f, 9 + 0.35, dSet - 0.45);
    const recovered2 = bass(f, 9 + dSet + 1.0, 1.5);
    log(`${fmt} bed full ${full.toFixed(1)} dB, under speech ${ducked.toFixed(1)} / ${ducked2.toFixed(1)}, pause ${recovered.toFixed(1)} / ${recovered2.toFixed(1)}`);
    assert.ok(Math.abs(full - ducked - 15) < 2.5, `${fmt}: ducked by ~15 dB (got ${(full - ducked).toFixed(1)})`);
    assert.ok(Math.abs(full - ducked2 - 15) < 2.5, `${fmt}: second line ducked by ~15 dB (got ${(full - ducked2).toFixed(1)})`);
    assert.ok(Math.abs(full - recovered) < 1.5, `${fmt}: music recovers in the pause (${(full - recovered).toFixed(1)} dB below full)`);
    assert.ok(Math.abs(full - recovered2) < 1.5, `${fmt}: recovers after second line`);
    assert.ok(recovered > -40, `${fmt}: music still audible in pauses (${recovered.toFixed(1)} dB)`);
    // Smooth: the 55 Hz envelope (50 ms steps) never jumps more than 3 dB between steps around duck and release.
    for (const [s0, label] of [[3 - 0.7, 'attack'], [3 + dDash - 0.2, 'release']]) {
      const x = pcm(f, BASS, s0, 1.6);
      const steps = [];
      for (let i = 0; i + 400 <= x.length; i += 400) steps.push(db(x.subarray(i, i + 400)));
      const jump = Math.max(...steps.slice(1).map((s, i) => Math.abs(s - steps[i])));
      log(`${fmt} ${label} max step ${jump.toFixed(2)} dB / 50 ms, range ${(Math.max(...steps) - Math.min(...steps)).toFixed(1)} dB`);
      assert.ok(jump < 3, `${fmt} ${label}: abrupt change ${jump.toFixed(2)} dB`);
      assert.ok(Math.max(...steps) - Math.min(...steps) > 10, `${fmt} ${label}: the ramp actually happens`);
    }
    // Fades: silent-ish at the very start and end, rising/falling in between.
    const start = bass(f, 0, 0.1), mid = bass(f, 0.45, 0.1), end = bass(f, TOTAL - 0.1, 0.1);
    log(`${fmt} fade-in ${start.toFixed(1)} → ${mid.toFixed(1)} → ${full.toFixed(1)} dB, last 0.1 s ${end.toFixed(1)} dB`);
    assert.ok(full - start > 20 && start < mid && mid < full, `${fmt}: fade-in`);
    assert.ok(full - end > 20, `${fmt}: fade-out`);
    // Speech in the foreground: speech band under the line vs the music's own speech-band level ducked.
    const speechDb = db(pcm(f, SPEECH, 3.1, dDash - 0.2));
    const pauseBand = db(pcm(f, SPEECH, 3 + dDash + 1.0, 1.5));
    log(`${fmt} speech band ${speechDb.toFixed(1)} dB under the line vs ${pauseBand.toFixed(1)} dB music in the pause (music during speech ≈ ${(pauseBand - 15).toFixed(1)} dB)`);
    assert.ok(speechDb - (pauseBand - 15) >= 10, `${fmt}: speech ≥ 10 dB above the ducked bed`);
    // Sync: each line is found at its scene start and not before it.
    for (const [id, s0, d] of [['dash', 3, dDash], ['set', 9, dSet]]) {
      const ref = pcm(path.join(flows, 'mix', 'audio', `${id}.${which('say') ? 'aiff' : 'wav'}`));
      const here = similarity(pcm(f, 'anull', s0, d + 0.1), ref);
      const early = similarity(pcm(f, 'anull', s0 - 1, d + 0.1), ref, 200);
      log(`${fmt} ${id} match at ${s0}s ${here.toFixed(3)}, 1 s early ${early.toFixed(3)}`);
      assert.ok(here > 0.8 && early < 0.5, `${fmt} ${id} sync`);
    }
    const peak = maxDb(f);
    log(`${fmt} peak ${peak} dB`);
    assert.ok(peak <= -0.5, `${fmt}: peak ${peak} dB`);
  }
});

test('limiter: music at full level with no ducking + speech never clips', { skip: noTts }, () => {
  const sb = storyboard('loud', { audio: { musicVolume: 1, duckDb: 0 } });
  assert.equal(run('voiceover.mjs', sb).status, 0);
  assert.equal(run('capture.mjs', sb).status, 0);
  assert.equal(run('render.mjs', sb).status, 0);
  // Without a limiter the raw sum of bed + voice would exceed full scale here.
  const rawPeak = (() => {
    const m = pcm(MUSIC, 'anull', 3, 2), v = pcm(path.join(flows, 'loud', 'audio', `dash.${which('say') ? 'aiff' : 'wav'}`));
    let p = 0; for (let i = 0; i < Math.min(m.length, v.length); i++) p = Math.max(p, Math.abs(m[i] + v[i])); return 20 * Math.log10(p);
  })();
  for (const fmt of ['landscape', 'vertical']) {
    const peak = maxDb(path.join(flows, 'loud', 'out', `${fmt}.mp4`));
    log(`limiter ${fmt}: unlimited sum would peak ≈ ${rawPeak.toFixed(1)} dBFS (mono 8 kHz estimate); output peak ${peak} dB`);
    assert.ok(peak <= -0.5, `${fmt} peak ${peak}`);
    assert.equal(JSON.parse(run('qa.mjs', path.join(flows, 'loud')).stdout).results[fmt].issues.filter((i) => /clipping/.test(i)).length, 0);
  }
});

test('music-only (voiceover: false): no ducking, no narration, same duration', { skip: noTts }, () => {
  const sb = sbPath('mix');
  edit(sb, (s) => { s.voiceover = false; });
  assert.equal(run('render.mjs', sb).status, 0);
  for (const fmt of ['landscape', 'vertical']) {
    const f = path.join(flows, 'mix', 'out', `${fmt}.mp4`);
    const full = bass(f, 1.5, 1.3), during = bass(f, 3.35, 1.2);
    const m = similarity(pcm(f, 'anull', 3, 2), pcm(path.join(flows, 'mix', 'audio', `dash.${which('say') ? 'aiff' : 'wav'}`)));
    log(`music-only ${fmt}: bed ${full.toFixed(1)} vs ${during.toFixed(1)} dB where the line would be; narration match ${m.toFixed(3)}`);
    assert.ok(Math.abs(full - during) < 1.5, 'no ducking without narration');
    assert.ok(m < 0.2, 'narration absent');
    assert.ok(Math.abs(Number(probe(f).format.duration) - TOTAL) < 0.05);
  }
  assert.equal(JSON.parse(run('qa.mjs', path.join(flows, 'mix')).stdout).pass, true);
  edit(sb, (s) => { s.voiceover = true; });
});

test('failures (corrupt music, corrupt narration, bad settings, stale narration) exit 1 and leave out/ and exports untouched', () => {
  // Uses hand-made narration so it runs without TTS.
  const sb = storyboard('fail', { voiceover: undefined, scenes: SCENES.map(({ narration, ...s }) => s) });
  const dir = path.join(flows, 'fail');
  fs.mkdirSync(path.join(dir, 'audio'), { recursive: true });
  spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=700:d=1.5', path.join(dir, 'audio', 'dash.wav')]);
  assert.equal(run('capture.mjs', sb).status, 0);
  assert.equal(run('render.mjs', sb).status, 0);
  assert.equal(run('export.mjs', proj, 'fail').status, 0);
  const out = tree(path.join(dir, 'out'));
  const exp = tree(path.join(proj, 'vidgen-export'));
  const cases = [
    ['corrupt music', () => fs.writeFileSync(path.join(dir, 'bed.m4a'), crypto.randomBytes(4096)), /music audio is unreadable|music audio fails to decode/, () => fs.copyFileSync(MUSIC, path.join(dir, 'bed.m4a'))],
    ['truncated music', () => fs.writeFileSync(path.join(dir, 'bed.m4a'), fs.readFileSync(MUSIC).subarray(0, 60000)), /music audio (is unreadable|fails to decode)/, () => fs.copyFileSync(MUSIC, path.join(dir, 'bed.m4a'))],
    ['corrupt narration', () => fs.writeFileSync(path.join(dir, 'audio', 'dash.wav'), 'RIFF....not audio'), /narration for scene dash audio is unreadable/, () => spawnSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=f=700:d=1.5', path.join(dir, 'audio', 'dash.wav')])],
    ['bad duckDb', () => edit(sb, (s) => { s.audio = { duckDb: 100 }; }), /audio\.duckDb must be a number 0–40/, () => edit(sb, (s) => { delete s.audio; })],
    ['unknown setting', () => edit(sb, (s) => { s.audio = { musicVolum: 0.5 }; }), /audio\.musicVolum is not a setting/, () => edit(sb, (s) => { delete s.audio; })],
    ['fades longer than video', () => edit(sb, (s) => { s.audio = { fadeIn: 10, fadeOut: 10 }; }), /exceed the video/, () => edit(sb, (s) => { delete s.audio; })],
  ];
  for (const [name, breakIt, re, fix] of cases) {
    breakIt();
    const r = run('render.mjs', sb);
    assert.equal(r.status, 1, name);
    assert.match(r.stderr, re, name);
    assert.deepEqual(tree(path.join(dir, 'out')), out, `${name}: out/ untouched`);
    assert.ok(!fs.existsSync(path.join(dir, 'tmp')), `${name}: tmp cleaned`);
    const e = run('export.mjs', proj, 'fail');
    assert.equal(e.status, 1, `${name}: export fails`);
    assert.deepEqual(tree(path.join(proj, 'vidgen-export')), exp, `${name}: exports untouched`);
    fix();
  }
  assert.equal(run('render.mjs', sb).status, 0, 'recovers once fixed');
});

test('stale narration is never mixed into a new export', { skip: noTts }, () => {
  const sb = sbPath('mix');
  assert.equal(run('export.mjs', proj, 'mix').status, 0);
  const exp = tree(path.join(proj, 'vidgen-export'));
  edit(sb, (s) => { s.scenes[1].narration = 'A new line nobody synthesized yet.'; });
  const e = run('export.mjs', proj, 'mix');
  assert.equal(e.status, 1);
  assert.match(e.stderr, /narration audio is stale/);
  assert.deepEqual(tree(path.join(proj, 'vidgen-export')), exp);
});

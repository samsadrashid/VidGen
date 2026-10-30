#!/usr/bin/env node
// Voiceover end to end: real local TTS (macOS `say` / espeak-ng), narration mixing, QA and export.
// Usage: node --test tests/voiceover.test.mjs
// The real-synthesis tests SKIP (and say so) when no TTS engine is installed; failure-path tests always run.
// Speech is verified in the exported MP4 itself: the synthesized waveform must be found, by cross-correlation,
// at its scene's position in the AAC track (music bed included) — not merely "an audio stream exists".
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
const engine = ['say', 'espeak-ng', 'espeak'].find((b) => which(b));
const noTts = !engine && 'no local TTS engine installed (macOS: say; Linux: espeak-ng)';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-voice-'));
const proj = path.join(tmp, 'proj');
const flows = path.join(proj, '.vidgen', 'flows');
const PORT = 8200 + Math.floor(Math.random() * 300);
let server;

const run = (script, args, env = {}) => spawnSync(process.execPath, [path.join(K, script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const tree = (d) => (fs.existsSync(d) ? Object.fromEntries(fs.readdirSync(d).sort().map((f) => [f, sha(path.join(d, f))])) : null);
const probe = (f) => JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f], { encoding: 'utf8' }).stdout);
const pcm = (f, start, len) => {
  const b = spawnSync(FFMPEG, ['-v', 'error', ...(start != null ? ['-ss', String(start), '-t', String(len)] : []), '-i', f, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 }).stdout;
  return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
};
const rmsDb = (a) => 10 * Math.log10(a.reduce((x, v) => x + v * v, 0) / a.length + 1e-12);
// PATH with only node on it: no say / espeak. ffmpeg is passed explicitly.
const bare = { PATH: path.dirname(process.execPath), VIDGEN_FFMPEG: FFMPEG, VIDGEN_FFPROBE: FFPROBE };

const SCENES = [
  { id: 'intro', type: 'title', text: 'Meet the dashboard', duration: 2.5 },
  { id: 'dash', type: 'capture', route: '/dashboard', caption: 'Live metrics', narration: 'Your metrics update in real time.', duration: 4 },
  { id: 'set', type: 'capture', route: '/settings', caption: 'Make it yours', narration: 'Change any setting in one click.', duration: 4 },
];
function storyboard(flow, extra = {}) {
  fs.mkdirSync(path.join(flows, flow), { recursive: true });
  const p = path.join(flows, flow, 'storyboard.json');
  fs.writeFileSync(p, JSON.stringify({ flow, title: flow, baseUrl: `http://localhost:${PORT}`, voiceover: true, music: 'auto', scenes: SCENES, ...extra }));
  return p;
}
const edit = (p, fn) => { const sb = JSON.parse(fs.readFileSync(p, 'utf8')); fn(sb); fs.writeFileSync(p, JSON.stringify(sb)); };

before(async () => {
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  server = spawn(process.execPath, ['server.mjs'], { cwd: proj, env: { ...process.env, PORT: String(PORT) } });
  await new Promise((r) => server.stdout.once('data', r));
});
after(() => { server?.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('doctor: detects the local TTS engine, and explains what happens when there is none', () => {
  const d = JSON.parse(run('doctor.mjs', ['--json', '--no-browser']).stdout);
  const tts = d.checks.find((c) => /TTS/.test(c.name));
  assert.equal(tts.ok, !!engine);
  if (engine) assert.match(tts.detail, new RegExp(engine));
  if (process.platform === 'darwin') assert.equal(engine, 'say', 'macOS ships /usr/bin/say');
  const none = JSON.parse(run('doctor.mjs', ['--json', '--no-browser'], bare).stdout).checks.find((c) => /TTS/.test(c.name));
  assert.equal(none.ok, false);
  assert.equal(none.required, false, 'music-only videos still work without TTS');
  assert.match(none.detail, /"voiceover": true will fail/);
});

test('missing TTS engine: voiceover requested -> clear failure (exit 1), nothing written; render refuses too', () => {
  const sb = storyboard('noengine');
  const r = run('voiceover.mjs', [sb], bare);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no local TTS engine was found/);
  assert.match(r.stderr, /"voiceover": false/);
  assert.ok(!fs.existsSync(path.join(flows, 'noengine', 'audio')), 'no audio dir created');
  assert.equal(run('capture.mjs', [sb]).status, 0);
  const rr = run('render.mjs', [sb]);
  assert.equal(rr.status, 1, 'render must not silently drop requested narration');
  assert.match(rr.stderr, /scene dash: narration audio missing — run voiceover.mjs/);
  assert.ok(!fs.existsSync(path.join(flows, 'noengine', 'out', 'landscape.mp4')));
});

test('failed synthesis (engine error, empty output, unknown voice, bad rate): exit 1, previous audio untouched', { skip: noTts }, () => {
  const sb = storyboard('fail');
  assert.equal(run('voiceover.mjs', [sb]).status, 0);
  const audio = path.join(flows, 'fail', 'audio');
  const good = tree(audio);
  const fake = path.join(tmp, 'fakebin');
  fs.mkdirSync(fake, { recursive: true });
  const env = { ...bare, PATH: `${fake}${path.delimiter}${bare.PATH}`, VIDGEN_TTS: 'say' };
  for (const [body, re] of [['echo "synth exploded" >&2; exit 3', /say failed \(exit 3\) synth exploded/], [': > "$2"', /produced no readable audio/]]) {
    fs.writeFileSync(path.join(fake, 'say'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const r = run('voiceover.mjs', [sb], env);
    assert.equal(r.status, 1, body);
    assert.match(r.stderr, re);
    assert.match(r.stderr, /previous narration in audio\/ left unchanged/);
    assert.deepEqual(tree(audio), good, 'audio/ byte-identical');
  }
  edit(sb, (s) => { s.voice = 'No Such Voice 123'; });
  const v = run('voiceover.mjs', [sb]);
  assert.equal(v.status, 1);
  assert.match(v.stderr, /voice "No Such Voice 123" is not installed/);
  edit(sb, (s) => { delete s.voice; s.voiceRate = 5000; });
  assert.match(run('voiceover.mjs', [sb]).stderr, /voiceRate must be 90–360/);
  assert.deepEqual(tree(audio), good);
});

test('narration longer than its scene is refused with the duration to use (voiceover and render)', { skip: noTts }, () => {
  const sb = storyboard('long', { scenes: [{ ...SCENES[1], narration: 'This sentence is far too long to fit inside a one second scene, so it must be refused.', duration: 1 }] });
  const r = run('voiceover.mjs', [sb]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /scene dash: narration lasts [\d.]+s but the scene is 1s — set "duration": [\d.]+/);
  // Bring-your-own audio that is too long is refused by render (it used to be truncated silently).
  edit(sb, (s) => { delete s.voiceover; });
  fs.mkdirSync(path.join(flows, 'long', 'audio'), { recursive: true });
  spawnSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=f=500:d=3', path.join(flows, 'long', 'audio', 'dash.wav')]);
  assert.equal(run('capture.mjs', [sb]).status, 0);
  const rr = run('render.mjs', [sb]);
  assert.equal(rr.status, 1);
  assert.match(rr.stderr, /narration for scene dash lasts 3\.00s but the scene is 1s/);
});

test('real synthesis + mix + export: speech present at the right time in both formats, music ducked, durations exact', { skip: noTts }, () => {
  const voices = engine === 'say' ? spawnSync('say', ['-v', '?'], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.match(/^(.+?)\s+en_US\s+#/)?.[1]).filter(Boolean) : [];
  const sb = storyboard('promo', voices.length ? { voice: voices[0], voiceRate: 190 } : {});
  const v = run('voiceover.mjs', [sb]);
  assert.equal(v.status, 0, v.stderr);
  const man = JSON.parse(fs.readFileSync(path.join(flows, 'promo', 'audio', 'voiceover.json'), 'utf8'));
  assert.equal(man.engine, engine);
  if (voices.length) assert.equal(man.voice, voices[0], 'selected voice recorded');
  assert.deepEqual(Object.keys(man.scenes).sort(), ['dash', 'set'], 'only narrated scenes');
  for (const [id, g] of Object.entries(man.scenes)) {
    const f = path.join(flows, 'promo', 'audio', g.file);
    const a = probe(f).streams[0];
    assert.equal(a.codec_type, 'audio', id);
    assert.ok(g.duration > 0.8 && g.duration < 4, `${id} ${g.duration}s`);
    assert.ok(rmsDb(pcm(f)) > -35, `${id} is audible`);
  }
  assert.equal(run('capture.mjs', [sb]).status, 0);
  const r = run('render.mjs', [sb]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /landscape: .*audio: music\+voiceover/);
  const q = run('qa.mjs', [path.join(flows, 'promo')]);
  assert.equal(q.status, 0, q.stdout);
  const qa = JSON.parse(q.stdout);
  console.log(`evidence qa narrationMatch ${JSON.stringify({ l: qa.results.landscape.narrationMatch, v: qa.results.vertical.narrationMatch })}, engine ${man.engine}, voice ${man.voice}`);
  for (const fmt of ['landscape', 'vertical']) for (const id of ['dash', 'set']) assert.ok(qa.results[fmt].narrationMatch[id] >= 0.5, `${fmt} ${id} ${qa.results[fmt].narrationMatch[id]}`);

  const e = run('export.mjs', [proj, 'promo']);
  assert.equal(e.status, 0, e.stderr);
  const total = SCENES.reduce((a, s) => a + s.duration, 0);
  for (const [name, W, H] of [['promo-1920x1080.mp4', 1920, 1080], ['promo-1080x1920.mp4', 1080, 1920]]) {
    const f = path.join(proj, 'vidgen-export', name);
    const p = probe(f);
    const vs = p.streams.find((s) => s.codec_type === 'video');
    const as = p.streams.find((s) => s.codec_type === 'audio');
    assert.equal(`${vs.width}x${vs.height}`, `${W}x${H}`);
    assert.equal(as.codec_name, 'aac');
    assert.equal(Number(as.sample_rate), 48000);
    assert.equal(as.channels, 2);
    assert.ok(Math.abs(Number(p.format.duration) - total) < 0.15, `${name} duration ${p.format.duration} vs ${total}`);
    assert.ok(Math.abs(Number(as.duration) - Number(vs.duration)) < 0.1, 'audio length = video length');
    // Independent check (not QA's own result): each synthesized line is in the AAC track at its scene's start…
    let start = 0;
    for (const s of SCENES) {
      if (s.narration) {
        const ref = pcm(path.join(flows, 'promo', 'audio', man.scenes[s.id].file));
        const here = similarity(pcm(f, start, man.scenes[s.id].duration + 0.1), ref);
        const elsewhere = similarity(pcm(f, 0, 2.4), ref.subarray(0, 2.4 * 8000));
        assert.ok(here > 0.6, `${name} ${s.id}: speech at ${start}s (match ${here.toFixed(2)})`);
        assert.ok(elsewhere < 0.3, `${name} ${s.id}: not in the title scene (match ${elsewhere.toFixed(2)})`);
        // …and clearly louder than the music under it. The title scene has music only, at full level (the bed recovers
        // in pauses since the dynamic ducking change); under speech it is ducked by the default 15 dB.
        const speechDb = rmsDb(pcm(f, start + 0.2, man.scenes[s.id].duration - 0.4));
        const bedDb = rmsDb(pcm(f, 1.2, 1));
        console.log(`evidence ${name} ${s.id}: match here ${here.toFixed(3)}, in title ${elsewhere.toFixed(3)}, speech ${speechDb.toFixed(1)} dB, bed ${bedDb.toFixed(1)} dB (≈ ${(bedDb - 15).toFixed(1)} dB under speech)`);
        assert.ok(speechDb - (bedDb - 15) >= 10, `${name} ${s.id}: speech ${speechDb.toFixed(1)} dB vs ducked bed ${(bedDb - 15).toFixed(1)} dB`);
      }
      start += s.duration;
    }
  }
});

test('script change -> stale narration refused until regenerated; removed narration is not mixed', { skip: noTts }, () => {
  const sb = path.join(flows, 'promo', 'storyboard.json');
  const audio = path.join(flows, 'promo', 'audio');
  const before = JSON.parse(fs.readFileSync(path.join(audio, 'voiceover.json'), 'utf8')).scenes;
  edit(sb, (s) => { s.scenes[1].narration = 'Every chart refreshes on its own.'; });
  const r = run('render.mjs', [sb]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /scene dash: narration audio is stale/);
  assert.equal(run('voiceover.mjs', [sb]).status, 0);
  const after = JSON.parse(fs.readFileSync(path.join(audio, 'voiceover.json'), 'utf8')).scenes;
  assert.notEqual(after.dash.sha256, before.dash.sha256, 'dash re-synthesized');
  assert.equal(after.set.sha256, before.set.sha256, 'unchanged line identical output');
  // Drop the narration of one scene: its generated file is removed on the next voiceover run.
  edit(sb, (s) => { delete s.scenes[2].narration; });
  assert.equal(run('voiceover.mjs', [sb]).status, 0);
  assert.ok(!fs.existsSync(path.join(audio, after.set.file)), 'stale generated file removed');
  assert.equal(run('render.mjs', [sb]).status, 0);
  const q = JSON.parse(run('qa.mjs', [path.join(flows, 'promo')]).stdout);
  assert.equal(q.pass, true);
  assert.deepEqual(Object.keys(q.results.landscape.narrationMatch), ['dash']);
});

test('voiceover: false -> music-only even with narration files on disk; with music none -> no audio stream', { skip: noTts }, () => {
  const sb = path.join(flows, 'promo', 'storyboard.json');
  const dashFile = path.join(flows, 'promo', 'audio', JSON.parse(fs.readFileSync(path.join(flows, 'promo', 'audio', 'voiceover.json'), 'utf8')).scenes.dash.file);
  edit(sb, (s) => { s.voiceover = false; });
  assert.match(run('voiceover.mjs', [sb]).stdout, /voiceover disabled/);
  const r = run('render.mjs', [sb]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /landscape: .*audio: music\)/);
  for (const fmt of ['landscape', 'vertical']) {
    const m = similarity(pcm(path.join(flows, 'promo', 'out', `${fmt}.mp4`), 2.5, 2), pcm(dashFile).subarray(0, 16000));
    console.log(`evidence music-only ${fmt}: narration match ${m.toFixed(3)}`);
    assert.ok(m < 0.3, `${fmt}: narration absent (match ${m.toFixed(2)})`);
  }
  assert.equal(JSON.parse(run('qa.mjs', [path.join(flows, 'promo')]).stdout).pass, true);
  edit(sb, (s) => { s.music = 'none'; });
  assert.equal(run('render.mjs', [sb]).status, 0);
  for (const fmt of ['landscape', 'vertical']) assert.ok(!probe(path.join(flows, 'promo', 'out', `${fmt}.mp4`)).streams.some((s) => s.codec_type === 'audio'), fmt);
  assert.equal(JSON.parse(run('qa.mjs', [path.join(flows, 'promo')]).stdout).pass, true);
  edit(sb, (s) => { s.voiceover = true; s.music = 'auto'; });
});

test('failed voiceover export leaves previous exports byte-identical', { skip: noTts }, () => {
  const sb = path.join(flows, 'promo', 'storyboard.json');
  const out = path.join(proj, 'vidgen-export');
  const before = tree(out);
  assert.ok(before['promo-1920x1080.mp4'], 'earlier export exists');
  edit(sb, (s) => { s.scenes[1].narration = 'A changed line that was never synthesized.'; });
  const e = run('export.mjs', [proj, 'promo']);
  assert.equal(e.status, 1);
  assert.match(e.stdout + e.stderr, /narration audio is stale/);
  assert.deepEqual(tree(out), before);
});

const KDIR = path.join(repo, '.tts');
const noKokoro = !fs.existsSync(path.join(KDIR, 'kokoro-v1.0.onnx')) && 'Kokoro not installed (.tts/ — README › Voiceover › Kokoro)';

test('kokoro: missing install fails clearly; unknown voice refused', () => {
  const sb = storyboard('kmiss', { tts: 'kokoro', voice: 'af_heart' });
  const r = run('voiceover.mjs', [sb], { VIDGEN_KOKORO_DIR: path.join(tmp, 'no-kokoro') });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /"tts": "kokoro" but it is not installed/);
  assert.ok(!fs.existsSync(path.join(flows, 'kmiss', 'audio')));
  if (!noKokoro) {
    edit(sb, (s) => { s.voice = 'zz_nobody'; });
    const v = run('voiceover.mjs', [sb]);
    assert.equal(v.status, 1);
    assert.match(v.stderr, /not a Kokoro voice/);
  }
});

test('kokoro: real neural synthesis, leveled to about -18 dB, renders into both formats', { skip: noKokoro }, () => {
  const sb = storyboard('kokoro', { tts: 'kokoro', voice: 'af_heart', voiceSpeed: 1 });
  const v = run('voiceover.mjs', [sb]);
  assert.equal(v.status, 0, v.stderr);
  const man = JSON.parse(fs.readFileSync(path.join(flows, 'kokoro', 'audio', 'voiceover.json'), 'utf8'));
  assert.equal(man.engine, 'kokoro');
  assert.equal(man.voice, 'af_heart');
  for (const [id, g] of Object.entries(man.scenes)) {
    const f = path.join(flows, 'kokoro', 'audio', g.file);
    const st = spawnSync(FFMPEG, ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const mean = Number(st.match(/mean_volume: (-?[\d.]+)/)[1]), max = Number(st.match(/max_volume: (-?[\d.]+)/)[1]);
    console.log(`evidence kokoro ${id}: ${g.duration}s mean ${mean} dB peak ${max} dB`);
    assert.ok(mean > -24 && mean < -15, `${id} leveled (${mean} dB)`);
    assert.ok(max <= -0.9, `${id} peak ${max}`);
  }
  assert.equal(run('capture.mjs', [sb]).status, 0);
  const r = run('render.mjs', [sb]);
  assert.equal(r.status, 0, r.stderr);
  const q = JSON.parse(run('qa.mjs', [path.join(flows, 'kokoro')]).stdout);
  assert.equal(q.pass, true);
  for (const fmt of ['landscape', 'vertical']) for (const id of ['dash', 'set']) assert.ok(q.results[fmt].narrationMatch[id] >= 0.5, `${fmt} ${id}`);
  // Changing engine settings makes narration stale.
  edit(sb, (s) => { s.voiceSpeed = 1.1; });
  assert.match(run('render.mjs', [sb]).stderr, /narration audio is stale/);
});

test('voice polish: 48 kHz, consistent 0.12 s breath, clearer presence than raw; toggling it re-generates', { skip: noTts }, () => {
  const band = (f, af) => Number(spawnSync(FFMPEG, ['-i', f, '-af', `${af},volumedetect`, '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+)/)[1]);
  const lead = (f) => Number(spawnSync(FFMPEG, ['-i', f, '-af', 'silencedetect=n=-50dB:d=0.01', '-f', 'null', '-'], { encoding: 'utf8' }).stderr.match(/silence_end: ([\d.]+)/)?.[1] ?? 0);
  const make = (flow, extra) => {
    const sb = storyboard(flow, { scenes: [SCENES[1]], ...extra });
    assert.equal(run('voiceover.mjs', [sb]).status, 0);
    const m = JSON.parse(fs.readFileSync(path.join(flows, flow, 'audio', 'voiceover.json'), 'utf8'));
    return [sb, path.join(flows, flow, 'audio', m.scenes.dash.file)];
  };
  const [, raw] = make('raw', { voicePolish: false });
  const [sb, pol] = make('pol', {});
  assert.equal(Number(probe(pol).streams[0].sample_rate), 48000);
  const presence = (f) => band(f, 'highpass=f=2500,lowpass=f=5000') - band(f, 'anull');
  console.log(`evidence polish: presence raw ${presence(raw).toFixed(1)} dB → polished ${presence(pol).toFixed(1)} dB (rel. to overall); lead silence raw ${lead(raw).toFixed(3)}s → ${lead(pol).toFixed(3)}s`);
  assert.ok(presence(pol) - presence(raw) >= 1.0, 'presence lifted relative to overall level');
  assert.ok(lead(pol) > 0.08 && lead(pol) < 0.2, `breath ${lead(pol)}`);
  edit(sb, (s) => { s.voicePolish = false; });
  assert.match(run('render.mjs', [sb]).stderr, /narration audio is stale/);
});

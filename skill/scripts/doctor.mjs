#!/usr/bin/env node
// Environment check for VidGen. Usage: doctor.mjs [--json] [--no-browser]
// Verifies Node, ffmpeg/ffprobe (+ the encoders, muxers and filters VidGen uses), Playwright Chromium, local TTS.
// Exit 0 when every required check passes, 1 otherwise. Prints what is missing and how to fix it.
import { spawnSync } from 'node:child_process';
import { FFMPEG, FFPROBE, which } from './platform.mjs';

const json = process.argv.includes('--json');
const checks = [];
const add = (name, ok, detail, required = true) => checks.push({ name, ok, detail, required });

const PLATFORM = process.env.VIDGEN_TEST_PLATFORM || process.platform;
add('macOS (VidGen v1 supports macOS only)', PLATFORM === 'darwin', PLATFORM === 'darwin' ? 'darwin' : `${PLATFORM} — not supported`);
const major = Number(process.versions.node.split('.')[0]);
add('node >= 20', major >= 20, `node ${process.versions.node}`);

const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8' });
const ff = run(FFMPEG, ['-hide_banner', '-version']);
add('ffmpeg', ff.status === 0, ff.error ? `${FFMPEG}: ${ff.error.code} — install ffmpeg or set VIDGEN_FFMPEG` : (ff.stdout.split('\n')[0] || '').slice(0, 80));
const fp = run(FFPROBE, ['-hide_banner', '-version']);
add('ffprobe', fp.status === 0, fp.error ? `${FFPROBE}: ${fp.error.code} — install ffmpeg or set VIDGEN_FFPROBE` : 'ok');

if (ff.status === 0) {
  const enc = run(FFMPEG, ['-hide_banner', '-encoders']).stdout;
  const mux = run(FFMPEG, ['-hide_banner', '-muxers']).stdout;
  const flt = run(FFMPEG, ['-hide_banner', '-filters']).stdout;
  const dmx = run(FFMPEG, ['-hide_banner', '-demuxers']).stdout;
  for (const e of ['libx264', 'aac']) add(`encoder ${e}`, new RegExp(`\\s${e}\\s`).test(enc), e === 'libx264' ? 'H.264 video (needs a GPL ffmpeg build)' : 'AAC audio');
  for (const m of ['mp4', 'rawvideo', 'null']) add(`muxer ${m}`, new RegExp(`\\s${m}\\s`).test(mux), '');
  for (const d of ['concat', 'lavfi']) add(`demuxer ${d}`, new RegExp(`\\s${d}\\s`).test(dmx), '');
  // drawtext is deliberately NOT required: text is rendered by Chromium.
  for (const f of ['zoompan', 'overlay', 'scale', 'format', 'fade', 'afade', 'amix', 'apad', 'atrim', 'concat', 'aevalsrc', 'anullsrc',
    'aresample', 'aformat', 'xfade', 'settb', 'fps', 'entropy', 'blackdetect', 'freezedetect', 'volumedetect', 'color']) {
    add(`filter ${f}`, new RegExp(`\\s${f}\\s`).test(flt), '');
  }
}

if (!process.argv.includes('--no-browser')) {
  try {
    const { chromium } = await import('playwright');
    const b = await chromium.launch({ executablePath: process.env.VIDGEN_CHROMIUM_PATH || undefined });
    add('playwright chromium', true, b.version());
    await b.close();
  } catch (e) {
    add('playwright chromium', false, `${String(e.message).split('\n')[0]} — run: npx playwright install chromium (Linux: npx playwright install --with-deps chromium)`);
  }
}
// Not required: music-only videos ("voiceover": false) work without it. Storyboards with "voiceover": true fail without it.
const tts = ['say', 'espeak-ng', 'espeak'].find((b) => which(b));
add('local TTS (needed for voiceover)', !!tts, tts ? `${tts}${tts === 'say' ? ` (${(run('say', ['-v', '?']).stdout ?? '').split('\n').filter(Boolean).length} voices)` : ''}`
  : `none — storyboards with "voiceover": true will fail. macOS: /usr/bin/say ships with the OS; put /usr/bin on PATH, or install Kokoro (README)`, false);

const failed = checks.filter((c) => c.required && !c.ok);
if (json) console.log(JSON.stringify({ ok: !failed.length, platform: `${process.platform}-${process.arch}`, ffmpeg: FFMPEG, checks }, null, 2));
else {
  for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.required ? 'FAIL' : 'warn'}  ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  console.log(failed.length ? `\n${failed.length} required check(s) failed.` : '\nAll required checks passed.');
}
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
// Render storyboard -> landscape (1920x1080) + vertical (1080x1920) mp4. Always both.
// Usage: render.mjs <storyboard.json> [--final]
// Audio: storyboard.music = "auto" (default: .vidgen/music/* or generated pad) | "none" | path (relative to storyboard).
// Narration: flowDir/audio/<sceneId>.{aiff,wav,mp3,m4a} (see voiceover.mjs / narration.mjs), mixed over the ducked music.
//   voiceover: true + missing/stale narration, or narration longer than its scene -> exit 1. voiceover: false -> music only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { sha, fingerprint, contrast } from './vision.mjs';
import { resolveNarration } from './narration.mjs';
import { theme } from './looks.mjs';
import { FFMPEG, FFPROBE, concatEntry, explainSpawnError, INTERRUPT_SIGNALS, assertNoSymlinks, outputBase, assertSafeNames } from './platform.mjs';

const sbPath = path.resolve(process.argv[2]);
const final = process.argv.includes('--final');
const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
const flowDir = path.dirname(sbPath);
const vidgenDir = path.dirname(path.dirname(flowDir));
try {
  assertSafeNames((sb.scenes ?? []).map((s) => s.id), 'scene id');
  assertNoSymlinks(outputBase(flowDir), [path.join(flowDir, 'tmp'), path.join(vidgenDir, 'cache', 'cards'),
    ...['landscape', 'vertical'].flatMap((f) => [path.join(flowDir, 'out', `${f}.mp4`), path.join(flowDir, 'out', `${f}.render.json`)])]);
} catch (e) { console.error(`render refused: ${e.message}`); process.exit(2); }
const FPS = 30;
const AR = 48000;
const FORMATS = { landscape: [1920, 1080], vertical: [1080, 1920] };
const brand = { primary: '#4F46E5', background: '#0B0B12', ...sb.brand };
// storyboard.look: canvas/title/caption treatment (looks.mjs). Unknown or planned looks are refused with the ready list.
let TH;
try { TH = theme(brand, sb.look); } catch (e) { console.error(`render refused: ${e.message}`); process.exit(2); }
// Async so signal handlers can run mid-render (execFileSync would block them until completion).
// Watchdog: ffmpeg can spin forever on undecodable input (e.g. -loop 1 on a corrupt image), so every call is time-boxed.
const FF_TIMEOUT = Number(process.env.VIDGEN_FFMPEG_TIMEOUT_MS) || 600_000;
let child;
const ff = (args) => new Promise((resolve, reject) => {
  child = spawn(FFMPEG, ['-y', '-loglevel', 'error', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  const timer = setTimeout(() => { child?.kill('SIGKILL'); reject(new Error(`ffmpeg exceeded ${FF_TIMEOUT / 1000}s (VIDGEN_FFMPEG_TIMEOUT_MS) — killed`)); }, FF_TIMEOUT);
  child.on('error', (e) => { clearTimeout(timer); reject(new Error(explainSpawnError(e, FFMPEG) ?? e.message)); });
  child.on('close', (code, sig) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code ?? sig}`)); });
});
const enc = final ? ['-c:v', 'libx264', '-profile:v', 'high', '-crf', '18', '-preset', 'slow']
                  : ['-c:v', 'libx264', '-crf', '23', '-preset', 'veryfast'];
const LIMIT = 0.891; // -1 dBFS
const STEREO = `aresample=${AR},aformat=sample_fmts=fltp:channel_layouts=stereo`;

function resolveMusic() {
  if (sb.music === 'none') return null;
  if (sb.music && sb.music !== 'auto') {
    const p = path.resolve(flowDir, sb.music);
    if (!fs.existsSync(p)) throw new Error(`music not found: ${p}`);
    return checkAudioFile(p, 'music');
  }
  const dir = path.join(vidgenDir, 'music'); // shared across all flows
  const f = fs.existsSync(dir) && fs.readdirSync(dir).filter((f) => /\.(mp3|wav|m4a|aac|ogg)$/i.test(f)).sort()[0];
  return f ? checkAudioFile(path.join(dir, f), 'music') : 'generated';
}

const narrDur = (f) => Number(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));
// An audio input must have a decodable audio stream with a real duration; returns its duration via `dur`.
function checkAudioFile(f, what) {
  let info;
  try { info = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', f], { stdio: ['ignore', 'pipe', 'pipe'] })); } catch { info = null; }
  const dur = Number(info?.format?.duration);
  if (!info?.streams?.length || !(dur > 0)) throw new Error(`${what} audio is unreadable or has no audio stream: ${f}`);
  const dec = spawnSync(FFMPEG, ['-v', 'error', '-i', f, '-map', '0:a:0', '-f', 'null', '-'], { encoding: 'utf8' });
  if (dec.status !== 0 || /invalid|error/i.test(dec.stderr)) throw new Error(`${what} audio fails to decode: ${f} (${(dec.stderr || `exit ${dec.status}`).trim().split('\n')[0]})`);
  checkAudioFile.dur = dur;
  return f;
}

// Mix settings (storyboard.audio). Volumes are linear gains; ducking is in dB below the music level.
const AUDIO_DEFAULTS = { musicVolume: 0.7, duckDb: 15, attack: 0.4, release: 0.8, fadeIn: 1, fadeOut: 1.5 };
const RANGES = { musicVolume: [0, 1], duckDb: [0, 40], attack: [0.05, 2], release: [0.05, 3], fadeIn: [0, 10], fadeOut: [0, 10] };
function audioSettings(total) {
  const a = { ...AUDIO_DEFAULTS, ...(sb.audio ?? {}) };
  for (const k of Object.keys(sb.audio ?? {})) if (!(k in RANGES)) throw new Error(`audio.${k} is not a setting (use ${Object.keys(RANGES).join(', ')})`);
  for (const [k, [lo, hi]] of Object.entries(RANGES)) if (typeof a[k] !== 'number' || !(a[k] >= lo && a[k] <= hi)) throw new Error(`audio.${k} must be a number ${lo}–${hi}, got ${JSON.stringify(a[k])}`);
  // Defaults shrink to fit short videos; explicit values that don't fit are errors.
  if (!sb.audio?.fadeIn) a.fadeIn = Math.min(a.fadeIn, total / 4);
  if (!sb.audio?.fadeOut) a.fadeOut = Math.min(a.fadeOut, total / 3);
  if (a.fadeIn + a.fadeOut > total) throw new Error(`audio.fadeIn + audio.fadeOut (${a.fadeIn + a.fadeOut}s) exceed the video (${total}s)`);
  return a;
}
// Music gain over time: musicVolume, smoothly pulled down (linearly in dB) by duckDb around each narration window [a, b]
// (fully ducked from a to b, ramping over `attack` before a and `release` after b). Overlapping ramps take the max.
function duckExpr(windows, { musicVolume, duckDb, attack, release }) {
  if (!windows.length || duckDb === 0) return String(musicVolume);
  const w = windows.map(([a, b]) => `clip(min((t-${(a - attack).toFixed(3)})/${attack},(${(b + release).toFixed(3)}-t)/${release}),0,1)`);
  const W = w.reduce((x, y) => `max(${x},${y})`);
  // Ramp in dB (not linear gain): a constant dB/s slope sounds even and has no abrupt tail.
  return `${musicVolume}*pow(10,-${duckDb}*${W}/20)`;
}

// Text is rendered by Chromium (brand fonts, no ffmpeg freetype dependency).
// Cards are cached in .vidgen/cache/cards by content hash, so flows sharing a title/outro reuse them.
const esc = (t) => String(t ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const cardCache = path.join(vidgenDir, 'cache', 'cards');
let browser;
async function card(W, H, html) {
  const doc = `<html><body style="margin:0;width:${W}px;height:${H}px;font-family:${TH.font ?? `'${brand.font ?? 'Inter'}'`},-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;background:transparent">${html}</body></html>`;
  const file = path.join(cardCache, crypto.createHash('sha256').update(`${W}x${H}${doc}`).digest('hex').slice(0, 20) + '.png');
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(cardCache, { recursive: true });
  browser ??= await chromium.launch();
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  await page.setContent(doc);
  // Overlay text must stay inside the frame, unclipped, within its line budget.
  const problems = await page.evaluate(([W, H]) => [...document.querySelectorAll('[data-text]')].flatMap((e) => {
    const r = e.getBoundingClientRect();
    // Count lines from the content height only (scrollHeight includes the caption box's padding).
    const cs = getComputedStyle(e);
    const lines = Math.round((e.scrollHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / parseFloat(cs.lineHeight));
    const out = [];
    if (r.left < W * 0.02 || r.right > W * 0.98 || r.top < H * 0.02 || r.bottom > H * 0.98) out.push('outside safe area');
    if (e.scrollWidth > e.clientWidth + 1) out.push('clipped horizontally');
    if (lines > Number(e.dataset.maxLines)) out.push(`${lines} lines > ${e.dataset.maxLines}`);
    return out.map((m) => `"${e.textContent.slice(0, 40)}": ${m}`);
  }), [W, H]);
  if (problems.length) { await page.close(); throw new Error(`overlay text problem (${W}x${H}): ${problems.join('; ')}`); }
  await page.screenshot({ path: file + '.tmp.png', omitBackground: true });
  await page.close();
  fs.renameSync(file + '.tmp.png', file);
  return file;
}

// ---- motion & transitions -------------------------------------------------------------------------
// scene.transition = how this scene hands over to the NEXT one (storyboard.transition sets the default).
// Overlapping transitions borrow time from an extended tail of the outgoing clip, so every scene still
// starts at the cumulative sum of durations and the total length is exactly the sum of scene durations.
export const TRANSITIONS = { cut: null, crossfade: 'fade', fade: 'fadeblack', slide: 'slideleft' }; // value -> ffmpeg xfade
export const MOTIONS = ['none', 'zoom-in', 'zoom-out', 'pan-down'];
// How a capture is presented: "screen" = full-bleed screenshot; "device" = inside a browser window (landscape) or
// phone (vertical) on a branded canvas, leaving room for the caption below.
export const STYLES = ['screen', 'device'];
const DEFAULT_TRANSITION = 'crossfade';
const DEFAULT_T = 0.5;

// Returns [{transition, T}] per scene (T = overlap into the next scene; 0 for cut and the last scene).
export function planTransitions(sb) {
  const errors = [];
  const def = sb.transition ?? DEFAULT_TRANSITION;
  const defT = sb.transitionDuration ?? DEFAULT_T;
  if (!(def in TRANSITIONS)) errors.push(`storyboard.transition "${def}" — use one of ${Object.keys(TRANSITIONS).join(', ')}`);
  const plan = sb.scenes.map((s, i) => {
    const d = Number(s.duration ?? 3);
    if (!(d > 0)) errors.push(`scene ${s.id}: duration must be > 0`);
    const transition = s.transition ?? def;
    if (!(transition in TRANSITIONS)) errors.push(`scene ${s.id}: transition "${transition}" — use one of ${Object.keys(TRANSITIONS).join(', ')}`);
    const motion = s.motion ?? 'none';
    if (s.type === 'capture' && !MOTIONS.includes(motion)) errors.push(`scene ${s.id}: motion "${motion}" — use one of ${MOTIONS.join(', ')}`);
    const style = s.style ?? sb.style ?? 'screen'; // look defaults are always valid
    if (s.type === 'capture' && !STYLES.includes(style)) errors.push(`scene ${s.id}: style "${style}" — use one of ${STYLES.join(', ')}`);
    const explicit = s.transitionDuration != null || sb.transitionDuration != null;
    let T = Number(s.transitionDuration ?? defT);
    if (explicit && !(T >= 0.2 && T <= 1.0)) errors.push(`scene ${s.id}: transitionDuration ${s.transitionDuration ?? defT} — must be 0.2..1.0 s`);
    const next = sb.scenes[i + 1];
    // The transition must end before the next scene's midpoint (where QA fingerprints it) and be at most half of this scene.
    const fit = next ? Math.min(d / 2, Number(next.duration ?? 3) / 2) : 0;
    let effective = transition;
    if (!next || transition === 'cut') T = 0;
    else if (T > fit) {
      // Explicit durations that don't fit are errors; the default shrinks to fit (or becomes a cut) so
      // storyboards that rendered before v0.2 — e.g. 0.4 s outros — keep rendering.
      if (explicit) errors.push(`scene ${s.id}: ${T}s ${transition} is too long for ${d}s → ${next.duration ?? 3}s scenes (max half of either)`);
      else T = fit >= 0.2 ? +fit.toFixed(3) : 0;
    }
    if (T === 0) effective = next && transition !== 'cut' ? 'cut' : effective;
    return { transition: effective, T, d };
  });
  if (errors.length) throw new Error(`invalid motion/transition settings: ${errors.join('; ')}`);
  return plan;
}

// Restrained, eased (smoothstep) motion over n frames: no abrupt start/stop.
// Subtitles (storyboard.subtitles: true | { "size": px }): each scene's narration, split into short phrases shown while
// they are spoken, on a black liquid-glass pill at the bottom. Timing is proportional to phrase length within the line.
const SUBS = sb.subtitles ? { size: null, ...(typeof sb.subtitles === 'object' ? sb.subtitles : {}) } : null;
if (SUBS && SUBS.size != null && !(Number.isInteger(SUBS.size) && SUBS.size >= 20 && SUBS.size <= 120)) {
  console.error(`render refused: subtitles.size must be an integer 20–120 px (smaller is unreadable), got ${JSON.stringify(SUBS.size)}`); process.exit(2);
}
function subtitlePhrases(text, maxWords = 7) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= maxWords || (/[.,;:!?]$/.test(w) && cur.length >= 3)) { out.push(cur.join(' ')); cur = []; }
  }
  if (cur.length) out.length && cur.length < 3 ? (out[out.length - 1] += ' ' + cur.join(' ')) : out.push(cur.join(' '));
  return out;
}
async function subtitleCards(W, H, text, dur) {
  const size = SUBS.size ?? Math.round(W > H ? H / 30 : H / 46);
  const phrases = subtitlePhrases(text);
  const total = phrases.reduce((a, p) => a + p.length, 0);
  let t = 0;
  const cards = [];
  for (const p of phrases) {
    const len = dur * (p.length / total);
    cards.push({ start: t, end: t + len, png: await card(W, H, `<div style="position:absolute;left:0;right:0;bottom:${Math.round(H * 0.03)}px;text-align:center"><span data-text data-max-lines="2" style="display:inline-block;box-sizing:border-box;max-width:90%;color:#fff;font-weight:600;font-size:${size}px;line-height:1.3;letter-spacing:0.01em;padding:${Math.round(size * 0.35)}px ${Math.round(size * 0.8)}px;border-radius:${Math.round(size * 0.9)}px;background:linear-gradient(180deg,rgba(255,255,255,.16) 0%,rgba(255,255,255,.04) 48%,rgba(255,255,255,0) 52%),rgba(8,8,12,.62);border:1px solid rgba(255,255,255,.18);box-shadow:inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(255,255,255,.06),0 10px 30px rgba(0,0,0,.45);text-shadow:0 1px 2px rgba(0,0,0,.6)">${esc(p)}</span></div>`) });
    t += len;
  }
  return cards;
}
// Overlay timed subtitle PNGs (inputs from index `first`) onto stream [src]; returns [filter, label].
function subtitleChain(src, cards, first) {
  let cur = src;
  const f = cards.map((c, k) => { const out = `s${k}`; const r = `[${cur}][${first + k}:v]overlay=0:0:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[${out}]`; cur = out; return r; });
  return [f.join(';'), cur];
}

// Device canvas: the real screenshot inside a browser window (landscape) or a phone (vertical), on a brand gradient.
function deviceHtml(W, H, png) {
  const src = `data:image/png;base64,${fs.readFileSync(png).toString('base64')}`;
  const bg = TH.canvas;
  if (W > H) {
    const w = Math.round(W * 0.68), bar = Math.round(H * 0.032), r = Math.round(H * 0.018);
    return `<div style="position:absolute;inset:0;background:${bg}"></div>
<div style="position:absolute;left:${(W - w) / 2}px;top:${Math.round(H * 0.06)}px;width:${w}px;border-radius:${r}px;overflow:hidden;background:#fff;box-shadow:0 ${Math.round(H * 0.04)}px ${Math.round(H * 0.09)}px #0008,0 0 0 1px #fff3">
<div style="height:${bar}px;background:#eef0f4;display:flex;align-items:center;gap:${Math.round(bar * 0.28)}px;padding-left:${Math.round(bar * 0.5)}px">${['#ff5f57', '#febc2e', '#28c840'].map((c) => `<i style="width:${Math.round(bar * 0.36)}px;height:${Math.round(bar * 0.36)}px;border-radius:50%;background:${c}"></i>`).join('')}</div>
<img src="${src}" style="display:block;width:100%"></div>`;
  }
  const h = Math.round(H * 0.66), w = Math.round(h * (W / H)), b = Math.round(W * 0.022);
  return `<div style="position:absolute;inset:0;background:${bg}"></div>
<div style="position:absolute;left:${Math.round((W - w) / 2) - b}px;top:${Math.round(H * 0.05)}px;padding:${b}px;border-radius:${b * 4.2}px;background:#0b0b0f;box-shadow:0 ${Math.round(H * 0.03)}px ${Math.round(H * 0.06)}px #000a,inset 0 0 0 2px #333">
<img src="${src}" style="display:block;width:${w}px;height:${h}px;object-fit:cover;object-position:top;border-radius:${b * 3}px"></div>`;
}

function motionFilter(m, len, W, H) {
  // Subpixel camera move: `perspective` maps float source corners to the output frame with bicubic interpolation.
  // (zoompan snaps its crop to whole pixels, which made slow zooms/pans step and stutter.) Inputs must be fed at FPS.
  const n = Math.max(1, Math.round(len * FPS));
  const e = `(3*pow(min(on/${n}\,1)\,2)-2*pow(min(on/${n}\,1)\,3))`; // smoothstep 0..1 over the clip
  const z = { 'zoom-in': `(1+0.06*${e})`, 'zoom-out': `(1.06-0.06*${e})`, 'pan-down': '1.12' }[m] ?? '1';
  if (z === '1') return `scale=${W}:${H},setsar=1`;
  const cw = `(W/${z})`, ch = `(H/${z})`, x = `((W-${cw})/2)`;
  const y = m === 'pan-down' ? `((H-${ch})*${e})` : `((H-${ch})/2)`;
  return `scale=${W}:${H},setsar=1,format=yuv444p,perspective=x0='${x}':y0='${y}':x1='${x}+${cw}':y1='${y}':x2='${x}':y2='${y}+${ch}':x3='${x}+${cw}':y3='${y}+${ch}':interpolation=cubic:eval=frame`;
}

async function renderFormat(fmt, W, H, tmp, music, plan, narration) {
  const clips = [];
  const fs_ = Math.round(H / 16);
  for (const [i, s] of sb.scenes.entries()) {
    const { d, T } = plan[i];
    const len = d + T; // rendered length: visible duration + tail that the next scene's transition overlaps
    const out = path.join(tmp, `${s.id}.mp4`);
    const fd = Math.min(0.35, d / 3);
    let bg;
    // Only the very first scene fades in from black and the last fades out; boundaries are handled by xfade.
    const fade = [i === 0 ? `fade=t=in:st=0:d=${fd}` : '', i === sb.scenes.length - 1 ? `fade=t=out:st=${len - fd}:d=${fd}` : ''].filter(Boolean).map((f) => ',' + f).join('');
    if (s.type === 'capture') {
      const png = path.join(flowDir, 'captures', fmt, `${s.id}.png`);
      if (!fs.existsSync(png)) throw new Error(`missing capture ${png} — run capture.mjs`);
      const head = fs.readFileSync(png).subarray(0, 24);
      if (!head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error(`corrupt capture (not a PNG): ${png} — re-run capture.mjs`);
      const frame = (s.style ?? sb.style ?? TH.style) === 'device' ? await card(W, H, deviceHtml(W, H, png)) : png;
      const subs = SUBS && narration[s.id] ? await subtitleCards(W, H, s.narration ?? '', Math.min(narrDur(narration[s.id]), d)) : [];
      const cap = await card(W, H, s.caption ? `<div style="position:absolute;left:0;right:0;bottom:${Math.round(H * (SUBS ? 0.105 : 0.08))}px;text-align:center"><span data-text data-max-lines="2" style="display:inline-block;box-sizing:border-box;max-width:92%;overflow-wrap:anywhere;background:${TH.capBg};color:${TH.capColor};border:${TH.capBorder};font-weight:700;font-size:${Math.round(fs_ * (SUBS ? 0.5 : 0.7))}px;line-height:1.2;padding:${Math.round(fs_ * (SUBS ? 0.22 : 0.3))}px ${Math.round(fs_ * (SUBS ? 0.45 : 0.6))}px;border-radius:${TH.capRadius ?? Math.round(fs_ * 0.4)}px;box-shadow:0 10px 40px #0006">${esc(s.caption)}</span></div>` : '');
      const [sf, sl] = subtitleChain('v', subs, 2);
      await ff(['-framerate', String(FPS), '-loop', '1', '-i', frame, '-framerate', String(FPS), '-loop', '1', '-i', cap, ...subs.flatMap((c) => ['-framerate', String(FPS), '-loop', '1', '-i', c.png]), '-t', String(len), '-filter_complex',
        `[0:v]${motionFilter(s.motion, len, W, H)}[b];[1:v]scale=${W}:${H}[c];[b][c]overlay=0:0:shortest=1[v]` + (sf ? `;${sf}` : '') + `;[${sl}]null${fade},format=yuv420p`, '-r', String(FPS), ...enc, '-an', out]);
    } else {
      bg = await card(W, H, `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;background:${TH.titleBg};color:${TH.titleColor};text-align:center"><div data-text data-max-lines="4" style="font-size:${fs_}px;line-height:1.15;font-weight:${TH.titleWeight};letter-spacing:${TH.titleTracking};text-shadow:${TH.titleGlow};max-width:80%;overflow-wrap:anywhere">${TH.highlight(s.text)}</div><div style="margin-top:${Math.round(fs_ * 0.5)}px;width:${Math.round(W / 8)}px;height:6px;border-radius:3px;background:${TH.accentBar}"></div></div>`);
      const subs = SUBS && narration[s.id] ? await subtitleCards(W, H, s.narration ?? '', Math.min(narrDur(narration[s.id]), d)) : [];
      const [sf, sl] = subtitleChain('v', subs, 1);
      await ff(['-framerate', String(FPS), '-loop', '1', '-i', bg, ...subs.flatMap((c) => ['-framerate', String(FPS), '-loop', '1', '-i', c.png]), '-t', String(len), '-filter_complex',
        `[0:v]${motionFilter('zoom-in', len, W, H)}[v]` + (sf ? `;${sf}` : '') + `;[${sl}]null${fade},format=yuv420p`, '-r', String(FPS), ...enc, '-an', out]);
    }
    clips.push({ file: out, d, id: s.id, type: s.type, source: s.type === 'capture' ? path.join(flowDir, 'captures', fmt, `${s.id}.png`) : bg });
  }

  const silent = path.join(tmp, 'video.mp4');
  if (plan.every((p) => p.T === 0)) {
    // All cuts: lossless stream copy.
    const list = path.join(tmp, 'list.txt');
    fs.writeFileSync(list, clips.map((c) => concatEntry(c.file)).join('\n'));
    await ff(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);
  } else {
    // xfade chain; offset of boundary k = sum of visible durations up to k (cuts join with concat).
    // Every input and every join output is normalised to the same 1/FPS timebase: concat and xfade
    // otherwise emit different timebases and the next xfade refuses to link (e.g. cut followed by slide).
    const TB = `fps=${FPS},settb=1/${FPS},format=yuv420p`;
    const f = clips.map((_, i) => `[${i}:v]setpts=PTS-STARTPTS,${TB}[s${i}]`);
    let cur = 's0', t = 0;
    for (let k = 0; k < clips.length - 1; k++) {
      t += plan[k].d;
      const out = `j${k}`;
      f.push((plan[k].T === 0
        ? `[${cur}][s${k + 1}]concat=n=2:v=1:a=0`
        : `[${cur}][s${k + 1}]xfade=transition=${TRANSITIONS[plan[k].transition]}:duration=${plan[k].T}:offset=${t.toFixed(4)}`) + `,${TB}[${out}]`);
      cur = out;
    }
    await ff([...clips.flatMap((c) => ['-i', c.file]), '-filter_complex', f.join(';'), '-map', `[${cur}]`, '-r', String(FPS), ...enc, '-pix_fmt', 'yuv420p', '-an', silent]);
  }
  const total = clips.reduce((a, c) => a + c.d, 0);

  const narr = clips.map((c) => narration[c.id]);
  const hasNarr = narr.some(Boolean);
  const inputs = ['-i', silent];
  const parts = [];
  const mix = [];
  const set = audioSettings(total);
  // Narration windows on the video timeline: each line starts at its scene's start.
  const windows = [];
  const narrIdx = [];
  if (hasNarr) {
    let start = 0;
    clips.forEach((c, i) => {
      if (narr[i]) {
        checkAudioFile(narr[i], `narration for scene ${c.id}`);
        const dur = checkAudioFile.dur;
        if (dur > c.d + 0.05) throw new Error(`narration for scene ${c.id} lasts ${dur.toFixed(2)}s but the scene is ${c.d}s — raise its duration to ${Math.ceil(dur * 2) / 2} or shorten the line`);
        windows.push([start, start + Math.min(dur, c.d)]);
        narrIdx[i] = true;
      }
      start += c.d;
    });
  }
  if (music) {
    inputs.push(...(music === 'generated'
      ? ['-f', 'lavfi', '-i', `aevalsrc='0.06*sin(2*PI*220*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.04*sin(2*PI*329.6*t)+0.03*sin(2*PI*440*t)':s=${AR}:d=${total}`]
      : ['-stream_loop', '-1', '-i', music]));
    // Bed: level + smooth ducking under each narration line (recovers in pauses), then fades.
    parts.push(`[1:a]${STEREO},atrim=0:${total},asetpts=N/SR/TB,volume='${duckExpr(windows, set)}':eval=frame` +
      (set.fadeIn > 0 ? `,afade=t=in:d=${set.fadeIn}` : '') + (set.fadeOut > 0 ? `,afade=t=out:st=${(total - set.fadeOut).toFixed(3)}:d=${set.fadeOut}` : '') + '[m]');
    mix.push('[m]');
  }
  if (hasNarr) {
    clips.forEach((c, i) => {
      if (narrIdx[i]) {
        inputs.push('-i', narr[i]);
        const idx = inputs.filter((x) => x === '-i').length - 1;
        parts.push(`[${idx}:a]${STEREO},apad,atrim=0:${c.d},asetpts=N/SR/TB[n${i}]`);
      } else parts.push(`anullsrc=r=${AR}:cl=stereo,atrim=0:${c.d}[n${i}]`);
    });
    parts.push(clips.map((_, i) => `[n${i}]`).join('') + `concat=n=${clips.length}:v=0:a=1[nar]`);
    mix.push('[nar]');
  }

  const dest = path.join(flowDir, 'out', `${fmt}.mp4`);
  const partial = path.join(tmp, `${fmt}.partial.mp4`);
  if (mix.length) {
    // Peak limiter at -1 dBFS (true sum of bed + voice can exceed full scale), then pad/trim to the exact video length.
    const filter = parts.join(';') + (mix.length === 2 ? ';[m][nar]amix=inputs=2:duration=first:normalize=0[mx]' : `;${mix[0]}anull[mx]`) +
      `;[mx]alimiter=limit=${LIMIT}:attack=5:release=50:level=false:latency=1,apad,atrim=0:${total},asetpts=N/SR/TB[aout]`;
    await ff([...inputs, '-filter_complex', filter, '-map', '0:v', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'aac', '-ar', String(AR), '-b:a', final ? '192k' : '128k',
      '-movflags', '+faststart', '-t', String(total), partial]);
  } else {
    await ff(['-i', silent, '-c', 'copy', '-movflags', '+faststart', partial]);
  }
  console.log(`${fmt}: ${dest} (${total}s, audio: ${mix.length ? [music && 'music', hasNarr && 'voiceover'].filter(Boolean).join('+') : 'none'})`);
  // Scene manifest: sources + a pixel fingerprint of each scene's midpoint in THIS file,
  // so QA/export can detect stale, swapped, reordered or missing scenes later.
  let t = 0;
  const scenes = clips.map((c) => {
    const mid = t + c.d / 2;
    t += c.d;
    return { id: c.id, type: c.type, transitionOut: plan[clips.indexOf(c)].T ? plan[clips.indexOf(c)].transition : 'cut', start: +(mid - c.d / 2).toFixed(3), duration: c.d, source: c.source, sourceSha: sha(c.source), fp: fingerprint(partial, mid).toString('base64') };
  });
  const json = path.join(tmp, `${fmt}.render.json`);
  fs.writeFileSync(json, JSON.stringify({ format: fmt, width: W, height: H, storyboardSha: sha(sbPath), renderedAt: new Date().toISOString(), scenes }, null, 2));
  return [[partial, dest], [json, path.join(flowDir, 'out', `${fmt}.render.json`)]];
}

const tmpRoot = path.join(flowDir, 'tmp');
const cleanup = () => fs.rmSync(tmpRoot, { recursive: true, force: true });
for (const sig of INTERRUPT_SIGNALS) process.on(sig, () => { child?.kill('SIGKILL'); cleanup(); console.error(`render interrupted (${sig}); previous outputs untouched`); process.exit(130); });
let failed = false;
try {
  const plan = planTransitions(sb);
  const music = resolveMusic();
  audioSettings(plan.reduce((a, p) => a + p.d, 0)); // fail fast on bad audio settings, before any encoding
  const { files: narration, errors: narrErrors } = resolveNarration(flowDir, sb);
  if (narrErrors.length) throw new Error(narrErrors.join('; '));
  // White overlay text must be readable on the brand colors (WCAG large-text minimum 3:1).
  for (const [name, c] of [['primary', brand.primary], ['background', brand.background]]) if (!/^#[0-9a-f]{6}$/i.test(c)) throw new Error(`brand.${name} must be #rrggbb, got ${c}`);
  for (const [name, fg, bgc] of TH.contrast) {
    const r = contrast(fg, bgc);
    if (r < 3) throw new Error(`unreadable overlay: ${name} ${bgc} has contrast ${r.toFixed(2)} < 3`);
  }
  const done = [];
  for (const [fmt, [W, H]] of Object.entries(FORMATS)) {
    const tmp = path.join(tmpRoot, fmt);
    fs.mkdirSync(tmp, { recursive: true });
    done.push(...(await renderFormat(fmt, W, H, tmp, music, plan, narration)));
  }
  // Promote only after BOTH formats succeeded, so out/ never mixes old and new renders.
  fs.mkdirSync(path.join(flowDir, 'out'), { recursive: true });
  for (const [partial, dest] of done) fs.renameSync(partial, dest);
} catch (e) {
  failed = true;
  console.error(`render failed: ${e.message?.split('\n')[0] ?? e}`);
} finally {
  await browser?.close();
  cleanup();
}
process.exit(failed ? 1 : 0);

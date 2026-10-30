#!/usr/bin/env node
// QA of a flow's captures and rendered videos. Usage: qa.mjs <flowDir>
// Technical checks (ffprobe/ffmpeg) + visual integrity: capture verification metadata, staleness,
// per-scene pixel fingerprints (order / missing / swapped scenes), duplicates, labelled contact sheets.
// Also exports helpers for export.mjs.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha, pngSize, entropy, fingerprint, mad, changedFraction } from './vision.mjs';
import { FFMPEG, FFPROBE, explainSpawnError, assertNoSymlinks, outputBase, assertSafeNames } from './platform.mjs';
import { resolveNarration } from './narration.mjs';

export const SPEC = { landscape: [1920, 1080], vertical: [1080, 1920] };
// Fingerprint distance (0..255) under which two frames count as "the same picture" after re-encoding.
export const SAME = 1.0; // calibrated: re-encode <= 0.05, closest distinct sparse pages ~3.4

export function checkVideo(f, { W, H, expected, expectAudio }) {
  const issues = [];
  const warnings = [];
  if (!fs.existsSync(f)) return { pass: false, issues: [`missing file ${f}`], warnings };
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', f]));
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  const dur = Number(probe.format.duration);
  if (!v) return { pass: false, issues: ['no video stream'], warnings };
  if (v.width !== W || v.height !== H) issues.push(`resolution ${v.width}x${v.height} != ${W}x${H}`);
  if (v.codec_name !== 'h264') issues.push(`codec ${v.codec_name}`);
  if (v.pix_fmt !== 'yuv420p') issues.push(`pix_fmt ${v.pix_fmt}`);
  if (expectAudio && !a) issues.push('no audio stream (expected music/voiceover)');
  if (!expectAudio && a) warnings.push('audio present but none expected');
  if (a && Math.abs(Number(a.duration ?? dur) - dur) > 0.25) issues.push(`audio/video length mismatch ${Number(a.duration).toFixed(2)}s vs ${dur.toFixed(2)}s`);
  if (expected != null && Math.abs(dur - expected) > 0.5) issues.push(`duration ${dur.toFixed(2)}s vs expected ${expected}s`);

  const det = spawnSync(FFMPEG, ['-i', f, '-vf', 'blackdetect=d=0.8:pix_th=0.05,freezedetect=n=0.001:d=3', '-an', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
  for (const m of det.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)) issues.push(`black frames ${m[1]}–${m[2]}s`);
  // Static scenes (motion "none") legitimately freeze; agent must confirm on the contact sheet.
  for (const m of det.matchAll(/freeze_start: ([\d.]+)/g)) warnings.push(`frozen video from ${m[1]}s — confirm on contact sheet it is intentional`);
  if (a) {
    const vol = spawnSync(FFMPEG, ['-i', f, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const max = Number(vol.match(/max_volume: (-?[\d.]+) dB/)?.[1]);
    const mean = Number(vol.match(/mean_volume: (-?[\d.]+) dB/)?.[1]);
    if (max >= 0) issues.push(`audio clipping (max ${max} dB)`);
    if (expectAudio && mean < -50) issues.push(`audio near-silent (mean ${mean} dB)`);
  }
  return { pass: issues.length === 0, duration: dur, sizeMB: +(probe.format.size / 1e6).toFixed(2), audio: !!a, issues, warnings };
}

// Audio is expected unless music is "none" and no narration is in use.
export function expectsAudio(flowDir, sb) {
  return sb.music !== 'none' || Object.values(resolveNarration(flowDir, sb).files).some(Boolean);
}

// Mono 8 kHz float PCM of [start, start+len) of any audio/video file.
function pcm(f, start, len) {
  const r = spawnSync(FFMPEG, ['-v', 'error', ...(start != null ? ['-ss', String(start), '-t', String(len)] : []), '-i', f, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const b = r.stdout ?? Buffer.alloc(0);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}
// Best normalised cross-correlation of `ref` inside `sig` within ±maxLag samples (1 = identical waveform).
export function similarity(sig, ref, maxLag = 800) {
  let best = 0;
  const e = (a, o, n) => { let x = 0; for (let i = 0; i < n; i++) x += a[i + o] ** 2; return x; };
  for (let lag = -maxLag; lag <= maxLag; lag += 2) {
    const o1 = Math.max(0, lag), o2 = Math.max(0, -lag);
    const n = Math.min(sig.length - o1, ref.length - o2);
    if (n < 800) continue;
    let dot = 0;
    for (let i = 0; i < n; i++) dot += sig[i + o1] * ref[i + o2];
    const c = dot / Math.sqrt(e(sig, o1, n) * e(ref, o2, n) || 1);
    if (c > best) best = c;
  }
  return best;
}
// Each narrated scene's speech must really be in the exported audio, at its scene's position:
// the narration waveform is matched against that window of the video's audio track (music bed included).
export function checkNarration(video, flowDir, sb, renderScenes, min = 0.5) {
  const issues = [];
  const narr = resolveNarration(flowDir, sb).files;
  const result = {};
  for (const sc of renderScenes ?? []) {
    if (!narr[sc.id]) continue;
    const ref = pcm(narr[sc.id]);
    const len = Math.min(sc.duration, ref.length / 8000);
    const sig = pcm(video, sc.start, len + 0.1);
    const c = +similarity(sig, ref.subarray(0, Math.floor(len * 8000))).toFixed(3);
    result[sc.id] = c;
    if (!(c >= min)) issues.push(`narration for scene ${sc.id} not found in the exported audio at ${sc.start}s (match ${c} < ${min})`);
  }
  return { issues, match: result };
}

// Every capture scene needs a screenshot that passed capture.mjs verification, unmodified since,
// at the format's exact pixel size, on baseUrl's origin, not blank, and not a duplicate of another scene.
export function checkCaptures(flowDir, sb) {
  const issues = [];
  const warnings = [];
  const origin = new URL(sb.baseUrl).origin;
  const ids = sb.scenes.map((s) => s.id);
  for (const id of new Set(ids.filter((x, i) => ids.indexOf(x) !== i))) issues.push(`duplicate scene id "${id}" in storyboard`);
  for (const [fmt, [W, H]] of Object.entries(SPEC)) {
    const seen = new Map();
    for (const s of sb.scenes.filter((s) => s.type === 'capture')) {
      const png = path.join(flowDir, 'captures', fmt, `${s.id}.png`);
      const metaPath = path.join(flowDir, 'captures', fmt, `${s.id}.json`);
      if (!fs.existsSync(png) || !fs.existsSync(metaPath)) { issues.push(`${fmt}/${s.id}: no verified capture (missing scene)`); continue; }
      const m = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const digest = sha(png);
      if (!m.sha256) issues.push(`${fmt}/${s.id}: capture predates verification — re-run capture.mjs`);
      else if (m.sha256 !== digest) issues.push(`${fmt}/${s.id}: screenshot changed after verification`);
      const { width, height } = pngSize(png);
      if (Math.abs(width - W) > 1 || Math.abs(height - H) > 1) issues.push(`${fmt}/${s.id}: capture is ${width}x${height}, expected ${W}x${H}`);
      if (new URL(m.url).origin !== origin) issues.push(`${fmt}/${s.id}: captured ${m.url}, outside ${origin}`);
      if (!(s.allow ?? []).includes('blank') && entropy(png) < 0.001) issues.push(`${fmt}/${s.id}: blank screenshot (uniform image)`);
      if (seen.has(digest) && !(s.allow ?? []).includes('duplicate')) issues.push(`${fmt}/${s.id}: identical to scene ${seen.get(digest)} (failed interaction or duplicated scene?)`);
      seen.set(digest, s.id);
      // Provenance from the reuse cache: must say how the screenshot was produced; never from another flow's file.
      if (m.provenance && !['captured', 'reused'].includes(m.provenance.source)) issues.push(`${fmt}/${s.id}: unknown capture provenance`);
      if (m.provenance?.source === 'reused' && !/^[0-9a-f]{16}$/.test(m.provenance.key ?? '')) issues.push(`${fmt}/${s.id}: reused capture without a cache key`);
      for (const w of m.warnings ?? []) warnings.push(`${fmt}/${s.id}: ${w}`);
    }
  }
  return { issues, warnings };
}

// The rendered file must match the CURRENT storyboard + captures, scene by scene, in order.
export function checkRender(flowDir, sb, fmt) {
  const issues = [];
  const manifestPath = path.join(flowDir, 'out', `${fmt}.render.json`);
  const video = path.join(flowDir, 'out', `${fmt}.mp4`);
  if (!fs.existsSync(manifestPath)) return [`${fmt}: no render manifest — re-render`];
  const r = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (r.storyboardSha !== sha(path.join(flowDir, 'storyboard.json'))) issues.push(`${fmt}: storyboard changed since render (stale video)`);
  const want = sb.scenes.map((s) => s.id).join(',');
  const got = r.scenes.map((s) => s.id).join(',');
  if (want !== got) issues.push(`${fmt}: scene order/list ${got} != storyboard ${want}`);
  for (const sc of r.scenes) {
    if (!fs.existsSync(sc.source)) { issues.push(`${fmt}/${sc.id}: source missing`); continue; }
    if (sha(sc.source) !== sc.sourceSha) issues.push(`${fmt}/${sc.id}: capture changed since render (stale video)`);
    const d = mad(fingerprint(video, sc.start + sc.duration / 2), sc.fp);
    if (d > SAME) issues.push(`${fmt}/${sc.id}: video frame doesn't match rendered scene (diff ${d.toFixed(1)}) — file replaced or corrupted`);
  }
  // Adjacent scenes rendering to the same picture usually means a failed interaction.
  r.scenes.forEach((sc, i) => {
    const next = r.scenes[i + 1];
    // The 64x36 thumbnail can't see small differences on sparse pages (e.g. only the heading changes), so confirm
    // on the source screenshots: identical = under 0.05% of pixels clearly changed at 256x144 (distinct pages: ~0.25%+).
    if (next && sc.type === 'capture' && next.type === 'capture' && mad(sc.fp, next.fp) < 0.5
      && fs.existsSync(sc.source) && fs.existsSync(next.source) && changedFraction(fingerprint(sc.source, null, 256, 144), fingerprint(next.source, null, 256, 144)) < 0.0005) {
      issues.push(`${fmt}: scenes ${sc.id} and ${next.id} look identical`);
    }
  });
  return issues;
}

// Every scene of every flow must appear in the combined file at its expected offset, in the given order.
export function checkCombined(file, flows) {
  const issues = [];
  let offset = 0;
  for (const e of flows) {
    for (const sc of e.scenes) {
      const d = mad(fingerprint(file, offset + sc.start + sc.duration / 2), sc.fp);
      if (d > SAME * 2) issues.push(`${e.flow}/${sc.id} not found at ${(offset + sc.start).toFixed(1)}s (diff ${d.toFixed(1)}) — wrong order or missing scene`);
    }
    offset += e.duration;
  }
  return issues;
}

// Labelled contact sheet: one tile per scene at its midpoint, with id, type and source URL/caption.
export async function contactSheet(video, scenes, out, W, H, labels = {}) {
  const { chromium } = await import('playwright');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-sheet-'));
  try {
    const tiles = scenes.map((sc, i) => {
      const f = path.join(tmp, `${i}.png`);
      execFileSync(FFMPEG, ['-v', 'error', '-ss', String(sc.start + sc.duration / 2), '-i', video, '-frames:v', '1', '-vf', `scale=${W > H ? 480 : 240}:-2`, f]);
      return { src: `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`, label: `${i + 1}. ${sc.id} · ${sc.type} · ${sc.start.toFixed(1)}s`, sub: labels[sc.id] ?? '' };
    });
    const cols = Math.min(tiles.length, W > H ? 4 : 6);
    const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const html = `<body style="margin:0;background:#111;color:#eee;font:13px system-ui"><div style="display:grid;grid-template-columns:repeat(${cols},auto);gap:8px;padding:8px;width:max-content">${tiles.map((t) => `<figure style="margin:0"><img src="${t.src}" style="display:block;border:1px solid #333"><figcaption style="padding:4px 2px;max-width:${W > H ? 480 : 240}px"><b>${esc(t.label)}</b><br><span style="color:#aaa">${esc(t.sub)}</span></figcaption></figure>`).join('')}</div></body>`;
    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 400, height: 300 } });
    await page.setContent(html);
    await page.waitForFunction(() => [...document.images].every((i) => i.complete));
    await page.locator('div').first().screenshot({ path: out });
    await browser.close();
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// realpath: argv[1] may go through a symlink (macOS /var -> /private/var) while import.meta.url is resolved.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const bin of [FFMPEG, FFPROBE]) {
    const r = spawnSync(bin, ['-version']);
    if (r.error) { console.error(`qa failed: ${explainSpawnError(r.error, bin) ?? r.error.message}`); process.exit(1); }
  }
  const flowDir = path.resolve(process.argv[2]);
  try {
    assertNoSymlinks(outputBase(flowDir), [path.join(flowDir, 'qa.json'), path.join(flowDir, 'out', 'landscape-sheet.png'), path.join(flowDir, 'out', 'vertical-sheet.png')]);
  } catch (e) { console.error(`qa refused: ${e.message}`); process.exit(2); }
  const sb = JSON.parse(fs.readFileSync(path.join(flowDir, 'storyboard.json'), 'utf8'));
  try { assertSafeNames((sb.scenes ?? []).map((s) => s.id), 'scene id'); } catch (e) { console.error(`qa refused: ${e.message}`); process.exit(2); }
  const expected = sb.scenes.reduce((a, s) => a + Number(s.duration ?? 3), 0);
  const expectAudio = expectsAudio(flowDir, sb);
  const caps = checkCaptures(flowDir, sb);
  const results = {};
  for (const [fmt, [W, H]] of Object.entries(SPEC)) {
    const r = checkVideo(path.join(flowDir, 'out', `${fmt}.mp4`), { W, H, expected, expectAudio });
    if (fs.existsSync(path.join(flowDir, 'out', `${fmt}.mp4`))) {
      r.issues.push(...checkRender(flowDir, sb, fmt));
      const manifestPath = path.join(flowDir, 'out', `${fmt}.render.json`);
      const narrErrors = resolveNarration(flowDir, sb).errors;
      r.issues.push(...narrErrors);
      if (fs.existsSync(manifestPath) && !narrErrors.length) {
        const n = checkNarration(path.join(flowDir, 'out', `${fmt}.mp4`), flowDir, sb, JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scenes);
        r.issues.push(...n.issues);
        if (Object.keys(n.match).length) r.narrationMatch = n.match;
      }
      if (fs.existsSync(manifestPath)) {
        const labels = {};
        for (const s of sb.scenes) {
          const meta = path.join(flowDir, 'captures', fmt, `${s.id}.json`);
          labels[s.id] = [fs.existsSync(meta) ? JSON.parse(fs.readFileSync(meta, 'utf8')).url : '', s.caption ?? s.text ?? ''].filter(Boolean).join(' · ');
        }
        r.sheet = path.join(flowDir, 'out', `${fmt}-sheet.png`);
        await contactSheet(path.join(flowDir, 'out', `${fmt}.mp4`), JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scenes, r.sheet, W, H, labels);
      }
    }
    r.pass = r.issues.length === 0;
    results[fmt] = r;
  }
  const report = {
    flow: sb.flow, checkedAt: new Date().toISOString(),
    pass: caps.issues.length === 0 && Object.values(results).every((r) => r.pass),
    captureIssues: caps.issues, captureWarnings: caps.warnings, results,
    reviewRequired: 'Open each sheet: automated checks cannot judge content correctness, PII, or whether the scene shows what the caption claims.',
  };
  fs.writeFileSync(path.join(flowDir, 'qa.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

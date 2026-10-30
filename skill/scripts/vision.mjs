// Dependency-free image helpers (ffmpeg + Node) shared by capture/render/qa/export.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FFMPEG } from './platform.mjs';

export const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function pngSize(f) {
  const b = fs.readFileSync(f);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// Normalized luma entropy 0..1. Solid/blank frames ~0; sparse real UIs ~0.05+.
export function entropy(f) {
  const out = execFileSync(FFMPEG, ['-v', 'error', '-i', f, '-vf', 'format=gray,entropy,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-'], { encoding: 'utf8' });
  return Number(out.match(/normalized_entropy\.normal\.Y=([\d.]+)/)?.[1] ?? 0);
}

// 64x36 grayscale thumbnail of an image, or of a video frame at time t (seconds).
// SSIM can't tell two mostly-white app pages apart (~0.98); raw-pixel MAD can.
export const FP_W = 64, FP_H = 36;
export function fingerprint(f, t, w = FP_W, h = FP_H) {
  const args = ['-v', 'error', ...(t != null ? ['-ss', String(t)] : []), '-i', f, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-'];
  return execFileSync(FFMPEG, args, { maxBuffer: 1 << 20 });
}

// Mean absolute difference, 0 (identical) .. 255.
export function mad(a, b) {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a, 'base64');
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b, 'base64');
  let s = 0;
  for (let i = 0; i < x.length; i++) s += Math.abs(x[i] - y[i]);
  return s / x.length;
}

// Fraction of pixels whose luma differs by more than `thr`. Unlike MAD this doesn't dilute a small but
// clear change (e.g. a different heading on an otherwise identical sparse page): distinct pages ~0.25%+, identical 0.
export function changedFraction(a, b, thr = 24) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > thr) n++;
  return n / a.length;
}

// WCAG contrast ratio between two #rrggbb colors.
export function contrast(c1, c2) {
  const lum = (c) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [a, b] = [lum(c1), lum(c2)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
}

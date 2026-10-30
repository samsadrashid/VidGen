// Cross-platform helpers: executable discovery, path normalization, ffmpeg concat escaping, friendly spawn errors.
import fs from 'node:fs';
import path from 'node:path';

const isWin = process.platform === 'win32';

// Find an executable on PATH (honours PATHEXT on Windows). Returns absolute path or null.
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
export function which(name, env = process.env, platform = process.platform, exists = isFile) {
  const isWin = platform === 'win32';
  const P = isWin ? path.win32 : path;
  if (P.isAbsolute(name) || name.includes('/') || name.includes('\\')) return fs.existsSync(name) ? name : null;
  const exts = isWin ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(P.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = P.join(dir, isWin && !P.extname(name) ? name + ext : name);
      if (exists(p)) return p;
    }
  }
  return null;
}

// ffmpeg/ffprobe: VIDGEN_FFMPEG / VIDGEN_FFPROBE override PATH lookup.
const resolveBin = (name, envVar) => process.env[envVar] || which(name) || name;
export const FFMPEG = resolveBin('ffmpeg', 'VIDGEN_FFMPEG');
export const FFPROBE = resolveBin('ffprobe', 'VIDGEN_FFPROBE');

// Turn ENOENT/EACCES from spawn into an actionable message.
export function explainSpawnError(e, bin) {
  if (e?.code === 'ENOENT') return `${bin} not found — install ffmpeg (macOS: brew install ffmpeg · Debian/Ubuntu: sudo apt install ffmpeg · Windows: winget install Gyan.FFmpeg) or set VIDGEN_FFMPEG/VIDGEN_FFPROBE to its full path. Run "node <skill>/scripts/doctor.mjs" to check.`;
  if (e?.code === 'EACCES') return `${bin} is not executable (EACCES) — check its permissions`;
  return null;
}

// Project-relative path with forward slashes on every OS (stable for regexes, manifests and caches).
export const toPosix = (p) => p.split(path.sep).join('/');
export const relPosix = (from, to) => toPosix(path.relative(from, to));

// One line of an ffmpeg concat-demuxer list. The demuxer treats ' and \ specially; forward slashes work on Windows too.
export function concatEntry(file) {
  const p = file.replace(/\\/g, '/').replace(/'/g, "'\\''");
  return `file '${p}'`;
}

// Signals we can actually receive. On Windows only SIGINT (Ctrl-C) / SIGBREAK / SIGHUP (console close) are delivered;
// TerminateProcess (task manager, child.kill()) cannot be intercepted, so cleanup relies on staging dirs never being promoted.
export const INTERRUPT_SIGNALS = isWin ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];

// ---- output-path symlink guard ----------------------------------------------------------------------------
// Writers call this once, before their first write. The project root may itself be reached through a symlink
// (realpath'd here, which also normalises macOS /var -> /private/var); every component BELOW it, down to each
// output dir/file, is lstat'ed (never followed). A symlink anywhere there — .vidgen, flows/<flow>, captures/, out/,
// cache/, vidgen-export/, or a planted qa.json/manifest.json — means writes could land outside the project: refuse.
// Limitation: a check-then-write; it does not stop a concurrent attacker swapping a directory for a symlink later.
export class SymlinkError extends Error {}
export function assertNoSymlinks(base, targets) {
  const real = fs.realpathSync(base);
  for (const t of targets) {
    const rel = path.relative(base, t);
    if (rel === '' ) continue;
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new SymlinkError(`output path ${t} is outside ${base}`);
    let cur = real;
    for (const part of rel.split(path.sep).filter(Boolean)) {
      cur = path.join(cur, part);
      let st;
      try { st = fs.lstatSync(cur); } catch { break; } // doesn't exist yet: nothing below it can be a link
      if (st.isSymbolicLink()) throw new SymlinkError(`refusing to write through symlink ${toPosix(path.relative(real, cur))} (in ${real})`);
    }
  }
}
// <root>/.vidgen/flows/<flow> -> <root>; storyboards elsewhere -> their own directory.
export function outputBase(flowDir) {
  const parts = flowDir.split(path.sep);
  const i = parts.lastIndexOf('.vidgen');
  return i > 0 && parts[i + 1] === 'flows' && parts.length === i + 3 ? parts.slice(0, i).join(path.sep) || path.sep : flowDir;
}

// ---- names that become file names ---------------------------------------------------------------------------
// Scene ids and flow names are used verbatim in paths (captures/<id>.png, audio/<id>.aiff, vidgen-export/<flow>-…).
// Without this, an id like "../../x" escapes the project — and capture/voiceover *delete* "<id>.<ext>" files.
export const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function assertSafeNames(names, what) {
  const bad = names.filter((n) => typeof n !== 'string' || !SAFE_NAME.test(n));
  if (bad.length) throw new Error(`unsafe ${what} ${bad.map((n) => JSON.stringify(n)).join(', ')} — use letters, digits, "-" or "_" (max 64, no "/", "\\\\", ".." or leading ".")`);
}

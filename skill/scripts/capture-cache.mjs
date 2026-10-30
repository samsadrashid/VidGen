// Screenshot reuse cache for capture.mjs — conservative and verification-based.
//
// A cache hit NEVER skips work that defines the screen: the scene is always navigated, its actions run,
// and every auth/QA/assertion check passes first. Reuse only means: the fresh screenshot is byte-identical
// to a cached one taken under the same key, so the cached file (with its already-computed entropy) is
// reused instead of writing and re-analysing a new one. If pixels differ, the cache is never used.
//
// Layout: <project>/.vidgen/cache/captures/<fmt>/<key>.png + <key>.json   (under .vidgen/, git-ignored)
// New entries are staged in memory-listed temp files and committed only when the whole capture run
// completes without interruption; failed scenes are never cached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const CACHE_VERSION = 1;
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const h = (x) => crypto.createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));

// Any change to capture/verification logic invalidates every entry.
export const CODE_FINGERPRINT = h(['capture.mjs', 'auth.mjs', 'vision.mjs', 'capture-cache.mjs'].map((f) => fs.readFileSync(path.join(here, f))).join('\0')).slice(0, 16);

// Actions that can change client or server state. Pure waits/hover/scroll/waitFor don't survive the next navigation.
const MUTATING = new Set(['click', 'fill', 'tap', 'goto']);
export const mutatingSignature = (scene) => (scene.actions ?? []).filter((a) => MUTATING.has(a.do)).length
  ? { route: scene.route ?? null, actions: scene.actions } : null;

// Everything that can change what the screenshot shows. Values are hashed; the key file stores only hashes.
export function sceneKey({ fmt, fmtOpts, sb, auth, scene, prefix, sourceHash, identity, redactSelectors }) {
  const parts = {
    v: CACHE_VERSION, code: CODE_FINGERPRINT, source: sourceHash,
    origin: new URL(sb.baseUrl).origin, fmt, device: fmtOpts,
    identity, // "anonymous" or a hash of the signed-in account's visible identity — never cookies/tokens
    auth: auth ? { loginPatterns: auth.loginPatterns, loginSelectors: auth.loginSelectors, authenticated: auth.authenticated, forbidden: [auth.forbiddenSelectors, auth.forbiddenText] } : null,
    scene: {
      route: scene.route ?? null, actions: scene.actions ?? [], expect: scene.expect ?? null, allow: [...(scene.allow ?? [])].sort(),
      public: !!scene.public, loadingTimeout: scene.loadingTimeout ?? 10000,
    },
    redact: redactSelectors,
    prefix, // state-changing scenes that ran earlier in this flow + format
  };
  return h(parts).slice(0, 32);
}

export class CaptureCache {
  constructor(vidgenDir, { enabled = true } = {}) {
    this.root = path.join(vidgenDir, 'cache', 'captures');
    this.enabled = enabled;
    this.pending = []; // [{ fmt, key, png, meta }] committed only by commit()
  }

  // Returns { png, meta } for a valid entry, or { reason } explaining why there is none.
  lookup(fmt, key) {
    if (!this.enabled) return { reason: 'reuse disabled' };
    const png = path.join(this.root, fmt, `${key}.png`);
    const metaPath = path.join(this.root, fmt, `${key}.json`);
    if (!fs.existsSync(png) || !fs.existsSync(metaPath)) return { reason: 'cache miss' };
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const buf = fs.readFileSync(png);
      if (!buf.subarray(0, 8).equals(PNG_SIG)) return { reason: 'cache entry corrupt (not a PNG)' };
      if (meta.key !== key || meta.cacheVersion !== CACHE_VERSION) return { reason: 'cache entry mismatched' };
      if (h(buf) !== meta.sha256) return { reason: 'cache entry corrupt (checksum)' };
      return { png, meta };
    } catch {
      return { reason: 'cache entry corrupt (metadata)' };
    }
  }

  // Queue a verified, successful capture for the cache (copied now to a temp name, renamed on commit).
  stage(fmt, key, pngFile, meta) {
    if (!this.enabled) return;
    const dir = path.join(this.root, fmt);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${key}.${process.pid}.tmp`);
    fs.copyFileSync(pngFile, tmp);
    this.pending.push({ fmt, key, tmp, meta: { ...meta, key, cacheVersion: CACHE_VERSION, cachedAt: new Date().toISOString() } });
  }

  commit() {
    for (const p of this.pending) {
      const dir = path.join(this.root, p.fmt);
      fs.writeFileSync(path.join(dir, `.${p.key}.${process.pid}.json.tmp`), JSON.stringify(p.meta, null, 2));
      fs.renameSync(p.tmp, path.join(dir, `${p.key}.png`));
      fs.renameSync(path.join(dir, `.${p.key}.${process.pid}.json.tmp`), path.join(dir, `${p.key}.json`));
    }
    this.pending = [];
  }

  // Interrupted/failed runs: drop staged temp files, leave the committed cache untouched.
  discard() {
    for (const p of this.pending) fs.rmSync(p.tmp, { force: true });
    this.pending = [];
  }
}

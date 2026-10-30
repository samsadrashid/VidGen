#!/usr/bin/env node
// Local-first project scan + cache. Usage: context.mjs <project> --check | --scan
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { relPosix } from './platform.mjs';
import { analyze } from './frameworks.mjs';

const [root = '.', mode = '--check'] = process.argv.slice(2);
const abs = path.resolve(root);
const out = path.join(abs, '.vidgen', 'context.json');
const IGNORE = new Set(['node_modules', '.git', '.next', 'dist', 'build', '.vidgen', 'coverage', '.turbo', 'vendor', 'Pods']);
const SRC = /\.(tsx?|jsx?|vue|svelte|astro|css|scss|html|dart|swift)$/;

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORE.has(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function sourceHash(files) {
  const h = crypto.createHash('sha256');
  for (const f of files.filter((f) => SRC.test(f) || f.endsWith('package.json')).sort()) {
    const s = fs.statSync(f);
    h.update(`${relPosix(abs, f)}:${s.size}:${s.mtimeMs}`);
  }
  return h.digest('hex').slice(0, 16);
}

// Meta-frameworks first, then UI library; bundler reported separately ("react (vite)").
function detectFramework(pkg) {
  if (fs.existsSync(path.join(abs, 'pubspec.yaml'))) return /sdk:\s*flutter/.test(fs.readFileSync(path.join(abs, 'pubspec.yaml'), 'utf8')) ? 'flutter' : 'dart';
  const d = { ...pkg.dependencies, ...pkg.devDependencies };
  const fw = ['next', 'nuxt', '@sveltejs/kit', 'astro', '@remix-run/react', '@angular/core', 'react', 'vue', 'svelte', 'solid-js'].find((k) => d?.[k]);
  const bundler = ['vite', 'webpack', 'parcel'].find((k) => d?.[k]);
  if (!fw) return bundler ?? 'unknown';
  return bundler && !['next', 'nuxt', '@sveltejs/kit', 'astro'].includes(fw) ? `${fw} (${bundler})` : fw;
}

function tokens(files) {
  const t = { colors: {}, fonts: [] };
  for (const f of files.filter((f) => /(tailwind\.config|theme|tokens)|\.(css|scss)$/i.test(f))) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const m of txt.matchAll(/--([\w-]*(?:primary|background|accent|brand)[\w-]*):\s*([^;]+);/g)) t.colors[m[1]] = m[2].trim();
    for (const m of txt.matchAll(/font-?family[^:]*:\s*\[?\s*['"]?([^'",;\]\n]+)/gi)) t.fonts.push(m[1]);
  }
  t.fonts = [...new Set(t.fonts.map((x) => x.trim()))].filter((x) => !/^(inherit|initial|unset|revert|var\(.*)$/.test(x));
  return t;
}

const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : null;
const files = walk(abs);
const hash = sourceHash(files);

if (mode === '--check') {
  console.log(JSON.stringify({ exists: !!prev, fresh: prev?.sourceHash === hash, sourceHash: hash, path: out }));
  process.exit(0);
}

const pkgPath = path.join(abs, 'package.json');
const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, 'utf8')) : {};
const rels = files.map((f) => relPosix(abs, f));
const router = analyze({ pkg, deps: { ...pkg.dependencies, ...pkg.devDependencies }, rels, read: (r) => fs.readFileSync(path.join(abs, r), 'utf8') });
const ctx = {
  ...prev, // keep agent-enriched fields (product, flows, brand) across rescans
  sourceHash: hash,
  scannedAt: new Date().toISOString(),
  name: pkg.name || path.basename(abs),
  framework: detectFramework(pkg),
  // package.json scripts sometimes inline secrets (API_KEY=... next dev); never cache those values.
  scripts: Object.fromEntries(Object.entries(pkg.scripts || {}).map(([k, v]) => [k, String(v).replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|SESSION|COOKIE|CREDENTIAL)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=[redacted]')])),
  // Visitable routes only. Dynamic patterns (need real param values), excluded files (API, internal, slots) and
  // the adapter's confidence/ambiguity are reported under "router" so the agent never guesses.
  routes: router.routes.static,
  router: { adapter: router.framework, confidence: router.confidence, ambiguous: router.ambiguous, dynamic: router.routes.dynamic, excluded: router.routes.excluded, note: router.routes.note ?? null },
  dev: router.dev,
  // Match on project-relative POSIX paths: absolute paths break on Windows and when a parent dir is named "assets" etc.
  components: rels.filter((f) => /(^|\/)components?\//.test(f) && /\.(tsx|jsx|vue|svelte)$/.test(f)).slice(0, 200),
  layouts: rels.filter((f) => /(^|\/)(layout|App|_app|root)\.(tsx?|jsx?|vue|svelte)$/.test(f)),
  tokens: tokens(files),
  assets: rels.filter((f) => /\.(svg|png|jpe?g|webp|ico)$/.test(f) && /(^|\/)(public|assets|static)\//.test(f)).slice(0, 100),
  readme: ['README.md', 'readme.md'].find((n) => fs.existsSync(path.join(abs, n))) ?? null,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(ctx, null, 2));
console.log(JSON.stringify({ written: out, framework: ctx.framework, routes: ctx.routes.length, components: ctx.components.length }));

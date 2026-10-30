#!/usr/bin/env node
// Optional external context providers. OFF by default; local analysis (context.mjs) stays authoritative.
//
//   external.mjs <project> --plan                         what each provider WOULD receive. No network access.
//   external.mjs <project> --run <provider> --authorize "<provider>:<target>"
//                                                         run ONE provider; the authorize string must equal the
//                                                         "authorize" value printed by --plan for that provider.
// Providers (documented access paths only, see references/external-context.md):
//   deepwiki    MCP server https://mcp.deepwiki.com/mcp  — receives only "owner/repo" of a PUBLIC GitHub repo
//   gitdiagram  MCP server https://gitdiagram.com/mcp     — receives only "owner/repo" of a PUBLIC GitHub repo
//   gitingest   local `gitingest` CLI (if installed) run on a SANITIZED COPY of the project (secrets/env/auth
//               material removed by VidGen first). Its own network behaviour is undocumented: treated as external.
// Output: .vidgen/external/<provider>.json, marked trust "unverified-external", plus a summary in context.json.
// Exit: 0 ok, 2 usage, 3 not authorized, 4 blocked (private/unknown repo, unsupported host, tool missing), 5 provider failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { which, relPosix } from './platform.mjs';
import { scrub } from './auth.mjs';

const ENDPOINTS = {
  deepwiki: process.env.VIDGEN_DEEPWIKI_MCP_URL || 'https://mcp.deepwiki.com/mcp',
  gitdiagram: process.env.VIDGEN_GITDIAGRAM_MCP_URL || 'https://gitdiagram.com/mcp',
  githubApi: process.env.VIDGEN_GITHUB_API || 'https://api.github.com',
};
const TIMEOUT = Number(process.env.VIDGEN_EXTERNAL_TIMEOUT_MS) || 20_000;
const MAX_CONTENT = 200_000; // chars kept per provider result
class Blocked extends Error { constructor(m) { super(m); this.code = 4; } }
class ProviderError extends Error { constructor(m) { super(m); this.code = 5; } }

// ---------- what may never leave the machine ----------
const SECRET_FILE = /(^|\/)(\.env(\..*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|jks|keystore|crt|cer|der|sqlite3?|db)|credentials(\..*)?|secrets?(\..*)?|.*storage-?state.*\.json|service-account.*\.json)$/i;
const SKIP_DIR = /(^|\/)(\.git|\.vidgen|node_modules|\.auth|playwright\/\.auth|\.next|\.svelte-kit|dist|build|coverage|vidgen-export|\.venv|venv|__pycache__)(\/|$)/;
const SECRET_CONTENT = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}\b|\bxox[baprs]-[A-Za-z0-9-]{10,}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}|\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[:=]\s*['"]?[^\s'"]{8,})/;

function walk(root, dir = root, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    const rel = relPosix(root, p);
    if (SKIP_DIR.test(rel)) continue;
    if (e.isDirectory()) walk(root, p, acc);
    else if (e.isFile()) acc.push(rel);
  }
  return acc;
}

// Files gitingest may see, and the ones withheld (with the reason — names only, never contents).
export function sanitizeSelection(root) {
  const allowed = [], withheld = [];
  for (const rel of walk(root)) {
    if (SECRET_FILE.test(rel)) { withheld.push({ file: rel, reason: 'secret/credential file name' }); continue; }
    const st = fs.statSync(path.join(root, rel));
    if (st.size > 512 * 1024) { withheld.push({ file: rel, reason: 'larger than 512 KB' }); continue; }
    const buf = fs.readFileSync(path.join(root, rel));
    if (buf.includes(0)) { withheld.push({ file: rel, reason: 'binary' }); continue; }
    if (SECRET_CONTENT.test(buf.toString('utf8'))) { withheld.push({ file: rel, reason: 'contains something that looks like a secret' }); continue; }
    allowed.push(rel);
  }
  return { allowed, withheld };
}

// ---------- repository identity & visibility ----------
export function githubRemote(root) {
  try {
    const cfg = fs.readFileSync(path.join(root, '.git', 'config'), 'utf8');
    const url = /\[remote "origin"\][^[]*?url\s*=\s*(\S+)/.exec(cfg)?.[1];
    const m = url && /github\.com[:/]([\w.-]+)\/([\w.-]+?)(\.git)?$/.exec(url);
    return m ? { owner: m[1], repo: m[2], slug: `${m[1]}/${m[2]}` } : url ? { unsupported: url.replace(/\/\/[^@/]+@/, '//***@') } : null;
  } catch { return null; }
}

async function fetchT(url, init = {}) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT) });
  } catch (e) {
    throw new ProviderError(e.name === 'TimeoutError' ? `timed out after ${TIMEOUT / 1000}s (${new URL(url).host})` : `network error contacting ${new URL(url).host}: ${e.cause?.code ?? e.message}`);
  }
}

// Public only if GitHub itself says so. 404/401/403 = private, missing, or unknowable without credentials -> blocked.
async function assertPublic(slug) {
  const res = await fetchT(`${ENDPOINTS.githubApi}/repos/${slug}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'vidgen' } });
  if (res.status === 200) {
    const j = await res.json().catch(() => null);
    if (j?.private === false && j?.visibility !== 'private' && j?.visibility !== 'internal') return { default_branch: j.default_branch };
    throw new Blocked(`${slug} is not public — nothing will be sent`);
  }
  if (res.status === 403 || res.status === 429) throw new ProviderError(`GitHub visibility check rate-limited (HTTP ${res.status}); try later — nothing was sent to any provider`);
  throw new Blocked(`GitHub returned HTTP ${res.status} for ${slug}: private, renamed or nonexistent — treated as private, nothing sent`);
}

// ---------- minimal MCP (Streamable HTTP) client ----------
async function mcp(url) {
  let session = null, id = 0;
  async function rpc(method, params, notify = false) {
    const res = await fetchT(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(session ? { 'mcp-session-id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notify ? {} : { id: ++id }), method, ...(params ? { params } : {}) }),
    });
    if (res.status === 429) throw new ProviderError(`rate limited by ${new URL(url).host} (HTTP 429${res.headers.get('retry-after') ? `, retry after ${res.headers.get('retry-after')}s` : ''})`);
    if (res.status >= 500) throw new ProviderError(`${new URL(url).host} unavailable (HTTP ${res.status})`);
    if (!res.ok && !(notify && res.status === 202)) throw new ProviderError(`${new URL(url).host} rejected ${method} (HTTP ${res.status})`);
    session = res.headers.get('mcp-session-id') ?? session;
    if (notify) return null;
    const text = await res.text();
    let msg;
    try {
      msg = (res.headers.get('content-type') ?? '').includes('text/event-stream')
        ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))).find((m) => m.id === id)
        : JSON.parse(text);
    } catch { throw new ProviderError(`malformed response from ${new URL(url).host} to ${method}`); }
    if (!msg || typeof msg !== 'object') throw new ProviderError(`malformed response from ${new URL(url).host} to ${method}`);
    if (msg.error) throw new ProviderError(`${new URL(url).host} error for ${method}: ${scrub(msg.error.message ?? JSON.stringify(msg.error)).slice(0, 200)}`);
    return msg.result;
  }
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vidgen', version: '0.2' } });
  await rpc('notifications/initialized', null, true);
  const tools = (await rpc('tools/list'))?.tools;
  if (!Array.isArray(tools)) throw new ProviderError(`malformed tools/list from ${new URL(url).host}`);
  return { tools, call: (name, args) => rpc('tools/call', { name, arguments: args }) };
}

// Fill a tool's single required string argument with the repo identifier, using the SERVER's schema.
// Several required args, or none, = we don't know what it wants: refuse instead of guessing.
function repoArgs(tool, gh) {
  const req = tool.inputSchema?.required ?? [];
  const props = tool.inputSchema?.properties ?? {};
  if (req.length !== 1 || props[req[0]]?.type !== 'string') throw new ProviderError(`tool ${tool.name} has an unexpected input schema (${JSON.stringify(req)}); not calling it`);
  return { [req[0]]: /url/i.test(req[0]) ? `https://github.com/${gh.slug}` : gh.slug };
}
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

const PROVIDERS = {
  deepwiki: {
    host: () => new URL(ENDPOINTS.deepwiki).host, kind: 'remote',
    async run(gh) {
      const s = await mcp(ENDPOINTS.deepwiki);
      const tool = s.tools.find((t) => t.name === 'read_wiki_contents') ?? s.tools.find((t) => t.name === 'read_wiki_structure');
      if (!tool) throw new ProviderError(`DeepWiki MCP did not offer read_wiki_contents/read_wiki_structure (got: ${s.tools.map((t) => t.name).join(', ')})`);
      const r = await s.call(tool.name, repoArgs(tool, gh));
      if (r?.isError) throw new ProviderError(`DeepWiki ${tool.name} failed: ${scrub(textOf(r)).slice(0, 200)}`);
      return { tool: tool.name, content: textOf(r) };
    },
  },
  gitdiagram: {
    host: () => new URL(ENDPOINTS.gitdiagram).host, kind: 'remote',
    async run(gh) {
      const s = await mcp(ENDPOINTS.gitdiagram);
      // get_repository_diagram is the tool GitDiagram's live tools/list returned on 2026-10-29 ("architecture ... a written
      // explanation"). Prefer it by exact name; otherwise accept only a single explain/architecture/diagram tool.
      const exact = s.tools.filter((t) => t.name === 'get_repository_diagram');
      const cands = exact.length ? exact : s.tools.filter((t) => /explain|architecture|diagram/i.test(`${t.name} ${t.description ?? ''}`));
      if (cands.length !== 1) throw new ProviderError(`GitDiagram MCP tools are not unambiguous (${s.tools.map((t) => t.name).join(', ') || 'none'}); not guessing which to call`);
      const r = await s.call(cands[0].name, repoArgs(cands[0], gh));
      if (r?.isError) throw new ProviderError(`GitDiagram ${cands[0].name} failed: ${scrub(textOf(r)).slice(0, 200)}`);
      return { tool: cands[0].name, content: textOf(r) };
    },
  },
  gitingest: {
    host: () => 'local gitingest CLI', kind: 'local-tool',
    async run(_gh, root) {
      const bin = process.env.VIDGEN_GITINGEST_BIN || which('gitingest');
      if (!bin) throw new Blocked('gitingest CLI not installed (pip install gitingest) — nothing run');
      const { allowed } = sanitizeSelection(root);
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-gitingest-'));
      try {
        for (const rel of allowed) { fs.mkdirSync(path.dirname(path.join(stage, rel)), { recursive: true }); fs.copyFileSync(path.join(root, rel), path.join(stage, rel)); }
        // Live test (2026-10-29, gitingest 0.3.1): the CLI tries to fetch tiktoken data from
        // openaipublic.blob.core.windows.net even for a local directory, and works without it. Point every proxy
        // variable at a dead local port so proxy-aware HTTP clients fail fast (best effort, not a sandbox), drop
        // credential variables, and run from the empty staging dir so python-dotenv can't pick up a project .env.
        const dead = 'http://127.0.0.1:9';
        const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|^AWS_|^GH_|^GITHUB_/i.test(k)));
        Object.assign(env, { HTTP_PROXY: dead, HTTPS_PROXY: dead, ALL_PROXY: dead, http_proxy: dead, https_proxy: dead, all_proxy: dead, NO_PROXY: '', no_proxy: '' });
        const r = spawnSync(bin, [stage, '-o', '-'], { cwd: stage, encoding: 'utf8', timeout: TIMEOUT, maxBuffer: 64 << 20, env });
        if (r.error?.code === 'ETIMEDOUT') throw new ProviderError(`gitingest timed out after ${TIMEOUT / 1000}s`);
        if (r.status !== 0) throw new ProviderError(`gitingest exited ${r.status}: ${scrub(r.stderr).slice(0, 200)}`);
        return { tool: 'gitingest <sanitized copy> -o -', content: r.stdout, filesProvided: allowed.length };
      } finally { fs.rmSync(stage, { recursive: true, force: true }); }
    },
  },
};

// ---------- plan: exactly what would be sent, no network ----------
export function plan(root) {
  const gh = githubRemote(root);
  const sel = sanitizeSelection(root);
  return Object.fromEntries(Object.entries(PROVIDERS).map(([name, p]) => {
    if (p.kind === 'local-tool') {
      const target = `local:${path.basename(root)}`;
      return [name, { receiver: p.host(), sends: `${sel.allowed.length} sanitized project files to the local gitingest CLI (its network behaviour is undocumented)`,
        withheld: sel.withheld, authorize: `${name}:${target}` }];
    }
    if (!gh || gh.unsupported) return [name, { receiver: p.host(), blocked: gh?.unsupported ? `origin is not GitHub (${gh.unsupported})` : 'no git remote "origin" — nothing can be sent' }];
    return [name, { receiver: p.host(), sends: `only the repository name "${gh.slug}" (no files, no local changes); describes GitHub's copy, which may differ from your working tree`,
      requires: `GitHub must report ${gh.slug} as public (checked via ${new URL(ENDPOINTS.githubApi).host} at run time)`, authorize: `${name}:${gh.slug}` }];
  }));
}

// Claims in external text that can be checked locally: file paths and routes.
function verify(root, content) {
  const ctx = (() => { try { return JSON.parse(fs.readFileSync(path.join(root, '.vidgen', 'context.json'), 'utf8')); } catch { return {}; } })();
  // Providers answer in markdown: split "[label](target)" links first so "a.js](b/a.js" never becomes one path.
  const scan = content.replace(/\]\(/g, ' ').replace(/\)(?=\s|$|[,.;:])/g, ' ');
  const files = [...new Set([...scan.matchAll(/\b((?:src|app|pages|lib|components|routes)\/[\w./\[\]()@+-]+\.\w{1,6})\b/g)].map((m) => m[1]))].slice(0, 200);
  const routes = [...new Set([...content.matchAll(/`(\/[\w\-/[\]]*)`/g)].map((m) => m[1]))].slice(0, 200);
  const known = new Set([...(ctx.routes ?? []), ...(ctx.router?.dynamic ?? []).map((d) => d.pattern)]);
  return {
    files: { confirmed: files.filter((f) => fs.existsSync(path.join(root, f))), notFoundLocally: files.filter((f) => !fs.existsSync(path.join(root, f))) },
    routes: { confirmed: routes.filter((r) => known.has(r)), notInLocalAnalysis: routes.filter((r) => !known.has(r)) },
  };
}

async function runProvider(root, name, authorize) {
  const p = PROVIDERS[name];
  if (!p) throw Object.assign(new Error(`unknown provider "${name}" (deepwiki, gitdiagram, gitingest)`), { code: 2 });
  const pl = plan(root)[name];
  if (pl.blocked) throw new Blocked(pl.blocked);
  if (authorize !== pl.authorize) throw Object.assign(new Error(`not authorized: this transfer needs --authorize "${pl.authorize}" (receiver: ${pl.receiver}; sends: ${pl.sends})`), { code: 3 });
  const gh = githubRemote(root);
  if (p.kind === 'remote') await assertPublic(gh.slug);
  const out = await p.run(gh, root);
  const content = scrub(String(out.content ?? '')).slice(0, MAX_CONTENT);
  if (!content.trim()) throw new ProviderError(`${name} returned no usable content`);
  const record = {
    provider: name, trust: 'unverified-external', receiver: pl.receiver, sent: pl.sends, authorizedAs: authorize, tool: out.tool,
    fetchedAt: new Date().toISOString(), contentSha256: crypto.createHash('sha256').update(content).digest('hex'), truncated: String(out.content).length > MAX_CONTENT,
    localSourceHashAtFetch: (() => { try { return JSON.parse(fs.readFileSync(path.join(root, '.vidgen', 'context.json'), 'utf8')).sourceHash; } catch { return null; } })(),
    verification: verify(root, content), content,
  };
  const dir = path.join(root, '.vidgen', 'external');
  // Never write provider output through a symlink (e.g. a cloned repo shipping .vidgen -> elsewhere).
  for (const p of [path.join(root, '.vidgen'), dir, path.join(dir, `${name}.json`)]) {
    if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) throw new Blocked(`${path.relative(root, p)} is a symlink — refusing to write external results through it`);
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(record, null, 2));
  // Summary for the agent; local fields (routes, router, framework...) are never touched.
  const ctxPath = path.join(root, '.vidgen', 'context.json');
  if (fs.existsSync(ctxPath)) {
    const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
    ctx.external = { ...(ctx.external ?? {}), [name]: { status: 'ok', trust: 'unverified-external', file: `.vidgen/external/${name}.json`, fetchedAt: record.fetchedAt, verification: { filesConfirmed: record.verification.files.confirmed.length, filesNotFound: record.verification.files.notFoundLocally.length } } };
    fs.writeFileSync(ctxPath, JSON.stringify(ctx, null, 2));
  }
  return { provider: name, ok: true, file: path.join(dir, `${name}.json`), chars: content.length, verification: record.verification };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  const root = args[0] && !args[0].startsWith('--') ? path.resolve(args[0]) : null;
  if (!root || !fs.existsSync(root) || !(args.includes('--plan') || opt('--run'))) {
    console.error('usage: external.mjs <project> --plan | --run <deepwiki|gitdiagram|gitingest> --authorize "<provider>:<target>"');
    process.exit(2);
  }
  if (args.includes('--plan')) { console.log(JSON.stringify(plan(root), null, 2)); process.exit(0); }
  try {
    console.log(JSON.stringify(await runProvider(root, opt('--run'), opt('--authorize')), null, 2));
  } catch (e) {
    const msg = scrub(e.message);
    console.error(`external context (${opt('--run')}): ${msg}. Local analysis is unaffected.`);
    console.log(JSON.stringify({ provider: opt('--run'), ok: false, error: msg }));
    process.exit(e.code ?? 5);
  }
}

#!/usr/bin/env node
// External context providers, fully mocked (no real service is contacted, nothing is uploaded).
// Usage: node --test tests/external.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const K = path.join(repo, 'skill', 'scripts');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-ext-'));
const proj = path.join(tmp, 'proj');
let server, base;
const seen = []; // every request the mock receives: proves what was (not) sent
let mode = {}; // per-test behaviour of the mocks

// ---- mock GitHub API + MCP servers ----
function mcpReply(res, req, body, toolsFor) {
  const msg = JSON.parse(body);
  const send = (result) => {
    const payload = { jsonrpc: '2.0', id: msg.id, result };
    if (mode.sse) res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 's1' }).end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
    else res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 's1' }).end(JSON.stringify(payload));
  };
  if (msg.method === 'notifications/initialized') return res.writeHead(202).end();
  if (mode.status) return res.writeHead(mode.status, mode.status === 429 ? { 'retry-after': '30' } : {}).end('nope');
  if (mode.hang) return; // never answers -> client timeout
  if (mode.malformed && msg.method === 'tools/list') return res.writeHead(200, { 'content-type': 'application/json' }).end('{"not json');
  if (msg.method === 'initialize') return send({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock' } });
  if (msg.method === 'tools/list') return send({ tools: toolsFor() });
  if (msg.method === 'tools/call') return send({ content: [{ type: 'text', text: `Wiki for ${JSON.stringify(msg.params.arguments)}. Entry: [src/App.jsx](src/App.jsx), missing \`src/Ghost.tsx\`; routes \`/dashboard\` and \`/nowhere\`. token=supersecret123` }] });
}
before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ path: req.url, body });
      if (req.url.startsWith('/gh/repos/')) {
        const slug = req.url.slice('/gh/repos/'.length);
        if (slug === 'acme/public-app') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ private: false, visibility: 'public', default_branch: 'main' }));
        if (slug === 'acme/limited') return res.writeHead(403).end();
        return res.writeHead(404).end();
      }
      if (req.url === '/deepwiki') return mcpReply(res, req, body, () => [
        { name: 'read_wiki_structure', inputSchema: { type: 'object', properties: { repoName: { type: 'string' } }, required: ['repoName'] } },
        { name: 'read_wiki_contents', inputSchema: { type: 'object', properties: { repoName: { type: 'string' } }, required: ['repoName'] } }]);
      if (req.url === '/gitdiagram') return mcpReply(res, req, body, () => mode.live
        ? [{ name: 'get_repository_diagram', inputSchema: { required: ['repository'], properties: { repository: { type: 'string' } } } },
          { name: 'find_repository_diagrams', inputSchema: { required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'integer' } } } },
          { name: 'get_explainer_video', inputSchema: { required: ['repository'], properties: { repository: { type: 'string' } } } }]
        : mode.ambiguous
        ? [{ name: 'explain_architecture', inputSchema: { required: ['repo'], properties: { repo: { type: 'string' } } } }, { name: 'diagram', inputSchema: { required: ['repo'], properties: { repo: { type: 'string' } } } }]
        : [{ name: 'get_architecture_explanation', description: 'Explain a public repo', inputSchema: { type: 'object', properties: { repoUrl: { type: 'string' } }, required: ['repoUrl'] } }]);
      res.writeHead(404).end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Project with secrets that must never be sent anywhere.
  fs.cpSync(path.join(repo, 'tests', 'fixture', 'app'), proj, { recursive: true });
  fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/public-app.git\n');
  fs.writeFileSync(path.join(proj, '.env'), 'DATABASE_URL=postgres://u:p@h/db\n');
  fs.writeFileSync(path.join(proj, '.env.production'), 'STRIPE_KEY=sk_live_x\n');
  fs.writeFileSync(path.join(proj, 'deploy-key.pem'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
  fs.writeFileSync(path.join(proj, 'src', 'config.js'), "export const OPENAI = 'sk-abcdefghijklmnopqrstuvwxyz123456';\n");
  fs.mkdirSync(path.join(proj, 'playwright', '.auth'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'playwright', '.auth', 'user.json'), '{"cookies":[{"value":"sid-SECRET-1"}]}');
  fs.mkdirSync(path.join(proj, '.vidgen'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.vidgen', 'captured-private.json'), '{"x":1}');
  const r = await run('context.mjs', [proj, '--scan']);
  assert.equal(r.code, 0);
});
after(() => { server?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function run(script, args, env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(K, script), ...args], { env: { ...process.env, VIDGEN_GITHUB_API: `${base}/gh`, VIDGEN_DEEPWIKI_MCP_URL: `${base}/deepwiki`, VIDGEN_GITDIAGRAM_MCP_URL: `${base}/gitdiagram`, VIDGEN_EXTERNAL_TIMEOUT_MS: '2000', ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => { let json = null; try { json = JSON.parse(out); } catch { /* not json */ } resolve({ code, out, err, json }); });
  });
}
const extRun = (provider, authorize, env) => run('external.mjs', [proj, '--run', provider, ...(authorize ? ['--authorize', authorize] : [])], env);

test('off by default: local analysis never imports or calls the external module', () => {
  for (const f of ['context.mjs', 'capture.mjs', 'render.mjs', 'qa.mjs', 'export.mjs', 'frameworks.mjs']) {
    assert.ok(!fs.readFileSync(path.join(K, f), 'utf8').includes('external.mjs'), f);
  }
  const ctx = JSON.parse(fs.readFileSync(path.join(proj, '.vidgen', 'context.json'), 'utf8'));
  assert.equal(ctx.external, undefined);
});

test('--plan shows receiver, payload and required authorization, with no network access at all', async () => {
  const before = seen.length;
  const r = await run('external.mjs', [proj, '--plan'], { VIDGEN_GITHUB_API: 'http://127.0.0.1:9', VIDGEN_DEEPWIKI_MCP_URL: 'http://127.0.0.1:9', VIDGEN_GITDIAGRAM_MCP_URL: 'http://127.0.0.1:9' });
  assert.equal(r.code, 0, r.err);
  assert.equal(seen.length, before, 'no requests');
  assert.match(r.json.deepwiki.sends, /only the repository name "acme\/public-app"/);
  assert.equal(r.json.deepwiki.authorize, 'deepwiki:acme/public-app');
  assert.equal(r.json.gitdiagram.authorize, 'gitdiagram:acme/public-app');
  const withheld = r.json.gitingest.withheld.map((w) => w.file);
  for (const f of ['.env', '.env.production', 'deploy-key.pem', 'src/config.js']) assert.ok(withheld.includes(f), f);
  assert.ok(!JSON.stringify(r.json).includes('postgres://'), 'plan names files, never contents');
});

test('no transfer without the exact authorization; wrong target does not count', async () => {
  for (const auth of [null, 'deepwiki', 'deepwiki:acme/other', 'gitdiagram:acme/public-app']) {
    const before = seen.length;
    const r = await extRun('deepwiki', auth);
    assert.equal(r.code, 3, String(auth));
    assert.match(r.err, /not authorized: this transfer needs --authorize "deepwiki:acme\/public-app"/);
    assert.equal(seen.length, before, 'nothing contacted');
  }
});

test('private / unknown repositories are blocked even when authorized; only GitHub visibility check is contacted', async () => {
  fs.writeFileSync(path.join(proj, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/secret-app.git\n');
  try {
    const before = seen.length;
    const r = await extRun('deepwiki', 'deepwiki:acme/secret-app');
    assert.equal(r.code, 4);
    assert.match(r.err, /HTTP 404.*treated as private, nothing sent/);
    assert.deepEqual(seen.slice(before).map((s) => s.path), ['/gh/repos/acme/secret-app'], 'provider never contacted');
    fs.writeFileSync(path.join(proj, '.git', 'config'), '[remote "origin"]\n\turl = https://gitlab.com/acme/app.git\n');
    assert.equal((await extRun('deepwiki', 'deepwiki:acme/app')).code, 4);
    fs.writeFileSync(path.join(proj, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme/limited.git\n');
    const rl = await extRun('deepwiki', 'deepwiki:acme/limited');
    assert.equal(rl.code, 5);
    assert.match(rl.err, /rate-limited.*nothing was sent/);
  } finally {
    fs.writeFileSync(path.join(proj, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:acme/public-app.git\n');
  }
});

test('authorized public repo: DeepWiki (JSON and SSE) gets only the repo name; result stored as unverified + cross-checked locally', async () => {
  for (const sse of [false, true]) {
    mode = { sse };
    const before = seen.length;
    const r = await extRun('deepwiki', 'deepwiki:acme/public-app');
    assert.equal(r.code, 0, r.err);
    const sent = seen.slice(before).map((s) => s.body).join('\n');
    assert.match(sent, /"repoName":"acme\/public-app"/, 'parameter name came from the server schema');
    for (const leak of ['postgres://', 'sk_live', 'PRIVATE KEY', 'sid-SECRET', 'sk-abcdef', 'App.jsx"', 'dashboard']) assert.ok(!sent.includes(leak), leak);
  }
  mode = {};
  const rec = JSON.parse(fs.readFileSync(path.join(proj, '.vidgen', 'external', 'deepwiki.json'), 'utf8'));
  assert.equal(rec.trust, 'unverified-external');
  assert.equal(rec.authorizedAs, 'deepwiki:acme/public-app');
  assert.deepEqual(rec.verification.files, { confirmed: ['src/App.jsx'], notFoundLocally: ['src/Ghost.tsx'] });
  assert.deepEqual(rec.verification.routes, { confirmed: ['/dashboard'], notInLocalAnalysis: ['/nowhere'] });
  assert.ok(!rec.content.includes('supersecret123'), 'provider output scrubbed too');
  const ctx = JSON.parse(fs.readFileSync(path.join(proj, '.vidgen', 'context.json'), 'utf8'));
  assert.equal(ctx.external.deepwiki.trust, 'unverified-external');
  assert.ok(!ctx.routes.includes('/nowhere'), 'external claims never become local routes');
});

test('GitDiagram: live tool name get_repository_diagram is preferred even when other diagram tools exist', async () => {
  mode = { live: true };
  const before = seen.length;
  const r = await extRun('gitdiagram', 'gitdiagram:acme/public-app');
  mode = {};
  assert.equal(r.code, 0, r.err);
  assert.match(seen.slice(before).map((s) => s.body).join(''), /"name":"get_repository_diagram","arguments":\{"repository":"acme\/public-app"\}/);
});

test('GitDiagram: schema-driven argument (URL param gets a URL); ambiguous tool lists are refused, not guessed', async () => {
  const before = seen.length;
  const r = await extRun('gitdiagram', 'gitdiagram:acme/public-app');
  assert.equal(r.code, 0, r.err);
  assert.match(seen.slice(before).map((s) => s.body).join(''), /"repoUrl":"https:\/\/github.com\/acme\/public-app"/);
  mode = { ambiguous: true };
  const amb = await extRun('gitdiagram', 'gitdiagram:acme/public-app');
  mode = {};
  assert.equal(amb.code, 5);
  assert.match(amb.err, /not unambiguous.*not guessing/);
});

test('failures are clean and bounded: timeout, 429, 500, malformed, unreachable — local analysis unaffected', async () => {
  const cases = [[{ hang: true }, /timed out after 2s/], [{ status: 429 }, /rate limited.*retry after 30s/], [{ status: 503 }, /unavailable \(HTTP 503\)/], [{ malformed: true }, /malformed tools\/list|malformed response/]];
  for (const [m, re] of cases) {
    mode = m;
    const t0 = Date.now();
    const r = await extRun('deepwiki', 'deepwiki:acme/public-app');
    assert.equal(r.code, 5, JSON.stringify(m));
    assert.match(r.err, re);
    assert.match(r.err, /Local analysis is unaffected/);
    assert.ok(Date.now() - t0 < 10000, 'bounded by the timeout');
  }
  mode = {};
  const down = await extRun('deepwiki', 'deepwiki:acme/public-app', { VIDGEN_DEEPWIKI_MCP_URL: 'http://127.0.0.1:9/mcp' });
  assert.equal(down.code, 5);
  assert.match(down.err, /network error/);
  const ctx = await run('context.mjs', [proj, '--scan']);
  assert.equal(ctx.code, 0, 'local analysis still works');
});

test('gitingest: runs only on a sanitized copy — secrets, env files, auth state and .vidgen never reach the tool', async () => {
  const fake = path.join(tmp, process.platform === 'win32' ? 'fake-gitingest.cmd' : 'fake-gitingest');
  const dump = path.join(tmp, 'dump.mjs');
  // Prints every file it was given + its contents, like a digest would.
  fs.writeFileSync(dump, "import fs from 'node:fs'; import path from 'node:path';\nconst root = process.argv[2]; const w = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? w(path.join(d, e.name)) : [path.join(d, e.name)]);\nfor (const f of w(root)) console.log('FILE ' + path.relative(root, f) + '\\n' + fs.readFileSync(f, 'utf8'));\nconsole.log('CHILDENV ' + JSON.stringify({ proxy: process.env.HTTPS_PROXY, gh: process.env.GITHUB_TOKEN ?? null, openai: process.env.OPENAI_API_KEY ?? null, cwdIsStage: fs.realpathSync(process.cwd()) === fs.realpathSync(root) }));");
  fs.writeFileSync(fake, process.platform === 'win32' ? `@"${process.execPath}" "${dump}" %1` : `#!/bin/sh\nexec "${process.execPath}" "${dump}" "$1"\n`, { mode: 0o755 });
  const missing = await extRun('gitingest', 'gitingest:local:proj', { VIDGEN_GITINGEST_BIN: '', PATH: path.dirname(process.execPath) });
  assert.equal(missing.code, 4);
  assert.match(missing.err, /not installed/);
  const r = await extRun('gitingest', 'gitingest:local:proj', { VIDGEN_GITINGEST_BIN: fake, GITHUB_TOKEN: 'ghp_FAKEFAKEFAKEFAKEFAKE00', OPENAI_API_KEY: 'sk-FAKE-openai' });
  assert.equal(r.code, 0, r.err);
  const rec = JSON.parse(fs.readFileSync(path.join(proj, '.vidgen', 'external', 'gitingest.json'), 'utf8'));
  assert.match(rec.content, /FILE src[\\/]App\.jsx/);
  // Credentials stripped, proxy-aware network pointed at a dead port, run from the sanitized dir (no project .env for dotenv).
  assert.match(rec.content, /CHILDENV \{"proxy":"http:\/\/127\.0\.0\.1:9","gh":null,"openai":null,"cwdIsStage":true\}/);
  // Withheld files must not appear at all (file headers) and planted secret VALUES must not appear anywhere.
  // (The fixture's own source legitimately contains strings like `process.env.PORT` and the `sid-SECRET-${...}` template.)
  for (const f of ['.env', '.env.production', 'deploy-key.pem', 'src/config.js', 'playwright/.auth/user.json', '.vidgen/captured-private.json']) {
    assert.ok(!new RegExp(`^FILE ${f.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\\\//g, '[\\\\/]')}$`, 'm').test(rec.content), `file ${f} reached gitingest`);
  }
  for (const leak of ['postgres://u:p', 'sk_live_x', 'PRIVATE KEY', 'sid-SECRET-1', 'sk-abcdefghijklmnop', 'node_modules']) assert.ok(!rec.content.includes(leak), leak);
  assert.equal((await extRun('gitingest', 'gitingest:local:other')).code, 3, 'authorization is per target');
});

test('results are never written through a symlinked .vidgen/external', { skip: process.platform === 'win32' && 'symlinks need admin on Windows' }, async () => {
  const ext = path.join(proj, '.vidgen', 'external');
  const elsewhere = path.join(tmp, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  const keep = path.join(tmp, 'external-keep');
  fs.renameSync(ext, keep);
  fs.symlinkSync(elsewhere, ext, 'dir');
  try {
    const r = await extRun('deepwiki', 'deepwiki:acme/public-app');
    assert.equal(r.code, 4);
    assert.match(r.err, /symlink — refusing/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally { fs.rmSync(ext); fs.renameSync(keep, ext); }
});

test('no credentials or tokens in stored provenance, context or logs', () => {
  const blob = ['deepwiki', 'gitdiagram', 'gitingest'].map((p) => fs.readFileSync(path.join(proj, '.vidgen', 'external', `${p}.json`), 'utf8')).join('\n') + fs.readFileSync(path.join(proj, '.vidgen', 'context.json'), 'utf8');
  for (const s of ['postgres://u:p', 'sk_live_x', 'PRIVATE KEY', 'sid-SECRET-1', 'supersecret123', 'GITHUB_TOKEN=']) assert.ok(!blob.includes(s), s);
});

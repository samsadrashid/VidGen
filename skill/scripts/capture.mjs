#!/usr/bin/env node
// Capture real app UI per storyboard scene in both formats, verifying each scene before accepting it.
// Usage: capture.mjs <storyboard.json>
// Per-scene checks (fail the scene unless listed in scene.allow):
//   noop        click/fill/tap changed neither pixels nor URL
//   navigation  final URL path != expect.url ?? route (or last goto)
//   loading     loading indicator still visible after loadingTimeout (default 10s)
//   blank       screenshot entropy ~0, or no visible text/media
//   images      broken <img> in viewport
//   overflow    page wider than viewport (broken responsive layout)
//   pageerror   uncaught JS exception during the scene
//   expect      scene.expect assertions {url, selector, text, notSelector, notText}
//   auth        landed on a login page, or (auth flows) the storyboard.auth.authenticated proof is missing
//   forbidden   HTTP 403 or a "403/Forbidden/Access denied" screen
//   apperror    framework error UI served with HTTP 200: Next.js dev overlay / error boundary, Vite overlay,
//               an error heading ("Something went wrong"), or a heading that is just a 4xx/5xx status (SvelteKit +error)
// Console errors and failed requests are recorded (scrubbed) as warnings in <scene>.json.
// Auth: `--login` (you sign in in a browser window) or `--cdp <url>` (reuse a browser you signed in to).
// Session state stays in memory; captures are staged and promoted only when the run completes.
// Exit: 0 ok, 1 scene failures, 2 config, 3 sign-in cancelled, 4 sign-in timeout, 5 browser failure,
//       6 session not authenticated/expired, 130 interrupted.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha, entropy, pngSize } from './vision.mjs';
import { INTERRUPT_SIGNALS, assertNoSymlinks, outputBase, assertSafeNames } from './platform.mjs';
import { CaptureCache, sceneKey, mutatingSignature } from './capture-cache.mjs';
import { APP_ERROR_MARKERS } from './frameworks.mjs';
import crypto from 'node:crypto';
import { SceneError, AuthError, validateAuth, obtainSession, checkScene, onLoginPage, redact, unredact, scrub, safeUrl, DEFAULT_REDACT } from './auth.mjs';

const argv = process.argv.slice(2);
const cdpAt = argv.indexOf('--cdp');
const opts = { login: argv.includes('--login'), cdp: cdpAt >= 0 ? argv[cdpAt + 1] : null, noCache: argv.includes('--no-cache') || process.env.VIDGEN_NO_CAPTURE_CACHE === '1' };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(cdpAt >= 0 && i === cdpAt + 1));
if (positional.length !== 1 || (cdpAt >= 0 && !opts.cdp)) {
  console.error('usage: capture.mjs <storyboard.json> [--login | --cdp <http://127.0.0.1:9222>] [--no-cache]');
  process.exit(2);
}
const sbPath = path.resolve(positional[0]);
const sb = JSON.parse(fs.readFileSync(sbPath, 'utf8'));
const NAV_TIMEOUT = sb.navigationTimeout ?? 15000;
// storyboard.localStorage: string key/values set on the app origin before any page script runs (dismiss onboarding tours,
// cookie banners, "what's new" popups). Not for sessions: credential-like keys are rejected by the auth checks.
const LOCAL = sb.localStorage ?? {};
if (typeof LOCAL !== 'object' || Array.isArray(LOCAL) || Object.values(LOCAL).some((v) => typeof v !== 'string')) { console.error('capture refused: localStorage must be an object of string values'); process.exit(2); }
if (!(Number.isInteger(NAV_TIMEOUT) && NAV_TIMEOUT >= 5000 && NAV_TIMEOUT <= 120000)) { console.error(`capture refused: navigationTimeout must be an integer 5000–120000 ms, got ${JSON.stringify(sb.navigationTimeout)}`); process.exit(2); }
const flowDir = path.dirname(sbPath);
try {
  assertSafeNames((sb.scenes ?? []).map((s) => s.id), 'scene id');
  const vd = path.join(outputBase(flowDir), '.vidgen');
  assertNoSymlinks(outputBase(flowDir), [path.join(flowDir, 'capture-report.json'), path.join(flowDir, 'captures', 'landscape'), path.join(flowDir, 'captures', 'vertical'),
    path.join(flowDir, `captures.staging-${process.pid}`), path.join(vd, 'cache', 'captures', 'landscape'), path.join(vd, 'cache', 'captures', 'vertical')]);
} catch (e) { console.error(`capture refused: ${e.message}`); process.exit(2); }

// Skill-local Playwright first (matches the browsers the installer downloaded); never load code from the cwd first.
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  ({ chromium } = createRequire(path.join(process.cwd(), 'x.js'))('playwright'));
}

// Vertical uses a real phone viewport (390x693 @ dpr ~2.77 -> 1080x1920) so responsive layouts render.
const FORMATS = {
  landscape: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, isMobile: false },
  vertical: { viewport: { width: 390, height: 693 }, deviceScaleFactor: 1080 / 390, isMobile: true, hasTouch: true },
};
const LOADING = '[aria-busy="true"], [role="progressbar"], .spinner, .loading, .loader, [class*="skeleton"], [data-loading="true"]';
// Near-uniform image. Sparse real pages (one heading on white) measure ~0.003, so text/media presence decides those.
const BLANK_ENTROPY = 0.001;


// Refuse error pages: a 4xx/5xx screen is not authentic product UI.
async function visit(page, route) {
  const res = await page.goto(new URL(route, sb.baseUrl).href, { waitUntil: 'networkidle' });
  if (!res) throw new Error(`no response for ${route}`);
  if (res.status() === 401) throw new SceneError('auth', `HTTP 401 for ${route} — not signed in or session expired`);
  if (res.status() === 403) throw new SceneError('forbidden', `HTTP 403 for ${route} — the signed-in account lacks permission`);
  if (res.status() >= 400) throw new Error(`HTTP ${res.status()} for ${route} — refusing to capture an error page`);
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(300);
}

const state = async (page) => ({ url: page.url(), png: await page.screenshot() });

async function run(page, a, fmt, allow) {
  const mutating = ['click', 'fill', 'tap'].includes(a.do);
  const before = mutating ? await state(page) : null;
  switch (a.do) {
    case 'goto': await visit(page, a.value); break;
    case 'click': await page.click(a.selector); break;
    case 'fill': await page.fill(a.selector, a.value); break;
    case 'hover': await page.hover(a.selector); break;
    // Canvas UIs (Flutter web, games) have no DOM selectors: tap at viewport fractions 0..1.
    // Optional per-format override, e.g. { "x":.9, "y":.9, "landscape": { "x":.98, "y":.96 } }.
    case 'tap': { const v = page.viewportSize(); const p = a[fmt] ?? a; await page.mouse.click(p.x * v.width, p.y * v.height); break; }
    case 'scroll': await page.mouse.wheel(0, Number(a.value ?? 600)); break;
    case 'wait': await page.waitForTimeout(Number(a.value ?? 500)); break;
    case 'waitFor': await page.waitForSelector(a.selector, { timeout: a.timeout ?? NAV_TIMEOUT }); break;
    default: throw new Error(`unknown action ${a.do}`);
  }
  if (mutating && !allow.has('noop') && !a.allowNoop) {
    // Client-side navigation is asynchronous (dev-server route compilation, data loading before the URL
    // changes), so poll for a URL or pixel change for up to noopWait ms before calling it a no-op.
    const until = Date.now() + (a.noopWait ?? 5000);
    let after;
    do {
      await settle(page);
      after = await state(page);
    } while (after.url === before.url && after.png.equals(before.png) && Date.now() < until);
    if (after.url === before.url && after.png.equals(before.png)) {
      throw new SceneError('noop', `${a.do} ${a.selector ?? JSON.stringify(a[fmt] ?? { x: a.x, y: a.y })} had no visible effect (no pixel or URL change)`);
    }
  }
}

async function waitNotLoading(page, timeout) {
  const end = Date.now() + timeout;
  for (;;) {
    const busy = await page.evaluate((sel) => {
      const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0; };
      const hits = [...document.querySelectorAll(sel)].filter(vis);
      const txt = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /^\s*(loading|please wait)\s*(\.{0,3}|…)\s*$/i.test(e.textContent) && vis(e));
      return [...hits, ...txt].map((e) => e.outerHTML.slice(0, 80));
    }, LOADING);
    if (!busy.length) return;
    if (Date.now() > end) throw new SceneError('loading', `still loading after ${timeout}ms: ${busy[0]}`);
    await page.waitForTimeout(250);
  }
}

async function contentReport(page) {
  return page.evaluate(() => {
    const inView = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth; };
    return {
      textChars: (document.body?.innerText ?? '').replace(/\s+/g, '').length,
      media: [...document.querySelectorAll('img,svg,canvas,video,picture,flutter-view,flt-glass-pane')].filter(inView).length,
      brokenImages: [...document.images].filter((i) => inView(i) && i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src),
      overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    };
  });
}

async function appError(page) {
  // Next.js >= 15 mounts <nextjs-portal> on every dev page (dev-tools indicator) with a hidden, zero-size error dialog;
  // only an error dialog that is actually shown counts. An empty legacy portal (Next <= 14 mounts it for the overlay) still does.
  const portal = await page.evaluate(() => {
    const p = document.querySelector('nextjs-portal');
    if (!p) return null;
    if (!p.shadowRoot) return 'open';
    const d = p.shadowRoot.querySelector('[data-nextjs-dialog]');
    const b = d?.getBoundingClientRect();
    return b && b.width > 0 && b.height > 0 ? 'open' : 'idle';
  }).catch(() => null);
  if (portal === 'open') return 'framework error UI present (nextjs-portal error dialog)';
  for (const sel of APP_ERROR_MARKERS.selectors.filter((s) => s !== 'nextjs-portal')) {
    // Locators pierce shadow roots, so the Next dialog must be visible (it always exists, collapsed, in Next >= 15 dev).
    const hit = sel === '[data-nextjs-dialog]' ? await page.locator(sel).first().isVisible().catch(() => false) : await page.locator(sel).first().count().catch(() => 0);
    if (hit) return `framework error UI present (${sel})`;
  }
  const heads = await page.evaluate(() => [document.title, ...[...document.querySelectorAll('h1,h2,[role=alert]')].filter((e) => e.offsetParent).map((e) => e.textContent)].map((t) => t.trim()).filter(Boolean)).catch(() => []);
  for (const h of heads) {
    if (APP_ERROR_MARKERS.statusHeading.test(h)) return `error status heading "${h}"`;
    for (const t of APP_ERROR_MARKERS.text) if (h.toLowerCase().includes(t.toLowerCase())) return `error message "${scrub(h).slice(0, 60)}"`;
  }
  return null;
}

async function expectations(page, ex) {
  if (!ex) return;
  if (ex.selector && !(await page.locator(ex.selector).first().isVisible())) throw new SceneError('expect', `selector not visible: ${ex.selector}`);
  if (ex.notSelector && (await page.locator(ex.notSelector).first().isVisible())) throw new SceneError('expect', `selector unexpectedly visible: ${ex.notSelector}`);
  if (ex.text && !(await page.getByText(ex.text).first().isVisible())) throw new SceneError('expect', `text not visible: "${ex.text}"`);
  if (ex.notText && (await page.getByText(ex.notText).first().isVisible().catch(() => false))) throw new SceneError('expect', `text unexpectedly visible: "${ex.notText}"`);
}

// Captures are staged and promoted at the end, so an interrupted/failed run never mixes old and new shots.
const staging = path.join(flowDir, `captures.staging-${process.pid}`);
const browsers = new Set();
const track = (b) => browsers.add(b);
const cleanup = async () => {
  for (const b of browsers) await b.close().catch(() => {});
  cache?.discard();
  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { console.error(`[vidgen] could not remove ${staging}: ${e.code} — delete it manually`); }
};
let interrupted = false;
for (const sig of INTERRUPT_SIGNALS) process.on(sig, async () => { interrupted = true; await cleanup(); console.error(`capture interrupted (${sig}); previous captures untouched`); process.exit(130); });
async function fail(e) {
  await cleanup();
  console.error(`capture failed: ${scrub(e.message)}`);
  console.log(JSON.stringify({ captured: 0, failed: [{ check: e instanceof AuthError ? 'auth' : 'error', error: scrub(e.message.split('\n')[0]) }] }));
  process.exit(e.code ?? 1);
}

let auth, storageState, browser, cache;
// Screenshot reuse (see capture-cache.mjs): identity is "anonymous" for public flows, a hash of the signed-in
// account's visible identity for auth flows, or null (= no reuse) when that identity can't be established.
let identity = 'anonymous';
let cacheOff = opts.noCache ? 'reuse disabled (--no-cache / VIDGEN_NO_CAPTURE_CACHE=1)' : null;
const vidgenDir = path.dirname(path.dirname(flowDir));
const projectRoot = path.dirname(vidgenDir);
let sourceHash = null;
try {
  auth = validateAuth(sb);
  // Screenshots of signed-in pages are private data: make sure the project won't commit them.
  const projectRoot = path.dirname(path.dirname(path.dirname(flowDir)));
  const git = spawnSync('git', ['-C', projectRoot, 'check-ignore', '-q', '.vidgen/flows'], { stdio: 'ignore' });
  if (auth && git.status === 1) console.error(`[vidgen] WARNING: ${projectRoot}/.vidgen is not git-ignored — authenticated captures could be committed. Add ".vidgen/" and "vidgen-export/" to .gitignore.`);
  storageState = await obtainSession(chromium, sb, auth, opts, track);
  browser = await chromium.launch({ executablePath: process.env.VIDGEN_CHROMIUM_PATH || undefined }).catch((e) => { throw new AuthError(5, `browser failed to start: ${e.message.split('\n')[0]}`); });
  track(browser);
  // Fail fast if the session we were handed isn't actually signed in (no session / expired).
  const probe = auth?.required && sb.scenes.find((s) => s.type === 'capture' && s.route && !s.public);
  if (probe) {
    const ctx = await browser.newContext({ storageState });
    const page = await ctx.newPage();
    await page.goto(new URL(probe.route, sb.baseUrl).href, { waitUntil: 'networkidle' }).catch(() => {});
    // Only "am I signed in at all?" here; route-specific problems (forbidden, redirects, proof) are per-scene failures.
    const login = await onLoginPage(page, sb.baseUrl, auth);
    const who = !login && auth.authenticated.selector ? await page.locator(auth.authenticated.selector).first().innerText({ timeout: 5000 }).catch(() => null) : null;
    identity = who ? 'account:' + crypto.createHash('sha256').update(who.trim()).digest('hex').slice(0, 16) : null;
    await ctx.close();
    if (login) throw new AuthError(6, `session check failed before capturing (${probe.route}): landed on the login page (${login}) — no session, or it expired. Re-run with --login or refresh the --cdp browser.`);
  }
  if (storageState && !probe) identity = null; // signed-in session but nothing to identify the account by
  if (identity === null) cacheOff ??= 'reuse disabled: signed-in account identity could not be established (needs auth.authenticated.selector)';
  const ctxCheck = spawnSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'context.mjs'), projectRoot, '--check'], { encoding: 'utf8' });
  try { sourceHash = JSON.parse(ctxCheck.stdout).sourceHash; } catch { cacheOff ??= 'reuse disabled: project source fingerprint unavailable'; }
  cache = new CaptureCache(vidgenDir, { enabled: !cacheOff });
} catch (e) { await fail(e); }

const report = [];
try {
for (const [fmt, fmtOpts] of Object.entries(FORMATS)) {
  const dir = path.join(staging, fmt);
  fs.mkdirSync(dir, { recursive: true });
  const ctx = await browser.newContext({ ...fmtOpts, storageState });
  if (Object.keys(LOCAL).length) {
    await ctx.addInitScript(([origin, kv]) => { if (location.origin === origin) for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v); }, [new URL(sb.baseUrl).origin, LOCAL]);
  }
  let page, log, onCrash, pageCrashed = false;
  const openPage = async () => {
    const p = await ctx.newPage();
    page = p;
    pageCrashed = false;
    // A crashed renderer makes later page.evaluate calls wait forever: fail the scene right away instead.
    p.on('crash', () => p === page && (pageCrashed = true) && onCrash?.(new SceneError('crash', 'browser renderer crashed — usually out of memory (low RAM, small /dev/shm in Docker: use --ipc=host)')));
    page.setDefaultTimeout(NAV_TIMEOUT); // storyboard.navigationTimeout: slow servers (e.g. SSR against a busy local DB)
    page.on('console', (m) => m.type() === 'error' && log?.consoleErrors.push(m.text().slice(0, 300)));
    page.on('pageerror', (e) => log?.pageErrors.push(String(e.message).slice(0, 300)));
    page.on('requestfailed', (r) => log?.failedRequests.push(`${r.failure()?.errorText} ${safeUrl(r.url())}`));
    page.on('response', (r) => r.status() >= 400 && !/favicon/.test(r.url()) && log?.failedRequests.push(`HTTP ${r.status()} ${safeUrl(r.url())}`));
  };
  await openPage();
  const prefix = []; // state-changing scenes already run in this flow + format (part of every later key)
  for (const s of sb.scenes.filter((s) => s.type === 'capture')) {
    if (interrupted) break;
    const redactSelectors = [...DEFAULT_REDACT, ...(sb.redact ?? []), ...(s.redact ?? [])];
    const key = sceneKey({ fmt, fmtOpts, sb, auth, scene: s, prefix: [...prefix], sourceHash, identity, redactSelectors });
    const sig = mutatingSignature(s);
    if (sig) prefix.push(sig); // pushed whether or not the scene succeeds: its actions may have changed state anyway
    const png = path.join(dir, `${s.id}.png`);
    const metaPath = path.join(dir, `${s.id}.json`);
    const allow = new Set(s.allow ?? []);
    log = { consoleErrors: [], pageErrors: [], failedRequests: [] };
    try {
      // Watchdog: some Playwright calls (evaluate, addStyleTag...) have no timeout of their own and can hang forever.
      const limit = s.timeout ?? (Number(process.env.VIDGEN_SCENE_TIMEOUT_MS) || 120_000);
      if (pageCrashed || page.isClosed()) { await page.close().catch(() => {}); await openPage(); } // late crash from the previous scene
      let timer;
      const watchdog = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new SceneError('timeout', `scene did not finish within ${limit / 1000}s`)), limit);
        onCrash = reject;
      });
      try {
        await Promise.race([(async () => {
          let expectedPath = s.route;
          if (s.route) await visit(page, s.route);
          // Inline <style> via evaluate: page.addStyleTag waits for a load event that never fires on Linux Chromium (hangs forever).
          await page.evaluate((css) => { const el = document.createElement('style'); el.textContent = css; (document.head ?? document.documentElement).appendChild(el); }, '*{caret-color:transparent!important} ::-webkit-scrollbar{display:none}');
          for (const a of s.actions ?? []) {
            if (a.do === 'goto') expectedPath = a.value;
            await run(page, a, fmt, allow);
          }
          await settle(page);
          if (!allow.has('loading')) await waitNotLoading(page, s.loadingTimeout ?? 10000);
          await checkScene(page, sb, auth, s, allow);
          if (!allow.has('apperror')) { const err = await appError(page); if (err) throw new SceneError('apperror', `${err} on ${safeUrl(page.url())}`); }
          await expectations(page, s.expect);

          const want = s.expect?.url ?? expectedPath;
          const got = new URL(page.url());
          if (want && !allow.has('navigation')) {
            const ok = want.startsWith('^') ? new RegExp(want).test(got.pathname + got.search) : got.pathname.replace(/\/$/, '') === new URL(want, sb.baseUrl).pathname.replace(/\/$/, '');
            if (!ok) throw new SceneError('navigation', `expected ${want}, ended on ${got.pathname}${got.search ? '?…' : ''}`);
          }
          if (new URL(page.url()).origin !== new URL(sb.baseUrl).origin) throw new SceneError('navigation', `left app origin: ${safeUrl(page.url())}`);

          const content = await contentReport(page);
          if (content.brokenImages.length && !allow.has('images')) throw new SceneError('images', `broken images: ${content.brokenImages.slice(0, 3).map(safeUrl).join(', ')}`);
          if (content.overflowX > 2 && !allow.has('overflow')) throw new SceneError('overflow', `page is ${content.overflowX}px wider than the ${fmt} viewport`);
          if (log.pageErrors.length && !allow.has('pageerror')) throw new SceneError('pageerror', scrub(log.pageErrors[0]));

          const redactions = await redact(page, redactSelectors);
          const shot = await page.screenshot();
          await unredact(page);
          // Reuse only a cached capture made under the same key AND byte-identical to what the page shows now.
          const digest = crypto.createHash('sha256').update(shot).digest('hex');
          const hit = cacheOff ? { reason: cacheOff } : cache.lookup(fmt, key);
          const reused = !!hit.meta && hit.meta.sha256 === digest;
          let ent;
          if (reused) { fs.copyFileSync(hit.png, png); ent = hit.meta.entropy; } else { fs.writeFileSync(png, shot); ent = entropy(png); }
          const provenance = { source: reused ? 'reused' : 'captured', key: key.slice(0, 16),
            reason: reused ? 'same capture inputs and pixel-identical to the cached capture' : hit.meta ? 'cached capture differs from the live page (pixels changed)' : hit.reason };
          if (!allow.has('blank') && (ent < BLANK_ENTROPY || (content.textChars === 0 && content.media === 0))) {
            throw new SceneError('blank', `screen looks blank (entropy ${ent.toFixed(3)}, ${content.textChars} chars, ${content.media} media)`);
          }
          const meta = {
            url: safeUrl(page.url()), title: scrub(await page.title()), at: new Date().toISOString(), sha256: sha(png), size: pngSize(png),
            entropy: +ent.toFixed(4), provenance, content: { ...content, brokenImages: content.brokenImages.map(safeUrl) }, allow: [...allow], redactions,
            warnings: [
              ...log.consoleErrors.map((e) => `console: ${scrub(e)}`),
              ...log.failedRequests.map((e) => `request: ${e}`),
              ...[...(sb.redact ?? []), ...(s.redact ?? [])].filter((sel) => !redactions[sel]).map((sel) => `redact selector matched nothing: ${sel} — check the screenshot`),
            ],
          };
          fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
          if (!reused) cache.stage(fmt, key, png, { sha256: meta.sha256, entropy: meta.entropy, size: meta.size });
          report.push({ fmt, scene: s.id, ok: true, reused, url: meta.url, warnings: meta.warnings.length });
        })(), watchdog]);
      } catch (e) {
        // A failed scene leaves the page in an unknown state (crashed, stuck, mid-navigation): never reuse it.
        // Cookies/storage live on the context, so signed-in sessions survive the swap.
        await page.close().catch(() => {});
        await openPage();
        throw e;
      } finally { clearTimeout(timer); onCrash = null; }
    } catch (e) {
      for (const f of [png, metaPath]) fs.rmSync(f, { force: true }); // never leave a stale shot from an earlier run
      report.push({ fmt, scene: s.id, ok: false, check: e.check ?? 'error', error: scrub(String(e.message || e).split('\n')[0]) });
    }
  }
  await ctx.close();
}
} catch (e) {
  // Once the signal handler has closed the browser, pending Playwright calls reject: let the handler exit 130.
  if (interrupted) await new Promise(() => {});
  await fail(e);
}
await browser.close().catch(() => {});
// An interrupt mid-run surfaces as scene errors above; never promote (or delete old captures) in that case.
if (interrupted) await new Promise(() => {}); // the signal handler exits 130
// Promote: successful scenes replace old captures; failed scenes remove stale old ones.
for (const r of report) {
  const dest = path.join(flowDir, 'captures', r.fmt);
  fs.mkdirSync(dest, { recursive: true });
  for (const ext of ['png', 'json']) {
    const from = path.join(staging, r.fmt, `${r.scene}.${ext}`);
    const to = path.join(dest, `${r.scene}.${ext}`);
    if (r.ok) fs.renameSync(from, to);
    else fs.rmSync(to, { force: true });
  }
}
cache.commit(); // only now: the run finished without interruption
await cleanup();
fs.writeFileSync(path.join(flowDir, 'capture-report.json'), JSON.stringify(report, null, 2));
const bad = report.filter((r) => !r.ok);
console.log(JSON.stringify({ captured: report.length - bad.length, reused: report.filter((r) => r.reused).length, failed: bad }));
process.exit(bad.length ? 1 : 0);

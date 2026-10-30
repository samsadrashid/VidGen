// Authenticated-capture support for capture.mjs: config validation, session acquisition,
// per-scene auth/forbidden checks, redaction overlays, and secret scrubbing for anything we log or store.
//
// Session state (cookies/localStorage) is held IN MEMORY ONLY for the duration of one capture run.
// Nothing about the session is written to disk by VidGen.

export class SceneError extends Error {
  constructor(check, msg) { super(`${check}: ${msg}`); this.check = check; }
}
// Exit codes: 2 config, 3 auth cancelled, 4 auth timeout, 5 browser failure, 6 session not authenticated.
export class AuthError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

// ---------- scrubbing ----------
const SECRET_NAME = /pass(word|wd)?|secret|token|cookie|api[-_]?key|authori[sz]ation|bearer|session|sid|credential|private[-_]?key/i;
export function scrub(text) {
  return String(text ?? '')
    .replace(/eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '[redacted-jwt]')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 [redacted]')
    // key=value (query strings, cookies, env) and "key":"value" (JSON). Prose like "auth: redirected" is left alone.
    .replace(/\b([\w-]*(?:token|secret|password|passwd|api[-_]?key|session|sid|code|auth)[\w-]*)=[^\s&;"',]+/gi, '$1=[redacted]')
    .replace(/("[\w-]*(?:token|secret|password|passwd|api[-_]?key|session|sid|cookie|auth)[\w-]*"\s*:\s*")[^"]*"/gi, '$1[redacted]"')
    .replace(/\bsk-[\w-]{6,}/g, '[redacted-key]');
}
// Keep origin + path only; query strings and fragments routinely carry OAuth codes and tokens.
export function safeUrl(u) {
  try {
    const x = new URL(u);
    return `${x.origin}${x.pathname}${x.search ? '?…' : ''}`;
  } catch { return scrub(u); }
}

// ---------- config ----------
const DEFAULT_LOGIN_PATTERNS = ['^/(login|log-in|signin|sign-in|auth|sso)(/|$)'];
const DEFAULT_LOGIN_SELECTORS = ['input[type="password"]'];
const DEFAULT_FORBIDDEN_TEXT = ['403', 'forbidden', 'access denied', 'not authorized', 'not authorised', 'permission denied', 'unauthorized'];
export const DEFAULT_REDACT = ['input[type="password"]', '[autocomplete^="cc-"]', '[data-vidgen-redact]'];
const AUTH_KEYS = new Set(['required', 'loginUrl', 'loginPatterns', 'loginSelectors', 'authenticated', 'forbidden', 'allowedOrigins', 'timeout']);

// Validate the whole storyboard for credential-like content and the `auth` block's shape.
// Errors name the offending key/field but never echo values.
export function validateAuth(sb) {
  const errors = [];
  (function walk(o, p) {
    if (Array.isArray(o)) return o.forEach((v, i) => walk(v, `${p}[${i}]`));
    if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
      if (SECRET_NAME.test(k)) errors.push(`${p}.${k}: storyboards must not contain credentials or session data — sign in with --login or --cdp instead`);
      walk(v, `${p}.${k}`);
    }
  })(sb, 'storyboard');
  sb.scenes?.forEach((s, i) => (s.actions ?? []).forEach((a, j) => {
    if (a.do === 'fill' && /pass|secret|token|otp|mfa|2fa/i.test(a.selector ?? '')) errors.push(`storyboard.scenes[${i}].actions[${j}]: filling a password/secret/OTP field from a storyboard is not allowed — sign in with --login`);
  }));
  for (const k of ['redact']) if (sb[k] != null && !(Array.isArray(sb[k]) && sb[k].every((x) => typeof x === 'string' && x))) errors.push(`storyboard.${k}: must be an array of CSS selectors`);

  const a = sb.auth;
  if (a == null) { if (errors.length) throw new AuthError(2, errors.join('\n')); return null; }
  if (typeof a !== 'object' || Array.isArray(a)) throw new AuthError(2, 'storyboard.auth: must be an object');
  for (const k of Object.keys(a)) if (!AUTH_KEYS.has(k) && !SECRET_NAME.test(k)) errors.push(`storyboard.auth.${k}: unknown setting`);
  const strArr = (k, v) => v == null || (Array.isArray(v) && v.every((x) => typeof x === 'string' && x)) || errors.push(`storyboard.auth.${k}: must be an array of strings`);
  strArr('loginPatterns', a.loginPatterns);
  strArr('loginSelectors', a.loginSelectors);
  strArr('allowedOrigins', a.allowedOrigins);
  for (const re of a.loginPatterns ?? []) { try { new RegExp(re); } catch { errors.push(`storyboard.auth.loginPatterns: invalid regex ${JSON.stringify(re)}`); } }
  for (const o of a.allowedOrigins ?? []) { try { if (new URL(o).origin !== o) throw 0; } catch { errors.push(`storyboard.auth.allowedOrigins: ${JSON.stringify(o)} is not an origin like https://login.example.com`); } }
  if (a.required != null && typeof a.required !== 'boolean') errors.push('storyboard.auth.required: must be true/false');
  if (a.loginUrl != null && (typeof a.loginUrl !== 'string' || !a.loginUrl)) errors.push('storyboard.auth.loginUrl: must be a path or URL');
  if (a.timeout != null && !(Number.isFinite(a.timeout) && a.timeout >= 1000 && a.timeout <= 1_800_000)) errors.push('storyboard.auth.timeout: must be 1000..1800000 ms');
  const ind = a.authenticated;
  if (!ind || typeof ind !== 'object' || !['selector', 'text', 'url'].some((k) => typeof ind[k] === 'string' && ind[k])) {
    errors.push('storyboard.auth.authenticated: required — at least one of {selector, text, url} that is only visible when signed in (positive proof of authentication)');
  } else if (ind.url) { try { new RegExp(ind.url); } catch { errors.push('storyboard.auth.authenticated.url: invalid regex'); } }
  if (a.forbidden != null && (typeof a.forbidden !== 'object' || Object.keys(a.forbidden).some((k) => !['selectors', 'text'].includes(k)))) errors.push('storyboard.auth.forbidden: {selectors?: string[], text?: string[]}');
  if (errors.length) throw new AuthError(2, errors.join('\n'));
  return {
    required: a.required !== false,
    loginUrl: a.loginUrl ?? '/login',
    loginPatterns: a.loginPatterns ?? DEFAULT_LOGIN_PATTERNS,
    loginSelectors: a.loginSelectors ?? DEFAULT_LOGIN_SELECTORS,
    authenticated: ind,
    forbiddenSelectors: a.forbidden?.selectors ?? [],
    forbiddenText: [...DEFAULT_FORBIDDEN_TEXT, ...(a.forbidden?.text ?? [])],
    allowedOrigins: a.allowedOrigins ?? [],
    timeout: a.timeout ?? 300_000,
  };
}

// ---------- page state ----------
const visible = (page, sel) => page.locator(sel).first().isVisible().catch(() => false);

export async function onLoginPage(page, base, auth) {
  const u = new URL(page.url());
  const patterns = auth?.loginPatterns ?? DEFAULT_LOGIN_PATTERNS;
  if (u.origin === new URL(base).origin && patterns.some((p) => new RegExp(p, 'i').test(u.pathname))) return `URL ${u.pathname}`;
  for (const s of auth?.loginSelectors ?? DEFAULT_LOGIN_SELECTORS) if (await visible(page, s)) return `login form (${s})`;
  return null;
}

async function indicatorMissing(page, ind) {
  if (ind.url && !new RegExp(ind.url).test(new URL(page.url()).pathname)) return `URL does not match ${ind.url}`;
  if (ind.selector && !(await visible(page, ind.selector))) return `element ${ind.selector} not visible`;
  if (ind.text && !(await page.getByText(ind.text).first().isVisible().catch(() => false))) return `text "${ind.text}" not visible`;
  return null;
}

// Forbidden screens are often served with HTTP 200 by SPAs: look at title + headings.
async function forbiddenScreen(page, auth) {
  for (const s of auth?.forbiddenSelectors ?? []) if (await visible(page, s)) return `forbidden marker ${s} visible`;
  const words = auth?.forbiddenText ?? DEFAULT_FORBIDDEN_TEXT;
  const heads = await page.evaluate(() => [document.title, ...[...document.querySelectorAll('h1,h2,[role=alert]')].filter((e) => e.offsetParent).map((e) => e.textContent)].map((t) => t.trim()).filter(Boolean)).catch(() => []);
  for (const h of heads) for (const w of words) if (new RegExp(`(^|\\W)${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\W)`, 'i').test(h)) return `"${scrub(h).slice(0, 60)}"`;
  return null;
}

// Run for every capture scene. Public flows get login-redirect and forbidden detection too.
export async function checkScene(page, sb, auth, scene, allow) {
  const here = new URL(page.url());
  if (here.origin !== new URL(sb.baseUrl).origin) throw new SceneError('navigation', `left app origin: now on ${safeUrl(here.href)} — external pages are never captured`);
  const login = await onLoginPage(page, sb.baseUrl, auth);
  // allow: ["login"] — the scene intentionally shows a sign-in/sign-up page (e.g. a "Sign up free" CTA). Honoured only when
  // the browser is still on the scene's own route, so a protected page that redirected to login is still rejected.
  const intended = allow.has('login') && scene.route && here.pathname === new URL(scene.route, sb.baseUrl).pathname;
  if (login && !intended) {
    throw new SceneError('auth', auth
      ? `landed on the login page (${login}) — session missing or expired. Re-run capture with --login (or refresh the --cdp browser session).`
      : `redirected to a login page (${login}) — this route needs authentication. Add storyboard.auth and run capture with --login or --cdp.`);
  }
  if (!allow.has('forbidden')) {
    const f = await forbiddenScreen(page, auth);
    if (f) throw new SceneError('forbidden', `${f} on ${safeUrl(page.url())} — the signed-in account lacks permission for this route; use an account with access or drop the scene`);
  }
  if (auth?.required && !scene.public) {
    const miss = await indicatorMissing(page, auth.authenticated);
    if (miss) throw new SceneError('auth', `not verifiably signed in on ${safeUrl(page.url())}: ${miss} (storyboard.auth.authenticated)`);
  }
}

// ---------- session acquisition ----------
// Returns a Playwright storageState object (kept in memory) or undefined for public flows.
export async function obtainSession(chromium, sb, auth, opts, track) {
  if (!auth) {
    if (opts.login || opts.cdp) throw new AuthError(2, '--login/--cdp given but storyboard has no "auth" block');
    return undefined;
  }
  if (!opts.login && !opts.cdp) {
    if (!auth.required) return undefined;
    throw new AuthError(2, 'this storyboard requires an authenticated session. Re-run capture with --login (sign in yourself in a browser window) or --cdp <url> (reuse a browser you already signed in to). VidGen never signs in on its own.');
  }
  const launchOpts = { executablePath: process.env.VIDGEN_CHROMIUM_PATH || undefined };
  if (opts.cdp) {
    let browser;
    try {
      browser = await chromium.connectOverCDP(opts.cdp, { timeout: 10_000 });
    } catch (e) {
      throw new AuthError(5, `cannot connect to the browser at ${safeUrl(opts.cdp)}: ${scrub(e.message.split('\n')[0])}`);
    }
    try {
      const ctx = browser.contexts()[0];
      if (!ctx) throw new AuthError(6, 'connected browser has no default context — start it with a user-data-dir and sign in first');
      return await ctx.storageState();
    } finally {
      await browser.close(); // disconnects only; the user's browser keeps running
    }
  }
  // --login: the USER signs in through the app's normal login page. We only watch for success.
  let browser;
  try {
    browser = await chromium.launch({ ...launchOpts, headless: process.env.VIDGEN_AUTH_HEADLESS === '1' });
  } catch (e) {
    throw new AuthError(5, `browser failed to start: ${scrub(e.message.split('\n')[0])}`);
  }
  track(browser);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    let closed = false;
    page.on('close', () => { closed = true; });
    browser.on('disconnected', () => { closed = true; });
    const loginUrl = new URL(auth.loginUrl, sb.baseUrl).href;
    await page.goto(loginUrl).catch((e) => { throw new AuthError(5, `cannot open login page ${safeUrl(loginUrl)}: ${scrub(e.message.split('\n')[0])}`); });
    console.error(`[vidgen] Sign in in the browser window (${safeUrl(loginUrl)}). Waiting up to ${Math.round(auth.timeout / 1000)}s; close the window or press Ctrl-C to cancel. VidGen does not read or store what you type.`);
    const base = new URL(sb.baseUrl).origin;
    const end = Date.now() + auth.timeout;
    while (Date.now() < end) {
      if (closed) throw new AuthError(3, 'sign-in cancelled (browser window closed) — nothing captured');
      try {
        const u = new URL(page.url());
        // During sign-in the browser may visit an SSO origin listed in auth.allowedOrigins; success must be back on the app.
        if (u.origin === base && !(await onLoginPage(page, sb.baseUrl, auth)) && !(await indicatorMissing(page, auth.authenticated))) {
          console.error('[vidgen] Signed in — capturing.');
          return await ctx.storageState();
        }
        if (u.origin !== base && !auth.allowedOrigins.includes(u.origin) && u.protocol.startsWith('http')) {
          throw new AuthError(6, `sign-in navigated to ${u.origin}, which is not the app or an allowed sign-in origin (storyboard.auth.allowedOrigins)`);
        }
      } catch (e) {
        if (e instanceof AuthError) throw e;
        if (closed) continue; // navigation/teardown race
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new AuthError(4, `sign-in not completed within ${Math.round(auth.timeout / 1000)}s (storyboard.auth.timeout) — nothing captured`);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ---------- redaction ----------
// Opaque boxes over sensitive elements, added right before the screenshot and removed after,
// so redaction never affects interactions or verification checks.
export async function redact(page, selectors) {
  return page.evaluate((sels) => {
    const counts = {};
    for (const sel of sels) {
      let n = 0;
      for (const e of document.querySelectorAll(sel)) {
        const r = e.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const box = document.createElement('div');
        box.setAttribute('data-vidgen-redaction', '');
        box.style.cssText = `position:fixed;left:${r.left - 2}px;top:${r.top - 2}px;width:${r.width + 4}px;height:${r.height + 4}px;background:#6b7280;border-radius:4px;z-index:2147483647;pointer-events:none`;
        document.body.appendChild(box);
        n++;
      }
      counts[sel] = n;
    }
    return counts;
  }, selectors);
}
export const unredact = (page) => page.evaluate(() => document.querySelectorAll('[data-vidgen-redaction]').forEach((e) => e.remove())).catch(() => {});

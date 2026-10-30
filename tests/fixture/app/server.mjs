// Fixture "real app": distinct pages per journey, true 404 for unknown routes.
import http from 'node:http';
const shell = (title, body) => `<!doctype html><html><head><meta name=viewport content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{margin:0;font-family:system-ui;background:#f8fafc;color:#0f172a}nav{background:#E11D48;color:#fff;padding:16px 24px;font-weight:700}
main{padding:32px;max-width:960px;margin:auto}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 2px 8px #0001}input,button{font-size:18px;padding:10px;margin:6px 0;width:100%;box-sizing:border-box}
button{background:#E11D48;color:#fff;border:0;border-radius:8px}</style></head><body><nav>Fixture</nav><main>${body}</main></body></html>`;
const pages = {
  '/': shell('Home', '<h1 data-testid=hero>Ship faster</h1><p>Fixture landing page.</p><a href=/signup>Get started</a>'),
  '/signup': shell('Signup', '<h1>Create account</h1><input name=email placeholder=Email><button id=submit onclick="fetch(\'/__ping\');this.textContent=\'Welcome!\'">Sign up</button>'),
  '/dashboard': shell('Dashboard', '<h1 data-testid=dash>Dashboard</h1><div class=grid>' + ['Revenue $12k', 'Users 341', 'Churn 1.2%', 'NPS 61'].map((t) => `<div class=card>${t}</div>`).join('') + '</div>'),
  '/settings': shell('Settings', '<h1>Settings</h1><label><input type=checkbox id=dark style="width:auto"> Dark mode</label>'),
  // Negative cases for visual-QA regression tests.
  '/noop': shell('Noop', '<h1>Dead button</h1><button id=dead>Does nothing</button>'),
  '/redirect': shell('Redirect', '<h1>Bouncing</h1><script>setTimeout(() => location.replace("/"), 100)</script>'),
  '/spinner': shell('Spinner', '<h1>Report</h1><div class=spinner style="width:40px;height:40px;border:4px solid #E11D48;border-radius:50%"></div>'),
  '/slow': shell('Slow', '<div id=s class=spinner style="width:40px;height:40px;border:4px solid #E11D48"></div><script>setTimeout(() => { document.getElementById("s").remove(); document.querySelector("main").insertAdjacentHTML("beforeend", "<h1 data-testid=ready>Report ready</h1>"); }, 1200)</script>'),
  '/blank': '<!doctype html><html><body style="margin:0;background:#fff"></body></html>',
  '/broken-img': shell('Img', '<h1>Gallery</h1><img src="/missing.png" width=200 height=120 alt="">'),
  '/crash': shell('Crash', '<h1>Crash</h1><script>setTimeout(() => { throw new Error("boom") }, 0)</script>'),
  // Framework-style error screens served with HTTP 200, async client navigation, and a sparse-but-real page.
  '/err-overlay': shell('Home', '<h1>Home</h1><nextjs-portal></nextjs-portal>'),
  // Next >= 15 dev: portal always mounted; the dialog is zero-size unless an error is actually shown.
  '/next-idle': shell('Home', '<h1>Home</h1><nextjs-portal></nextjs-portal><script>document.querySelector("nextjs-portal").attachShadow({mode:"open"}).innerHTML=\'<div data-nextjs-dialog style="width:0;height:0;overflow:hidden">Console Error</div><div data-issues>1 Issue</div>\'</script>'),
  '/next-open': shell('Home', '<h1>Home</h1><nextjs-portal></nextjs-portal><script>document.querySelector("nextjs-portal").attachShadow({mode:"open"}).innerHTML=\'<div data-nextjs-dialog style="position:fixed;inset:40px;background:#fff">Unhandled Runtime Error</div>\'</script>'),
  // Onboarding tour that covers the page unless localStorage says it was dismissed.
  '/tour': shell('Tour', '<h1>Workspace</h1><script>if(!localStorage.getItem("tour_done"))document.body.insertAdjacentHTML("beforeend","<div id=tour style=\'position:fixed;inset:0;background:#000c;color:#fff;font-size:40px\'>Welcome tour</div>")</script>'),
  '/err-status': shell('Error', '<h1>500</h1><p>Internal Error</p>'),
  '/err-boundary': shell('Dashboard', '<h2>Something went wrong</h2>'),
  '/slow-nav': shell('Slow nav', '<h1>Start</h1><a id=go href="#" onclick="event.preventDefault();setTimeout(()=>{history.pushState({}, \'\', \'/settings\');document.querySelector(\'h1\').textContent=\'Settings\'},1800)">Go</a>'),
  '/sparse': '<!doctype html><html><body style="margin:0;background:#fff;font-family:system-ui"><h1 style="font-size:14px;margin:8px">Pages Router page</h1></body></html>',
  '/wide': shell('Wide', '<h1>Wide</h1><div style="width:2400px;height:20px;background:#E11D48"></div>'),
};
const port = Number(process.env.PORT || 4173);
const hits = {};
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // Test hooks: count how often a scene's action really ran (/__ping) and read the counters (/__hits).
  if (url.pathname === '/__ping') { hits.ping = (hits.ping ?? 0) + 1; return res.writeHead(204).end(); }
  if (url.pathname === '/__hits') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hits));
  hits[url.pathname] = (hits[url.pathname] ?? 0) + 1;
  if (url.pathname === '/login' || url.pathname.startsWith('/app')) return auth(req, res, url);
  // Slow server-side render (e.g. SSR against a busy database): responds after ?ms.
  if (url.pathname === '/slow-ssr') return setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end(shell('Slow SSR', '<h1>Rendered late</h1>')), Number(url.searchParams.get('ms') ?? 0));
  const p = pages[url.pathname];
  res.writeHead(p ? 200 : 404, { 'content-type': 'text/html' }).end(p ?? shell('404', '<h1>404 Not Found</h1>'));
}).listen(port, () => console.log(`fixture on ${port}`));

// ---- Synthetic auth (test-only accounts; never real credentials) ----
// Session ids carry a recognizable marker so tests can assert they never leak into logs/outputs.
export const ACCOUNTS = { 'demo@example.test': { password: 'fixture-pass-123', role: 'user' }, 'admin@example.test': { password: 'fixture-admin-456', role: 'admin' } };
const sessions = new Map(); // sid -> { email, role, left }  (left = authenticated page loads before expiry; Infinity = never)
const cookieSid = (req) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
function auth(req, res, url) {
  if (url.pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const f = new URLSearchParams(body);
      const acct = ACCOUNTS[f.get('email')];
      if (!acct || acct.password !== f.get('password')) return res.writeHead(401, { 'content-type': 'text/html' }).end(shell('Login', '<h1>Sign in</h1><p role=alert>Invalid credentials</p>'));
      const sid = `sid-SECRET-${Math.random().toString(36).slice(2)}`;
      sessions.set(sid, { email: f.get('email'), role: acct.role, left: Number(f.get('ttl')) || Infinity });
      res.writeHead(302, { 'set-cookie': `sid=${sid}; HttpOnly; Path=/; SameSite=Lax`, location: f.get('next') || '/app' }).end();
    });
    return;
  }
  if (url.pathname === '/login') {
    // Test hooks: ?auto=demo|admin submits synthetic creds; &ttl=N expires the session after N page loads;
    // ?close=1 closes the window (user cancels); ?stall=1 never completes.
    const a = url.searchParams.get('auto');
    const acct = a && Object.entries(ACCOUNTS).find(([e]) => e.startsWith(a));
    const script = acct ? `<script>setTimeout(()=>{document.querySelector('[name=email]').value=${JSON.stringify(acct[0])};document.querySelector('[name=password]').value=${JSON.stringify(acct[1].password)};document.forms[0].submit()},150)</script>`
      : url.searchParams.get('close') ? '<script>setTimeout(()=>window.close(),150)</script>' : '';
    return res.writeHead(200, { 'content-type': 'text/html' }).end(shell('Login', `<h1>Sign in</h1><form method=post action=/login id=login>
      <input name=email type=email placeholder=Email><input name=password type=password placeholder=Password>
      <input type=hidden name=ttl value="${Number(url.searchParams.get('ttl')) || ''}"><input type=hidden name=next value="${(url.searchParams.get('next') ?? '').replace(/[^\w/-]/g, '')}">
      <button>Sign in</button></form>${script}`));
  }
  const s = sessions.get(cookieSid(req));
  if (!s || s.left <= 0) return res.writeHead(302, { location: `/login?next=${encodeURIComponent(url.pathname)}` }).end();
  s.left--;
  const nav = `<div data-testid=account-menu style="float:right">Signed in as <span class=account-email data-sensitive>${s.email}</span></div>`;
  const app = (title, body) => shell(title, nav + body);
  switch (url.pathname) {
    case '/app': return res.writeHead(200, { 'content-type': 'text/html' }).end(app('Dashboard', '<h1 data-testid=app-dash>Team dashboard</h1><div class=grid><div class=card>MRR $48k</div><div class=card>Seats 120</div><div class=card>API key: <code data-sensitive class=api-key>sk-live-FAKE0000</code></div></div>'));
    case '/app/reports': return res.writeHead(200, { 'content-type': 'text/html' }).end(app('Reports', '<h1>Reports</h1><div class=card>Q3 revenue up 12%</div>'));
    case '/app/admin': return s.role === 'admin' ? res.writeHead(200, { 'content-type': 'text/html' }).end(app('Admin', '<h1>Admin console</h1>'))
      : res.writeHead(403, { 'content-type': 'text/html' }).end(app('Forbidden', '<h1>403 Forbidden</h1>'));
    case '/app/billing': // forbidden page served with HTTP 200 (common in SPAs)
      return res.writeHead(200, { 'content-type': 'text/html' }).end(app('Billing', s.role === 'admin' ? '<h1>Billing</h1>' : '<h1>Access denied</h1><p>You do not have permission to view billing.</p>'));
    case '/app/sso-out': return res.writeHead(302, { location: `http://127.0.0.1:${port}/` }).end();
    default: return res.writeHead(404, { 'content-type': 'text/html' }).end(app('404', '<h1>404 Not Found</h1>'));
  }
}

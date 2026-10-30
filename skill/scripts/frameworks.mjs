// Framework adapters: ONLY detection, route discovery and dev-server hints live here.
// Browser, auth, actions, checks, redaction, cache, QA, render and export stay in the shared core.
//
// Each adapter: { id, detect(ctx) -> 0..1 confidence, routes(ctx) -> {static, dynamic, excluded}, dev(ctx) -> hint }
// ctx = { pkg, deps, rels (project-relative POSIX paths), read(rel) }.
// Discovery never guesses values for dynamic segments: those are reported for the user/agent to fill in.

const page = (r) => ('/' + r).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
const isDynamic = (r) => /\[[^\]]+\]/.test(r);
const sortU = (xs) => [...new Set(xs)].sort();

function split(entries) {
  // entries: [{ route, file }] -> static vs dynamic
  const stat = sortU(entries.filter((e) => !isDynamic(e.route)).map((e) => e.route));
  const dyn = entries.filter((e) => isDynamic(e.route)).map((e) => ({ pattern: e.route, file: e.file, params: [...e.route.matchAll(/\[(?:\.\.\.)?\[?(?:\.\.\.)?([^\]]+)\]?\]/g)].map((m) => m[1]) }));
  return { static: stat, dynamic: dyn.sort((a, b) => a.pattern.localeCompare(b.pattern)) };
}

const next = {
  id: 'next',
  detect: ({ deps }) => (deps.next ? 0.95 : 0),
  routes({ rels }) {
    const entries = [], excluded = [];
    for (const f of rels) {
      let m;
      // App Router: app/**/page.(tsx|jsx|ts|js|mdx), optionally under src/.
      if ((m = f.match(/(?:^|\/)app\/((?:.*\/)?)page\.(tsx?|jsx?|mdx)$/))) {
        const segs = m[1].split('/').filter(Boolean);
        if (segs.some((s) => s.startsWith('_'))) { excluded.push({ file: f, reason: 'private folder (_name)' }); continue; }
        if (segs.some((s) => s.startsWith('@'))) { excluded.push({ file: f, reason: 'parallel-route slot (@name), rendered inside its parent' }); continue; }
        if (segs.some((s) => /^\(\.{1,3}\)/.test(s))) { excluded.push({ file: f, reason: 'intercepting route' }); continue; }
        if (segs[0] === 'api') { excluded.push({ file: f, reason: 'api' }); continue; }
        entries.push({ route: page(segs.filter((s) => !/^\(.*\)$/.test(s)).join('/')), file: f });
      } else if (/(?:^|\/)app\/.*\/?route\.(tsx?|jsx?)$/.test(f)) {
        excluded.push({ file: f, reason: 'route handler (API), not a page' });
      // Pages Router: pages/**/*.(tsx|jsx|ts|js|mdx) minus _app/_document/_error and api/.
      } else if ((m = f.match(/(?:^|\/)pages\/(.*)\.(tsx?|jsx?|mdx)$/))) {
        if (/^api(\/|$)/.test(m[1])) { excluded.push({ file: f, reason: 'api' }); continue; }
        if (/(^|\/)_/.test(m[1])) { excluded.push({ file: f, reason: 'framework-internal (_app/_document/_error)' }); continue; }
        if (/\.(test|spec|stories)$/.test(m[1])) { excluded.push({ file: f, reason: 'test/story file' }); continue; }
        entries.push({ route: page(m[1].replace(/(^|\/)index$/, '')), file: f });
      }
    }
    return { ...split(entries), excluded };
  },
  dev: ({ pkg }) => ({ command: pkg.scripts?.dev ? 'npm run dev' : 'npx next dev', port: 3000, url: 'http://localhost:3000' }),
};

const sveltekit = {
  id: 'sveltekit',
  detect: ({ deps }) => (deps['@sveltejs/kit'] ? 0.95 : 0),
  routes({ rels }) {
    const entries = [], excluded = [];
    for (const f of rels) {
      let m;
      if ((m = f.match(/(?:^|\/)src\/routes\/((?:.*\/)?)\+page(@[\w-]*)?\.svelte$/))) {
        const segs = m[1].split('/').filter(Boolean);
        entries.push({ route: page(segs.filter((s) => !/^\(.*\)$/.test(s)).join('/')), file: f });
      } else if (/(?:^|\/)src\/routes\/(.*\/)?\+server\.(ts|js)$/.test(f)) excluded.push({ file: f, reason: 'endpoint (+server), not a page' });
    }
    return { ...split(entries), excluded };
  },
  dev: ({ pkg }) => ({ command: pkg.scripts?.dev ? 'npm run dev' : 'npx vite dev', port: 5173, url: 'http://localhost:5173' }),
};

// react-router only when the dependency is present AND the file imports it (path literals elsewhere are noise).
const reactRouter = {
  id: 'react-router',
  detect: ({ deps }) => (deps['react-router-dom'] || deps['react-router'] ? 0.7 : 0),
  routes({ rels, read }) {
    const entries = [];
    for (const f of rels.filter((r) => /\.(tsx?|jsx?)$/.test(r))) {
      const txt = read(f);
      if (!/react-router|createBrowserRouter|<Route\b|routes\s*=|export const routes/.test(txt)) continue;
      for (const m of txt.matchAll(/path:\s*['"](\/[^'"]*)['"]|<Route[^>]*path=['"](\/[^'"]*)['"]/g)) entries.push({ route: page((m[1] || m[2]).slice(1)), file: f });
    }
    const res = split(entries.map((e) => ({ ...e, route: e.route.replace(/:(\w+)/g, '[$1]') })));
    return { ...res, excluded: [] };
  },
  dev: ({ pkg }) => ({ command: pkg.scripts?.dev ? 'npm run dev' : pkg.scripts?.start ? 'npm start' : null, port: null, url: null }),
};

const flutter = {
  id: 'flutter',
  detect: ({ read, rels }) => (rels.includes('pubspec.yaml') && /sdk:\s*flutter/.test(read('pubspec.yaml')) ? 0.95 : 0),
  routes({ rels, read }) {
    const entries = [];
    for (const f of rels.filter((r) => r.endsWith('.dart'))) {
      for (const m of read(f).matchAll(/GoRoute\([^)]*?path:\s*['"]([^'"]+)['"]|['"](\/[\w\-/:]*)['"]\s*:\s*\(\s*\w*\s*\)\s*=>/g)) entries.push({ route: page((m[1] || m[2]).replace(/^\//, '')), file: f });
    }
    return { ...split(entries.map((e) => ({ ...e, route: e.route.replace(/:(\w+)/g, '[$1]') }))), excluded: [] };
  },
  dev: () => ({ command: 'flutter build web && npx serve build/web', port: 3000, url: 'http://localhost:3000' }),
};

// Fallback: no reliable file-based routing. Offer "/" for an obvious single-page entry and ask for explicit routes.
const generic = {
  id: 'generic',
  detect: () => 0.1,
  routes({ rels }) {
    const spa = rels.some((f) => /(^|\/)(index\.html|main\.(jsx?|tsx?)|App\.(jsx|tsx|vue|svelte))$/.test(f));
    return { static: spa ? ['/'] : [], dynamic: [], excluded: [], note: 'No supported router detected: routes are not discovered automatically. List the routes to capture in each storyboard scene (scene.route), or add them to context.json "routes".' };
  },
  dev: ({ pkg }) => ({ command: pkg.scripts?.dev ? 'npm run dev' : pkg.scripts?.start ? 'npm start' : null, port: null, url: null }),
};

export const ADAPTERS = [next, sveltekit, flutter, reactRouter];

// Pick the adapter. Several confident matches (e.g. a monorepo root with next AND @sveltejs/kit) = ambiguous:
// report every candidate and their routes rather than silently choosing one.
export function analyze(ctx) {
  const scored = ADAPTERS.map((a) => ({ a, c: a.detect(ctx) })).filter((x) => x.c > 0).sort((x, y) => y.c - x.c);
  const strong = scored.filter((x) => x.c >= 0.9);
  const chosen = scored[0]?.a ?? generic;
  const r = chosen.routes(ctx);
  // A framework adapter that finds nothing usable falls back to the generic behaviour (with its explanation).
  const empty = !r.static.length && !r.dynamic.length;
  const routes = empty ? { ...generic.routes(ctx), excluded: r.excluded } : r;
  return {
    framework: chosen.id,
    confidence: scored[0]?.c ?? 0.1,
    ambiguous: strong.length > 1 ? strong.map((x) => x.a.id) : null,
    routes,
    dev: chosen.dev(ctx),
  };
}

// Error screens that come back with HTTP 200 (client-side navigation, dev overlays, error boundaries).
// Checked for every capture scene regardless of framework; markers are specific enough not to collide.
export const APP_ERROR_MARKERS = {
  selectors: ['nextjs-portal', '[data-nextjs-dialog]', '#__next_error__', 'vite-error-overlay'],
  text: ['Application error: a client-side exception has occurred', 'Unhandled Runtime Error', 'Internal Server Error', 'Something went wrong'],
  // A page whose main heading is just an HTTP error status (SvelteKit's default +error page, many SPAs).
  statusHeading: /^\s*(4\d\d|5\d\d)\s*$/,
};

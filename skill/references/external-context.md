# External context providers (optional, off by default)

VidGen works fully offline. Route discovery, capture, auth, redaction, cache, QA, transitions and export never use external services. External context can only **enrich analysis and planning**. It's stored separately as `trust: "unverified-external"` and never overrides local code, routes or runtime behaviour.

## Providers

These are the access paths each project documents, checked 2026-10-29. I didn't invent any endpoints or parameters.

| Provider | What it adds | Access path used | What leaves your machine | Status |
|---|---|---|---|---|
| `deepwiki` | Generated documentation / architecture explanation of the GitHub repo | MCP server `https://mcp.deepwiki.com/mcp` (Streamable HTTP, no auth, public repos only); tool `read_wiki_contents` (falls back to `read_wiki_structure`); argument names read from the server's own `tools/list` schema | The repo name `owner/repo` only | **Live-validated once** (2026-10-29, `sveltejs/kit`): success |
| `gitdiagram` | Architecture explanation / component relationships | MCP server `https://gitdiagram.com/mcp` (no key, public repos only). VidGen prefers the tool `get_repository_diagram` (seen in the live `tools/list`); otherwise it accepts only a single explain/architecture/diagram tool with exactly one string argument | The repo name (as `owner/repo`, or `https://github.com/owner/repo` when the argument is URL-typed) | **Live-validated** (2026-10-29, `sveltejs/kit`): the first run refused (ambiguous tools); after the fix, `get_repository_diagram` succeeded |
| `gitingest` | A text digest of the code (structure, sizes, contents) | The `gitingest` CLI (`pip install gitingest`), run as `gitingest <dir> -o -` on a **sanitized copy** of the project. Its HTTP website has no documented API and isn't used | Nothing is uploaded by VidGen. GitIngest's docs don't say whether local runs make network calls, so it's still treated as external and needs authorization | **Live-validated** with gitingest 0.3.1 on a synthetic repo. It **attempts a network request** (see below) |

## How to use it

```bash
node "<skill>/scripts/external.mjs" <project> --plan
```

This makes no network calls. For each provider it prints the receiver, exactly what would be sent, and the files that would be withheld, plus the exact `authorize` string needed.

```bash
node "<skill>/scripts/external.mjs" <project> --run deepwiki --authorize "deepwiki:owner/repo"
```

The `--authorize` value must equal the plan's string for that provider and target. Authorization is per provider and per repository; nothing carries over between them. The agent must show the plan to the user and get a yes in chat before every run.

Results go to `.vidgen/external/<provider>.json`, with provider, receiver, what was sent, the authorization used, tool, time, content hash and local cross-checks. A short summary goes into `context.json` under `external`.

## Safeguards

- **Off by default.** No other script imports `external.mjs`. A failed local analysis never falls back to an external provider.
- **Remote providers send only the repository name**, never files, diffs or local changes. Their output describes **GitHub's copy**, which may differ from your working tree.
- **Public repos only.** Before contacting DeepWiki or GitDiagram, VidGen asks `api.github.com` whether the repo is public; that request contains only the repo name. 404/401 counts as private (blocked even with authorization), a non-GitHub remote is blocked, and a rate-limited check means nothing is sent.
- **GitIngest only sees a sanitized copy.** VidGen withholds:
  - `.env*`, keys and certificates (`*.pem`, `*.key`, `id_rsa`…), `.npmrc`/`.netrc`, `credentials*`/`secrets*`, storage-state files and databases;
  - files whose contents look like a secret (private keys, `sk-…`, `ghp_…`, AWS keys, JWTs, `*_SECRET=…`);
  - binaries and files over 512 KB;
  - `.git`, `.vidgen` (captures, cache, auth artifacts), `node_modules` and build output.

  `GITHUB_TOKEN` is blanked for the subprocess.
- **Never written through symlinks.** If `.vidgen`, `.vidgen/external` or the result file is a symlink, the run refuses (exit 4). The sanitizer's directory walk never follows symlinked files or directories.
- **No credentials are stored.** Provider output is scrubbed with the same secret scrubber as capture logs.
- **Failures are bounded and non-fatal:**
  - 20 s timeout (`VIDGEN_EXTERNAL_TIMEOUT_MS`);
  - 429 is reported with retry-after, with no retry loops;
  - 5xx means unavailable; malformed responses and ambiguous tool schemas are refused;
  - exit 5, and local analysis is unaffected.
- **Cross-checks.** File paths and routes mentioned by a provider are checked against the local project (`verification.files.confirmed/notFoundLocally`, `verification.routes.confirmed/notInLocalAnalysis`). External claims never become routes, actions or assertions.
- **Not in the screenshot cache key.** External context doesn't change what's captured.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | OK |
| 2 | Usage |
| 3 | Not authorized |
| 4 | Blocked (private/unknown repo, non-GitHub remote, gitingest not installed) |
| 5 | Provider failure (timeout, rate limit, unavailable, malformed) |

## Live validation (2026-10-29)

**DeepWiki and GitDiagram, public repo `sveltejs/kit` only.** These ran from a throwaway project containing just `.git/config`; only the repo name was sent.

Discovery (`initialize` + `tools/list`, which sends no repo id):
- **DeepWiki** (server 2.14.3; replies as an SSE stream; no session id): `read_wiki_contents {repoName}`, `read_wiki_structure {repoName}`, `ask_wiki_question {repoName, question}`. The docs call the last one `ask_question` (out of date), and its schema lists `repoName` as required without declaring it.
- **GitDiagram** (1.0.0, SSE): `get_repository_diagram {repository}`, `find_repository_diagrams {query, limit?}`, `get_explainer_video {repository}`.

Authorized runs:
- **DeepWiki:** `read_wiki_contents {"repoName":"sveltejs/kit"}` succeeded in 35.5 s. It returned markdown text in MCP `content[].text`, more than 200,000 characters, truncated by VidGen and stored as `unverified-external`. This exposed a bug: markdown links were parsed into bogus file paths. Fixed and regression-tested.
- **GitDiagram:** refused before any `tools/call`, because the old selector matched all three tools ("not guessing"). Per the test rules, no alternative was tried. The selector now prefers `get_repository_diagram`. **Live re-run with the fix:** succeeded in 2.3 s with `{"repository":"sveltejs/kit"}`, returning 14,201 characters of markdown (not truncated). File paths in links parsed cleanly, confirming the extraction fix on real output.

The stored DeepWiki record from the first run predates the path fix, so its `notFoundLocally` list still contains bogus `…](…` entries. Re-running DeepWiki would recompute it; that wasn't done, to avoid an extra external call.

**GitIngest 0.3.1** (PyPI; MIT; project URL `github.com/coderamp-labs/gitingest`), installed in an isolated venv in the scratchpad:
- **Python version:** crashes on import under Python 3.9 despite declaring `requires_python >=3.8`. Works on 3.14.
- **Undocumented flags:** the real CLI also has `-e/--exclude-pattern`, `-i/--include-pattern` and `-s/--max-size`, which the README doesn't list. VidGen doesn't rely on them.
- **Synthetic repo:** ordinary files plus fake `.env`, `.env.local`, an SSH private key, an `sk-` key and a JWT in source, a Playwright auth state, `storage-state.json` and a `.vidgen` cache entry. VidGen's sanitized copy (inspected before running) held only `README.md`, `src/greet.js` and `src/routes/+page.svelte`. The real digest contained only those files, with **0** planted secrets.
- **Network denied:** under macOS `sandbox-exec`, with network denied and writes restricted to the scratch area (enforcement confirmed: `curl` failed), it **completed successfully**.
- **Network observed:** with every proxy variable pointed at a logging proxy that refuses everything, it made **one outbound attempt: `CONNECT openaipublic.blob.core.windows.net:443`** (tiktoken tokenizer download). The request contents can't be seen through TLS. **So GitIngest is not offline by default.**
- **Hardening applied:**
  - VidGen now runs GitIngest from the sanitized directory;
  - it strips credential-like variables (`*TOKEN*`, `*SECRET*`, `*API_KEY*`, `AWS_*`, `GH_*`, `GITHUB_*`…);
  - it points all proxy variables at a dead local port, so proxy-aware HTTP clients fail fast.

  This is **best effort, not a sandbox**: code that ignores proxy variables could still connect. For a hard guarantee, run inside an OS network sandbox.

## Limitations

- No private-repo support: DeepWiki's private path needs a Devin account and API key, and GitDiagram's needs a GitHub token in its web UI. Both are deliberately unsupported.
- DeepWiki and GitDiagram are each live-validated for **one** public repo (`sveltejs/kit`) on one day. Tool names and schemas can change (DeepWiki's docs are already out of date); VidGen then refuses rather than guesses.
- DeepWiki answers can take more than 30 s and are often longer than VidGen keeps (200 KB cap, marked `truncated`).
- Rate limits and terms of use for these services aren't documented; check them before relying on them.
- Cross-checks are heuristic (path and route mentions only). Everything else in provider output is unverified prose.

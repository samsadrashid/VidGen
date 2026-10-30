#!/usr/bin/env node
// Run every offline suite SEQUENTIALLY, then the smoke demo, and print a summary. Usage: node tests/all.mjs
// (`node --test tests/` does not work: Node treats the directory as one file. Suites are listed explicitly.)
// Not included: tests/frameworks-real.mjs (needs npm network access) and the bench-*.mjs benchmarks.
// Exit 0 only if every suite and the smoke demo pass. Per-suite logs: $VIDGEN_TEST_LOGS (default: OS temp dir).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SUITES = ['core.test.mjs', 'auth.test.mjs', 'platform.test.mjs', 'cache.test.mjs', 'motion.test.mjs', 'frameworks.test.mjs', 'external.test.mjs', 'symlink.test.mjs', 'voiceover.test.mjs', 'audio-mix.test.mjs'];
// VIDGEN_SUITES=a.mjs,b.mjs (names under tests/ or absolute paths) runs a subset — used to verify the runner itself.
const selected = process.env.VIDGEN_SUITES ? process.env.VIDGEN_SUITES.split(',').filter(Boolean) : SUITES;
const logs = process.env.VIDGEN_TEST_LOGS || fs.mkdtempSync(path.join(os.tmpdir(), 'vidgen-tests-'));
fs.mkdirSync(logs, { recursive: true });

const run = (args, log) => new Promise((resolve) => {
  const t0 = Date.now();
  const p = spawn(process.execPath, args, { cwd: repo });
  const out = fs.createWriteStream(log);
  let text = '';
  p.stdout.on('data', (d) => { out.write(d); text += d; });
  p.stderr.on('data', (d) => { out.write(d); text += d; });
  p.on('close', (code) => { out.end(); resolve({ code, text, secs: Math.round((Date.now() - t0) / 1000) }); });
});
// Node >= 23 prints "ℹ pass N"; Node 20/22 print TAP "# pass N" when not on a TTY.
const count = (text, k) => Number(text.match(new RegExp(`^(?:ℹ|#) ${k} (\\d+)`, 'm'))?.[1] ?? NaN);

const rows = [];
for (const s of selected) {
  const log = path.join(logs, `${path.basename(s)}.log`);
  process.stdout.write(`running ${s} … `);
  const r = await run(['--test', path.isAbsolute(s) ? s : path.join('tests', s)], log);
  const row = { suite: s, exit: r.code, tests: count(r.text, 'tests'), pass: count(r.text, 'pass'), fail: count(r.text, 'fail'), skipped: count(r.text, 'skipped'), secs: r.secs, log };
  rows.push(row);
  console.log(`exit ${r.code}, ${row.pass}/${row.tests} pass, ${row.fail} fail, ${row.skipped} skipped (${r.secs}s)`);
}
process.stdout.write('running smoke.mjs … ');
const sm = await run([path.join('tests', 'smoke.mjs')], path.join(logs, 'smoke.log'));
const smokeOk = sm.code === 0 && /SMOKE PASS/.test(sm.text);
console.log(`exit ${sm.code}, ${smokeOk ? 'PASS' : 'FAIL'} (${sm.secs}s)`);
for (const l of sm.text.split('\n').filter((l) => /^(landscape|vertical):/.test(l))) console.log(`  ${l}`);

const total = rows.reduce((a, r) => ({ tests: a.tests + r.tests, pass: a.pass + r.pass, fail: a.fail + r.fail, skipped: a.skipped + r.skipped }), { tests: 0, pass: 0, fail: 0, skipped: 0 });
const ok = rows.every((r) => r.exit === 0 && r.fail === 0 && r.pass === r.tests - r.skipped) && smokeOk;
console.log(`\n${process.platform}-${process.arch} node ${process.version}`);
console.log(`TOTAL ${total.pass}/${total.tests} pass, ${total.fail} fail, ${total.skipped} skipped; smoke ${smokeOk ? 'PASS' : 'FAIL'} → ${ok ? 'ALL PASS' : 'FAILURES'}`);
console.log(`logs: ${logs}`);
fs.writeFileSync(path.join(logs, 'summary.json'), JSON.stringify({ platform: `${process.platform}-${process.arch}`, node: process.version, rows, smoke: { exit: sm.code, pass: smokeOk }, total, ok }, null, 2));
process.exit(ok ? 0 : 1);

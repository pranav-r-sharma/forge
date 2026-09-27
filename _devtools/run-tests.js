'use strict';
// Runs every _devtools/runtime_test/test_*.ts (or those matching an optional substring) in its own Node process, in parallel-limited fashion,
// and prints a per-file PASS/FAIL table plus totals. Exit code 1 if any file fails.
// usage: node _devtools/run-tests.js [filter] [--timeout=SECONDS]
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, 'runtime_test');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));
const timeoutS = Number((process.argv.find((a) => a.startsWith('--timeout=')) || '--timeout=180').split('=')[1]);
const benchDir = path.join(__dirname, 'bench');
const tsFiles = fs.readdirSync(dir).filter((f) => /^test.*\.ts$/.test(f) && (!filter || f.includes(filter))).sort();
// Python (standard-library) tests for the bench scripts live in _devtools/bench/test_*.py
const pyFiles = (fs.existsSync(benchDir) ? fs.readdirSync(benchDir) : []).filter((f) => /^test_.*\.py$/.test(f) && (!filter || f.includes(filter))).sort().map((f) => path.join('..', 'bench', f));
const files = [...tsFiles, ...pyFiles];
const results = [];
function runOne(f) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const isPy = f.endsWith('.py');
    const p = isPy ? spawn('python3', [path.join(dir, f)], { cwd: dir, env: process.env }) : spawn(process.execPath, [path.join(__dirname, 'run-ts.js'), path.join(dir, f)], { cwd: dir, env: process.env });
    let out = '';
    const timer = setTimeout(() => { out += '\n[runner] TIMEOUT\n'; p.kill('SIGKILL'); }, timeoutS * 1000);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => {
      clearTimeout(timer);
      const m = /(\d+) passed, (\d+) failed/.exec(out);
      // A file only counts as passing if it exits 0 AND printed its own completion line. Node exits 0 silently if the event loop empties
      // mid-await (e.g. an unref'd timer), which would otherwise look like a pass with checks never run.
      const complete = /All .*passed\./i.test(out) || (!!m && m[2] === '0');
      const noNotOk = !/^NOT OK/m.test(out);
      resolve({ file: f, code: code === 0 && complete && noNotOk ? 0 : code === 0 ? 'INCOMPLETE' : code, secs: ((Date.now() - t0) / 1000).toFixed(1), passed: m ? +m[1] : null, failed: m ? +m[2] : null, out });
    });
  });
}
(async () => {
  const queue = [...files]; const workers = Array.from({ length: 4 }, async () => { while (queue.length) { const f = queue.shift(); results.push(await runOne(f)); } });
  await Promise.all(workers);
  results.sort((a, b) => a.file.localeCompare(b.file));
  let ok = 0, bad = 0, tp = 0, tf = 0;
  for (const r of results) {
    const pass = r.code === 0; pass ? ok++ : bad++; tp += r.passed || 0; tf += r.failed || 0;
    console.log(`${pass ? 'PASS' : r.code === 'INCOMPLETE' ? 'INCOMPLETE' : 'FAIL'}  ${r.file.padEnd(38)} ${String(r.passed ?? '?').padStart(4)} passed ${String(r.failed ?? '?').padStart(3)} failed  ${r.secs}s`);
  }
  console.log(`\n${ok}/${results.length} files passed; ${tp} checks passed, ${tf} failed.`);
  if (bad) { for (const r of results.filter((x) => x.code !== 0)) { console.log(`\n--- ${r.file} (exit ${r.code}) — last lines ---\n` + r.out.trim().split('\n').slice(-8).join('\n')); } process.exit(1); }
})();

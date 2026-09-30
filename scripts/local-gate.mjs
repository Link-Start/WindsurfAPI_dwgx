#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function releaseEvidence(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r\n/g, '\n');
  const plans = [...text.matchAll(/^Running test shard \d+\/\d+: (\d+)\/\d+ files$/gm)];
  if (plans.length !== 1 || Number(plans[0][1]) === 0) throw new Error('missing or empty release file plan');
  const expected = Number(plans[0][1]);
  const files = [...text.matchAll(/^- (test\/[^\n]+\.test\.js)$/gm)].map(m => m[1]);
  if (files.length !== expected || new Set(files).size !== expected) throw new Error('release file plan mismatch');
  const rows = new Map();
  // A file whose whole suite is skipped at the describe level reports zero tests
  // with a `suites N` line as its only witness. The runner accepts that shape
  // (see parseFileSummary); the gate must accept exactly the same shape or the
  // gate can never pass on a suite that contains such a file.
  const suiteRows = new Map();
  for (const m of text.matchAll(/^((?:\[[^\]]+\]\s+)+)(?:#|ℹ) (tests|pass|fail|skipped|cancelled|todo|suites) (\d+)$/gm)) {
    const names = [...m[1].matchAll(/\[([^\]]+)\]/g)].map(x => x[1].replace(/\\/g, '/'));
    const file = names[0];
    if (!names.every(name => name === file) || !files.includes(file)) throw new Error('unexpected release file');
    if (m[2] === 'suites') { suiteRows.set(file, Number(m[3])); continue; }
    const row = rows.get(file) || {};
    if (Object.hasOwn(row, m[2])) throw new Error('duplicate release summary');
    row[m[2]] = Number(m[3]); rows.set(file, row);
  }
  if (rows.size !== expected) throw new Error(`release parsed ${rows.size}/${expected} files`);
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
  // Per-file skip census. A file whose every test skipped contributes zero to
  // `pass` while still counting toward `tests`, which is exactly the shape a
  // load-time throw produces: node --test reports the declared tests as
  // `skipped` and exits 0. Summing per file lets the caller name the offenders
  // instead of only reporting a total it cannot act on.
  const inert = [];
  for (const [file, row] of rows) {
    const zeroWithSuite = row.tests === 0 && Number.isSafeInteger(suiteRows.get(file)) && suiteRows.get(file) > 0;
    if (!Object.keys(totals).every(k => Number.isSafeInteger(row[k]))
        || (row.tests === 0 && !zeroWithSuite)
        || row.tests !== row.pass + row.fail + row.skipped + row.cancelled + row.todo) {
      throw new Error('incomplete release summary');
    }
    if (row.tests > 0 && row.pass + row.fail === 0) inert.push({ file, tests: row.tests });
    for (const key of Object.keys(totals)) totals[key] += row[key];
  }
  return { files: rows.size, ...totals, inert };
}

function execute(command, args, root, env) {
  return new Promise(done => {
    let output = '', error = null;
    const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk); });
    child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk); });
    child.on('error', failure => { error = failure.message; });
    child.on('close', (code, signal) => done({ code: error || signal ? 2 : code ?? 2, output, error,
      untrustworthy: Boolean(error || signal || code === null) }));
  });
}

/**
 * Inert test files the operator has explicitly accepted for this host.
 *
 * Semicolon- or newline-separated repo-relative paths in GATE_INERT_SKIP_PATHS.
 * The environment variable is an OVERRIDE, never a default: an empty value
 * means "accept nothing", so the gate fails on every inert file. Pre-seeding a
 * default list would recreate the original defect with extra steps — a file
 * that becomes inert through a new import-time throw would inherit acceptance
 * it was never reviewed for.
 */
export function inertSkipAllowlist(env = process.env) {
  return new Set(String(env.GATE_INERT_SKIP_PATHS || '')
    .split(/[;\n]/)
    .map(p => p.trim().replace(/\\/g, '/'))
    .filter(Boolean));
}

export async function runGate(root = process.cwd()) {
  // npm exposes the actual JS CLI path on Windows too. Launch it through Node rather
  // than spawning npm.cmd or interpolating command strings through a shell.
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    console.error('GATE: FAIL exit=2 — invoke this entry point with npm run gate');
    return 2;
  }
  const env = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR; delete env.NODE_TEST_CONTEXT;
  const steps = [
    ['spec-static-check', process.execPath, ['scripts/spec-static-check.mjs']],
    ['spec-baseline-check', process.execPath, ['scripts/spec-baseline-check.mjs']],
    ['secret-scan', process.execPath, ['scripts/secret-scan.mjs']],
    ['test:release', process.execPath, [npmCli, 'run', '--silent', 'test:release']],
    ['git diff --check', 'git', ['diff', '--check']],
    ['git diff --cached --check', 'git', ['diff', '--cached', '--check']],
  ];
  const results = [];
  for (const [name, command, args] of steps) {
    console.log(`\n=== ${name} ===`);
    const result = await execute(command, args, root, env);
    // Git uses exit 2 for whitespace errors. Only evidence-producing scripts
    // reserve that status for untrustworthy evidence; preserve every raw code.
    result.untrustworthy ||= result.code === 2 && ['spec-static-check', 'spec-baseline-check', 'test:release'].includes(name);
    let detail = result.error || '';
    if (name === 'test:release') {
      try {
        const counts = releaseEvidence(result.output);
        detail = `${counts.pass} pass / ${counts.fail} fail / ${counts.skipped} skip (${counts.files} files)`;
        if ((counts.fail || counts.cancelled) && result.code === 0) result.code = 1;
        // A file that declares tests but executes none is not evidence. It is
        // what a load-time throw looks like from out here: node --test reports
        // every declared test as skipped and still exits 0, so both the shard
        // runner and this summary would otherwise certify a suite that never
        // ran. Naming the files is the point — a skip total alone cannot be
        // acted on.
        //
        // Some inert files are legitimate and deliberate: the real-Git fixtures
        // skip on any host without git at a trusted absolute POSIX path, by
        // design (test/git-fixture-env.js:22-24, asserted in
        // git-fixture-availability.test.js:38-40). A hard failure there would
        // make the gate permanently red on Windows and teach people to bypass
        // it, which is worse than the bug. So the exemption is explicit and
        // per-file rather than a silent global: an operator declares the paths
        // they accept, and anything undeclared still fails. The default is
        // therefore FAIL, not pass.
        if (counts.inert.length && result.code === 0) {
          const accepted = inertSkipAllowlist(env);
          const inert = counts.inert.map(f => f.file.replace(/\\/g, '/'));
          const undeclared = counts.inert.filter(f => !accepted.has(f.file.replace(/\\/g, '/')));
          const unused = [...accepted].filter(p => !inert.includes(p));
          if (accepted.size) {
            detail += ` — ${counts.inert.length} inert file(s), ${accepted.size} declared`
              + (unused.length ? ` (unused: ${unused.join(', ')})` : '');
          }
          if (undeclared.length) {
            result.code = 1;
            detail += ` — ${undeclared.length} ran no tests and are not declared inert: `
              + undeclared.map(f => `${f.file} (${f.tests})`).join(', ')
              + (accepted.size ? '' : ' (set GATE_INERT_SKIP_PATHS to accept deliberate platform gates)');
          }
        }
      } catch (error) {
        // A real failing child stays a failure. Missing evidence on exit zero is exit two.
        if (result.code === 0) { result.code = 2; result.untrustworthy = true; }
        detail = `evidence unavailable: ${error.message}`;
      }
    }
    results.push({ name, code: result.code, untrustworthy: result.untrustworthy, detail });
  }
  console.log('\n=== Local gate summary ===');
  for (const row of results) console.log(`${row.code === 0 ? 'PASS' : 'FAIL'} ${row.name} exit=${row.code}${row.detail ? ` — ${row.detail}` : ''}`);
  console.log('SKIP mutation EXECUTION — this incremental gate checks spec shape, anchors and baseline'
    + ' values, but does not run the mutants themselves; the Linux full-gate recipe runs the sweep.');
  const code = results.some(row => row.untrustworthy) ? 2 : results.some(row => row.code !== 0) ? 1 : 0;
  console.log(`INCREMENTAL GATE: ${code ? 'FAIL' : 'PASS'} exit=${code}`);
  return code;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = await runGate(); }
  catch (error) { console.error(`GATE: FAIL exit=2 — ${error.message}`); process.exitCode = 2; }
}

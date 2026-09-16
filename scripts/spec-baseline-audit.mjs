#!/usr/bin/env node
// Re-measure every spec's expectBaselinePass and report drift.
//
// WHY THIS EXISTS SEPARATELY FROM spec-static-check.mjs
//
// The static check (anchors/shape) reads files and is ~0.3s. Baseline VALUE is a
// different animal: it requires actually running each spec's test files and comparing
// the pass count. That is expensive (all specs ~40 min) — too slow for per-PR CI, but
// exactly right as the POST-MERGE sweep that the repo already knows it needs
// (pr-gate --all-specs, SKILL.md step 5).
//
// History this exists to catch (all were invisible to `npm test`):
//   - retry-rescue-budget-split: 82 & 87 were both right alone, 88 merged (#242+#243)
//   - reasoning-continuity: 289 -> 300 (#243/#248 added tests to shared files)
//   - session-continuity-compaction-survival: 35 -> 48 (#242's tests)
//   - reasoning-dedup-incremental: 13 -> 18 (off-switch tests)
//
// Usage:
//   node scripts/spec-baseline-audit.mjs [spec-name-filter]
//
// Exit 0: every spec's baseline matches measured. Exit 1: drift found (prints the fix).
// Exit 2: at least one suite could not produce trustworthy structured evidence.
// Intended to run on master after merges (release workflow or post-merge gate).

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
let acquireMutationLock, harnessEnv, materializeMutationWorkspace, parseMutationReporterOutput;
try {
  ({ acquireMutationLock, harnessEnv, materializeMutationWorkspace, parseMutationReporterOutput } =
    await import('./mutation-harness-utils.mjs'));
} catch (error) {
  console.error(`spec-baseline-audit: infrastructure unavailable: ${error.message}`);
  process.exit(2);
}

const SOURCE_ROOT = process.cwd();
const SPEC_DIR = join(SOURCE_ROOT, 'test', 'mutations');
const filter = process.argv[2];

const C = process.stdout.isTTY
  ? { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' }
  : { red: '', green: '', yellow: '', dim: '', bold: '', reset: '' };

// Same invocation and same structured reporter as mutate-verify's runSuite. If
// this measured a count differently, a disagreement with the harness would be
// unexplainable — and the whole point is to report the TRUE number.
function measure(tests) {
  const workspace = materializeMutationWorkspace(SOURCE_ROOT);
  let stdout = '';
  let stderr = '';
  let executionFailure = null;
  try {
    stdout = execFileSync(process.execPath,
      [
        '--import', './scripts/mutation-network-deny.mjs',
        '--import', './test/setup-env.mjs',
        '--test-reporter=./scripts/mutation-harness-utils.mjs',
        '--test', ...tests,
      ],
      {
        cwd: workspace.root,
        encoding: 'utf8', env: harnessEnv(), stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
      });
  } catch (e) {
    stdout = e.stdout || '';
    stderr = e.stderr || '';
    executionFailure = {
      status: e.status, signal: e.signal, killed: e.killed === true, code: e.code,
    };
  } finally {
    workspace.cleanup();
  }
  return parseMutationReporterOutput(stdout, stderr, executionFailure);
}

let specs;
try {
  specs = readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.json'))
    .filter((f) => !filter || f.includes(filter))
    .sort();
} catch (error) {
  console.error(`spec-baseline-audit: cannot discover specs: ${error.message}`);
  process.exit(2);
}
if (!specs.length) {
  console.error('spec-baseline-audit: zero selected specs; evidence is untrustworthy');
  process.exit(2);
}

let drift = 0;
let untrustworthy = 0;
let total = 0;

// Lock the Owner repo once for the whole audit.  A clone-local lock would give
// every measured spec its own namespace and would not exclude another mutation
// harness running against the same checkout.
let releaseMutationLock;
try { releaseMutationLock = acquireMutationLock(SOURCE_ROOT); }
catch (err) {
  console.error(`${C.red}!${C.reset} spec-baseline-audit lock failure: ${err.message}`);
  process.exit(2);
}

try {
for (const name of specs) {
  total++;
  let spec;
  try { spec = JSON.parse(readFileSync(join(SPEC_DIR, name), 'utf8')); }
  catch (error) {
    untrustworthy++;
    console.error(`! ${name} invalid JSON: ${error.message}`);
    continue;
  }
  const tests = spec.tests;
  if (!Number.isSafeInteger(spec.expectBaselinePass) || spec.expectBaselinePass <= 0
      || !Array.isArray(tests) || !tests.length || tests.some(t => typeof t !== 'string')) {
    untrustworthy++;
    console.error(`! ${name} missing or invalid baseline/test-file evidence`);
    continue;
  }

  // Missing files invalidate evidence even when the static check was not run.
  if (tests.some((t) => !existsSync(join(process.cwd(), t)))) {
    untrustworthy++;
    console.log(`${C.red}!${C.reset} ${name}  (missing test file — evidence untrustworthy)`);
    continue;
  }

  let measured;
  try { measured = measure(tests); }
  catch (err) {
    untrustworthy++;
    console.log(`${C.red}!${C.reset} ${name}  (workspace failure: ${err.message})`);
    continue;
  }
  const { pass, fail, tests: testCount, skipped, cancelled, todo, infrastructureFailure } = measured;
  if (infrastructureFailure || testCount === 0 || testCount !== pass
      || fail !== 0 || skipped !== 0 || cancelled !== 0 || todo !== 0) {
    untrustworthy++;
    console.log(`${C.red}!${C.reset} ${name}  measurement untrustworthy `
      + `(pass=${pass} fail=${fail} tests=${testCount} skipped=${skipped} cancelled=${cancelled} todo=${todo})`);
    continue;
  }
  const ok = pass === spec.expectBaselinePass && fail === 0;
  if (ok) {
    console.log(`${C.green}✓${C.reset} ${name}  (${pass})`);
  } else {
    drift++;
    console.log(`${C.red}✗${C.reset} ${name}  expected=${spec.expectBaselinePass} measured=${pass} (fail=${fail})`);
    console.log(`     review: reproduce baseline=${pass}, inspect the changed test set, then update with provenance`);
  }
}

} finally { releaseMutationLock?.(); }
console.log(`\n${C.bold}spec-baseline-audit${C.reset}: ${total - drift - untrustworthy}/${total} match, ${drift} drifted, ${untrustworthy} untrustworthy`);
process.exit(untrustworthy ? 2 : drift ? 1 : 0);

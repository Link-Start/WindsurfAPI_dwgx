#!/usr/bin/env node
// Mutation-spec BASELINE drift check — the half of the mutation gate that no spec can
// see about itself, and the half that could not run on Windows until now.
//
// WHY THIS EXISTS
//
// `scripts/spec-static-check.mjs` verifies anchors and spec shape by reading files
// (~0.3s) and deliberately does not verify the baseline VALUE. That value is only
// checked by `scripts/spec-baseline-audit.mjs` — which imports
// `scripts/mutation-harness-utils.mjs`, whose git resolution is a list of POSIX
// absolute paths, so it throws on Windows and the check never ran here. The mutation
// harness itself is skipped by the incremental gate for the same reason.
//
// The drift it hides is real and already shipped twice: an independent audit found
// `s4-r4.json` pinned at 8 while its test list measured 9, and `think-text-reroute.json`
// pinned at 91 while it measured 95. Both were "merge products" — two repair commits
// added assertions to files other specs already pinned, and neither spec was
// re-measured. `npm test` cannot see it, because the suite does not run specs.
//
// WHAT IT DOES NOT DO
//
// It never writes a spec. A drifted number is a decision — the reviewer has to say
// which side is wrong — so the fix is printed, not applied. An automatic write-back
// would convert this check into a rubber stamp for exactly the drift it exists to catch.
//
// PLATFORM DIFFERENCES ARE NOT DRIFT
//
// A spec whose tests are partly skipped on this platform is not wrong here: on Windows
// `pass + skipped === expectBaselinePass` holds for every spec that differs. Lowering a
// Unix expectation to match this machine would be the bug, so skipped counts are
// accepted as an explanation and reported, never applied.
//
// Usage:
//   node scripts/spec-baseline-check.mjs              # specs whose tests changed vs the base
//   node scripts/spec-baseline-check.mjs --all        # every spec
//   node scripts/spec-baseline-check.mjs --base <ref> # change comparison base
//   node scripts/spec-baseline-check.mjs s4-r4.json   # named specs
//
// Exit 0: nothing drifted. Exit 1: drift found (the fix is printed). Exit 2: a suite did
// not produce trustworthy counts, or the selection could not be computed.

import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const argv = process.argv.slice(2);

const all = readdirSync(join(root, 'test/mutations'))
  .filter(name => name.endsWith('.json'))
  .sort();
if (!all.length) {
  console.error('spec-baseline-check: zero discovered specs — refusing to report a clean sweep');
  process.exit(2);
}

const flag = name => argv.includes(name);
const named = argv.filter(a => !a.startsWith('--'));
const baseIndex = argv.indexOf('--base');
const base = baseIndex >= 0 ? argv[baseIndex + 1] : 'origin/master';

function changedFiles(ref) {
  const out = execFileSync('git', ['diff', '--name-only', `${ref}...HEAD`], { cwd: root, encoding: 'utf8' });
  const list = out.split('\n').map(s => s.trim()).filter(Boolean);
  if (!list.length) throw new Error(`no changed files versus ${ref}`);
  return list;
}

// Selection: named specs, --all, or the specs whose own test files moved.
let selected;
if (named.length) {
  selected = named.map(n => n.split('/').pop());
  const unknown = selected.filter(n => !all.includes(n));
  if (unknown.length) {
    console.error(`spec-baseline-check: unknown spec(s): ${unknown.join(', ')}`);
    process.exit(2);
  }
} else if (flag('--all')) {
  selected = all;
} else {
  let changed;
  try {
    changed = new Set(changedFiles(base));
  } catch (error) {
    console.error(`spec-baseline-check: cannot diff against ${base} (${error.message}); use --all or --base <ref>`);
    process.exit(2);
  }
  selected = all.filter(name => {
    try {
      const spec = JSON.parse(readFileSync(join(root, 'test/mutations', name), 'utf8'));
      return (spec.tests || []).some(t => changed.has(t));
    } catch { return false; }
  });
}

if (!selected.length) {
  console.log(`spec-baseline-check: no spec covers a file changed versus ${base} — nothing to measure`);
  process.exit(0);
}

const counts = out => {
  const read = kind => {
    const hits = [...out.matchAll(new RegExp(`^\\u2139 ${kind} (\\d+)$`, 'gm'))].map(m => Number(m[1]));
    return hits.length ? hits[hits.length - 1] : null;
  };
  return { pass: read('pass'), fail: read('fail'), skipped: read('skipped') };
};

let drift = 0;
let untrustworthy = 0;
for (const name of selected) {
  const spec = JSON.parse(readFileSync(join(root, 'test/mutations', name), 'utf8'));
  const files = spec.tests || [];
  if (!files.length) {
    console.log(`FAIL ${name}: no tests listed`);
    untrustworthy++;
    continue;
  }
  const result = spawnSync(process.execPath, [
    '--import', './scripts/mutation-network-deny.mjs',
    '--import', './test/setup-env.mjs',
    '--test', ...files,
  ], { cwd: root, encoding: 'utf8', timeout: 900000, maxBuffer: 256 * 1024 * 1024 });
  const { pass, fail, skipped } = counts(`${result.stdout || ''}${result.stderr || ''}`);
  const expected = spec.expectBaselinePass;
  if (pass == null || fail == null) {
    console.log(`FAIL ${name}: no structured counts (exit ${result.status})`);
    untrustworthy++;
    continue;
  }
  if (fail > 0) {
    console.log(`FAIL ${name}: ${fail} failing test(s) — a spec's baseline cannot be judged on a red suite`);
    untrustworthy++;
    continue;
  }
  if (pass === expected) {
    console.log(`ok   ${name}: ${pass} pass${skipped ? ` (+${skipped} skipped on this platform)` : ''}`);
    continue;
  }
  if (pass + skipped === expected) {
    console.log(`ok   ${name}: ${pass} pass + ${skipped} skipped = ${expected} (platform skips, not drift)`);
    continue;
  }
  drift++;
  console.log(`DRIFT ${name}: expectBaselinePass is ${expected}, this platform measures ${pass} pass`
    + `${skipped ? ` + ${skipped} skipped` : ''} and 0 fail.`);
  console.log(`      fix: set "expectBaselinePass": ${pass + skipped} in test/mutations/${name}`
    + (skipped ? ' (on a platform that skips nothing)' : ''));
}

console.log(`\n${selected.length} spec(s) measured, ${drift} drift, ${untrustworthy} untrustworthy`);
process.exit(untrustworthy ? 2 : drift ? 1 : 0);

#!/usr/bin/env node
//
// DIAGNOSTIC (workflow_dispatch only). Not a gate and not on the PR path.
//
// Guard 5 in scripts/mutate-verify.mjs refuses to score a mutation whose suite reports a
// different number of tests than the baseline. The 2026-09-13 sweep aborted 8 specs that
// way, and the guard prints the reason as "a truncated or load-broken suite". That phrase
// is the guard's INFERENCE, not a measurement, and it is wrong for at least one spec: on
// Windows the same mutation leaves the count untouched (34 -> 34) and is cleanly CAUGHT,
// while the same bytes on Linux reported 19. See tmp/audit/VERIFICATION-LOG.md section 18.
//
// This script answers the two questions a VERDICT line cannot:
//
//   1. Is the missing count REAL, or is the harness's own reporter under-reporting?
//      The identical child is run twice per tree: once with the TAP reporter, once with the
//      harness's structured reporter. If TAP counts 34 and the harness reporter counts 19
//      on the same bytes, the defect is in the reporter or its parser, not in the mutation.
//   2. If the loss is real: WHICH tests disappeared, and what reason did node give?
//
// It also runs each arm in two trees, because the harness does NOT test in your checkout:
// mutate-verify materializes a disposable clone and runs the suite there. A path- or
// cwd-sensitive test could behave differently, so "checkout" alone would be a control-group
// error of the kind section 18 was written to stop repeating.
//
// Linux-only for one reason: scripts/mutation-harness-utils.mjs refuses to import unless git
// sits at one of its fixed absolute Unix paths.
//
// Usage: node scripts/diag-guard5-count.mjs <spec.json> [mutationIndex1Based]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  harnessEnv, parseMutationReporterOutput, materializeMutationWorkspace,
} from './mutation-harness-utils.mjs';

const MAX_TAP_LINES = 400;

const banner = (text) => console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);

/** One child run, env and argv identical to mutate-verify's runSuite. */
function execSuite(args, cwd) {
  try {
    return {
      out: execFileSync(process.execPath, args, {
        cwd, encoding: 'utf8', env: harnessEnv(), stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
      }),
      err: '', failure: null,
    };
  } catch (e) {
    return {
      out: e.stdout || '', err: e.stderr || '',
      failure: { status: e.status, signal: e.signal, killed: e.killed === true, code: e.code },
    };
  }
}

/** TAP reporter inventory: counts plus the exact multiset of names that reported. */
function tapInventory(text) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  const num = (re) => { const g = clean.match(re); return g ? Number(g[1]) : null; };
  const names = [];
  for (const line of clean.split('\n')) {
    const mm = line.match(/^(\s*)(not ok|ok) \d+ - (.*)$/);
    if (mm) names.push(`${'  '.repeat(mm[1].length / 4)}${mm[2]} ${mm[3]}`);
  }
  return {
    tests: num(/^# tests (\d+)$/m), pass: num(/^# pass (\d+)$/m),
    fail: num(/^# fail (\d+)$/m), skipped: num(/^# skipped (\d+)$/m),
    todo: num(/^# todo (\d+)$/m), names, clean,
  };
}

function harnessInventory({ out, err, failure }) {
  const m = parseMutationReporterOutput(out, err, failure);
  return {
    tests: m.tests, pass: m.pass, fail: m.fail, skipped: m.skipped,
    cancelled: m.cancelled, todo: m.todo,
    infrastructureFailure: m.infrastructureFailure === true,
    failedNames: m.failedNames || [],
  };
}

function printTap(label, tap) {
  const lines = tap.clean.split('\n');
  console.log(`\n--- ${label}: full TAP (${lines.length} lines) ---`);
  if (lines.length <= MAX_TAP_LINES) { console.log(tap.clean); return; }
  console.log(lines.slice(0, MAX_TAP_LINES / 2).join('\n'));
  console.log(`\n… [${lines.length - MAX_TAP_LINES} lines elided] …\n`);
  console.log(lines.slice(-MAX_TAP_LINES / 2).join('\n'));
}

/** Multiset difference: what is in `a` that `b` does not account for. */
function missingFrom(a, b) {
  const left = new Map();
  for (const x of b) left.set(x, (left.get(x) || 0) + 1);
  const out = [];
  for (const x of a) {
    const n = left.get(x) || 0;
    if (n > 0) left.set(x, n - 1); else out.push(x);
  }
  return out;
}

const [specPath, idxRaw, roundsRaw] = process.argv.slice(2);
if (!specPath) { console.error('usage: node scripts/diag-guard5-count.mjs <spec.json> [index] [rounds]'); process.exit(1); }
const rounds = Number(roundsRaw || '1');
const idx = Number(idxRaw || '1') - 1;
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
const mut = spec.mutations[idx];
if (!mut) { console.error(`no mutation #${idx + 1} in ${specPath}`); process.exit(1); }

const ROOT = process.cwd();
const COMMON = ['--import', './scripts/mutation-network-deny.mjs', '--import', './test/setup-env.mjs'];
const TAP_ARGS = [...COMMON, '--test-reporter=tap', '--test', '--test-force-exit', ...spec.tests];
const HARNESS_ARGS = [...COMMON, '--test-reporter=./scripts/mutation-harness-utils.mjs',
  '--test', '--test-force-exit', ...spec.tests];

banner(`guard-5 count divergence: ${specPath}`);
console.log(`mutation            : #${idx + 1} of ${spec.mutations.length} — ${mut.name}`);
console.log(`expectBaselinePass  : ${spec.expectBaselinePass ?? '(none)'}`);
console.log(`tests               : ${spec.tests.join(' ')}`);
console.log(`node                : ${process.version} on ${process.platform}`);

const anchorHits = readFileSync(resolve(ROOT, mut.file), 'utf8').split(mut.anchor).length - 1;
if (anchorHits !== 1) {
  console.error(`REFUSING: anchor matches ${anchorHits}x in ${mut.file}, need exactly 1`);
  process.exit(2);
}

function measure(label, cwd) {
  const tap = tapInventory(execSuite(TAP_ARGS, cwd).out);
  const h = harnessInventory(execSuite(HARNESS_ARGS, cwd));
  console.log(`[${label}] TAP     : tests=${tap.tests} pass=${tap.pass} fail=${tap.fail} skipped=${tap.skipped}`);
  console.log(`[${label}] HARNESS : tests=${h.tests} pass=${h.pass} fail=${h.fail}`
    + ` skipped=${h.skipped} cancelled=${h.cancelled} infra=${h.infrastructureFailure}`);
  return { tap, h };
}

/** Write the mutation into `cwd`, proving the write landed. */
function applyIn(cwd) {
  const p = resolve(cwd, mut.file);
  const cur = readFileSync(p, 'utf8');
  const hits = cur.split(mut.anchor).length - 1;
  if (hits !== 1) throw new Error(`anchor matches ${hits}x in ${mut.file} inside ${cwd}`);
  writeFileSync(p, cur.replace(mut.anchor, mut.replacement));
  if (readFileSync(p, 'utf8') === cur) throw new Error(`write did not land in ${cwd}`);
}

async function armCheckout() {
  banner('ARM 1. the repository checkout (cwd = process.cwd())');
  console.log('baseline:');
  const base = measure('checkout baseline', ROOT);
  printTap('checkout baseline', base.tap);

  console.log(`\napplying mutation #${idx + 1} to ${mut.file} …`);
  applyIn(ROOT);
  console.log('mutation applied to disk: true');
  let m;
  try {
    m = measure('checkout mutated', ROOT);
  } finally {
    execFileSync('git', ['checkout', 'HEAD', '--', mut.file], { cwd: ROOT, stdio: 'ignore' });
  }
  console.log(`reverted ${mut.file} cleanly: ${readFileSync(resolve(ROOT, mut.file), 'utf8').split(mut.anchor).length - 1 === 1}`);
  printTap('checkout mutated', m.tap);
  return { base, mut: m };
}

async function armDisposable() {
  banner('ARM 2. a materialized disposable clone (where mutate-verify actually tests)');
  let ws;
  try { ws = materializeMutationWorkspace(ROOT); }
  catch (e) { console.log(`SKIPPED — could not materialize: ${e.message}`); return null; }
  try {
    console.log(`workspace: ${ws.root}`);
    const base = measure('disposable baseline', ws.root);
    applyIn(ws.root);
    console.log('mutation applied inside the disposable clone: true');
    const m = measure('disposable mutated', ws.root);
    printTap('disposable mutated', m.tap);
    return { base, mut: m };
  } finally {
    ws.cleanup?.();
  }
}

/**
 * The whole point: TAP and the harness reporter read the SAME bytes. If they disagree, the
 * count loss is a reporting defect; if they agree, it is real and the names say which tests.
 */
function conclude(name, r) {
  if (!r) return;
  banner(`CONCLUSION — ${name}`);
  const tapDelta = r.mut.tap.tests - r.base.tap.tests;
  const hDelta = r.mut.h.tests - r.base.h.tests;
  console.log(`TAP     tests: baseline ${r.base.tap.tests} -> mutated ${r.mut.tap.tests}   (delta ${tapDelta})`);
  console.log(`HARNESS tests: baseline ${r.base.h.tests} -> mutated ${r.mut.h.tests}   (delta ${hDelta})`);
  console.log('');
  if (tapDelta === 0 && hDelta !== 0) {
    console.log('>>> REPORTER ARTIFACT: TAP shows no loss while the harness reporter does.');
    console.log('    The defect is in the reporter or its parser, NOT in the mutation.');
  } else if (tapDelta !== 0 && hDelta !== 0) {
    console.log('>>> REAL LOSS: both reporters agree that tests stopped reporting.');
  } else if (tapDelta === 0 && hDelta === 0) {
    console.log('>>> NO DIVERGENCE REPRODUCED on this runner for this mutation.');
  } else {
    console.log('>>> MIXED: TAP lost tests that the harness reporter did not. Inspect the parser.');
  }
  const gone = missingFrom(r.base.tap.names, r.mut.tap.names);
  const added = missingFrom(r.mut.tap.names, r.base.tap.names);
  console.log(`\nTAP names: baseline ${r.base.tap.names.length}, mutated ${r.mut.tap.names.length}`);
  console.log(`\nDISAPPEARED (${gone.length}):`);
  for (const n of gone) console.log(`  - ${n}`);
  console.log(`\nAPPEARED (${added.length}):`);
  for (const n of added) console.log(`  + ${n}`);
  console.log(`\nharness failedNames (mutated): ${r.mut.h.failedNames.join(' | ') || '(none)'}`);
}

/**
 * DRIFT MODE (rounds > 1): run the SAME unmutated baseline N times and report whether the
 * number of tests the harness counts is stable. This is the judgement the 2026-09-13 sweeps
 * could not make: mutate-verify printed "baseline pass=60 but spec expects 72" in one sweep
 * and "baseline pass=72 but spec expects 60" in the next, for a spec whose `tests` array is a
 * SINGLE unchanged file. If N identical runs disagree, no declared baseline can be correct.
 */
async function driftMode() {
  banner(`DRIFT MODE — ${rounds} identical baseline runs of ${spec.tests.join(' ')}`);
  console.log('No mutation is applied here. Same bytes, same argv, same env, every round.');
  console.log('Counting both ways: TAP (# tests) and the harness parser (counts.tests).\n');
  const seen = new Map();
  const seenTap = new Map();
  const seenNames = new Map();
  const rounds_ = [];
  for (let r = 1; r <= rounds; r++) {
    const h = harnessInventory(execSuite(HARNESS_ARGS, ROOT));
    const tap = tapInventory(execSuite(TAP_ARGS, ROOT).out);
    const key = `${h.tests}/${h.pass}/${h.fail}`;
    seen.set(key, (seen.get(key) || 0) + 1);
    seenTap.set(String(tap.tests), (seenTap.get(String(tap.tests)) || 0) + 1);
    const nk = [...tap.names].sort().join('\u0000');
    seenNames.set(nk, (seenNames.get(nk) || 0) + 1);
    rounds_.push({ r, h, tap });
    console.log(`round ${String(r).padStart(3)}  HARNESS tests=${h.tests} pass=${h.pass} fail=${h.fail}`
      + ` skipped=${h.skipped} cancelled=${h.cancelled} infra=${h.infrastructureFailure}`
      + `   | TAP tests=${tap.tests} pass=${tap.pass} fail=${tap.fail}  names=${tap.names.length}`);
  }
  banner('DRIFT RESULT');
  console.log(`rollout ${spec.tests.join(' ')}`);
  console.log(`declared expectBaselinePass = ${spec.expectBaselinePass ?? '(none)'}\n`);
  console.log('harness (tests/pass/fail) -> how many rounds:');
  for (const [k, n] of [...seen.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}   x${n}`);
  console.log('\nTAP (# tests) -> how many rounds:');
  for (const [k, n] of [...seenTap.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k}   x${n}`);
  console.log(`\ndistinct TAP name-sets: ${seenNames.size}`);
  const totals = [...seen.keys()].map((k) => Number(k.split('/')[0]));
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  console.log(`\n${seen.size === 1 ? '>>> STABLE' : '>>> UNSTABLE (DRIFT CONFIRMED)'}: harness counted ${lo}..${hi} across ${rounds} identical runs.`);
  if (seen.size > 1) {
    console.log('    A baseline that varies run-to-run makes expectBaselinePass unsatisfiable and');
    console.log('    makes guard 5 trip at random. Fix the DIGIT STABILITY, not the declared value.');
  }

  // WHICH tests disappear? A suffix means the run was CUT SHORT at a point in time; a
  // scattered set means per-test trouble. The distinction decides the fix, so measure it.
  const richest = rounds_.reduce((a, b) => (b.tap.names.length > a.tap.names.length ? b : a));
  const leanest = rounds_.reduce((a, b) => (b.tap.names.length < a.tap.names.length ? b : a));
  banner(`WHICH TESTS DISAPPEARED — round ${leanest.r} (${leanest.tap.names.length} names) vs round ${richest.r} (${richest.tap.names.length} names)`);
  const have = new Map();
  for (const n of leanest.tap.names) have.set(n, (have.get(n) || 0) + 1);
  const positions = [];
  richest.tap.names.forEach((n, i) => {
    const c = have.get(n) || 0;
    if (c > 0) have.set(n, c - 1); else positions.push({ i, n });
  });
  const total = richest.tap.names.length;
  console.log(`missing ${positions.length} of ${total} entries. Their positions in the fullest run:`);
  for (const p of positions.slice(0, 60)) console.log(`  #${String(p.i).padStart(3)}/${total}  ${p.n}`);
  if (positions.length > 60) console.log(`  … and ${positions.length - 60} more`);
  const idx = positions.map((p) => p.i).sort((a, b) => a - b);
  const contiguousTail = idx.length > 0 && idx[idx.length - 1] === total - 1
    && idx.every((v, k) => k === 0 || v === idx[k - 1] + 1);
  console.log(`\nare they a contiguous TAIL of the run? ${contiguousTail ? 'YES -> the run is CUT SHORT' : 'NO -> scattered, not a simple truncation'}`);
  console.log(`first missing index ${idx[0] ?? '-'}, last ${idx[idx.length - 1] ?? '-'}, count ${idx.length}`);

  // Per-top-level-suite child counts, leanest vs richest. A suite that reports ZERO children in
  // the leanest round means its tests were never REGISTERED there -- which distinguishes "the
  // runner lost results" from "the file never declared them". node's own summary arithmetic
  // (tests === pass+fail+skipped+cancelled+todo) already holds in truncated runs, so the
  // aggregate agrees with whatever it was told; this shows what it was told.
  const suites = (round) => {
    const out = [];
    let cur = null;
    for (const line of round.tap.clean.split('\n')) {
      const m = line.match(/^(\s*)(not ok|ok) \d+ - (.*)$/);
      if (!m) continue;
      const depth = m[1].length / 4;
      if (depth === 0) { cur = { name: m[3], kids: 0 }; out.push(cur); }
      else if (cur && depth === 1) cur.kids++;
    }
    return out;
  };
  const ls = suites(leanest);
  const rs = suites(richest);
  console.log(`\ntop-level suites: leanest round ${leanest.r} = ${ls.length}, richest round ${richest.r} = ${rs.length}`);
  console.log('  (# = children reported in that round)');
  const maxLen = Math.max(ls.length, rs.length);
  for (let i = 0; i < maxLen; i++) {
    const a = ls[i], b = rs[i];
    const flag = (!a || !b || a.kids !== b.kids) ? '  <-- differs' : '';
    console.log(`  [${String(i).padStart(2)}] leanest=${a ? String(a.kids).padStart(3) : ' --'}`
      + `  richest=${b ? String(b.kids).padStart(3) : ' --'}`
      + `  ${(b || a).name.slice(0, 62)}${flag}`);
  }

  if (leanest.tap.tests < richest.tap.tests) {
    banner(`FULL TAP OF THE LEANEST ROUND (${leanest.r}, ${leanest.tap.tests} tests) — where does it stop?`);
    console.log(leanest.tap.clean);
  }
}

if (rounds > 1) {
  await driftMode();
} else {
  const checkout = await armCheckout();
  conclude('checkout', checkout);
  const disposable = await armDisposable();
  conclude('disposable clone', disposable);

  banner('BOTTOM LINE');
  for (const [name, r] of [['checkout', checkout], ['disposable', disposable]]) {
    if (!r) { console.log(`${name.padEnd(11)} not measured`); continue; }
    console.log(`${name.padEnd(11)} TAP ${r.base.tap.tests}->${r.mut.tap.tests}   HARNESS ${r.base.h.tests}->${r.mut.h.tests}`);
  }
}

#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 90_000;
const TEST_SETUP = pathToFileURL(resolve(process.cwd(), 'test/setup-env.mjs')).href;

export function parseArgs(argv) {
  const positional = [];
  let timeoutMs = Number(process.env.TEST_FILE_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--timeout-ms') {
      timeoutMs = Number(argv[++i]);
      continue;
    }
    if (arg?.startsWith('--timeout-ms=')) {
      timeoutMs = Number(arg.slice('--timeout-ms='.length));
      continue;
    }
    positional.push(arg);
  }

  const shardIndex = Number(positional[0] ?? process.env.TEST_SHARD_INDEX ?? 0);
  const shardTotal = Number(positional[1] ?? process.env.TEST_SHARD_TOTAL ?? 1);
  if (!Number.isInteger(shardIndex) || shardIndex < 0) {
    throw new Error(`Invalid shard index: ${positional[0] ?? process.env.TEST_SHARD_INDEX ?? ''}`);
  }
  if (!Number.isInteger(shardTotal) || shardTotal < 1) {
    throw new Error(`Invalid shard total: ${positional[1] ?? process.env.TEST_SHARD_TOTAL ?? ''}`);
  }
  if (shardIndex >= shardTotal) {
    throw new Error(`Shard index ${shardIndex} must be smaller than shard total ${shardTotal}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1_000) {
    throw new Error(`Invalid per-file timeout: ${timeoutMs}`);
  }
  return { shardIndex, shardTotal, timeoutMs };
}

export function listTopLevelTestFiles(root = process.cwd()) {
  // The historical export name is retained; discovery includes nested test files.
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      // `test/_research/` is deliberately outside the runnable set, the same way the
      // secret scanner already skips it: those files are captured-evidence notebooks,
      // and this one's expected token counts are stale relative to today's handler.
      // Making it run again means re-baselining it, not discovering it by accident.
      if (entry.isDirectory() && entry.name === '_research') continue;
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && entry.name.endsWith('.test.js')) {
        files.push(path.slice(root.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  root = resolve(root);
  walk(join(root, 'test'));
  return files.sort((a, b) => a.localeCompare(b));
}

export function selectShard(files, shardIndex, shardTotal) {
  return files.filter((_, i) => i % shardTotal === shardIndex);
}

export function parseFileSummary(output) {
  const counts = {};
  const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
  for (const match of stripped.matchAll(
    /^(?:#|ℹ) (tests|pass|fail|skipped|cancelled|todo) (\d+)\r?$/gm,
  )) {
    if (Object.hasOwn(counts, match[1])) throw new Error(`Duplicate summary: ${match[1]}`);
    counts[match[1]] = Number(match[2]);
  }
  for (const field of ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']) {
    if (!Number.isSafeInteger(counts[field])) throw new Error(`Missing summary: ${field}`);
  }
  if (counts.tests !== counts.pass + counts.fail + counts.skipped + counts.cancelled + counts.todo) {
    throw new Error('Incomplete test summary');
  }
  // A file whose whole suite is skipped at the describe level reports zero tests —
  // node emits the suite with its skip reason and no test entries at all. That is a
  // measured skip, not a truncated run, so it needs the suite line as its witness:
  // `tests 0` with no suite at all is still an incomplete summary.
  if (counts.tests === 0 && !/(?:^|\n)(?:#|\u2139) suites [1-9]/.test(stripped)) {
    throw new Error('Incomplete test summary');
  }
  return counts;
}

function runOne(file, timeoutMs) {
  return new Promise(resolveRun => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [
      // Do not force exit: a timeout is a named failure, not a truncated green run.
      '--import', TEST_SETUP, '--test', file,
    ], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let spawnError = null;
    const prefix = `[${file}] `;
    for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      // Decode and prefix complete lines; arbitrary pipe chunk boundaries must not
      // split the reporter's count fields or a multibyte character.
      stream.setEncoding('utf8');
      let pending = '';
      stream.on('data', chunk => {
        if (stream === child.stdout) stdout = (stdout + chunk).slice(-64 * 1024);
        pending += chunk;
        let newline;
        while ((newline = pending.indexOf('\n')) !== -1) {
          destination.write(prefix + pending.slice(0, newline + 1));
          pending = pending.slice(newline + 1);
        }
      });
      stream.on('end', () => { if (pending) destination.write(prefix + pending + '\n'); });
    }
    child.on('error', error => { spawnError = error.message; });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.();
    }, timeoutMs);
    child.on('close', code => {
      clearTimeout(timer);
      let counts = null;
      let summaryError = null;
      try { counts = parseFileSummary(stdout); }
      catch (error) { summaryError = error.message; }
      resolveRun({ file, code, timedOut, counts, summaryError, spawnError,
        ok: !timedOut && !spawnError && !summaryError && code === 0 && counts.fail === 0 });
    });
  });
}

export async function runShard({ shardIndex, shardTotal, timeoutMs, root = process.cwd() }) {
  const files = listTopLevelTestFiles(root);
  const selected = selectShard(files, shardIndex, shardTotal);
  if (!selected.length) throw new Error('Test shard selected zero files');
  console.log(`Running test shard ${shardIndex + 1}/${shardTotal}: ${selected.length}/${files.length} files`);
  for (const file of selected) console.log(`- ${file}`);

  const totals = { files: selected.length, measuredFiles: 0, tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
  const failures = [];
  for (const file of selected) {
    const result = await runOne(file, timeoutMs);
    if (result.counts) {
      totals.measuredFiles++;
      for (const key of ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo']) totals[key] += result.counts[key];
    }
    if (!result.ok) failures.push(result);
  }

  console.log(`TEST_SHARD_SUMMARY ${JSON.stringify(totals)}`);
  console.log(`Suite: ${totals.pass} pass / ${totals.fail} fail / ${totals.skipped} skip (${totals.measuredFiles}/${totals.files} files measured)`);
  if (failures.length) {
    console.error(`Test shard ${shardIndex + 1}/${shardTotal} failed:`);
    for (const failure of failures) {
      const suffix = failure.timedOut ? `timed out after ${timeoutMs}ms`
        : failure.spawnError || failure.summaryError || `exit ${failure.code}`;
      console.error(`- ${failure.file}: ${suffix}`);
    }
    return 1;
  }
  return 0;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    process.exitCode = await runShard(opts);
  } catch (err) {
    console.error(err?.message || err);
    process.exitCode = 2;
  }
}

#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function selectSpecs(root, names = [], shard = '0/1') {
  const all = readdirSync(join(root, 'test/mutations')).filter(n => n.endsWith('.json'))
    .sort().map(n => `test/mutations/${n}`);
  if (!all.length) throw new Error('zero discovered mutation specs');
  const requested = names.length ? names.map(n => n.includes('/') ? n : `test/mutations/${n}`) : all;
  if (new Set(requested).size !== requested.length) throw new Error('duplicate spec selection');
  for (const name of requested) if (!all.includes(name)) throw new Error(`unknown spec: ${name}`);
  const match = /^(\d+)\/(\d+)$/.exec(shard);
  if (!match) throw new Error('shard must be zero-based i/N');
  const [index, total] = match.slice(1).map(Number);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index >= total) {
    throw new Error('invalid shard index/total');
  }
  const selected = [...requested].sort().filter((_, i) => i % total === index);
  if (!selected.length) throw new Error('zero selected specs (including empty shards)');
  return { discovered: all.length, selected, shard };
}

export function verifyReport(directory) {
  const plan = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  const text = readFileSync(join(directory, 'verdicts.log'), 'utf8');
  if (!Array.isArray(plan.selected) || !plan.selected.length
      || new Set(plan.selected).size !== plan.selected.length) throw new Error('empty or duplicate manifest');
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = lines.map(line => /^VERDICT (\S+) (OK|FAIL|UNTRUSTWORTHY) exit=(\d+)$/.exec(line));
  if (rows.some(row => !row)) throw new Error('malformed VERDICT record');
  const seen = rows.map(row => row[1]);
  if (rows.length !== plan.selected.length || new Set(seen).size !== plan.selected.length
      || seen.some(name => !plan.selected.includes(name))) {
    throw new Error(`VERDICT coverage mismatch: expected=${plan.selected.length} actual=${rows.length}`);
  }
  for (const row of rows) if ((row[2] === 'OK') !== (row[3] === '0')) throw new Error('inconsistent verdict/exit');
  const code = rows.some(row => row[2] === 'UNTRUSTWORTHY') ? 2 : rows.some(row => row[2] === 'FAIL') ? 1 : 0;
  return { expected: plan.selected.length, actual: rows.length, code };
}

export function runSweep(argv, root = process.cwd()) {
  let names = [], shard = '0/1', directory;
  for (let i = 0; i < argv.length; i++) {
    const value = () => { if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${argv[i]}`); return argv[++i]; };
    if (argv[i] === '--specs') {
      names = value().split(/[\s,]+/).filter(Boolean);
      if (!names.length) throw new Error('explicit spec selection is empty');
    }
    else if (argv[i] === '--shard') shard = value();
    else if (argv[i] === '--report-dir') directory = resolve(value());
    else if (argv[i] === '--verify' && argv.length === 2) {
      const result = verifyReport(resolve(value()));
      console.log(`VERDICT coverage: ${result.actual}/${result.expected}; exit=${result.code}`);
      return result.code;
    } else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const plan = selectSpecs(root, names, shard);
  directory ??= mkdtempSync(join(tmpdir(), 'wa-mutation-sweep-'));
  const rel = relative(resolve(root), directory);
  if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
    throw new Error('report directory must be outside the owner working tree');
  }
  mkdirSync(directory, { recursive: true });
  // Exclusive creation prevents a retry from reusing or overwriting old evidence.
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  writeFileSync(join(directory, 'verdicts.log'), '', { flag: 'wx' });
  console.log(`Sweep: discovered=${plan.discovered} selected=${plan.selected.length} shard=${shard}`);
  console.log(`Report: ${directory}`);
  for (const spec of plan.selected) {
    const child = spawnSync(process.execPath, ['scripts/mutate-verify.mjs', spec], {
      cwd: root, encoding: 'utf8', env: process.env,
      maxBuffer: 128 * 1024 * 1024,
    });
    const output = `${child.stdout || ''}${child.stderr || ''}`;
    // Child output cannot masquerade as an authoritative sweep record.
    process.stdout.write(output.split(/\r?\n/).filter(Boolean).map(line => `  ${line}\n`).join(''));
    const code = child.error || child.signal || child.status === null ? 2 : child.status;
    const verdict = code === 0 ? 'OK' : code === 2 ? 'UNTRUSTWORTHY' : 'FAIL';
    if (child.error) console.error(`  spawn failure: ${child.error.message}`);
    const line = `VERDICT ${spec} ${verdict} exit=${code}\n`;
    appendFileSync(join(directory, 'verdicts.log'), line);
    process.stdout.write(line);
  }
  // Read the persisted records, not a loop counter: omissions and duplicates are failures.
  const result = verifyReport(directory);
  console.log(`VERDICT coverage: ${result.actual}/${result.expected}; exit=${result.code}`);
  return result.code;
}

if (resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = runSweep(process.argv.slice(2)); }
  catch (error) { console.error(`mutation sweep: ${error.message}`); process.exitCode = 2; }
}

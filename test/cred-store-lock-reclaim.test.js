// WHY THIS FILE EXISTS. The credential store serialises writers through a lock
// whose identity is an INSTANCE, never a path:
//
//   <store>.lock            permanent sentinel at the fixed pre-v2 path
//                             • a regular file holding {"v":2} — a fresh store
//                             • a pre-v2 directory that now holds format.json
//   <store>.lock.claims/    retained coordination directory
//     claim-<host>-<pid>-<token>/     one immutable claim per writer
//
// The first lock was a single owner.json at a fixed path, reclaimed by re-reading
// that path: two reclaimers could judge the same dead owner, and the slower one
// then deleted whatever occupied the path by then — including a live writer's
// brand-new lock (2026-09-17 review, P1). Its identity was also a second write, so
// a partial owner write (ENOSPC) left an unreadable stamp that fenced every later
// save forever (P2).
//
// Every interleaving below is driven by executing the real module text with only
// its boundary imports and the process liveness probe substituted (the same
// technique test/sec1-credential-persistence.test.js uses for fs). The claim name,
// the sentinel gate, the claims sweep and the publish fences are production code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, utimesSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const cred = await import('../src/devin-connect-credentials.js');
const SOURCE = readFileSync(new URL('../src/devin-connect-credentials.js', import.meta.url), 'utf8');
const MODULE_URL = pathToFileURL(resolve('src/devin-connect-credentials.js')).href;
const KEY = 'fixture-master-key-for-lock-reclaim';
const EMAIL = 'lock-probe@example.test';
// Same encoding the module uses, so a name this file builds by hand is the one
// the module would have built.
const HOST_TAG = Buffer.from(hostname(), 'utf8').toString('hex');

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cred-lock-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { DEVIN_CONNECT_CRED_KEY: KEY, DEVIN_CONNECT_CRED_FILE: join(dir, 'creds.json') } };
}

function deadPid() {
  // A pid that is provably gone: run a child to completion and reuse its pid.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  return child.pid;
}

const sentinel = env => `${env.DEVIN_CONNECT_CRED_FILE}.lock`;
const claimsDir = env => `${env.DEVIN_CONNECT_CRED_FILE}.lock.claims`;
const instances = env => (existsSync(claimsDir(env)) ? readdirSync(claimsDir(env)) : []);
const claimNamed = (pid, token = 'a'.repeat(32), host = HOST_TAG) => `claim-${host}-${pid}-${token}`;

// Execute the real module text with only its boundary imports substituted. Sync
// fs hooks must stay sync; returning promises would test a different API.
function loadModule({ fsOverrides = {}, kill } = {}) {
  const deps = {
    fs: { ...fs, ...fsOverrides },
    path,
    crypto,
    os: { hostname },
    './config.js': { config: {}, log: { info() {}, warn() {}, error() {} } },
    './devin-connect-metrics.js': { bumpConnect() {}, __registerCredHealth() {} },
  };
  const executable = SOURCE
    .replace(/^import \{([\s\S]*?)\} from '([^']+)';/gm,
      (_all, bindings, name) => `const {${bindings}} = deps[${JSON.stringify(name)}];`)
    .replace(/^export /gm, '');
  const body = `const process = deps.kernelProcess;\n${executable}`
    + '\nreturn { storeCredential, getCredential, acquireClaim, __testing };';
  return new Function('deps', body)({
    ...deps,
    kernelProcess: { pid: process.pid, env: process.env, kill: kill || process.kill.bind(process) },
  });
}

function legacyDir(env, stamp) {
  const lock = sentinel(env);
  mkdirSync(lock, { recursive: true });
  if (stamp !== undefined) writeFileSync(join(lock, 'owner.json'), typeof stamp === 'string' ? stamp : JSON.stringify(stamp));
  return lock;
}

// ─── The sentinel path ─────────────────────────────────────────────────────

test('a fresh store publishes a file sentinel a pre-v2 release cannot remove', (t) => {
  const { env } = sandbox(t);
  assert.equal(cred.storeCredential(EMAIL, 'pw-fresh', env), true);
  assert.equal(statSync(sentinel(env)).isFile(), true, 'the sentinel must be a regular file, never a directory');
  assert.deepEqual(JSON.parse(readFileSync(sentinel(env), 'utf8')), { v: 2 });
  assert.deepEqual(instances(env), [], 'no claim instance may survive the write');
  // A pre-v2 release released its lock with unlink(owner.json) + rmdir(lock): the
  // sentinel is a file, so that rmdir can never take the path away.
  assert.throws(() => fs.rmdirSync(sentinel(env)), 'rmdir on the sentinel must fail');
  // Repeated writes reuse the same sentinel and leave the claims directory empty.
  for (let i = 0; i < 4; i++) assert.equal(cred.storeCredential(`repeat-${i}@example.test`, `pw-${i}`, env), true);
  assert.equal(statSync(sentinel(env)).isFile(), true);
  assert.deepEqual(instances(env), []);
  assert.equal(cred.listCredentialEmails(env).length, 5);
});

test('a sentinel file this code did not write is refused, never overwritten', (t) => {
  const { env } = sandbox(t);
  writeFileSync(sentinel(env), 'not a marker\n');
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-unknown-file', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(readFileSync(sentinel(env), 'utf8'), 'not a marker\n');
  writeFileSync(sentinel(env), JSON.stringify({ v: 99 }));
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-other-format', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
});

// ─── Pre-v2 directories: migrated in place, or refused ─────────────────────

test('a dead pre-v2 stamp is migrated in place and the write proceeds', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: deadPid(), host: hostname() });
  assert.equal(cred.storeCredential(EMAIL, 'pw-dead-owner', env), true);
  assert.equal(existsSync(join(lock, 'owner.json')), false, 'the dead stamp must be gone');
  assert.deepEqual(JSON.parse(readFileSync(join(lock, 'format.json'), 'utf8')), { v: 2 });
  assert.deepEqual(readdirSync(lock), ['format.json'], 'the directory keeps its permanent marker and nothing else');
  assert.equal(cred.getCredential(EMAIL, env), 'pw-dead-owner');
  // The migrated directory can never be removed by a pre-v2 release path.
  assert.throws(() => fs.rmdirSync(lock), (e) => e.code === 'ENOTEMPTY');
});

test('a pre-v2 owner that is alive still refuses, and nothing is written into its directory', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: process.pid, host: hostname() });
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-live-owner', env),
    (e) => e.code === 'ERR_CRED_STORE_BUSY', 'a live owner must still be respected');
  assert.deepEqual(readdirSync(lock), ['owner.json'], 'a refusal must not add or remove anything');
  assert.equal(existsSync(join(lock, 'format.json')), false);
});

test('a pre-v2 owner from another host is never migrated here', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: 999999, host: 'some-other-host' });
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-foreign', env),
    (e) => e.code === 'ERR_CRED_STORE_BUSY', 'liveness of a foreign host cannot be checked from here');
  assert.deepEqual(readdirSync(lock), ['owner.json']);
});

test('an unreadable pre-v2 stamp is refused, never stolen', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, '{"pid": 1234, "host": "fixture');
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-torn', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(readdirSync(lock), ['owner.json']);
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), '{"pid": 1234, "host": "fixture');
});

test('an unknown artifact in a pre-v2 directory refuses the write and is left alone', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: deadPid(), host: hostname() });
  writeFileSync(join(lock, 'mystery'), 'x');
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-mystery', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(readdirSync(lock).sort(), ['mystery', 'owner.json']);
});

test('an empty pre-v2 directory is never adopted, however old it looks', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, undefined);
  // A pre-v2 writer between its mkdir and its owner write is indistinguishable
  // from a leftover, and how long it paused cannot be observed. Age is not proof.
  utimesSync(lock, new Date(0), new Date(0));
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-aged', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(readdirSync(lock), [], 'the untouched directory must stay empty');
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-aged-again', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
});

test('a migrated directory cleans a crashed migrator but respects a live one', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: deadPid(), host: hostname() });
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  mkdirSync(join(lock, claimNamed(deadPid(), 'b'.repeat(32))));
  assert.equal(cred.storeCredential(EMAIL, 'pw-after-crash', env), true, 'a dead guard must not fence the store');
  assert.deepEqual(readdirSync(lock), ['format.json']);

  mkdirSync(join(lock, claimNamed(process.pid, 'c'.repeat(32))));
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-live-guard', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(readdirSync(lock).sort(), [claimNamed(process.pid, 'c'.repeat(32)), 'format.json'].sort(),
    'a live instance must never be removed');
});

test('a torn marker staged by a crashed migrator is reclaimed, not treated as an artifact', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: deadPid(), host: hostname() });
  // The migrator died between staging the marker and renaming it into place.
  writeFileSync(join(lock, claimNamed(deadPid(), 'd'.repeat(32))), '{"v":2');
  assert.equal(cred.storeCredential(EMAIL, 'pw-torn-marker', env), true);
  assert.deepEqual(readdirSync(lock), ['format.json']);
});

test('a pre-v2 directory replaced before the guard is refused, never adopted', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: deadPid(), host: hostname() });
  // The audit's deterministic replacement case: the pre-guard listing still shows a
  // dead D0, but an old reclaimer has already removed it and an old writer has
  // created the replacement directory it is about to stamp. Nothing may be
  // concluded from the stamp being gone after the guard — absence is not death.
  let swapped = false;
  const mod = loadModule({
    fsOverrides: {
      readdirSync(name, ...args) {
        const entries = fs.readdirSync(name, ...args);
        if (!swapped && String(name) === lock && entries.includes('owner.json')) {
          swapped = true;
          fs.unlinkSync(join(lock, 'owner.json'));
          fs.rmdirSync(lock);
          fs.mkdirSync(lock);              // the old writer's mkdir, before its owner write
        }
        return entries;                    // the stale listing the migrator acted on
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-swapped', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(swapped, true, 'the replacement must have happened before the guard');
  assert.deepEqual(readdirSync(lock), [],
    'the replacement directory belongs to the old writer: the guard must be given back');
  assert.equal(existsSync(join(lock, 'format.json')), false, 'no marker may be installed over a directory this writer did not prove dead');
  assert.equal(existsSync(env.DEVIN_CONNECT_CRED_FILE), false, 'and nothing may be stored');
});

test('a replacement directory holding a DIFFERENT stamp is refused, never adopted', (t) => {
  const { env } = sandbox(t);
  const stampA = { pid: deadPid(), host: hostname() };
  const lock = legacyDir(env, stampA);
  // Sharpening of the case above: the pre-guard read returns the stamp that was
  // proved dead, and the directory is replaced BEFORE the guard, so the replacement
  // already carries a stamp of its own by the time the migrator holds the barrier.
  // That stamp parses and is even dead; only a re-read AFTER the guard can tell it
  // is not the one this writer proved dead. A reader that trusted the pre-guard
  // value would migrate a directory that belongs to another writer.
  let replacement = null;
  const mod = loadModule({
    fsOverrides: {
      readFileSync(name, ...args) {
        const data = fs.readFileSync(name, ...args);
        if (replacement === null && String(name) === join(lock, 'owner.json')) {
          fs.unlinkSync(join(lock, 'owner.json'));
          fs.rmdirSync(lock);
          fs.mkdirSync(lock);
          replacement = { pid: deadPid(), host: hostname() };
          fs.writeFileSync(join(lock, 'owner.json'), JSON.stringify(replacement));
        }
        return data;                                       // the stale bytes the migrator acted on
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-foreign-stamp', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(readdirSync(lock), ['owner.json'], 'the replacement keeps its stamp: this writer never proved THAT one dead');
  assert.deepEqual(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')), replacement, 'and the stamp is untouched');
  assert.equal(existsSync(join(lock, 'format.json')), false, 'no marker may be installed over a directory this writer did not prove dead');
  assert.equal(existsSync(env.DEVIN_CONNECT_CRED_FILE), false, 'and nothing may be stored');
});

test('an unreadable stamp inside an already-migrated directory is refused, never deleted', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, 'not-json{{{');
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  // Marker present, stamp present but unparseable: absence of a READABLE stamp is
  // not evidence of death, so the only safe move is to leave the evidence alone.
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-unreadable', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(readdirSync(lock).sort(), ['format.json', 'owner.json'], 'the unreadable stamp must survive');
  assert.equal(existsSync(env.DEVIN_CONNECT_CRED_FILE), false, 'and nothing may be stored');
});

test('a failed marker install keeps the dead-owner evidence and the retry succeeds', (t) => {
  const { env } = sandbox(t);
  const lock = legacyDir(env, { pid: deadPid(), host: hostname() });
  let inject = true;
  const mod = loadModule({
    fsOverrides: {
      writeFileSync(name, ...args) {
        // The permanent marker is staged under a claim-shaped name inside the
        // directory; fail exactly there, once.
        if (inject && typeof name === 'string' && name.startsWith(join(lock, 'claim-'))) {
          inject = false;
          throw Object.assign(new Error('synthetic marker ENOSPC'), { code: 'ENOSPC' });
        }
        return fs.writeFileSync(name, ...args);
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-marker-fault', env), (e) => e.code === 'ENOSPC');
  assert.deepEqual(readdirSync(lock), ['owner.json'],
    'the dead stamp must survive a failed install: never an empty directory, never lost evidence');
  assert.equal(mod.storeCredential(EMAIL, 'pw-marker-fault', env), true, 'the retry must complete once the fault clears');
  assert.deepEqual(readdirSync(lock), ['format.json']);
  assert.equal(mod.getCredential(EMAIL, env), 'pw-marker-fault');
});

// ─── Claim instances ───────────────────────────────────────────────────────

test('a dead claim instance is reclaimed and a live one in the same directory is untouched', (t) => {
  const { env } = sandbox(t);
  cred.storeCredential(EMAIL, 'pw-seed', env);
  mkdirSync(join(claimsDir(env), claimNamed(deadPid())));
  const live = claimNamed(process.pid, 'b'.repeat(32));
  mkdirSync(join(claimsDir(env), live));
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-both', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(instances(env), [live], 'the dead instance is gone, the live instance is exactly where it was');
});

test('a foreign-host claim and an unknown artifact in the claims directory both refuse', (t) => {
  const { env } = sandbox(t);
  cred.storeCredential(EMAIL, 'pw-seed', env);
  const foreign = `claim-${Buffer.from('other-host', 'utf8').toString('hex')}-4242-${'c'.repeat(32)}`;
  mkdirSync(join(claimsDir(env), foreign));
  mkdirSync(join(claimsDir(env), 'mystery-artifact'));
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-unknown', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(instances(env).sort(), ['mystery-artifact', foreign].sort());
});

test('a dead claim whose initialization failed halfway is still reclaimed', (t) => {
  const { env } = sandbox(t);
  cred.storeCredential(EMAIL, 'pw-seed', env);
  const dead = claimNamed(deadPid());
  mkdirSync(join(claimsDir(env), dead));
  writeFileSync(join(claimsDir(env), dead, 'leftover'), '{');
  assert.equal(cred.storeCredential(EMAIL, 'pw-torn-instance', env), true);
  assert.deepEqual(instances(env), []);
});

// ─── The F1 interleaving and the publish fences ────────────────────────────

test('a stale reclaimer must not delete the claim a new writer just took', (t) => {
  const { env } = sandbox(t);
  const gone = deadPid();
  const dead = claimNamed(gone);
  const stolen = claimNamed(process.pid, 'd'.repeat(32));
  cred.storeCredential(EMAIL, 'pw-seed', env);
  mkdirSync(join(claimsDir(env), dead));

  // The interleaving the old lock lost to: during the liveness probe of the dead
  // instance, that instance is already gone and a NEW writer's claim occupies the
  // directory. Deleting by path takes the new claim; deleting by identity does not.
  let switched = false;
  const mod = loadModule({
    kill(pid, signal) {
      assert.equal(signal, 0);
      if (pid === gone && !switched) {
        switched = true;
        fs.rmdirSync(join(claimsDir(env), dead));
        fs.mkdirSync(join(claimsDir(env), stolen));
      }
      return process.kill(pid, signal);
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-stale-reclaimer', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(switched, true, 'the probe must have been reached');
  assert.equal(existsSync(join(claimsDir(env), stolen)), true, 'the new writer\'s claim must survive a stale reclaim');
  assert.equal(cred.getCredential(EMAIL, env), 'pw-seed', 'and the stored record must be the one from before, not a stale snapshot');
});

test('a writer that lost its claim while reading refuses instead of publishing', (t) => {
  const { env } = sandbox(t);
  let dropped = false;
  const mod = loadModule({
    fsOverrides: {
      readFileSync(name, ...args) {
        // The snapshot read happens while the claim is held: drop the instance
        // then, exactly as a foreign cleaner would.
        if (!dropped && String(name) === env.DEVIN_CONNECT_CRED_FILE) {
          for (const entry of readdirSync(claimsDir(env))) {
            if (entry.startsWith('claim-')) { fs.rmdirSync(join(claimsDir(env), entry)); dropped = true; }
          }
        }
        return fs.readFileSync(name, ...args);
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-lost-claim', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(dropped, true, 'the claim must have been present while the lock was held');
  assert.equal(existsSync(env.DEVIN_CONNECT_CRED_FILE), false, 'a lost claim must not publish a stale snapshot');
});

test('a writer that lost its claim during the temp write must not rename it into place', (t) => {
  const { dir, env } = sandbox(t);
  assert.equal(cred.storeCredential(EMAIL, 'pw-first', env), true);
  const before = readFileSync(env.DEVIN_CONNECT_CRED_FILE);
  let dropped = false;
  const mod = loadModule({
    fsOverrides: {
      writeFileSync(target, ...args) {
        // The store content is written through a file descriptor; the claim is
        // still held at that moment.
        if (!dropped && typeof target === 'number') {
          for (const entry of readdirSync(claimsDir(env))) {
            if (entry.startsWith('claim-')) { fs.rmdirSync(join(claimsDir(env), entry)); dropped = true; }
          }
        }
        return fs.writeFileSync(target, ...args);
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-second', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(dropped, true);
  assert.deepEqual(readFileSync(env.DEVIN_CONNECT_CRED_FILE), before, 'the published store must not change');
  assert.equal(existsSync(env.DEVIN_CONNECT_CRED_FILE + '.tmp'), false);
  assert.equal(readdirSync(dir).filter(name => name.includes('.tmp')).length, 0, 'no temp file may survive the refusal');
});

// ─── Failure injection: nothing fences, the original error survives ────────

test('a failed sentinel publication reports the original error and fences nothing', (t) => {
  const { env } = sandbox(t);
  const claims = claimsDir(env);
  let inject = true;
  const mod = loadModule({
    fsOverrides: {
      writeFileSync(name, ...args) {
        if (inject && typeof name === 'string' && String(name).startsWith(claims)) {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return fs.writeFileSync(name, ...args);
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-enospc', env), (e) => e.code === 'ENOSPC',
    'the caller must see the real failure, not BUSY');
  assert.equal(existsSync(sentinel(env)), false, 'the sentinel path must stay absent');
  assert.deepEqual(instances(env), [], 'and no staged file may be left behind');

  inject = false;                                  // the fault clears
  assert.equal(mod.storeCredential(EMAIL, 'pw-enospc', env), true, 'the next save must succeed');
  assert.equal(mod.getCredential(EMAIL, env), 'pw-enospc');
});

test('a claim that could not be created reports the original error and fences nothing', (t) => {
  const { env } = sandbox(t);
  let inject = true;
  const mod = loadModule({
    fsOverrides: {
      mkdirSync(name, ...args) {
        if (inject && String(name).includes('claim-')) {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return fs.mkdirSync(name, ...args);
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-enospc-claim', env), (e) => e.code === 'ENOSPC');
  inject = false;
  assert.equal(mod.storeCredential(EMAIL, 'pw-enospc-claim', env), true);
  assert.deepEqual(instances(env), [], 'the retry must not leak its claim either');
});

test('a failed read after the claim is taken releases it and preserves the error', (t) => {
  const { env } = sandbox(t);
  const claims = claimsDir(env);
  let inject = true;
  const mod = loadModule({
    fsOverrides: {
      readdirSync(name, ...args) {
        const entries = fs.readdirSync(name, ...args);
        if (inject && String(name) === claims && entries.some(entry => String(entry).startsWith('claim-'))) {
          inject = false;
          throw Object.assign(new Error('injected post-claim scan failure'), { code: 'EIO' });
        }
        return entries;
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-eio', env), (e) => e.code === 'EIO',
    'the real failure must reach the caller');
  assert.deepEqual(instances(env), [], 'a failed read must not leak this writer\'s own claim');

  assert.equal(mod.storeCredential(EMAIL, 'pw-eio', env), true, 'the next call must work');
  assert.equal(mod.getCredential(EMAIL, env), 'pw-eio');
});

// ─── Real processes, real read-modify-write ────────────────────────────────

test('four processes serialise through the claim and lose no record', { timeout: 60000 }, async (t) => {
  const { dir, env } = sandbox(t);
  const childPath = join(dir, 'writer.mjs');
  writeFileSync(childPath, [
    `import { storeCredential } from ${JSON.stringify(MODULE_URL)};`,
    'const [file, key, email, password] = process.argv.slice(2);',
    'const env = { DEVIN_CONNECT_CRED_KEY: key, DEVIN_CONNECT_CRED_FILE: file };',
    'for (let i = 0; i < 400; i++) {',
    '  try { storeCredential(email, password, env); process.exit(0); }',
    '  catch (error) {',
    '    if (error.code !== "ERR_CRED_STORE_BUSY") { console.error(error.code || error.message); process.exit(3); }',
    '    await new Promise(r => setTimeout(r, 5));',
    '  }',
    '}',
    'console.error("busy-timeout"); process.exit(4);',
  ].join('\n'));

  // Every child this test spawns is tracked so an aborted run cannot leave a
  // writer (or the lock it holds) behind: only our own children are terminated,
  // and their close is awaited before the test is over.
  const spawned = [];
  t.after(async () => {
    for (const entry of spawned) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill();
    }
    await Promise.all(spawned.map(entry => entry.closed));
  });

  const runWriter = (name) => new Promise((resolve) => {
    const child = spawn(process.execPath, [childPath, env.DEVIN_CONNECT_CRED_FILE, KEY, `${name}@example.test`, `pw-${name}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const entry = { child, closed: null };
    entry.closed = new Promise((closed) => {
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', (error) => { closed(); resolve({ name, code: `spawn-error:${error.code || error.message}`, stderr }); });
      child.on('close', (code) => { closed(); resolve({ name, code, stderr }); });
    });
    spawned.push(entry);
  });

  const results = await Promise.all(['one', 'two', 'three', 'four'].map(runWriter));
  assert.deepEqual(results.map(r => r.code), [0, 0, 0, 0], JSON.stringify(results));

  // Each writer read-modify-wrote the whole store under the lock: a lost update
  // would leave a record missing or a password from another writer's snapshot.
  const records = JSON.parse(readFileSync(env.DEVIN_CONNECT_CRED_FILE, 'utf8')).records;
  assert.deepEqual(Object.keys(records).sort(), ['four@example.test', 'one@example.test', 'three@example.test', 'two@example.test']);
  for (const name of ['one', 'two', 'three', 'four']) {
    assert.equal(cred.getCredential(`${name}@example.test`, env), `pw-${name}`);
  }
  assert.deepEqual(instances(env), [], 'every writer must have given its claim instance back');
});

// WHY THIS FILE EXISTS. The credential store serialises writers through a lock
// directory, and the lock's identity is an INSTANCE, never a path:
//
//   <store>.lock/                          coordination directory, kept forever
//     format.json                          {"v":2} — this directory is ours
//     claim-<host>-<pid>-<boot>-<token>/   one immutable claim per writer
//     owner.json                           pre-v2 stamp (read-only here)
//
// The first lock carried one owner.json at the fixed path and reclaimed it by
// re-reading that path. Two reclaimers could judge the same dead owner, and the
// slower one then deleted whatever occupied the path by then — including a live
// writer's brand-new lock (2026-09-17 review, P1). And because the stamp was a
// second, separate write, a writer that died between mkdir and the stamp left an
// unreadable lock that fenced every later save forever (P2). Both halves are
// asserted here, because "reclaim" without the refusal half would silently steal
// locks from live writers.
//
// The reclaim interleavings are driven by executing the real module text with
// only its boundary imports and the process liveness probe substituted (the same
// technique test/sec1-credential-persistence.test.js uses for fs). Everything the
// interleaving depends on — the claim name, the container read, the publish
// fence — is the production code, not a re-implementation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, realpathSync, utimesSync } from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { tmpdir, hostname, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
// The credential store is imported below on purpose: the module reads its env
// per call, so no import-time state matters, but keeping the dynamic import
// documents that this suite is about that module and not about auth.js.
const cred = await import('../src/devin-connect-credentials.js');
const SOURCE = readFileSync(new URL('../src/devin-connect-credentials.js', import.meta.url), 'utf8');
const MODULE_URL = pathToFileURL(resolve('src/devin-connect-credentials.js')).href;
const KEY = 'fixture-master-key-for-lock-reclaim';
const EMAIL = 'lock-probe@example.test';
// Same encoding the module uses, so a claim name this file builds by hand is the
// one the module would have built.
const HOST_TAG = Buffer.from(hostname(), 'utf8').toString('hex');
const BOOT = Math.floor(uptime());

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

function claimDir(env) { return `${env.DEVIN_CONNECT_CRED_FILE}.lock`; }

function claimNames(env) {
  const dir = claimDir(env);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(entry => entry.startsWith('claim-'));
}

function claimNamed(pid, boot = BOOT, token = 'a'.repeat(32)) {
  return `claim-${HOST_TAG}-${pid}-${boot}-${token}`;
}

// Execute the real module text with only its boundary imports substituted. Sync
// fs hooks must stay sync; returning promises would test a different API.
function loadModule({ fsOverrides = {}, kill } = {}) {
  const deps = {
    fs: { ...fs, ...fsOverrides },
    path,
    crypto,
    os: { hostname, uptime },
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

// ─── Pre-v2 locks: refused unless provably dead ────────────────────────────

test('a lock left by a dead pre-v2 writer is reclaimed and the write proceeds', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: deadPid(), host: hostname() }));

  assert.equal(cred.storeCredential(EMAIL, 'pw-dead-owner', env), true, 'the dead owner must not fence the write');
  assert.equal(existsSync(join(lock, 'owner.json')), false, 'the dead pre-v2 stamp must be gone');
  assert.equal(existsSync(join(lock, 'format.json')), true, 'and the directory must now advertise its format');
  assert.deepEqual(claimNames(env), [], 'no claim instance may survive the write');
  assert.equal(cred.getCredential(EMAIL, env), 'pw-dead-owner');
});

test('a pre-v2 owner that is alive still refuses, and its stamp is left alone', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  const stamp = { pid: process.pid, host: hostname() };
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify(stamp));

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-live-owner', env),
    (e) => e.code === 'ERR_CRED_STORE_BUSY', 'a live owner must still be respected');
  assert.deepEqual(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')), stamp);
  assert.equal(existsSync(join(lock, 'format.json')), false, 'a refusal must not rewrite the directory either');
});

test('a pre-v2 owner from another host is never reclaimed here', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, host: 'some-other-host' }));

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-foreign', env),
    (e) => e.code === 'ERR_CRED_STORE_BUSY', 'liveness of a foreign host cannot be checked from here');
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).host, 'some-other-host');
});

test('an unreadable pre-v2 stamp is refused, never stolen', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), '{"pid": 1234, "host": "fixture');

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-torn', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), '{"pid": 1234, "host": "fixture',
    'an unprovable stamp must stay exactly as it was found');
});

test('a fresh marker-less directory is refused; a settled one is adopted', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  // A pre-v2 writer sits between its mkdir and its stamp: nothing may enter.
  assert.throws(() => cred.storeCredential(EMAIL, 'pw-fresh-empty', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(readdirSync(lock), [], 'the fresh directory must not gain a claim');
  // The same directory, untouched for longer than the settle window, is a
  // leftover from a writer that will never come back.
  const settled = Date.now() / 1000 - 30;
  utimesSync(lock, settled, settled);
  assert.equal(cred.storeCredential(EMAIL, 'pw-settled-empty', env), true);
  assert.equal(cred.getCredential(EMAIL, env), 'pw-settled-empty');
});

// ─── Claim instances: never deleted, always fenced ─────────────────────────

test('a dead claim instance is reclaimed and a live one in the same container is untouched', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  mkdirSync(join(lock, claimNamed(deadPid())));
  mkdirSync(join(lock, claimNamed(process.pid, BOOT, 'b'.repeat(32))));

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-both', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.deepEqual(claimNames(env), [claimNamed(process.pid, BOOT, 'b'.repeat(32))],
    'the dead instance is gone, the live instance is exactly where it was');
  assert.equal(existsSync(lock), true, 'a reclaim must never remove the shared container');
});

test('a claim from before this boot is reclaimed even though its pid looks alive', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  // Same host, this process's own (live) pid, but a boot stamp that can only
  // belong to a machine that has since restarted: the pid was recycled.
  mkdirSync(join(lock, claimNamed(process.pid, BOOT + 3600)));

  assert.equal(cred.storeCredential(EMAIL, 'pw-pre-boot', env), true, 'a pre-boot claim cannot be a live writer');
  assert.deepEqual(claimNames(env), []);
  assert.equal(cred.getCredential(EMAIL, env), 'pw-pre-boot');
});

test('a live claim instance is never removed, whatever else the container holds', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  const live = claimNamed(process.pid);
  mkdirSync(join(lock, live));

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-live-claim', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(existsSync(join(lock, live)), true);
});

test('a foreign-host claim and an unknown artifact both refuse, and are left alone', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  const foreign = `claim-${Buffer.from('other-host', 'utf8').toString('hex')}-4242-7-${'c'.repeat(32)}`;
  mkdirSync(join(lock, foreign));
  mkdirSync(join(lock, 'mystery-artifact'));

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-unknown', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(existsSync(join(lock, foreign)), true);
  assert.equal(existsSync(join(lock, 'mystery-artifact')), true);
});

test('a stale reclaimer must not delete the claim a new writer just took', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  const gone = deadPid();
  const dead = claimNamed(gone);
  const stolen = claimNamed(process.pid, BOOT, 'd'.repeat(32));
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  mkdirSync(join(lock, dead));

  // The interleaving the old lock lost to: during the liveness probe of the dead
  // instance, that instance is already gone and a NEW writer's claim occupies the
  // container. Deleting by path takes the new claim; deleting by identity does not.
  let switched = false;
  const mod = loadModule({
    kill(pid, signal) {
      assert.equal(signal, 0);
      if (pid === gone && !switched) {
        switched = true;
        fs.rmdirSync(join(lock, dead));
        fs.mkdirSync(join(lock, stolen));
      }
      return process.kill(pid, signal);
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-stale-reclaimer', env), (e) => e.code === 'ERR_CRED_STORE_BUSY');
  assert.equal(switched, true, 'the probe must have been reached');
  assert.equal(existsSync(join(lock, stolen)), true, 'the new writer\'s claim must survive a stale reclaim');
  assert.equal(existsSync(env.DEVIN_CONNECT_CRED_FILE), false, 'and no snapshot may be published past it');
});

test('a writer that lost its claim instance refuses instead of publishing', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  let dropped = false;
  const mod = loadModule({
    fsOverrides: {
      readFileSync(name, ...args) {
        // The snapshot read happens while the claim is held: drop the instance
        // then, exactly as a foreign cleaner would.
        if (!dropped && String(name) === env.DEVIN_CONNECT_CRED_FILE) {
          for (const entry of readdirSync(lock)) {
            if (entry.startsWith('claim-')) { fs.rmdirSync(join(lock, entry)); dropped = true; }
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

// ─── Initialization failure leaves nothing behind (P2) ─────────────────────

test('a failed container bootstrap reports the original error and fences nothing', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  let inject = true;
  const mod = loadModule({
    fsOverrides: {
      writeFileSync(name, ...args) {
        if (inject && String(name).includes('.format.')) {
          throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
        }
        return fs.writeFileSync(name, ...args);
      },
    },
  });
  assert.throws(() => mod.storeCredential(EMAIL, 'pw-enospc', env), (e) => e.code === 'ENOSPC',
    'the caller must see the real failure, not BUSY');
  assert.equal(existsSync(lock), false, 'an unmarkerable container must be handed back, not left to fence the store');
  assert.equal(existsSync(env.DEVIN_CONNECT_CRED_FILE), false);

  inject = false;                                  // the fault clears
  assert.equal(mod.storeCredential(EMAIL, 'pw-enospc', env), true, 'the next save must succeed');
  assert.equal(mod.getCredential(EMAIL, env), 'pw-enospc');
});

test('a claim that could not be created reports the original error and fences nothing', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
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
  assert.deepEqual(readdirSync(lock), ['format.json'], 'a failed claim creates nothing to reclaim');

  inject = false;
  assert.equal(mod.storeCredential(EMAIL, 'pw-enospc-claim', env), true);
  assert.deepEqual(claimNames(env), [], 'the retry must not leak its claim either');
});

test('a dead claim that failed halfway is still reclaimed', (t) => {
  const { env } = sandbox(t);
  const lock = claimDir(env);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'format.json'), JSON.stringify({ v: 2 }));
  const dead = claimNamed(deadPid());
  mkdirSync(join(lock, dead));
  // A torn artifact inside a dead instance must not make it look foreign: the
  // instance name is the identity, so the whole instance is reclaimable litter.
  writeFileSync(join(lock, dead, 'owner.json'), '{');

  assert.equal(cred.storeCredential(EMAIL, 'pw-torn-instance', env), true);
  assert.deepEqual(claimNames(env), []);
  assert.equal(cred.getCredential(EMAIL, env), 'pw-torn-instance');
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

  const writers = ['one', 'two', 'three', 'four'].map(name => new Promise((done) => {
    const child = spawn(process.execPath, [childPath, env.DEVIN_CONNECT_CRED_FILE, KEY, `${name}@example.test`, `pw-${name}`], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => done({ name, code, stderr }));
  }));
  const results = await Promise.all(writers);
  assert.deepEqual(results.map(r => r.code), [0, 0, 0, 0], JSON.stringify(results));

  // Each writer read-modify-wrote the whole store under the lock: a lost update
  // would leave a record missing or a password from another writer's snapshot.
  const records = JSON.parse(readFileSync(env.DEVIN_CONNECT_CRED_FILE, 'utf8')).records;
  assert.deepEqual(Object.keys(records).sort(), ['four@example.test', 'one@example.test', 'three@example.test', 'two@example.test']);
  for (const name of ['one', 'two', 'three', 'four']) {
    assert.equal(cred.getCredential(`${name}@example.test`, env), `pw-${name}`);
  }
  assert.deepEqual(claimNames(env), [], 'every writer must have given its claim instance back');
});

test('the claim format keeps the container reusable across many writes', (t) => {
  const { env } = sandbox(t);
  for (let i = 0; i < 5; i++) {
    assert.equal(cred.storeCredential(`repeat-${i}@example.test`, `pw-${i}`, env), true);
  }
  assert.deepEqual(readdirSync(claimDir(env)), ['format.json']);
  assert.equal(cred.listCredentialEmails(env).length, 5);
});

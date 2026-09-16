// WHY THIS FILE EXISTS. The credential store serialises writers with a
// mkdir-based lock. The first version never reclaimed that lock, so a writer
// that died mid-save fenced every later write forever — the store became
// read-only by accident and only an operator deleting the directory could fix
// it. The lock now carries an owner stamp (pid + hostname) and is reclaimed
// only when that owner is provably gone on this host; a lock whose owner is
// alive (or whose owner cannot be checked, e.g. another host) still refuses.
//
// Both halves are asserted here, because "reclaim" without the refusal half
// would silently steal locks from live writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
// The credential store is imported below on purpose: the module reads its env
// per call, so no import-time state matters, but keeping the dynamic import
// documents that this suite is about that module and not about auth.js.
const cred = await import('../src/devin-connect-credentials.js');
const KEY = 'fixture-master-key-for-lock-reclaim';
const EMAIL = 'lock-probe@example.test';

function sandbox(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cred-lock-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, env: { DEVIN_CONNECT_CRED_KEY: KEY, DEVIN_CONNECT_CRED_FILE: join(dir, 'creds.json') } };
}

test('a lock left by a dead writer is reclaimed and the write proceeds', (t) => {
  const { env } = sandbox(t);
  const lock = `${env.DEVIN_CONNECT_CRED_FILE}.lock`;
  // A pid that is provably gone: run a child to completion and reuse its pid.
  const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  assert.equal(child.status, 0);
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: child.pid, host: hostname() }));

  assert.equal(cred.storeCredential(EMAIL, 'pw-dead-owner', env), true, 'the dead owner must not fence the write');
  assert.equal(existsSync(lock), false, 'the reclaimed lock must be released after the write');
  assert.equal(cred.getCredential(EMAIL, env), 'pw-dead-owner');
});

test('a lock whose owner is alive still refuses (no stealing from a live writer)', (t) => {
  const { env } = sandbox(t);
  const lock = `${env.DEVIN_CONNECT_CRED_FILE}.lock`;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname() }));

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-live-owner', env),
    (e) => e.code === 'ERR_CRED_STORE_BUSY', 'a live owner must still be respected');
  assert.equal(existsSync(lock), true, 'a refused write must not remove the holder lock');
});

test('a lock from another host is never reclaimed here', (t) => {
  const { env } = sandbox(t);
  const lock = `${env.DEVIN_CONNECT_CRED_FILE}.lock`;
  mkdirSync(lock, { recursive: true });
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, host: 'some-other-host' }));

  assert.throws(() => cred.storeCredential(EMAIL, 'pw-foreign', env),
    (e) => e.code === 'ERR_CRED_STORE_BUSY', 'liveness of a foreign host cannot be checked from here');
  assert.equal(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).host, 'some-other-host');
});

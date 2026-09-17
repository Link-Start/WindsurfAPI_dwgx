import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';

const source = fs.readFileSync(new URL('../src/devin-connect-credentials.js', import.meta.url), 'utf8');

// Execute the actual module text with only its boundary imports substituted.
// Sync fs hooks must remain sync; returning promises would test a different API.
function loadCredentials(text, overrides = {}) {
  const deps = {
    fs: { ...fs, ...overrides }, path, crypto,
    // The lock's claim names carry the owner's host and pid, so this suite has to
    // substitute os the same way it substitutes fs: a fixed hostname keeps the
    // "provably gone on this host" rule testable.
    os: { hostname: () => 'fixture-host' },
    './config.js': { config: {}, log: { info() {}, warn() {}, error() {} } },
    './devin-connect-metrics.js': { bumpConnect() {}, __registerCredHealth() {} },
  };
  const executable = text
    .replace(/^import \{([\s\S]*?)\} from '([^']+)';/gm,
      (_all, bindings, name) => `const {${bindings}} = deps[${JSON.stringify(name)}];`)
    .replace(/^export /gm, '');
  return new Function('deps', executable +
    '\nreturn { storeCredential, getCredential, hasCredential, deleteCredential, listCredentialEmails, __testing };')(deps);
}

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 's5-credentials-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'creds.json');
  const env = { DEVIN_CONNECT_CRED_FILE: file, DEVIN_CONNECT_CRED_KEY: 's5-offline-fixture-key' };
  return { dir, file, env };
}

function readStoreFile(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

test('SEC-1: synchronous return values remain boolean and ordinary calls preserve both records', t => {
  const { file, env } = fixture(t);
  const api = loadCredentials(source);
  assert.equal(api.storeCredential('a@example.test', 'alpha', env), true);
  assert.equal(api.storeCredential('b@example.test', 'beta', env), true);
  assert.deepEqual(Object.keys(readStoreFile(file).records).sort(), ['a@example.test', 'b@example.test']);
  assert.equal(api.getCredential('a@example.test', env), 'alpha');
  assert.equal(api.getCredential('b@example.test', env), 'beta');
  assert.equal(api.storeCredential('a@example.test', 'alpha', {}), false);
});

test('SEC-1: injected reentrancy cannot acknowledge a stale RMW overwrite', t => {
  const { file, env } = fixture(t);
  fs.writeFileSync(file, '{"v":1,"records":{}}');
  let nested = false;
  let busy = false;
  let api;
  api = loadCredentials(source, {
    readFileSync(name, ...args) {
      const bytes = fs.readFileSync(name, ...args);
      if (String(name) === file && !nested) {
        nested = true;
        try { api.storeCredential('b@example.test', 'beta', env); }
        catch (error) {
          assert.equal(error.code, 'ERR_CRED_STORE_BUSY');
          busy = true;
        }
      }
      return bytes;
    },
  });
  assert.equal(api.storeCredential('a@example.test', 'alpha', env), true);
  if (busy) assert.equal(api.storeCredential('b@example.test', 'beta', env), true);
  assert.deepEqual(Object.keys(readStoreFile(file).records).sort(), ['a@example.test', 'b@example.test']);
  assert.equal(busy, true, 'reentrant persistence must not claim premature success');
});

test('SEC-1: delayed fs read in another isolate cannot lose either successful write', { timeout: 15000 }, async t => {
  const { file, env } = fixture(t);
  fs.writeFileSync(file, '{"v":1,"records":{}}');
  const control = new Int32Array(new SharedArrayBuffer(4));
  const code = `
    const fs = require('node:fs');
    const path = require('node:path');
    const crypto = require('node:crypto');
    const { parentPort, workerData } = require('node:worker_threads');
    const loadCredentials = ${loadCredentials.toString()};
    const gate = new Int32Array(workerData.control);
    let delayed = false;
    const api = loadCredentials(workerData.source, {
      readFileSync(name, ...args) {
        const data = fs.readFileSync(name, ...args);
        if (workerData.pause && String(name) === workerData.env.DEVIN_CONNECT_CRED_FILE && !delayed) {
          delayed = true;
          parentPort.postMessage({ type: 'snapshot' });
          Atomics.wait(gate, 0, 0);
        }
        return data;
      }
    });
    try {
      const value = api.storeCredential(workerData.email, workerData.password, workerData.env);
      parentPort.postMessage({ type: 'result', value });
    } catch (error) {
      parentPort.postMessage({ type: 'result', error: error.code || error.message });
    }
  `;
  const launch = (email, password, pause) => new Worker(code, { eval: true, workerData: {
    source, env, email, password, pause, control: control.buffer,
  } });
  const a = launch('a@example.test', 'alpha', true);
  let b;
  try {
    assert.equal((await once(a, 'message'))[0].type, 'snapshot');
    b = launch('b@example.test', 'beta', false);
    const rb = (await once(b, 'message'))[0];
    const pendingA = once(a, 'message');
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    assert.equal((await pendingA)[0].value, true);
    if (rb.error) {
      assert.equal(rb.error, 'ERR_CRED_STORE_BUSY');
      assert.equal(loadCredentials(source).storeCredential('b@example.test', 'beta', env), true);
    } else {
      assert.equal(rb.value, true);
    }
    assert.deepEqual(Object.keys(readStoreFile(file).records).sort(), ['a@example.test', 'b@example.test']);
    assert.equal(loadCredentials(source).getCredential('a@example.test', env), 'alpha');
    assert.equal(loadCredentials(source).getCredential('b@example.test', env), 'beta');
  } finally {
    Atomics.store(control, 0, 1);
    Atomics.notify(control, 0);
    await a.terminate();
    if (b) await b.terminate();
  }
});

test('SEC-1: torn source is retained byte-for-byte and intact records survive healing and a new write', t => {
  const { dir, file, env } = fixture(t);
  const api = loadCredentials(source);
  api.storeCredential('a@example.test', 'alpha', env);
  api.storeCredential('b@example.test', 'beta', env);
  const original = readStoreFile(file);
  const broken = Buffer.from('BROKEN WRAPPER\n' + JSON.stringify(original) + '\n"cut":{"salt":"');
  fs.writeFileSync(file, broken);
  assert.equal(api.getCredential('a@example.test', env), 'alpha');
  const copies = fs.readdirSync(dir).filter(name => name.includes('.corrupt.') && name.endsWith('.bak'));
  assert.equal(copies.length, 1);
  assert.deepEqual(fs.readFileSync(path.join(dir, copies[0])), broken);
  assert.deepEqual(readStoreFile(file).records, original.records);
  api.storeCredential('c@example.test', 'gamma', env);
  assert.equal(api.getCredential('b@example.test', env), 'beta');
  assert.deepEqual(Object.keys(readStoreFile(file).records).sort(), ['a@example.test', 'b@example.test', 'c@example.test']);
});

test('SEC-1: a reader rechecks under lock rather than overwriting a newer clean store', t => {
  const { file, env } = fixture(t);
  const seed = loadCredentials(source);
  seed.storeCredential('a@example.test', 'alpha', env);
  const small = readStoreFile(file);
  seed.storeCredential('b@example.test', 'beta', env);
  const large = fs.readFileSync(file);
  fs.writeFileSync(file, 'BROKEN\n' + JSON.stringify(small));
  let advanced = false;
  const api = loadCredentials(source, {
    readFileSync(name, ...args) {
      const bytes = fs.readFileSync(name, ...args);
      if (String(name) === file && !advanced) {
        advanced = true;
        fs.writeFileSync(file, large);
      }
      return bytes;
    },
  });
  api.__testing.readStore(env);
  assert.deepEqual(fs.readFileSync(file), large);
});

test('SEC-1: unreadable is not empty; failed reads never publish a replacement', t => {
  const { file, env } = fixture(t);
  loadCredentials(source).storeCredential('a@example.test', 'alpha', env);
  const before = fs.readFileSync(file);
  const api = loadCredentials(source, {
    readFileSync(name, ...args) {
      if (String(name) === file) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
      return fs.readFileSync(name, ...args);
    },
  });
  assert.throws(() => api.storeCredential('b@example.test', 'beta', env), { code: 'EACCES' });
  assert.deepEqual(fs.readFileSync(file), before);
});

test('SEC-1: each publish uses a different pid-plus-random tmp name', t => {
  const { env } = fixture(t);
  const paths = [];
  const api = loadCredentials(source, {
    // Only the STORE publishes count here: the lock stages its own marker file
    // through a rename too (legacy migration), and that one is not a credential
    // publish.
    renameSync(from, to) {
      if (String(to) === env.DEVIN_CONNECT_CRED_FILE) paths.push(String(from));
      return fs.renameSync(from, to);
    },
  });
  api.storeCredential('a@example.test', 'alpha', env);
  api.storeCredential('b@example.test', 'beta', env);
  assert.equal(paths.length, 2);
  assert.equal(new Set(paths).size, paths.length);
  for (const name of paths) assert.match(name, new RegExp(`\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`));
});

test('SEC-1: failed forensic backup aborts mutation instead of erasing the raw source', t => {
  const { file, env } = fixture(t);
  const seed = loadCredentials(source);
  seed.storeCredential('a@example.test', 'alpha', env);
  const broken = Buffer.from('BROKEN\n' + fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, broken);
  const api = loadCredentials(source, {
    writeFileSync(name, ...args) {
      if (typeof name === 'string' && name.includes('.corrupt.')) {
        throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' });
      }
      return fs.writeFileSync(name, ...args);
    },
  });
  assert.throws(() => api.storeCredential('b@example.test', 'beta', env), { code: 'ENOSPC' });
  assert.deepEqual(fs.readFileSync(file), broken);
});

test('SEC-1: record-set guard rejects replacement and permits only named deletion', () => {
  const { assertRecordSetPreserved } = loadCredentials(source).__testing;
  assert.throws(() => assertRecordSetPreserved({ a: {}, b: {} }, { a: {}, c: {} }), { code: 'ERR_CRED_STORE_RECORD_LOSS' });
  assert.doesNotThrow(() => assertRecordSetPreserved({ a: {}, b: {} }, { a: {} }, ['b']));
});

test('SEC-1: special own keys roundtrip and deleted records are not restored from backups', t => {
  const { file, env } = fixture(t);
  const api = loadCredentials(source);
  api.storeCredential('__proto__', 'alpha', env);
  assert.equal(api.getCredential('__proto__', env), 'alpha');
  assert.equal(Object.hasOwn(readStoreFile(file).records, '__proto__'), true);
  fs.writeFileSync(file, 'BROKEN\n' + fs.readFileSync(file, 'utf8'));
  assert.equal(api.getCredential('__proto__', env), 'alpha');
  assert.equal(api.deleteCredential('__proto__', env), true);
  assert.equal(api.hasCredential('__proto__', env), false);
  assert.equal(api.getCredential('__proto__', env), null);
});

test('SEC-1: tier-2 success cannot discard an intact tier-3 record', t => {
  const { file, env } = fixture(t);
  const api = loadCredentials(source);
  api.storeCredential('a@example.test', 'alpha', env);
  api.storeCredential('b@example.test', 'beta', env);
  const records = readStoreFile(file).records;
  const broken = '\ufeff' + JSON.stringify({
    v: 1, records: { 'a@example.test': records['a@example.test'] },
    stranded: { 'b@example.test': records['b@example.test'] },
  });
  fs.writeFileSync(file, broken);
  assert.equal(api.getCredential('a@example.test', env), 'alpha');
  assert.equal(api.getCredential('b@example.test', env), 'beta');
  assert.deepEqual(Object.keys(readStoreFile(file).records).sort(), ['a@example.test', 'b@example.test']);
});

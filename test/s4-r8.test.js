import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
function deferred() {
  let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve };
}
function jwt(expMs) {
  return `test.${Buffer.from(JSON.stringify({ exp: expMs / 1000 })).toString('base64url')}.test`;
}
function load(post, encode = x => x) {
  const source = readFileSync(new URL('../src/devin-connect.js', import.meta.url), 'utf8');
  const start = source.indexOf('const _userJwtCache = new Map();');
  const end = source.indexOf('\n/**\n * One unary Connect-RPC', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end).replace(/^export /gm, '');
  const deps = { HOST: 'test.invalid', USER_JWT_PATH: '/test', Buffer,
    buildClientMetadata: encode, writeMessageField: (_tag, x) => x, wrapEnvelope: x => x,
    postConnectUnary: post, parseFields: x => x, getField: x => ({ value: Buffer.from(x) }), log: { debug() {} } };
  return new Function(...Object.keys(deps), `${block}\nreturn {mintUserJwt,invalidateUserJwtCache,_userJwtCache,_userJwtInflight};`)(...Object.values(deps));
}

test('R8 token churn is bounded and unrelated lookups reap stale JWT entries', async () => {
  const s = load(async () => jwt(1000000));
  for (let i = 0; i < 5000; i++) await s.mintUserJwt(`token-${i}`, { now: 1 });
  assert.ok(s._userJwtCache.size <= 500, 'the cache has an entry-count ceiling independent of total rotations');
  await s.mintUserJwt('reaper', { now: 1000001 });
  assert.equal(s._userJwtCache.size, 0, 'stale mints are not reinserted after the sweep');
});

test('R8 hot cache hits refresh LRU position', async () => {
  const s = load(async () => jwt(1000000));
  for (let i = 0; i < 500; i++) await s.mintUserJwt(`token-${i}`, { now: 1 });
  assert.equal(s._userJwtCache.size, 500);
  await s.mintUserJwt('token-0', { now: 2 });
  await s.mintUserJwt('new', { now: 3 });
  assert.equal(s._userJwtCache.has('token-0 test.invalid'), true);
  assert.equal(s._userJwtCache.has('token-1 test.invalid'), false);
});

test('R8 no-expiry and near-expiry values are usable once but never retained', async () => {
  for (const value of ['opaque', jwt(50000)]) {
    let calls = 0; const s = load(async () => { calls++; return value; });
    assert.equal(await s.mintUserJwt('token', { now: 1 }), value);
    await s.mintUserJwt('token', { now: 1 });
    assert.equal(calls, 2); assert.equal(s._userJwtCache.size, 0);
  }
});

test('R8 old-epoch completion cannot delete a newer pending mint', async () => {
  const old = deferred(), fresh = deferred(); let calls = 0;
  const s = load(() => (++calls === 1 ? old.promise : fresh.promise));
  const p1 = s.mintUserJwt('same', { now: 1 });
  s.invalidateUserJwtCache();
  const p2 = s.mintUserJwt('same', { now: 1 });
  old.resolve(jwt(1000000)); assert.equal(await p1, null);
  const p3 = s.mintUserJwt('same', { now: 1 });
  assert.equal(calls, 2, 'a stale finalizer must not delete the new in-flight entry');
  fresh.resolve(jwt(2000000));
  assert.equal(await p2, jwt(2000000)); assert.equal(await p3, jwt(2000000));
  assert.equal(s._userJwtInflight.size, 0);
});

test('R8 synchronous encoding failure cannot pin a settled null promise forever', async () => {
  let encodes = 0;
  const s = load(async () => jwt(1000000), x => { if (++encodes === 1) throw new Error('encode failed'); return x; });
  assert.equal(await s.mintUserJwt('same', { now: 1 }), null);
  assert.equal(s._userJwtInflight.size, 0);
  assert.equal(await s.mintUserJwt('same', { now: 1 }), jwt(1000000));
});

test('R8 expiry removes an entry at the exact refresh-skew boundary', async () => {
  const s = load(async () => jwt(1000000));
  await s.mintUserJwt('first', { now: 1 });
  await s.mintUserJwt('other', { now: 940000 });
  assert.equal(s._userJwtCache.size, 0);
});

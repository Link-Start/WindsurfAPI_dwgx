import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

function load(max = 32, byCaller = false) {
  const source = readFileSync(new URL('../src/conversation-pool.js', import.meta.url), 'utf8')
    .replace("import { createHash } from 'crypto';", '').replace(/^export /gm, '');
  let now = 1000;
  const env = { CASCADE_REUSE_BY_CALLER: byCaller ? '1' : '0' };
  if (max !== null) env.CASCADE_POOL_MAX = String(max);
  const api = new Function('createHash', 'process', 'Date', 'setInterval', `${source}\nreturn {
    checkin, checkout, invalidateFor, poolStats, _pool, _callerLatest, prune
  };`)(createHash, { env }, { now: () => now }, () => ({ unref() {} }));
  return { ...api, advance(ms = 1) { now += ms; } };
}
function put(p, fp, caller = 'api:A:user', fields = {}) {
  p.advance();
  p.checkin(fp, { cascadeId: fp, apiKey: 'test-key', lsPort: 1001, lsGeneration: 1, ...fields }, caller);
}

test('R2 A fills 32 slots, B stores one, A writes 50: B remains', () => {
  const p = load();
  for (let i = 0; i < 32; i++) put(p, `a-${i}`);
  assert.equal(p.poolStats().size, 32, 'one tenant may use the whole pool');
  put(p, 'b', 'api:B:user');
  for (let i = 0; i < 50; i++) put(p, `a-next-${i}`, `api:A:user-${i}`);
  assert.equal(p.checkout('b', 'api:B:user')?.cascadeId, 'b', 'B must retain its only slot');
  assert.ok(p.poolStats().size <= 32);
});

test('R2 default capacity survives a full LRU horizon, not just 50 writes', () => {
  const p = load(null);
  assert.equal(p.poolStats().maxSize, 500);
  for (let i = 0; i < 500; i++) put(p, `a-${i}`);
  put(p, 'b', 'api:B:user');
  for (let i = 0; i < 501; i++) put(p, `next-${i}`);
  assert.ok(p.checkout('b', 'api:B:user'));
});

test('R2 over-capacity tenant cardinality rejects the newcomer, not an existing singleton', () => {
  const p = load(2, true);
  put(p, 'a', 'api:A:u'); put(p, 'b', 'api:B:u'); put(p, 'c', 'api:C:u');
  assert.equal(p.poolStats().size, 2);
  assert.equal(p._pool.has('a'), true);
  assert.equal(p._pool.has('b'), true);
  assert.equal(p._pool.has('c'), false);
  assert.equal(p._callerLatest.size, 2);
});

test('R2 under-share admission evicts an over-share LRU, never a different singleton', () => {
  const p = load(4);
  put(p, 'b', 'api:B:u');
  for (let i = 0; i < 3; i++) put(p, `a-${i}`);
  put(p, 'c', 'api:C:u');
  assert.equal(p._pool.has('b'), true);
  assert.equal(p._pool.has('a-0'), false);
  assert.equal(p._pool.has('c'), true);
});

test('R2 TTL, alias slots, owner checks and generation invalidation retain their meaning', () => {
  const p = load(8, true);
  put(p, ['old', 'old-alias'], 'api:A:u', { cascadeId: 'old-cascade', lsGeneration: 7 });
  put(p, 'new', 'api:B:u', { lsGeneration: 8 });
  assert.equal(p.checkout('new', 'api:foreign:u'), null);
  assert.equal(p.invalidateFor({ lsPort: 1001, lsGeneration: 7 }), 2);
  assert.equal(p._pool.has('new'), true);
  assert.equal(p.checkout('new', 'api:B:u', { lsGeneration: 7 }), null);
  assert.ok(p.checkout('new', 'api:B:u', { lsGeneration: 8 }));
  put(p, 'exp', 'api:A:u');
  p.advance(30 * 60 * 1000 + 1);
  p.prune(10000000);
  assert.equal(p.poolStats().size, 0);
  assert.equal(p._callerLatest.size, 0);
});

test('R2 users under one API key share a tenant budget rather than creating protected singleton slots', () => {
  const p = load(3);
  put(p, 'a0', 'api:A:u0'); put(p, 'a1', 'api:A:u1'); put(p, 'b', 'api:B:u0');
  put(p, 'c', 'api:C:u0');
  assert.equal(p._pool.has('b'), true);
  assert.equal(p._pool.has('c'), true, 'A has two slots in one tenant and must lend one to C');
  assert.equal(p._pool.has('a0'), false);
});

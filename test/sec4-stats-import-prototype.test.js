import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/dashboard/stats.js', import.meta.url), 'utf8');
const match = source.match(/^export function importStats\([^]*?^\}/m);
assert.ok(match, 'exercise the actual production importStats function');
function fresh() {
  const state = { totalRequests: 2, creditsByModel: { normal: 1 }, recentRequests: [], recentPolicyBlocks: [] };
  return new Function('_state', `
    let _curBucket = {};
    let saves = 0;
    const RECENT_REQ_CAP = 200;
    const process = { env: {} };
    function scheduleSave() { saves += 1; }
    ${match[0].replace(/^export /, '')}
    return { importStats, state: () => _state, saves: () => saves };
  `)(state);
}

test('SEC-4: JSON own __proto__ cannot change the state prototype on replace', () => {
  const api = fresh();
  const proto = Object.getPrototypeOf(api.state());
  const payload = JSON.parse('{"__proto__":{"totalRequests":1},"totalRequests":7,"recentRequests":[]}');
  assert.equal(Object.hasOwn(payload, '__proto__'), true, 'object-literal syntax is not the HTTP JSON attack');
  assert.deepEqual(api.importStats(payload, { mode: 'replace' }), { ok: true, mode: 'replace' });
  assert.equal(Object.getPrototypeOf(api.state()), proto);
  assert.equal(api.state().totalRequests, 7);
  assert.equal(Object.hasOwn(api.state(), '__proto__'), false);
  assert.equal(Object.prototype.totalRequests, undefined);
});

test('SEC-4: constructor/prototype keys are removed recursively in replace and merge', () => {
  for (const mode of ['replace', 'merge']) {
    const api = fresh();
    const input = JSON.parse('{"constructor":{"prototype":{"polluted":true}},"creditsByModel":{"normal":3,"__proto__":{"polluted":true},"constructor":2,"prototype":2},"recentRequests":[]}');
    assert.equal(api.importStats(input, { mode }).ok, true);
    assert.equal(Object.hasOwn(api.state(), 'constructor'), false);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      assert.equal(Object.hasOwn(api.state().creditsByModel, key), false, `${mode}: ${key}`);
    }
    assert.equal(Object.getPrototypeOf(api.state().creditsByModel), Object.prototype);
    assert.equal(api.state().creditsByModel.normal, mode === 'merge' ? 4 : 3);
  }
});

test('SEC-4: object-literal __proto__ is not confused with an own JSON key', () => {
  const api = fresh();
  const input = { __proto__: { totalRequests: 1 }, recentRequests: [] };
  assert.equal(Object.hasOwn(input, '__proto__'), false);
  api.importStats(input, { mode: 'replace' });
  assert.equal(Object.getPrototypeOf(api.state()), Object.prototype);
  assert.equal(api.state().totalRequests, undefined);
});

test('SEC-4: clone failure leaves the existing state untouched', () => {
  const api = fresh();
  const before = JSON.stringify(api.state());
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => api.importStats(cycle, { mode: 'replace' }), TypeError);
  assert.equal(JSON.stringify(api.state()), before);
  assert.equal(api.saves(), 0);
});

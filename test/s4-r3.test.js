import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
async function drain() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function load(getUserStatus, fetchUserStatus) {
  const source = readFileSync(new URL('../src/auth.js', import.meta.url), 'utf8');
  const start = source.includes('const _creditInFlight = new Map();')
    ? source.indexOf('const _creditInFlight = new Map();') : source.indexOf('export async function refreshCredits(id) {');
  const end = source.indexOf('\nexport async function refreshAllCredits', start);
  assert.ok(start >= 0 && end > start, 'load the actual production refresh block');
  const block = source.slice(start, end).replace(/^export /gm, '')
    .replace("await import('./windsurf-api.js')", 'await Promise.resolve(_creditRest)')
    .replace("await import('./devin-connect-catalog.js')", 'await Promise.resolve(_creditBilling)');
  const account = { id: 'a', apiKey: 'key-a', tier: 'unknown', credits: { balance: -1 } };
  const accounts = [account], applied = [], warnings = [];
  const deps = {
    accounts, _creditRest: { getUserStatus }, _creditBilling: { fetchUserStatus }, getEffectiveProxy: () => null,
    applyQuotaSnapshot: a => applied.push(structuredClone(a.credits)), saveAccounts() {},
    looksLikeBanSignal: () => false, reportBanSignal() {}, log: { warn: s => warnings.push(s) },
  };
  const refresh = new Function(...Object.keys(deps), `${block}\nreturn refreshCredits;`)(...Object.values(deps));
  return { account, accounts, refresh, applied, warnings };
}
function paired(c) {
  assert.equal(Object.hasOwn(c, 'rateTable'), Object.hasOwn(c, 'rateTableFetchedAt'), 'table and timestamp publish together');
}

test('R3 overlapping callers share one fetch and receive one complete snapshot', async () => {
  const rest = deferred(), billing = deferred(); let restCalls = 0, billingCalls = 0;
  const s = load(() => { restCalls++; return rest.promise; }, () => { billingCalls++; return billing.promise; });
  const p1 = s.refresh('a'), p2 = s.refresh('a');
  await drain();
  assert.equal(restCalls, 1, 'the second caller must not start another REST read');
  rest.resolve({ balance: 10, weeklyPercent: 11, planName: 'Pro', raw: { catalog: 'old endpoint response' } });
  await drain();
  assert.equal(billingCalls, 1);
  assert.equal(s.account.credits.balance, -1, 'no REST-only snapshot may escape while billing waits');
  billing.resolve({ balance: 20, periodStart: 'new-start', periodEnd: 'new-end', rateTable: { model: 0 } });
  const [a, b] = await Promise.all([p1, p2]);
  assert.strictEqual(a, b, 'joined callers share the settled result object');
  assert.strictEqual(a.credits, s.account.credits);
  assert.equal(a.credits.balance, 20);
  assert.deepEqual(a.credits.rateTable, { model: 0 }); paired(a.credits);
  assert.equal(s.applied.length, 1);
});

test('R3 a later refresh publishes the later completed batch; billing failure clears both pair fields', async () => {
  let round = 0;
  const s = load(async () => ({ weeklyPercent: ++round, balance: round,
    rateTable: { stale: 0 }, rateTableFetchedAt: 1 }), async () => {
    if (round === 1) return { balance: 50, periodStart: 'p1', rateTable: { old: 0 } };
    if (round === 2) return { balance: 60, periodStart: 'p2', rateTable: { newer: 1 } };
    throw new Error('billing unavailable');
  });
  await s.refresh('a');
  const latest = await s.refresh('a');
  assert.equal(latest.credits.balance, 60); assert.equal(latest.credits.periodStart, 'p2');
  assert.deepEqual(latest.credits.rateTable, { newer: 1 }); paired(latest.credits);
  const noBilling = await s.refresh('a');
  assert.equal(noBilling.ok, true);
  assert.equal(noBilling.credits.balance, 3);
  assert.equal(Object.hasOwn(noBilling.credits, 'rateTable'), false); paired(noBilling.credits);
});

test('R3 unpaired, empty and absent billing data cannot carry a stale paired table', async () => {
  for (const billing of [{ rateTable: [0] }, { rateTable: {} }, null]) {
    const s = load(async () => ({ rateTable: { stale: 0 }, rateTableFetchedAt: 2 }), async () => billing);
    const r = await s.refresh('a');
    assert.equal(r.ok, true);
    assert.equal(Object.hasOwn(r.credits, 'rateTable'), false); paired(r.credits);
  }
});

test('R3 token rotation during a read cannot publish onto the new account lifetime', async () => {
  const billing = deferred();
  const s = load(async () => ({ balance: 1 }), () => billing.promise);
  const p = s.refresh('a'); await drain();
  s.account.apiKey = 'key-new';
  billing.resolve({ balance: 99, rateTable: { stale: 0 } });
  assert.equal((await p).ok, false);
  assert.equal(s.account.credits.balance, -1);
  assert.equal(s.applied.length, 0);
});

test('R3 failure releases the flight and keeps the previous complete snapshot', async () => {
  let calls = 0;
  const s = load(async () => { if (++calls === 1) throw new Error('REST down'); return { balance: 7 }; }, async () => null);
  assert.equal((await s.refresh('a')).ok, false);
  assert.equal(s.account.credits.balance, -1);
  assert.equal((await s.refresh('a')).credits.balance, 7);
  assert.equal(calls, 2);
});

test('R3 flights are per account, not a process-wide serialization queue', async () => {
  const gate = deferred(); let calls = 0;
  const s = load(async key => { calls++; if (key === 'key-a') await gate.promise; return { balance: 9 }; }, async () => null);
  s.accounts.push({ id: 'b', apiKey: 'key-b', credits: {} });
  const a = s.refresh('a');
  assert.equal((await s.refresh('b')).ok, true); assert.equal(calls, 2);
  gate.resolve(); await a;
});

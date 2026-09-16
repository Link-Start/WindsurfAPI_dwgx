import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
function topFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start, `actual ${name} definition must exist`);
  return source.slice(start, end);
}
async function run(pattern, env = {}, emittedInitially = false) {
  const start = source.indexOf('          const attemptStream = async (a) => {');
  const end = source.indexOf('            if (leakTraceEnabled()) {', start);
  assert.ok(start >= 0 && end > start, 'the complete production attempt/loop block is required');
  const ladder = source.slice(start, end) + '\n          } finally {}';
  const accounts = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, apiKey: `key-${i}` }));
  let now = 0, scheduled = 0; const attempts = [], events = [], finalized = [];
  const deps = {
    accounts, env, emittedInitially,
    getApiKey: tried => accounts.find(a => !tried.includes(a.apiKey)) || null,
    setTimeout(fn, ms) { scheduled++; now += ms; queueMicrotask(fn); return scheduled; }, clearTimeout() {},
    streamChatCompletion: async params => {
      const n = attempts.length; attempts.push({ token: params.token, at: now });
      const code = typeof pattern === 'function' ? pattern(n) : pattern[n];
      if (code) throw Object.assign(new Error(code), { code });
      return { content: 'ok', toolCalls: [] };
    },
    ensureDeviceSeed: () => undefined, recordTokenUsage() {}, recordAccountSpend() {}, connectSpendOpts: () => ({}),
    finalizeConnectAccount: (a, result) => finalized.push({ id: a?.id, err: result.err?.code }),
    isConnectRetryable: e => e.code === 'STREAM_TRUNCATED', isAbortError: e => e?.name === 'AbortError',
    reLoginAccount: async id => `fresh-${id}`, currentApiKeyForId: (_id, key) => key,
    bumpConnect: event => events.push(event), releaseAccountById() {}, bindConnectSticky() {}, commitConnectSession() {},
    reportDeadToken() {}, isAccountFailoverError: code => ['QUOTA_EXHAUSTED', 'RATE_LIMITED'].includes(code),
    chatStreamError: (message, type, code) => ({ error: { message, type, code } }),
    log: { info() {}, error() {} }, AbortController,
  };
  const body = `${topFunction('acquireConnectFailover')}\n${topFunction('connectFailoverMax')}\nreturn (async () => {
    const connectParams = {}, connectMeta = {}, reqId = 'r', reqModelName = 'model', selector = 'model';
    const ccStart = 0, ccAcct = accounts[0], callerKey = 'owner', connectMessages = [], incomingConnectReasoning = '';
    const abortController = new AbortController(), triedKeys = [], maxHops = connectFailoverMax(env);
    let emitted = emittedInitially;
    const send = frame => { emitted = true; };
    ${ladder}
  })();`;
  await new Function(...Object.keys(deps), body)(...Object.values(deps));
  return { attempts, events, finalized, scheduled };
}

test('R5 default outer ceiling is nine adapter calls, with two 500ms account gaps', async () => {
  const r = await run(n => ['STREAM_TRUNCATED', 'UNAUTHORIZED', 'QUOTA_EXHAUSTED'][n % 3]);
  assert.equal(r.attempts.length, 9);
  assert.deepEqual(r.attempts.map(a => a.at), [0, 0, 0, 500, 500, 500, 1000, 1000, 1000]);
  assert.equal(r.events.filter(x => x === 'quota_failover_hops').length, 2);
  assert.equal(r.finalized.length, 3);
});

test('R5 healthy first-attempt success has zero scheduled delay', async () => {
  const r = await run([]);
  assert.equal(r.attempts.length, 1); assert.equal(r.scheduled, 0); assert.equal(r.attempts[0].at, 0);
});

test('R5 repeated transient failures alone are only two attempts and never hop', async () => {
  const r = await run(() => 'STREAM_TRUNCATED');
  assert.equal(r.attempts.length, 2); assert.equal(r.scheduled, 0);
});

test('R5 max=0 and already-emitted payload retain the original retry vetoes', async () => {
  const zero = await run(() => 'QUOTA_EXHAUSTED', { DEVIN_CONNECT_FAILOVER_MAX: '0' });
  assert.equal(zero.attempts.length, 1); assert.equal(zero.scheduled, 0);
  const emitted = await run(() => 'STREAM_TRUNCATED', {}, true);
  assert.equal(emitted.attempts.length, 1); assert.equal(emitted.scheduled, 0);
});

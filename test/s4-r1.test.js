import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';

function load() {
  const source = readFileSync(new URL('../src/session-continuity.js', import.meta.url), 'utf8')
    .replace("import crypto from 'crypto';", '').replace(/^export /gm, '');
  const env = { DEVIN_CONNECT_SESSION_REUSE: '1', DEVIN_CONNECT_SESSION_MAX_STATES: '3' };
  return new Function('crypto', 'process', 'Date', 'setInterval', `${source}\nreturn {
    commitAfterResponse, resolveSessionId, statesById, pairIndex, commitIndex,
    evictState, clearExpired, buildPairHashes, canonicalize, analyzeHistory,
    deriveScopeId, findExistingState
  };`)(crypto, { env }, { now: () => 1000 }, () => ({ unref() {} }));
}
function pair(i, prefix = '') {
  return [{ role: 'user', content: `${prefix}question-${i}` },
    { role: 'assistant', content: `${prefix}answer-${i}: ${'abcdefghij'.repeat(8)}` }];
}
function grow(s, n, caller = 'owner') {
  let messages = [], session;
  for (let i = 0; i < n; i++) {
    messages = [...messages, ...pair(i)].slice(-22);
    const id = s.commitAfterResponse(caller, messages);
    if (session) assert.equal(id, session);
    session = id;
  }
  return { session, messages };
}

test('R1 eviction reclaims every historical pair and commit membership', () => {
  const s = load();
  for (let cycle = 0; cycle < 10; cycle++) {
    grow(s, 100, `owner-${cycle}`);
    assert.equal(s.statesById.size, 1);
    const id = s.statesById.keys().next().value;
    s.evictState(id);
    assert.equal(s.pairIndex.size, 0, 'no pair keys survive an empty state store');
    assert.equal(s.commitIndex.size, 0, 'no historical commit keys survive eviction');
  }
});

test('R1 deleting an owner preserves shared memberships and the exact winner', () => {
  const s = load();
  grow(s, 30);
  const firstId = s.statesById.keys().next().value;
  const branch = [...pair(0), ...pair(1, 'branch-')];
  const secondSession = s.commitAfterResponse('owner', branch);
  const query = [...branch, { role: 'user', content: 'next' }];
  const before = s.resolveSessionId('owner', query);
  assert.equal(before, secondSession);
  const { scopeId, hashes } = s.buildPairHashes('owner', pair(0));
  const key = `${scopeId}:${hashes[0]}`;
  assert.equal(s.pairIndex.get(key).size, 2);
  s.evictState(firstId);
  assert.equal(s.pairIndex.get(key).size, 1, 'shared live membership is retained');
  assert.equal(s.resolveSessionId('owner', query), before, 'same input, same winning session');
});

test('R1 live historical commits are semantic, not disposable cache entries', () => {
  const s = load();
  const { session } = grow(s, 40);
  const state = [...s.statesById.values()][0];
  const window = [...state.pairWindow];
  const turnCount = state.turnCount;
  assert.equal(s.commitAfterResponse('owner', pair(0)), session);
  assert.deepEqual(state.pairWindow, window, 'an old idempotent commit does not roll back the window');
  assert.equal(state.turnCount, turnCount);
  assert.ok(s.commitIndex.size > 10, 'this conservative patch does NOT claim a live-history bound');
  for (const key of s.commitIndex.keys()) if (key !== state.commitKey) s.commitIndex.delete(key);
  assert.notEqual(s.commitAfterResponse('owner', pair(0)), session,
    'counterexample: keeping only the latest commit key changes a real result');
});

test('R1 an old exact prefix can be the only index gate for a current drift match', () => {
  const s = load();
  const { session } = grow(s, 40);
  const tail = pair(39);
  tail[1].content = tail[1].content.slice(0, 50);
  const scope = s.deriveScopeId('owner');
  const analysis = s.analyzeHistory(s.canonicalize([...pair(0), ...tail]), scope);
  const found = s.findExistingState(scope, analysis, { DEVIN_CONNECT_SESSION_TTL_MS: '60000' });
  assert.equal(found?.state.sessionId, session);
  const state = found.state;
  for (const [key, ids] of s.pairIndex) {
    if (key !== state.rootKey && !state.pairWindow.some(hash => key === `${scope}:${hash}`)) {
      ids.delete(state.stateId);
      if (!ids.size) s.pairIndex.delete(key);
    }
  }
  assert.equal(s.findExistingState(scope, analysis, { DEVIN_CONNECT_SESSION_TTL_MS: '60000' }), null,
    'counterexample: current-window-only indexing loses a genuine drift match');
});

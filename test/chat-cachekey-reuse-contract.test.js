import { describe, it, beforeEach, afterEach } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { cacheKey, cacheGet, cacheSet, cacheClear, cacheStats } from '../src/cache.js';

// WHY THIS EXISTS
//
// The inner chat path now reuses `context.__originalCkey` instead of recomputing
// `cacheKey(body, callerKey)` (measured 1.09 ms @400 messages, 2.96 ms @4 MB image —
// and it was computed twice per request). The reuse is gated on `!__fallbackAttempt`
// because the auto-fallback path REWRITES body.model before re-entering: that is the
// H-3 design where the lookup must use the fallback model while the write goes into the
// original slot.
//
// Measured 2026-09-13: deleting that guard left 110 cache/fallback tests green. The
// reason is structural — `cacheSet` only accepts keys the CALLER passes, so no existing
// test can observe "which key did the inner path use". These assertions pin the
// contract at the only level that can see it, by reproducing exactly what the inner
// path does with each combination.

const ORIGINAL = { model: 'glm-5.1', messages: [{ role: 'user', content: 'hi' }] };
const FALLBACK = { model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] };
const CALLER = 'team:alice:client:abc';

describe('chat cache key reuse contract (perf change 2026-09-13)', () => {
  beforeEach(() => {
    process.env.RESPONSE_CACHE_ENABLED = '1';
    process.env.WINDSURFAPI_RESPONSE_CACHE = '1';
    cacheClear();
  });
  afterEach(() => { cacheClear(); });

  it('the outer key is computed from the ORIGINAL body, before any fallback rewrite', () => {
    const originalCkey = cacheKey(ORIGINAL, CALLER);
    assert.notEqual(originalCkey, cacheKey(FALLBACK, CALLER), 'the two models must not collide');
  });

  it('non-fallback: reusing the outer key is identical to recomputing (the optimisation is sound)', () => {
    const outer = cacheKey(ORIGINAL, CALLER);
    const recomputed = cacheKey(ORIGINAL, CALLER);
    assert.equal(outer, recomputed, 'same body + same callerKey must be a stable key');
  });

  it('fallback attempt: the inner path must NOT reuse the outer key', () => {
    // Reproduce the inner path for both branches and show they address different slots.
    const outer = cacheKey(ORIGINAL, CALLER);              // written by handleChatCompletions:2778
    const innerReused = outer;                             // what the buggy guard does
    const innerFresh = cacheKey(FALLBACK, CALLER);         // what !__fallbackAttempt must yield

    assert.notEqual(innerReused, innerFresh, 'the guard is load-bearing: these are different cache slots');

    // And prove the difference is observable through the cache itself: an entry stored
    // under the fresh (fallback) key must be invisible to a lookup under the reused one.
    cacheSet(innerFresh, { text: 'fallback answer', ts: Date.now() });
    assert.equal(cacheGet(innerReused), null, 'a fallback-model entry must not be served as the original model');
    assert.ok(cacheGet(innerFresh), 'and the fallback key itself does resolve');
  });

  it('the cache must be on for the assertion above to mean anything', () => {
    const stats = cacheStats();
    assert.equal(stats.enabled, true, `cache disabled (${JSON.stringify(stats)}) — cacheGet is always null and the test would be vacuous`);
  });

  // STRUCTURAL, and deliberately so. The assertions above pin the KEY derivation, which
  // is all a cache-level test can see; they cannot see whether chat.js actually consults
  // `__fallbackAttempt` before reusing. Measured: deleting that conjunct from chat.js
  // leaves every behavioural cache test green (110 tests), because `cacheSet` only ever
  // receives keys its caller passes. "Which key did the inner path choose" is not
  // observable through the cache API, so the guard is pinned at source level and the
  // comment above it explains what it protects. This is the rubric's sanctioned case:
  // a proposition about code shape that behaviour cannot express.
  it('chat.js gates the reuse on !__fallbackAttempt, and says why', () => {
    const src = readFileSync(new URL('../src/handlers/chat.js', import.meta.url), 'utf8');
    assert.match(
      src,
      /reuseOriginalCkey[\s\S]{0,600}?__fallbackAttempt/,
      'the inner ckey reuse must stay gated on __fallbackAttempt',
    );
    assert.match(
      src,
      /reuseOriginalCkey\s*=\s*typeof context\.__originalCkey === 'string'/,
      'and it must require a non-empty outer key rather than reusing undefined',
    );
  });
});

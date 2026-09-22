// Kit section G, item G-1: "an unauthenticated caller supplying a session id must
// not receive a per-user scope".
//
// Measured at the audit baseline: the property does NOT hold inside
// src/caller-key.js or hasPerUserScope. `callerKeyFromRequest({headers:{'x-dashboard-session':
// 'deadbeef'}}, '')` really does mint `session:<digest>` and hasPerUserScope really
// does trust it unconditionally. What holds is the COMPOSITION: every /v1 route sits
// behind the API-key gate at src/server.js:415, so the session branch is reachable
// only on an instance that has no credential configured at all — and no code in this
// repository ever writes `x-dashboard-session` (the dashboard authenticates with
// `x-dashboard-password`).
//
// These tests pin that composition. They are green today and go red if the wall moves:
// if the session header is ever accepted as a credential, or if an API key stops
// outranking a session header in the caller-key ladder.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callerKeyFromRequest } from '../src/caller-key.js';
import { hasPerUserScope } from '../src/handlers/chat.js';
import { extractToken } from '../src/server.js';

const SESSION_HEADERS = [
  'x-dashboard-session',
  'x-session-id',
  'x-windsurf-session',
  'session-id',
];

function fakeReq({ headers = {}, ip = '127.0.0.1' } = {}) {
  return { headers, socket: { remoteAddress: ip } };
}

describe('G-1: the session caller-key branch stays behind the credential wall', () => {
  it('an API key outranks every session header shape', () => {
    for (const name of SESSION_HEADERS) {
      const key = callerKeyFromRequest(fakeReq({ headers: { [name]: 'deadbeef' } }), 'sk-real-key');
      assert.ok(key.startsWith('api:'), `${name} must not outrank a presented API key (got ${key})`);
      assert.ok(!key.startsWith('session:'), `${name} must never mint a session key when a credential was sent`);
      assert.equal(hasPerUserScope(key), false, `${name} must not earn a per-user scope via the session branch`);
    }
  });

  it('a session header is not a credential', () => {
    for (const name of SESSION_HEADERS) {
      const req = fakeReq({ headers: { [name]: 'deadbeef' } });
      assert.equal(extractToken(req), '', `${name} must not be readable as an API token`);
    }
    // The credential carriers still work, so the assertion above is about the
    // session headers and not about extractToken being inert.
    assert.equal(extractToken(fakeReq({ headers: { authorization: 'Bearer sk-real-key' } })), 'sk-real-key');
    assert.equal(extractToken(fakeReq({ headers: { 'x-api-key': 'sk-real-key' } })), 'sk-real-key');
  });

  it('the session branch is reachable only with no credential at all', () => {
    const req = fakeReq({ headers: { 'x-dashboard-session': 'deadbeef' } });
    assert.ok(callerKeyFromRequest(req, '').startsWith('session:'), 'the branch itself still exists');
    assert.ok(callerKeyFromRequest(req, 'sk-real-key').startsWith('api:'), 'and a credential still closes it');
  });

  it('hasPerUserScope grants the session branch only for session keys', () => {
    assert.equal(hasPerUserScope('session:abcdef'), true, 'the session branch is the scope it grants');
    assert.equal(hasPerUserScope('api:abcdef'), false);
    assert.equal(hasPerUserScope(''), false);
    assert.equal(hasPerUserScope(null), false);
  });
});

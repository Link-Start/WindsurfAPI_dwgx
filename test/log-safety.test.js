import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { logHash, redactCredentialFragments, sliceRedactedJson, safeAccountRef, safeEmailRef, safeKeyRef } from '../src/log-safety.js';

describe('log safety helpers', () => {
  it('keeps log references stable without exposing raw labels', () => {
    const email = 'operator@example.test';
    const key = 'sk-ws-01-secret-fixture-key';
    const account = { id: 'acct1234', email };

    const accountRef = safeAccountRef(account);
    const emailRef = safeEmailRef(email);
    const keyRef = safeKeyRef(key, 'apiKey');

    assert.equal(accountRef, `account=acct1234 labelHash=${logHash(email)}`);
    assert.equal(emailRef, `emailHash=${logHash(email)}`);
    assert.equal(keyRef, `apiKeyHash=${logHash(key)}`);

    assert.doesNotMatch(accountRef, /operator@example\.test/);
    assert.doesNotMatch(emailRef, /operator@example\.test/);
    assert.doesNotMatch(keyRef, /sk-ws-01-secret/);
  });

  it('redacts session tokens and JWTs from operator-facing error text', () => {
    const jwt = `${'eyJhbGciOiJub25lIn0'.padEnd(20, 'x')}.${'eyJzdWIiOiJhIn0'.padEnd(20, 'y')}.${'sig'.padEnd(20, 'z')}`;
    const raw = `failed to validate Devin token: Invalid token ${jwt} and devin-session-token$ws-fixture.abc.def`;
    const out = redactCredentialFragments(raw);
    assert.doesNotMatch(out, /eyJhbGciOiJub25lIn0/);
    assert.doesNotMatch(out, /devin-session-token\$ws-fixture/);
    assert.match(out, /\[jwt-redacted\]/);
    assert.match(out, /devin-session-token\$\[redacted\]/);
  });

  it('sliceRedactedJson redacts before truncating a JWT-bearing body', () => {
    const jwt = `eyJhbGciOiJub25lIn0.${'b'.repeat(40)}.${'c'.repeat(40)}`;
    const sliced = sliceRedactedJson({ message: `invalid token ${jwt}` }, 80);
    assert.doesNotMatch(sliced, /eyJhbGciOiJub25lIn0/);
    assert.ok(sliced.length <= 80);
  });

  it('login paths do not slice raw JSON before redaction', () => {
    for (const file of [
      'src/dashboard/windsurf-login.js',
      'src/dashboard/email-otp-login.js',
    ]) {
      const src = readFileSync(file, 'utf8');
      assert.doesNotMatch(src, /JSON\.stringify\([^)]*\)\.slice\(0,\s*\d+\)/, file);
      assert.match(src, /sliceRedactedJson/, file);
    }
  });

  it('does not reintroduce raw account labels or API key prefixes in sensitive logs', () => {
    const files = [
      'src/auth.js',
      'src/handlers/chat.js',
      'src/dashboard/windsurf-login.js',
      'src/dashboard/api.js',
      'src/windsurf-api.js',
    ];

    const offenders = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const [idx, line] of src.split(/\r?\n/).entries()) {
        if (!/\blog\.(?:info|warn|error|debug)\b/.test(line)) continue;
        if (/\$\{\s*(?:(?:acct|account)\.email|email)\b[^}]*\}|(?:apiKey|reg\.api_key|currentApiKey)\??\.slice\(/.test(line)) {
          offenders.push(`${file}:${idx + 1}: ${line.trim()}`);
        }
      }
    }

    assert.deepEqual(offenders, []);
  });
});

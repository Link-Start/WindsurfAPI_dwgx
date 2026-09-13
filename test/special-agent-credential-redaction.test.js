import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The Devin CLI child gets the pool credential in its environment
// (src/special-agent.js:428-431 `env[envName] = apiKey`). Its stderr is folded into
// the error message the CALLER receives (:502-508, and :692 SSE / :925 non-stream
// hand that message to the client). So if the CLI prints its own token on an auth
// failure — a normal thing for a CLI to do — the credential reaches the API client.
//
// Measured 2026-09-13: `sanitizeText` (src/sanitize.js) is a PATH/XML redactor only.
// All four credential shapes below pass through it unchanged, while the path control
// is correctly redacted. The credential redactor already exists in this repo
// (src/log-safety.js `redactCredentialFragments`, used by windsurf-api.js) — this
// test pins that the subprocess-output path uses it too.
import { sanitizeText } from '../src/sanitize.js';

const SRC = readFileSync(new URL('../src/special-agent.js', import.meta.url), 'utf8');

const SHAPES = [
  ['auth1_ session token', 'auth1_0123456789abcdef0123456789abcdef'],
  ['devin-session-token$ form', 'devin-session-token$9f3a7c1e5b2d8046a1c3e5f7092b4d6e'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
];

describe('special-agent: a credential in CLI stderr must not reach the caller', () => {
  it('the module redacts credential fragments on the subprocess-output path', () => {
    // Structural: the redactor must be imported AND applied on that path. A
    // behaviour-only test cannot see this, because producing a real CLI token
    // requires a live account — so this half is a deliberate meta-guard.
    assert.match(
      SRC,
      /import\s*\{[^}]*redactCredentialFragments[^}]*\}\s*from\s*'\.\/log-safety\.js'/,
      'special-agent.js must import redactCredentialFragments from ./log-safety.js',
    );
    const uses = SRC.match(/redactCredentialFragments\(/g) || [];
    assert.ok(
      uses.length >= 2,
      `expected redactCredentialFragments at BOTH error exits (const build + the non-stream return), found ${uses.length}`,
    );
  });

  it('and ordering is redact-then-truncate, never truncate-then-redact', () => {
    // log-safety.js documents this trap: slice() first splits a JWT at its first
    // dot, so the regex no longer matches and the fragment survives the redactor.
    assert.doesNotMatch(
      SRC,
      /detail\.slice\(0,\s*1000\)/,
      'raw `detail.slice(0, 1000)` reintroduces truncate-then-redact',
    );
  });
});

// These two pin the shared redactor's contract that the fix depends on, so a
// future edit to log-safety.js cannot silently stop covering a shape above.
describe('the redactor the fix relies on', () => {
  it('covers every credential shape we hand it', async () => {
    const { redactCredentialFragments } = await import('../src/log-safety.js');
    for (const [label, value] of SHAPES) {
      const out = redactCredentialFragments(`Devin CLI failed: auth error, token=${value}`);
      assert.ok(!out.includes(value), `${label} survived the redactor: ${out}`);
    }
  });

  it('does not eat the legitimate diagnostics we still want', async () => {
    const { redactCredentialFragments } = await import('../src/log-safety.js');
    const msg = 'Devin CLI failed: ENOENT spawn devin; exit code 127';
    assert.equal(redactCredentialFragments(msg), msg);
  });
});

// Control, kept honest: sanitizeText remains the PATH redactor it always was.
// If a future change makes it swallow credentials too, this documents that the
// subprocess path still must not rely on it alone.
describe('control: sanitizeText is a path redactor, not a credential one', () => {
  it('redacts a workspace path', () => {
    assert.match(sanitizeText('open /tmp/windsurf-workspace/src/index.js failed'), /<workspace>/);
  });
});

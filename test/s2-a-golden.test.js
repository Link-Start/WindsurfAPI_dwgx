// WHY THIS FILE EXISTS. The S2-A encoder patch replaces the per-field
// `Buffer.concat` writers in src/proto.js with single-allocation fast paths.
// Those writers sit under every request that reaches the Devin wire, so the
// only acceptable outcome is "not one byte moved" — a claim that has to be
// re-derived on every run, not argued in a report.
//
// The golden frames were captured by scripts/s2-a-golden.mjs --write on the
// pinned pre-change commit (014204f, the v3.9.35 tree) with a deterministic
// crypto stub, so UUID/message-id churn cannot be mistaken for a byte change.
// This test re-derives them from the current tree through the public builder
// (buildGetChatMessageRequest + wrapEnvelope) and compares hash, length,
// random-source call order, and the raw frame bytes.
//
// The baseline file is generated, never hand-edited: regenerate it only from a
// tree whose src/proto.js, src/connect.js and src/devin-connect.js are the ones
// you intend to freeze, and only via `--write` (which refuses to overwrite).
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('proto fast paths reproduce the pre-change request frames byte-for-byte', () => {
  const out = execFileSync(
    process.execPath,
    ['scripts/s2-a-golden.mjs', '--check', 'test/fixtures/s2-a-golden-frames.json'],
    { cwd: root, encoding: 'utf8' },
  );
  assert.match(out, /PASS: 12 complete frames match the pre-change baseline byte-for-byte/);
});

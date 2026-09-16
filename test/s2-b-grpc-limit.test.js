import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGrpc, startStream } from './helpers/s2-b-grpc-harness.mjs';

// This is intentionally a real 100 MiB boundary, not a mocked length property.
// Run in the repository's per-file release process; the old oracle copies it.
const CAP = 100 * 1024 * 1024;
const before = await loadGrpc({ before: true }), current = await loadGrpc();

test('S2-B gRPC: aggregate pending size permits exactly 100 MiB, then aborts once', () => {
  const data = Buffer.alloc(CAP); data.writeUInt32BE(0xFFFFFFFF, 1);
  for (const module of [before, current]) {
    const stream = startStream(module);
    try {
      stream.req.emit('data', data);
      assert.deepEqual(stream.events, []);
      stream.req.emit('data', Buffer.from([0]));
      assert.deepEqual(stream.events, [['error', 'Error', 'gRPC frame too large (>100MB)']]);
      assert.equal(stream.closeCodes.length, 1);
      stream.req.emit('data', Buffer.from([0])); stream.req.emit('end');
      assert.equal(stream.events.length, 1);
    } finally { stream.cleanup(); }
  }
});

test('S2-B gRPC: one oversized coalesced batch is rejected before a complete frame is emitted', () => {
  const data = Buffer.alloc(CAP + 1); data.writeUInt32BE(CAP - 5, 1);
  for (const module of [before, current]) {
    const stream = startStream(module);
    try {
      stream.req.emit('data', data);
      assert.deepEqual(stream.payloads, []);
      assert.deepEqual(stream.events, [['error', 'Error', 'gRPC frame too large (>100MB)']]);
      assert.equal(stream.closeCodes.length, 1);
    } finally { stream.cleanup(); }
  }
});

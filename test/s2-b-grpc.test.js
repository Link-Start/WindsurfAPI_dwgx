import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { loadGrpc, startStream, grpcFrame } from './helpers/s2-b-grpc-harness.mjs';

const old = await loadGrpc({ before: true }), current = await loadGrpc();
function compare(chunks, trailer) {
  const a = startStream(old), b = startStream(current);
  try {
    for (const chunk of chunks) {
      a.req.emit('data', chunk); b.req.emit('data', chunk);
      assert.deepEqual(b.events, a.events); assert.deepEqual(b.payloads, a.payloads);
    }
    if (trailer) { a.req.emit('trailers', trailer); b.req.emit('trailers', trailer); }
    a.req.emit('end'); b.req.emit('end');
    assert.deepEqual(b.events, a.events); assert.deepEqual(b.closeCodes, a.closeCodes);
    return { events: b.events, payloads: b.payloads };
  } finally { a.cleanup(); b.cleanup(); }
}

test('S2-B gRPC: all split positions and one-byte chunks match the original', () => {
  const data = Buffer.concat([grpcFrame(Buffer.from('one')), grpcFrame(Buffer.alloc(0)), grpcFrame(Buffer.from('two'))]);
  for (let i = 0; i <= data.length; i++) compare([data.subarray(0, i), Buffer.alloc(0), data.subarray(i)]);
  compare(Array.from(data, (_, i) => data.subarray(i, i + 1)));
});

test('S2-B gRPC: unsupported compression is skipped, not newly decoded', () => {
  const data = Buffer.concat([grpcFrame(Buffer.from('ignored'), 1), grpcFrame(Buffer.from('also ignored'), 128), grpcFrame(Buffer.from('kept'))]);
  const result = compare([data]);
  assert.deepEqual(result.payloads.map(p => p.toString()), ['kept']);
});

test('S2-B gRPC: an absurd advertised length alone does not trigger the pending-byte cap', () => {
  const header = Buffer.alloc(5); header.writeUInt32BE(0xFFFFFFFF, 1);
  const result = compare([header]);
  assert.deepEqual(result.events, [['end']]);
});

test('S2-B gRPC: errors in trailers still follow any delivered payloads', () => {
  const result = compare([grpcFrame(Buffer.from('partial answer'))], { 'grpc-status': '13', 'grpc-message': 'bad%20request' });
  assert.deepEqual(result.events, [['data', 14], ['error', 'Error', 'bad request']]);
});

test('S2-B gRPC: incomplete frames do not concatenate or allocate payloads', () => {
  const data = grpcFrame(Buffer.alloc(65536, 5)), stream = startStream(current);
  const savedConcat = Buffer.concat, savedAlloc = Buffer.alloc;
  let concats = 0, allocations = 0, partial;
  Buffer.concat = function (...args) { concats++; return Reflect.apply(savedConcat, this, args); };
  Buffer.alloc = function (...args) { allocations++; return Reflect.apply(savedAlloc, this, args); };
  try {
    for (let pos = 0; pos < data.length - 1; pos += 1024) stream.req.emit('data', data.subarray(pos, Math.min(data.length - 1, pos + 1024)));
    partial = [concats, allocations, stream.payloads.length];
    stream.req.emit('data', data.subarray(data.length - 1));
  } finally {
    Buffer.concat = savedConcat; Buffer.alloc = savedAlloc; stream.cleanup();
  }
  assert.deepEqual(partial, [0, 0, 0]);
  assert.equal(concats, 0); assert.equal(allocations, 1);
  assert.deepEqual(stream.payloads, [data.subarray(5)]);
});

test('S2-B gRPC: partition fuzz preserves order and partial tails', () => {
  let seed = 0x53320002;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let round = 0; round < 32; round++) {
    const data = Buffer.concat(Array.from({ length: 12 }, (_, i) => grpcFrame(Buffer.alloc(random() % 65, i), i % 5 === 0 ? 1 : 0)));
    const chunks = [];
    for (let pos = 0; pos < data.length;) { const end = Math.min(data.length, pos + 1 + random() % 19); chunks.push(data.subarray(pos, end)); pos = end; }
    compare(chunks);
  }
});

test('S2-B gRPC: Connect mode still parses gzip and end-stream frames', async () => {
  const before = await loadGrpc({ before: true, connect: true }), after = await loadGrpc({ connect: true });
  const a = startStream(before), b = startStream(after);
  const data = Buffer.concat([grpcFrame(gzipSync(Buffer.from('connect')), 1), grpcFrame(Buffer.from('{}'), 2)]);
  try {
    for (let i = 0; i < data.length; i++) { a.req.emit('data', data.subarray(i, i + 1)); b.req.emit('data', data.subarray(i, i + 1)); }
    a.req.emit('end'); b.req.emit('end');
    assert.deepEqual(b.events, a.events); assert.deepEqual(b.payloads, a.payloads);
    assert.deepEqual(b.payloads.map(p => p.toString()), ['connect']);
  } finally { a.cleanup(); b.cleanup(); }
});

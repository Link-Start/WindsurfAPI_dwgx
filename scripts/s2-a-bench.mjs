import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import * as current from '../src/proto.js';

// Frozen 014204f varint and the original field-concatenation shape.
function encodeVarint(value) {
  const bytes = [];
  // BigInt path for negatives (two's-complement uint64) and any int > 2^31
  // since JS `>>>` truncates to uint32 and silently corrupts larger varints.
  if (typeof value === 'bigint' || value < 0 || value > 0x7FFFFFFF) {
    let b = (typeof value === 'bigint' ? value : BigInt(value)) & 0xFFFFFFFFFFFFFFFFn;
    while (true) {
      const byte = Number(b & 0x7Fn);
      b >>= 7n;
      if (b === 0n) { bytes.push(byte); break; }
      bytes.push(byte | 0x80);
    }
    return Buffer.from(bytes);
  }
  let v = Number(value);
  do {
    let byte = v & 0x7F;
    v >>>= 7;
    if (v > 0) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0);
  return Buffer.from(bytes);
}


const before = {
  writeStringField(field, str) {
    if (!str && str !== '') return Buffer.alloc(0);
    const data = Buffer.from(str, 'utf-8');
    return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(data.length), data]);
  },
  writeVarintField(field, value) {
    return Buffer.concat([encodeVarint((field << 3) | 0), encodeVarint(value)]);
  },
  writeMessageField(field, message) {
    if (!message || message.length === 0) return Buffer.alloc(0);
    return Buffer.concat([encodeVarint((field << 3) | 2), encodeVarint(message.length), message]);
  },
};
const text = '中🙂'.repeat(4096), payload = Buffer.alloc(4 * 1024 * 1024, 7);
const image = 'A'.repeat(4 * 1024 * 1024), small = 'x'.repeat(64);
function nestedImage(writer) {
  // Image -> ChatMessage -> request -> envelope COPY SHAPE, not a complete
  // GetChatMessageRequest schema. The golden CLI checks complete real builders.
  const img = Buffer.concat([writer.writeStringField(1, image), writer.writeStringField(2, 'image/png')]);
  const cm = Buffer.concat([writer.writeStringField(1, '00000000-0000-4000-8000-000000000001'),
    writer.writeVarintField(2, 1), writer.writeStringField(3, 'image'), writer.writeMessageField(10, img)]);
  const proto = Buffer.concat([writer.writeMessageField(3, cm), writer.writeStringField(21, 'swe-1-6-slow')]);
  const frame = Buffer.alloc(5 + proto.length); frame.writeUInt32BE(proto.length, 1); proto.copy(frame, 5);
  return frame;
}
const workloads = [
  ['string-64B', 20000, w => w.writeStringField(2, small)],
  ['utf8-28KiB', 1000, w => w.writeStringField(2, text)],
  ['message-4MiB', 32, w => w.writeMessageField(3, payload)],
  ['nested-image-4MiB-shape', 16, nestedImage],
];
console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, platform: process.platform,
  arch: process.arch, cpu: os.cpus()[0]?.model, gc_exposed: !!global.gc }));
let sink = 0;
for (const [name, iterations, run] of workloads) {
  assert.deepEqual(run(current), run(before), `${name}: bytes differ`);
  for (const [implementation, writer] of [['before', before], ['candidate', current]]) {
    for (let i = 0; i < Math.min(iterations, 10); i++) run(writer);
    global.gc?.();
    const started = performance.now();
    for (let i = 0; i < iterations; i++) { const out = run(writer); sink ^= out.length + out[0] + out[out.length - 1]; }
    const elapsed_ms = performance.now() - started;
    console.log(JSON.stringify({ name, implementation, iterations, elapsed_ms, ns_per_op: elapsed_ms * 1e6 / iterations }));
  }
}
console.log(JSON.stringify({ sink }));

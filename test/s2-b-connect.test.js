import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { runInNewContext } from 'node:vm';
import { StreamingFrameParser, MAX_FRAME_SIZE } from '../src/connect.js';
import { StreamingFrameParser as BeforeParser } from './fixtures/s2-b-connect-before.mjs';

function frame(payload, flags = 0) {
  const out = Buffer.alloc(5 + payload.length);
  out[0] = flags; out.writeUInt32BE(payload.length, 1); payload.copy(out, 5);
  return out;
}
function split(buf, size) {
  const out = [];
  for (let pos = 0; pos < buf.length; pos += size) out.push(buf.subarray(pos, pos + size));
  return out;
}
function drain(parser) {
  try { return { frames: parser.drain() }; }
  catch (error) { return { error: [error.constructor.name, error.message] }; }
}
function compare(chunks, drainEveryPush = true) {
  const old = new BeforeParser(), current = new StreamingFrameParser();
  for (const chunk of chunks) {
    old.push(chunk); current.push(chunk);
    if (drainEveryPush) assert.deepEqual(drain(current), drain(old));
  }
  assert.deepEqual(drain(current), drain(old));
  return current;
}

test('S2-B Connect: every header split, empty push, and partial body', () => {
  const data = frame(Buffer.from('header split'));
  for (let cut = 0; cut <= data.length; cut++) compare([data.subarray(0, cut), Buffer.alloc(0), data.subarray(cut)]);
  compare(split(data, 1));
});

test('S2-B Connect: coalesced frames preserve flags and stream order', () => {
  const data = Buffer.concat([frame(Buffer.from('first')), frame(Buffer.alloc(0)), frame(Buffer.from('{}'), 2), frame(Buffer.from('reserved'), 128)]);
  for (const size of [1, 2, 3, 5, 7, 16, data.length]) compare(split(data, size));
  const parser = new StreamingFrameParser(); parser.push(data);
  assert.deepEqual(parser.drain().map(f => [f.flags, f.isEndStream, f.payload.toString()]), [[0, false, 'first'], [0, false, ''], [2, true, '{}'], [128, false, 'reserved']]);
});

test('S2-B Connect: one complete frame plus a partial next frame', () => {
  const first = frame(Buffer.from('one')), second = frame(Buffer.from('two'));
  const parser = new StreamingFrameParser();
  parser.push(Buffer.concat([first, second.subarray(0, 6)]));
  assert.deepEqual(parser.drain().map(f => f.payload.toString()), ['one']);
  assert.deepEqual(parser.drain(), []);
  parser.push(second.subarray(6));
  assert.deepEqual(parser.drain().map(f => f.payload.toString()), ['two']);
});

test('S2-B Connect: many pushes before a drain do not change the result', () => {
  const data = Buffer.concat([frame(Buffer.from('a'.repeat(127))), frame(Buffer.from('b'.repeat(128))), frame(Buffer.from('c'))]);
  compare(split(data, 3), false);
});

test('S2-B Connect: gzip data and compressed trailers retain their flags', () => {
  compare(split(Buffer.concat([frame(gzipSync(Buffer.from('gzip data')), 1), frame(gzipSync(Buffer.from('{}')), 3)]), 2));
});

test('S2-B Connect: advertised limit rejects at the fifth header byte, not sooner', () => {
  for (const length of [MAX_FRAME_SIZE + 1, 0xFFFFFFFF]) {
    const header = Buffer.alloc(5); header.writeUInt32BE(length, 1);
    for (let cut = 0; cut < 5; cut++) {
      const parser = new StreamingFrameParser();
      parser.push(header.subarray(0, cut)); assert.deepEqual(parser.drain(), []);
      parser.push(header.subarray(cut));
      const expected = { error: ['Error', `HTTP/2 frame size ${length} exceeds ${MAX_FRAME_SIZE}`] };
      assert.deepEqual(drain(parser), expected);
      assert.deepEqual(drain(parser), expected);
    }
  }
});

test('S2-B Connect: exactly MAX_FRAME_SIZE remains accepted', () => {
  const data = frame(Buffer.alloc(MAX_FRAME_SIZE, 0x61));
  compare([data]);
});

test('S2-B Connect: a failing later frame does not resurrect an earlier frame', () => {
  const bad = Buffer.alloc(5); bad.writeUInt32BE(MAX_FRAME_SIZE + 1, 1);
  const old = new BeforeParser(), current = new StreamingFrameParser();
  const data = Buffer.concat([frame(Buffer.from('consumed before failure')), bad]);
  old.push(data); current.push(data);
  assert.deepEqual(drain(current), drain(old));
  assert.deepEqual(drain(current), drain(old));
  assert.equal(current._length, 5);
});

test('S2-B Connect: corrupt gzip errors retain the failing frame', () => {
  const old = new BeforeParser(), current = new StreamingFrameParser();
  const bad = frame(Buffer.from('not gzip'), 1);
  old.push(bad); current.push(bad);
  for (let i = 0; i < 2; i++) {
    const result = drain(current); assert.deepEqual(result, drain(old));
    assert.match(result.error[1], /^Connect frame decompression failed: /);
  }
});

test('S2-B Connect: inflated output is still bounded', () => {
  const compressed = gzipSync(Buffer.alloc(MAX_FRAME_SIZE + 1, 0x61));
  const old = new BeforeParser(), current = new StreamingFrameParser();
  const bomb = frame(compressed, 1); old.push(bomb); current.push(bomb);
  const result = drain(current); assert.deepEqual(result, drain(old));
  assert.match(result.error[1], /^Connect frame decompression failed: /);
});

test('S2-B Connect: incomplete input retains references without allocating or copying', () => {
  const data = frame(Buffer.alloc(65536, 0x61)), pieces = split(data, 1024);
  const parser = new StreamingFrameParser();
  const names = ['alloc', 'allocUnsafe', 'from', 'concat'];
  const saved = Object.fromEntries(names.map(name => [name, Buffer[name]]));
  const counts = Object.fromEntries(names.map(name => [name, 0]));
  const setDescriptor = Object.getOwnPropertyDescriptor(Buffer.prototype, 'set');
  const savedSet = Buffer.prototype.set;
  let copied = 0, outputs;
  for (const name of names) Buffer[name] = function (...args) { counts[name]++; return Reflect.apply(saved[name], this, args); };
  Buffer.prototype.set = function (input, offset) { copied += input.length; return Reflect.apply(savedSet, this, [input, offset]); };
  let partialCounts, partialCopied;
  try {
    for (const piece of pieces.slice(0, -1)) { parser.push(piece); parser.drain(); }
    partialCounts = { ...counts }; partialCopied = copied;
    parser.push(pieces.at(-1)); outputs = parser.drain();
  } finally {
    Object.assign(Buffer, saved);
    if (setDescriptor) Object.defineProperty(Buffer.prototype, 'set', setDescriptor);
    else delete Buffer.prototype.set;
  }
  assert.deepEqual(partialCounts, { alloc: 0, allocUnsafe: 0, from: 0, concat: 0 });
  assert.equal(partialCopied, 0);
  assert.equal(counts.alloc, 1);
  assert.equal(counts.concat, 0);
  assert.equal(copied, data.length - 5);
  assert.equal(outputs.length, 1);
  assert.deepEqual(outputs[0].payload, data.subarray(5));
});

test('S2-B Connect: retired references are released and returned data is independent', () => {
  const data = frame(Buffer.from('output survives'));
  const parser = new StreamingFrameParser(); parser.push(data.subarray(0, 6));
  assert.equal(parser._chunks[0].buffer, data.buffer);
  parser.push(data.subarray(6)); const [out] = parser.drain();
  data.fill(0);
  assert.equal(out.payload.toString(), 'output survives');
  assert.equal(parser._chunks.length, 0); assert.equal(parser._length, 0);
});

test('S2-B Connect: deterministic partition fuzz includes cross-frame boundaries', () => {
  let seed = 0x53320001;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let round = 0; round < 64; round++) {
    const frames = Array.from({ length: 9 }, (_, i) => frame(Buffer.alloc(random() % 129, i + 1), i === 8 ? 2 : 0));
    const data = Buffer.concat(frames), chunks = [];
    for (let pos = 0; pos < data.length;) { const end = Math.min(data.length, pos + 1 + random() % 23); chunks.push(data.subarray(pos, end)); pos = end; }
    compare(chunks, round % 2 === 0);
  }
});

test('S2-B Connect: Uint8Array and invalid-input errors remain compatible', () => {
  compare([new Uint8Array(frame(Buffer.from('typed')))]);
  compare([runInNewContext('new Uint8Array([0, 0, 0, 0, 1, 65])')]);
  const capture = (parser, input) => {
    try { parser.push(input); return null; }
    catch (err) { return [err.constructor.name, err.message]; }
  };
  for (const input of [null, undefined, 'text', [0], new ArrayBuffer(5), new Uint16Array(5)]) {
    assert.deepEqual(capture(new StreamingFrameParser(), input), capture(new BeforeParser(), input));
  }
});

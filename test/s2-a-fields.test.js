import test from 'node:test';
import assert from 'node:assert/strict';
import * as actual from '../src/proto.js';
import * as before from './fixtures/s2-a-proto-before.mjs';
import { walk } from './helpers/s2-a-fixtures.mjs';

function outcome(fn) {
  try { return { value: fn() }; }
  catch (err) { return { error: [err.constructor.name, err.message] }; }
}
function same(name, ...args) {
  assert.deepEqual(outcome(() => actual[name](...args)), outcome(() => before[name](...args)), name);
}

test('S2-A: UTF-8 bytes and length boundaries match the frozen encoder', () => {
  const texts = ['', 'ASCII', '世界', '🙂', 'e\u0301', '\0', '\uD800', '\uDC00', '\uD800A\uDC00', '\uD83D\uDE42'];
  for (const n of [1, 126, 127, 128, 129, 16383, 16384]) texts.push('x'.repeat(n));
  for (const text of texts) for (const field of [0, 1, 15, 16, 127, 128, 0x0FFFFFFF]) same('writeStringField', field, text);
});

test('S2-A: unusual tags retain signed-shift and coercion behavior', () => {
  for (const field of [0x10000000, 0x1FFFFFFF, 0x20000000, -1, 1.5, NaN, Infinity, '3', 3n, null, undefined, Symbol('field')]) {
    same('writeStringField', field, 'x');
    same('writeVarintField', field, 128);
    same('writeMessageField', field, Buffer.from([8, 1]));
  }
});

test('S2-A: varints preserve BigInt, signed, fractional, and invalid inputs', () => {
  for (const value of [0, -0, 1, 127, 128, 16383, 16384, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF,
    Number.MAX_SAFE_INTEGER, -1, -2147483648, 1.25, -1.25, NaN, Infinity, -Infinity,
    0n, -1n, 128n, (1n << 64n) - 1n, 1n << 64n, -(1n << 80n), '128', '', true, false, null, undefined, Symbol('value')]) {
    same('writeVarintField', 16, value);
    same('encodeVarint', value);
  }
});

test('S2-A: non-string Buffer.from inputs use the original path', () => {
  for (const value of [undefined, null, false, 0, -0, NaN, true, 42, {}, [65, 66],
    Buffer.from([0xC3, 0xA9]), new Uint8Array([0xC3, 0xA9]), new String('boxed'),
    { type: 'Buffer', data: [65, 66] }, { valueOf: () => 'coerced' }]) same('writeStringField', 2, value);
});

test('S2-A: fallback coercions keep their evaluation order', () => {
  for (const name of ['writeStringField', 'writeVarintField']) {
    const run = (module) => {
      const trace = [];
      const field = { valueOf() { trace.push('field'); return 2; } };
      const value = { valueOf() { trace.push('value'); return name === 'writeStringField' ? 's' : 128; } };
      return { result: outcome(() => module[name](field, value)), trace };
    };
    assert.deepEqual(run(actual), run(before));
  }
});

test('S2-A: empty string, empty bytes, and omitted empty message remain distinct', () => {
  assert.equal(actual.writeStringField(2, '').toString('hex'), '1200');
  assert.equal(actual.writeBytesField(2, Buffer.alloc(0)).toString('hex'), '1200');
  for (const value of [undefined, null, false, Buffer.alloc(0), new Uint8Array(0)]) same('writeMessageField', 2, value);
  assert.equal(actual.writeMessageField(2, Buffer.alloc(0)).length, 0);
  for (const value of [undefined, null, false, 0, NaN]) same('writeStringField', 2, value);
});

test('S2-A: embedded payloads copy exact view ranges and do not alias input', () => {
  for (const n of [1, 127, 128, 16383, 16384]) {
    const backing = Buffer.alloc(n + 20);
    for (let i = 0; i < backing.length; i++) backing[i] = (i * 37) & 255;
    const view = backing.subarray(7, 7 + n);
    same('writeMessageField', 16, view);
    same('writeMessageField', 16, new Uint8Array(view.buffer, view.byteOffset, view.length));
    const encoded = actual.writeMessageField(16, view), snapshot = Buffer.from(encoded);
    view.fill(0);
    assert.deepEqual(encoded, snapshot);
  }
  same('writeMessageField', 2, { length: 3 });
});

test('S2-A: independent walker pins field order, wire types, and lengths', () => {
  const body = Buffer.concat([
    actual.writeStringField(16, 'x'.repeat(128)),
    actual.writeVarintField(3, 128),
    actual.writeMessageField(4, Buffer.alloc(0)),
    actual.writeStringField(7, ''),
  ]);
  assert.equal(body.subarray(0, 4).toString('hex'), '82018001');
  const fields = walk(body);
  assert.deepEqual(fields.map(f => [f.field, f.wireType, f.length]), [[16, 2, 128], [3, 0, undefined], [7, 2, 0]]);
  assert.equal(fields[1].value, 128n);
  assert.equal(fields.at(-1).end, body.length);
});

test('S2-A: untouched fixed and bool writers remain byte-identical', () => {
  same('writeFixed64Field', 5, Buffer.from('010000000000f87f', 'hex'));
  same('writeFixed32Field', 5, Buffer.from('0100c07f', 'hex'));
  for (const value of [false, true, null, 0, 1, 'x']) same('writeBoolField', 20, value);
});

test('S2-A: fast fields allocate one output each and do not concatenate', () => {
  const payload = Buffer.alloc(16384, 7), text = 'x'.repeat(16384);
  const saved = { alloc: Buffer.alloc, from: Buffer.from, concat: Buffer.concat };
  const calls = { alloc: 0, from: 0, concat: 0 };
  for (const key of Object.keys(saved)) Buffer[key] = function (...args) { calls[key]++; return Reflect.apply(saved[key], this, args); };
  let outputs;
  try {
    outputs = [actual.writeStringField(16, text), actual.writeVarintField(3, 128), actual.writeMessageField(10, payload)];
  } finally {
    Object.assign(Buffer, saved);
  }
  assert.deepEqual(calls, { alloc: 3, from: 0, concat: 0 });
  assert.ok(outputs.every(Buffer.isBuffer));
});

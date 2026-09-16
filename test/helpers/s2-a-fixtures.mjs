import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';

export const BASE = '014204fc2883fe58811c57a89f5069faee0b6411';

// Install before dynamically importing devin-connect.js: it uses named imports.
// Reset both streams for each request, including its default random fingerprint.
export function installDeterministicCrypto() {
  const savedUUID = crypto.randomUUID;
  const savedBytes = crypto.randomBytes;
  let uuid = 0, bytes = 0, calls = [];
  crypto.randomUUID = () => {
    const value = `00000000-0000-4000-8000-${(++uuid).toString(16).padStart(12, '0')}`;
    calls.push(['uuid', value]);
    return value;
  };
  crypto.randomBytes = (size, callback) => {
    assert.equal(callback, undefined, 'The wire builder must use synchronous randomBytes');
    const value = Buffer.alloc(size);
    const sequence = ++bytes;
    for (let i = 0; i < size; i++) value[i] = (17 + 29 * sequence + 13 * i) & 255;
    calls.push(['bytes', size, sequence]);
    return value;
  };
  syncBuiltinESMExports();
  return {
    reset() { uuid = 0; bytes = 0; calls = []; },
    calls() { return structuredClone(calls); },
    restore() {
      crypto.randomUUID = savedUUID;
      crypto.randomBytes = savedBytes;
      syncBuiltinESMExports();
    },
  };
}

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6mQAAAAASUVORK5CYII=';
const call = (id, name, text) => ({ id, type: 'function', function: { name, arguments: JSON.stringify({ text }) } });
const nativeHistory = () => [
  { role: 'user', content: 'Run both tools.' },
  { role: 'assistant', content: 'Calling tools.', tool_calls: [call('c1', 'echo', 'one'), call('c2', 'echo', 'two')] },
  { role: 'tool', tool_call_id: 'c1', content: 'one' },
  { role: 'tool', tool_call_id: 'c2', content: 'two' },
  { role: 'user', content: 'Continue.' },
];

export function makeCases() {
  const base = { token: 's2-test-not-a-real-token', model: 'swe-1-6-slow', env: {} };
  const entry = (name, args) => ({ name, args: { ...base, ...args } });
  const replay = nativeHistory();
  replay[1].reasoning = ' first alias \n';
  replay[1].reasoning_content = 'second alias must not win';
  const imageContent = [
    { type: 'text', text: 'Inspect both images.' },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
  ];
  return [
    entry('plain-text', { messages: [{ role: 'user', content: 'Hello 世界🙂\0end' }] }),
    entry('multi-assistant', { nativeToolCall: true, messages: nativeHistory() }),
    entry('tool-calls-emulated', { messages: nativeHistory() }),
    entry('reasoning-off', { messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: '', reasoning: 'hidden' }] }),
    entry('reasoning-11', { nativeToolCall: true, env: { DEVIN_CONNECT_REPLAY_REASONING: '1' }, messages: replay }),
    entry('reasoning-9', { env: { DEVIN_CONNECT_REPLAY_REASONING: '9' }, messages: [{ role: 'user', content: 'Q' }, { role: 'assistant', content: '', reasoning: '  think  ' }] }),
    entry('inline-images', { messages: [{ role: 'user', content: imageContent }] }),
    entry('long-system', { messages: [{ role: 'system', content: 'policy中🙂\n'.repeat(2300) }, { role: 'user', content: 'Q' }] }),
    entry('empty-content', { messages: [{ role: 'system', content: '' }, { role: 'user', content: '' }, { role: 'assistant', content: '' }] }),
    entry('length-boundaries', { messages: [127, 128, 16383, 16384].map((n, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(n) })) }),
    entry('images-disabled', { env: { DEVIN_CONNECT_IMAGE_TAG: '0' }, messages: [{ role: 'user', content: imageContent }] }),
    entry('unicode-edge', { messages: [{ role: 'user', content: '\uD800A\uDC00\uD83D\uDE42e\u0301\0' }] }),
  ];
}

// Independent, bounds-checked walker. Do not use the production decoder as its
// own oracle: a common length bug could otherwise make encoder and walker agree.
export function walk(buf) {
  let pos = 0;
  const read = () => {
    let value = 0n, shift = 0n, byte;
    do {
      assert.ok(pos < buf.length && shift <= 63n, 'Truncated or overflowing varint');
      byte = buf[pos++]; value |= BigInt(byte & 127) << shift; shift += 7n;
    } while (byte & 128);
    return value;
  };
  const fields = [];
  while (pos < buf.length) {
    const start = pos, tag = read();
    const field = Number(tag >> 3n), wireType = Number(tag & 7n);
    let value, length;
    if (wireType === 0) value = read();
    else {
      assert.ok([1, 2, 5].includes(wireType), 'Unsupported wire type');
      length = wireType === 2 ? Number(read()) : wireType === 1 ? 8 : 4;
      assert.ok(Number.isSafeInteger(length) && length <= buf.length - pos, 'Invalid field length');
      value = buf.subarray(pos, pos + length); pos += length;
    }
    fields.push({ field, wireType, length, value, start, end: pos });
  }
  return fields;
}

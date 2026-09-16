import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { installDeterministicCrypto, makeCases, walk } from './helpers/s2-a-fixtures.mjs';

const entropy = installDeterministicCrypto();
const savedCap = process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS;
process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS = '8192';
const { buildGetChatMessageRequest } = await import('../src/devin-connect.js');
const { wrapEnvelope } = await import('../src/connect.js');
after(() => {
  entropy.restore();
  if (savedCap === undefined) delete process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS;
  else process.env.DEVIN_CONNECT_WIRE_MAX_TOKENS = savedCap;
});

function encode(name) {
  entropy.reset();
  const { args } = makeCases().find(c => c.name === name);
  const proto = buildGetChatMessageRequest(structuredClone(args));
  return { args, proto, fields: walk(proto), frame: wrapEnvelope(proto, { compress: false }), calls: entropy.calls() };
}
const chats = result => result.fields.filter(f => f.field === 3).map(f => walk(f.value));
const get = (fields, n) => fields.find(f => f.field === n);

for (const { name } of makeCases()) {
  test(`S2-A request: ${name} is deterministic and has an exact envelope length`, { concurrency: false }, () => {
    const first = encode(name), second = encode(name);
    assert.deepEqual(first.frame, second.frame);
    assert.deepEqual(first.calls, second.calls);
    assert.equal(first.frame[0], 0);
    assert.equal(first.frame.readUInt32BE(1), first.proto.length);
    assert.deepEqual(first.frame.subarray(5), first.proto);
    assert.ok(first.calls.some(c => c[0] === 'uuid'));
    assert.ok(first.calls.some(c => c[0] === 'bytes' && c[1] === 366));
    assert.equal(first.fields.at(-1).end, first.proto.length);
    for (const cm of chats(first)) {
      for (const field of cm.filter(f => f.field === 6 || f.field === 10)) {
        assert.equal(walk(field.value).at(-1).end, field.length);
      }
    }
  });
}

test('S2-A request: plain root and ChatMessage order are pinned independently', () => {
  const result = encode('plain-text');
  assert.deepEqual(result.fields.map(f => [f.field, f.wireType]), [[1, 2], [2, 2], [3, 2], [7, 0], [8, 2], [15, 2], [16, 2], [20, 0], [21, 2]]);
  const [cm] = chats(result);
  assert.deepEqual(cm.map(f => [f.field, f.wireType]), [[1, 2], [2, 0], [3, 2]]);
  assert.equal(cm[0].length, 36);
  assert.equal(cm[1].value, 1n);
  assert.equal(cm[2].length, Buffer.byteLength(result.args.messages[0].content));
  assert.equal(cm[2].value.toString(), result.args.messages[0].content);
  assert.deepEqual(walk(get(result.fields, 8).value).map(f => [f.field, f.wireType]), [[1, 0], [2, 0], [3, 0], [5, 1], [7, 0], [8, 1]]);
});

test('S2-A request: native calls remain separate ordered protobuf submessages', () => {
  const cm = chats(encode('multi-assistant'));
  const calls = cm.filter(fields => get(fields, 6));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(fields => get(walk(get(fields, 6).value), 1).value.toString()), ['c1', 'c2']);
  for (const fields of calls) assert.deepEqual(walk(get(fields, 6).value).map(f => f.field), [1, 2, 3]);
  assert.deepEqual(cm.filter(fields => get(fields, 7)).map(fields => get(fields, 7).value.toString()), ['c1', 'c2']);
});

test('S2-A request: reasoning replay keeps default-off, alias, count, and tag semantics', () => {
  assert.equal(chats(encode('reasoning-off')).length, 1);
  const replay = chats(encode('reasoning-11')).flatMap(cm => cm.filter(f => f.field === 11));
  assert.equal(replay.length, 3);
  assert.ok(replay.every(f => f.value.toString() === ' first alias \n'));
  const nine = chats(encode('reasoning-9'));
  assert.equal(get(nine[1], 9).value.toString(), 'think');
  assert.equal(get(nine[1], 11), undefined);
});

test('S2-A request: images stay base64 text in ordered fields 1 and 2', () => {
  const result = encode('inline-images'), [cm] = chats(result);
  const images = cm.filter(f => f.field === 10);
  assert.equal(images.length, 2);
  for (const image of images) {
    const inner = walk(image.value);
    assert.deepEqual(inner.map(f => [f.field, f.wireType]), [[1, 2], [2, 2]]);
    assert.ok(inner[0].value.toString().startsWith('iVBORw0KGgo'));
    assert.equal(inner[1].value.toString(), 'image/png');
    assert.equal(inner[0].length, inner[0].value.toString().length);
  }
  assert.equal(chats(encode('images-disabled'))[0].filter(f => f.field === 10).length, 0);
});

test('S2-A request: long and empty strings retain their explicit fields', () => {
  const long = encode('long-system');
  assert.equal(get(long.fields, 2).length, Buffer.byteLength(long.args.messages[0].content));
  assert.ok(get(long.fields, 2).length > 16383);
  const empty = encode('empty-content');
  assert.equal(get(empty.fields, 2).length, 0);
  assert.equal(chats(empty).length, 1);
  assert.equal(get(chats(empty)[0], 3).length, 0);
});

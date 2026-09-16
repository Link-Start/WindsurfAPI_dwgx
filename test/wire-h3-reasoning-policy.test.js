import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { buildGetChatMessageRequest } from '../src/devin-connect.js';
import { parseFields, getField, getAllFields } from '../src/proto.js';
import {
  normalizeMessagesForCascade, interleaveParallelToolMessages,
} from '../src/handlers/tool-emulation.js';

function build(messages, env = {}, nativeToolCall = true) {
  const originalUUID = crypto.randomUUID;
  let n = 0;
  // Fix entropy before encoding, not by erasing fields from the encoded bytes.
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  syncBuiltinESMExports();
  try {
    return buildGetChatMessageRequest({
      token: 'wire-test',
      model: 'swe-1-7',
      sessionId: 'wire-session',
      sessionModelConfig: { id: 'wire-config', turn: 1 },
      deviceSeed: 'wire-device',
      messages,
      nativeToolCall,
      env,
    });
  } finally {
    crypto.randomUUID = originalUUID;
    syncBuiltinESMExports();
  }
}

const frames = (buf) => getAllFields(parseFields(buf), 3)
  .filter((f) => f.wireType === 2).map((f) => parseFields(f.value));
const strings = (fields, tag) => getAllFields(fields, tag)
  .filter((f) => f.wireType === 2).map((f) => f.value.toString('utf8'));
const roles = (items) => items.map((f) => getField(f, 2, 0).value);
const user = { role: 'user', content: 'continue' };
const call = (id) => ({
  id, type: 'function', function: { name: 'f', arguments: '{}' },
});

const callIds = (items) => items.flatMap((f) => getAllFields(f, 6)
  .map((c) => strings(parseFields(c.value), 1)[0]));

test('H3-T1: enabled raw replay copies reasoning to every native assistant frame', () => {
  const cases = [
    { text: 'before', expectedRoles: [2, 2, 2, 1] },
    { text: '', expectedRoles: [2, 2, 1] },
  ];
  for (const { text, expectedRoles } of cases) {
    for (const [value, tag] of [['1', 11], ['9', 9]]) {
      const items = frames(build([
        { role: 'assistant', content: text, reasoning: 'R', tool_calls: [call('a'), call('b')] },
        user,
      ], { DEVIN_CONNECT_REPLAY_REASONING: value }));
      // Raw encoder shape only: the three-assistant run is not a live acceptance fixture.
      assert.deepEqual(roles(items), expectedRoles);
      assert.deepEqual(callIds(items), ['a', 'b']);
      for (const f of items.slice(0, -1)) {
        assert.deepEqual(strings(f, tag), ['R']);
        assert.deepEqual(strings(f, tag === 11 ? 9 : 11), []);
      }
      assert.deepEqual(strings(items.at(-1), tag), []);
    }
  }
});

test('H3-T2: disabled or unrecognized replay leaves full wire bytes unchanged', () => {
  const base = { role: 'assistant', content: 'before', tool_calls: [call('a'), call('b')] };
  for (const env of [
    {}, { DEVIN_CONNECT_REPLAY_REASONING: '0' }, { DEVIN_CONNECT_REPLAY_REASONING: '11' },
  ]) {
    for (const native of [false, true]) {
      const actual = build([{ ...base, reasoning: 'R', reasoning_content: 'A' }, user], env, native);
      assert.deepEqual(actual, build([base, user], env, native));
      for (const f of frames(actual)) {
        assert.deepEqual(strings(f, 11), []);
        assert.deepEqual(strings(f, 9), []);
      }
    }
  }
});

test('H3-T3: first-truthy aliases and branch-specific trimming remain explicit', () => {
  const cases = [
    { reasoning: 'P', reasoning_content: 'A', native: ['P'], plain: ['P'] },
    { reasoning: '', reasoning_content: 'A', native: ['A'], plain: ['A'] },
    { reasoning: null, reasoning_content: 'A', native: ['A'], plain: ['A'] },
    { reasoning: '  ', reasoning_content: 'A', native: ['  '], plain: [] },
    { reasoning: ' P ', reasoning_content: 'A', native: [' P '], plain: ['P'] },
  ];
  const env = { DEVIN_CONNECT_REPLAY_REASONING: '1' };
  for (const row of cases) {
    const msg = {
      role: 'assistant', content: 'before',
      reasoning: row.reasoning, reasoning_content: row.reasoning_content,
    };
    const native = frames(build([{ ...msg, tool_calls: [call('a')] }, user], env));
    assert.deepEqual(roles(native), [2, 2, 1]);
    assert.deepEqual(strings(native[0], 11), row.native);
    assert.deepEqual(strings(native[1], 11), row.native);
    const plain = frames(build([msg, user], env));
    assert.deepEqual(roles(plain), [2, 1]);
    assert.deepEqual(strings(plain[0], 11), row.plain);
  }
});

test('H3-T4: matched batch preprocessing retains reasoning only on the first split call', () => {
  const cases = [
    {
      text: 'before', expectedRoles: [2, 2, 4, 2, 4, 1],
      expectedReasoning: [['R'], ['R'], [], [], [], []],
    },
    {
      text: '', expectedRoles: [2, 4, 2, 4, 1],
      expectedReasoning: [['R'], [], [], [], []],
    },
  ];
  for (const { text, expectedRoles, expectedReasoning } of cases) {
    const input = [
      { role: 'assistant', content: text, reasoning: 'R', reasoning_content: 'A',
        tool_calls: [call('a'), call('b')] },
      { role: 'tool', tool_call_id: 'a', content: 'ra' },
      { role: 'tool', tool_call_id: 'b', content: 'rb' },
      user,
    ];
    for (const history of [
      interleaveParallelToolMessages(input),
      normalizeMessagesForCascade(input, [], {
        modelKey: 'swe-1-7', route: 'devin_connect',
        nativeStructured: true, injectUserPreamble: false,
      }),
    ]) {
      const items = frames(build(history, { DEVIN_CONNECT_REPLAY_REASONING: '1' }));
      assert.deepEqual(roles(items), expectedRoles);
      assert.deepEqual(callIds(items), ['a', 'b']);
      assert.deepEqual(items.map((f) => strings(f, 11)), expectedReasoning);
    }
  }
});

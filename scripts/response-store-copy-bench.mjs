// Perf + semantics probe for the response-store copy boundary.
// Usage: node copy-probe.mjs <tree-root>
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(process.argv[2]);
const store = await import(pathToFileURL(resolve(root, 'src/response-store.js')).href);

const bigText = 'x'.repeat(4 * 1024 * 1024 / 4 * 3);   // ~3 MB of text, stands in for a base64 image
const msgs200 = Array.from({ length: 200 }, (_, i) => ({
  role: i % 2 ? 'user' : 'assistant',
  content: i === 3 ? bigText : `message ${i}`,
  ...(i % 5 === 0 ? { tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'f', arguments: '{}' } }] } : {}),
}));
const bufMsg = [{ role: 'user', content: 'with-buffer', blob: Buffer.from('binary-payload') }];

const time = (label, fn, n = 20) => {
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < n; i++) fn(i);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / n;
  console.log(JSON.stringify({ root, label, ms_per_op: Number(ms.toFixed(3)), n }));
  return ms;
};

const caller = { id: 'caller-1' };
time('put-200msg-with-3MB', i => store.putResponse(`r${i}`, msgs200, caller));
const storedId = 'r-iso';
store.putResponse(storedId, msgs200, caller);
time('get-200msg-with-3MB', () => store.getResponse(storedId, caller), 20);

// semantics: caller -> store isolation
msgs200[0].content = 'MUTATED-AFTER-PUT';
const first = store.getResponse(storedId, caller);
console.log(JSON.stringify({ root, caller_isolation: first.messages[0].content !== 'MUTATED-AFTER-PUT' }));
// semantics: reader -> reader isolation
first.messages[1].content = 'MUTATED-BY-READER';
const second = store.getResponse(storedId, caller);
console.log(JSON.stringify({ root, reader_isolation: second.messages[1].content === 'message 1' }));
// semantics: Buffer stays a Buffer
store.putResponse('r-buf', bufMsg, caller);
const back = store.getResponse('r-buf', caller);
console.log(JSON.stringify({ root, buffer_preserved: Buffer.isBuffer(back.messages[0].blob), buffer_value: back.messages[0].blob.toString() }));
// semantics: a function still throws like structuredClone would (no silent sharing)
try {
  store.putResponse('r-fn', [{ role: 'user', content: 'x', fn: () => 1 }], caller);
  console.log(JSON.stringify({ root, function_throws: false }));
} catch (e) {
  console.log(JSON.stringify({ root, function_throws: e.name === 'DataCloneError' }));
}

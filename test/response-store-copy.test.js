// WHY THIS FILE EXISTS. The response store copies a conversation on the way in
// and on the way out, so a caller cannot rewrite history another reader already
// holds. The first version did that with structuredClone, which re-copies every
// string it walks (a 4 MB image turn cost ~2.8 ms per put and per read — measured)
// and turns a Buffer into a Uint8Array, losing the type the rest of the pipeline
// expects. The copy now allocates only containers and shares immutable values.
//
// Two properties have to hold after that change, and both are asserted here:
// a Buffer stays a Buffer, and a payload that cannot be cloned still fails loudly
// instead of being stored as a live reference.
//
// These go through the real module (no source-text extraction), so they fail if
// the copy is made cheaper by sharing something that must not be shared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const store = await import(pathToFileURL(resolve(ROOT, 'src/response-store.js')).href);

const CALLER = 'copy-probe-caller';

test('a stored Buffer comes back as a Buffer with the same bytes', () => {
  const blob = Buffer.from('binary-payload');
  store.putResponse('copy-buffer', [{ role: 'user', content: 'x', blob }], CALLER);
  const out = store.getResponse('copy-buffer', CALLER);
  assert.equal(Buffer.isBuffer(out.messages[0].blob), true, 'structuredClone would have produced a Uint8Array');
  assert.equal(out.messages[0].blob.toString(), 'binary-payload');
  assert.notEqual(out.messages[0].blob, blob, 'and it must still be a copy, not the caller’s buffer');
});

test('the copy still isolates the store from the caller and readers from each other', () => {
  const callerMessages = [{ role: 'user', content: 'original' }];
  store.putResponse('copy-isolation', callerMessages, CALLER);
  callerMessages[0].content = 'mutated after put';
  const first = store.getResponse('copy-isolation', CALLER);
  assert.equal(first.messages[0].content, 'original', 'a caller mutation after put must not reach the store');
  first.messages[0].content = 'mutated by reader';
  const second = store.getResponse('copy-isolation', CALLER);
  assert.equal(second.messages[0].content, 'original', 'a reader mutation must not reach the next reader');
});

test('a payload that cannot be cloned still fails loudly', () => {
  assert.throws(
    () => store.putResponse('copy-function', [{ role: 'user', content: 'x', fn: () => 1 }], CALLER),
    (error) => error.name === 'DataCloneError',
    'storing a live function reference silently would be worse than refusing it',
  );
});

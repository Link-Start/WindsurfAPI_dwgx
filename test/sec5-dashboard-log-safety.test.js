import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const guardSource = readFileSync(new URL('./log-safety.test.js', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../src/dashboard/api.js', import.meta.url), 'utf8');
const start = guardSource.indexOf("it('does not reintroduce raw account labels or API key prefixes in sensitive logs'");
assert.notEqual(start, -1);
const body = guardSource.slice(start);
const filesMatch = body.match(/const files = (\[[^]*?\]);/);
assert.ok(filesMatch);
const files = new Function(`return ${filesMatch[1]};`)();
const predicate = body.match(/^\s*if \((.+\.test\(line\))\) \{/m);
assert.ok(predicate, 'read the actual permanent guard, not a duplicate regex');
const isOffender = new Function('line', `return ${predicate[1]};`);

test('SEC-5: the permanent log guard includes dashboard/api.js', () => {
  assert.equal(files.includes('src/dashboard/api.js'), true);
});

test('SEC-5: the permanent regex catches raw email with fallback but accepts maskEmail', () => {
  assert.equal(isOffender("log.info(`${acct.email || 'no-email'}`);"), true);
  assert.equal(isOffender("log.info(`${email}`);"), true);
  assert.equal(isOffender("log.info(`${maskEmail(acct.email) || 'no-email'}`);"), false);
});

test('SEC-5: the real reveal-key log statement emits a masked address', () => {
  const mask = apiSource.match(/^function maskEmail\([^]*?^\}/m);
  assert.ok(mask);
  const logs = apiSource.split(/\r?\n/).filter(line => line.includes('log.info(`reveal-key:'));
  assert.equal(logs.length, 1);
  const emitted = [];
  new Function('log', 'acct', 'revealKey', 'req', 'dashboardClientIp',
    mask[0] + '\n' + logs[0])(
    { info: line => emitted.push(line) },
    { email: 'operator@example.test' }, [null, 'fixture-account'], {}, () => '127.0.0.1',
  );
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].includes('operator@example.test'), false);
  assert.equal(emitted[0].includes('o***@example.test'), true);
});

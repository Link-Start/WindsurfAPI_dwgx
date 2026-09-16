import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('baseline audit distinguishes a match, drift, empty selection and missing evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-baseline-audit-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'test/mutations'), { recursive: true });
    writeFileSync(join(root, 'scripts/spec-baseline-audit.mjs'), readFileSync(new URL('../scripts/spec-baseline-audit.mjs', import.meta.url)));
    // The policy is tested without importing the POSIX-only production harness.
    writeFileSync(join(root, 'scripts/mutation-harness-utils.mjs'), `
      export const acquireMutationLock = () => () => {};
      export const harnessEnv = () => process.env;
      export const materializeMutationWorkspace = root => ({ root, cleanup() {} });
      export const parseMutationReporterOutput = () => ({ pass: 1, fail: 0, tests: 1, skipped: 0, cancelled: 0, todo: 0 });
      export default async function* reporter(source) { for await (const event of source) {} }
    `);
    writeFileSync(join(root, 'scripts/mutation-network-deny.mjs'), '');
    writeFileSync(join(root, 'test/setup-env.mjs'), '');
    writeFileSync(join(root, 'test/probe.test.js'), "import { it } from 'node:test'; it('probe', () => {});\n");
    const specPath = join(root, 'test/mutations/probe.json');
    const set = value => writeFileSync(specPath, JSON.stringify(value));
    const run = (...args) => spawnSync(process.execPath, ['scripts/spec-baseline-audit.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
    set({ expectBaselinePass: 1, tests: ['test/probe.test.js'] });
    let result = run(); assert.equal(result.status, 0, result.stdout + result.stderr);
    set({ expectBaselinePass: 2, tests: ['test/probe.test.js'] });
    result = run(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /expected=2 measured=1/);
    assert.equal(run('zzz').status, 2);
    set({ expectBaselinePass: 1, tests: ['test/missing.test.js'] });
    result = run(); assert.equal(result.status, 2); assert.match(result.stdout, /missing test file/);
    set({ tests: [] }); assert.equal(run().status, 2);
    writeFileSync(specPath, '{'); assert.equal(run().status, 2);
    writeFileSync(join(root, 'scripts/mutation-harness-utils.mjs'), "throw new Error('unavailable POSIX git');");
    result = run(); assert.equal(result.status, 2); assert.match(result.stderr, /infrastructure unavailable/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

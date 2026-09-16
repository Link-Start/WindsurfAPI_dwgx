import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseFileSummary } from '../scripts/run-test-shard.mjs';
import { REAL_GIT, SKIP_REASON } from './git-fixture-env.js';

it('an unavailable trusted Git probe imports without throwing or consulting PATH', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-probe-'));
  try {
    const source = readFileSync(new URL('./git-fixture-env.js', import.meta.url), 'utf8');
    const anchor = 'TRUSTED_GIT_CANDIDATES.find(executable)';
    assert.equal(source.split(anchor).length - 1, 1);
    writeFileSync(join(dir, 'probe.mjs'), source.replace(anchor, 'undefined'));
    const probe = await import(pathToFileURL(join(dir, 'probe.mjs')).href);
    assert.equal(probe.REAL_GIT, null);
    assert.equal(probe.SKIP_REASON, SKIP_REASON);
    assert.ok(probe.SKIP_REASON.length > 0);
    assert.equal(typeof probe.trustedFixturePath(), 'string');
    assert.equal(probe.isolatedGitEnv().GIT_CONFIG_GLOBAL, '/dev/null');
    assert.ok(REAL_GIT === null || typeof REAL_GIT === 'string');
    // Exercise the entire existing harness test module with no trusted Git. The
    // deliberate import bomb proves the production harness is not loaded at all.
    mkdirSync(join(dir, 'test')); mkdirSync(join(dir, 'scripts'));
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, 'test/git-fixture-env.js'), source.replace(anchor, 'undefined'));
    writeFileSync(join(dir, 'test/mutate-verify-harness.test.js'),
      readFileSync(new URL('./mutate-verify-harness.test.js', import.meta.url)));
    writeFileSync(join(dir, 'scripts/mutation-harness-utils.mjs'), "throw new Error('must not import unavailable harness');");
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; delete env.FORCE_COLOR;
    const child = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/mutate-verify-harness.test.js'],
      { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const counts = parseFileSummary(child.stdout);
    assert.ok(counts.skipped > 0);
    assert.equal(counts.tests, counts.skipped);
    assert.equal(counts.pass, 0); assert.equal(counts.fail, 0);
    console.log(`GIT_UNAVAILABLE_FIXTURE ${JSON.stringify(counts)}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('release summaries count explicit skips and reject missing reporter evidence', () => {
  const text = '# tests 2\n# pass 1\n# fail 0\n# skipped 1\n# cancelled 0\n# todo 0\n';
  assert.deepEqual(parseFileSummary(text), { tests: 2, pass: 1, fail: 0, skipped: 1, cancelled: 0, todo: 0 });
  assert.throws(() => parseFileSummary('reporter changed\n'), /Missing summary/);
  assert.throws(() => parseFileSummary(text + '# pass 1\n'), /Duplicate summary/);
  assert.throws(() => parseFileSummary(text.replace('# tests 2', '# tests 3')), /Incomplete/);
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, selectShard } from '../scripts/run-test-shard.mjs';

describe('test shard runner', () => {
  it('selects deterministic modulo shards', async () => {
    const files = ['a.test.js', 'b.test.js', 'c.test.js', 'd.test.js', 'e.test.js'];
    assert.deepEqual(selectShard(files, 0, 2), ['a.test.js', 'c.test.js', 'e.test.js']);
    assert.deepEqual(selectShard(files, 1, 2), ['b.test.js', 'd.test.js']);
    const { verifyLocalGateFixture } = await import('./local-gate-fixture.js');
    await verifyLocalGateFixture();
  });

  it('validates shard arguments and timeout', () => {
    assert.deepEqual(parseArgs(['1', '4', '--timeout-ms=120000']), {
      shardIndex: 1,
      shardTotal: 4,
      timeoutMs: 120000,
    });
    assert.throws(() => parseArgs(['4', '4']), /smaller than shard total/);
    assert.throws(() => parseArgs(['0', '0']), /Invalid shard total/);
    assert.throws(() => parseArgs(['0', '1', '--timeout-ms=1']), /Invalid per-file timeout/);
  });
});

import { listTopLevelTestFiles } from '../scripts/run-test-shard.mjs';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('test inventory coverage', () => {
  it('recurses and selects every test file exactly once', () => {
    const root = mkdtempSync(join(tmpdir(), 'wa-discovery-'));
    try {
      mkdirSync(join(root, 'test/nested'), { recursive: true });
      for (const file of ['a.test.js', 'b.test.js', 'nested/c.test.js']) writeFileSync(join(root, 'test', file), '');
      writeFileSync(join(root, 'test/nested/helper.js'), '');
      const files = listTopLevelTestFiles(root);
      assert.deepEqual(files, ['test/a.test.js', 'test/b.test.js', 'test/nested/c.test.js']);
      assert.equal(files.length, 3);
      assert.equal(new Set(files).size, files.length);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('the repository inventory equals all top-level files plus any nested test outside _research', () => {
    const topLevel = readdirSync('test', { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith('.test.js')).length;
    const files = listTopLevelTestFiles();
    const nested = files.filter(f => f.slice('test/'.length).includes('/'));
    // `_research/` is excluded on purpose (see the walker): its files are captured-evidence
    // notebooks, and the one that lives there has stale expectations. Everything else that
    // is nested MUST be discovered — that is the point of the recursive inventory, and the
    // count below is the tripwire for a file quietly landing in a subdirectory again.
    assert.deepEqual(nested.filter(f => !f.includes('/_research/')), [],
      'a nested test file exists outside _research and needs an explicit inventory review');
    assert.equal(files.length, topLevel, 'the inventory must equal the top-level count when _research is skipped');
    assert.equal(new Set(files).size, files.length);
  });
});

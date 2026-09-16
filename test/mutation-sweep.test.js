import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { selectSpecs, runSweep, verifyReport } from '../scripts/mutation-sweep.mjs';

it('sweep rejects empty inputs and proves exact persisted verdict coverage', () => {
  const parent = mkdtempSync(join(tmpdir(), 'wa-sweep-test-'));
  const root = join(parent, 'owner');
  const report = join(parent, 'report');
  try {
    mkdirSync(join(root, 'test/mutations'), { recursive: true });
    mkdirSync(join(root, 'scripts'));
    assert.throws(() => selectSpecs(root), /zero discovered/);
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, `test/mutations/${name}.json`), '{}');
    assert.throws(() => selectSpecs(root, ['zzz.json']), /unknown spec/);
    assert.throws(() => runSweep(['--specs', '   '], root), /selection is empty/);
    assert.throws(() => selectSpecs(root, ['a.json', 'a.json']), /duplicate/);
    assert.throws(() => selectSpecs(root, [], '3/3'), /invalid shard/);
    assert.throws(() => selectSpecs(root, [], '3/4'), /zero selected/);
    assert.deepEqual(selectSpecs(root, [], '0/2').selected, ['test/mutations/a.json', 'test/mutations/c.json']);
    assert.deepEqual(selectSpecs(root, [], '1/2').selected, ['test/mutations/b.json']);
    writeFileSync(join(root, 'scripts/mutate-verify.mjs'), "console.log('VERDICT forged OK exit=0');\n");
    assert.equal(runSweep(['--report-dir', report], root), 0);
    assert.deepEqual(verifyReport(report), { expected: 3, actual: 3, code: 0 });
    const log = readFileSync(join(report, 'verdicts.log'), 'utf8');
    writeFileSync(join(report, 'verdicts.log'), log.split('\n').slice(0, 2).join('\n') + '\n');
    assert.throws(() => verifyReport(report), /coverage mismatch/);
    writeFileSync(join(report, 'verdicts.log'), log.replace('test/mutations/b.json', 'test/mutations/a.json'));
    assert.throws(() => verifyReport(report), /coverage mismatch/);
    writeFileSync(join(report, 'verdicts.log'), log.replace('b.json OK exit=0', 'b.json UNTRUSTWORTHY exit=2'));
    assert.equal(verifyReport(report).code, 2);
    writeFileSync(join(report, 'verdicts.log'), log.replace('b.json OK exit=0', 'b.json FAIL exit=1'));
    assert.equal(verifyReport(report).code, 1);
  } finally { rmSync(parent, { recursive: true, force: true }); }
});

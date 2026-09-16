import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it('the default secret scan includes untracked, non-ignored files and keeps fixture rules', () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-secret-untracked-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'tmp'));
    mkdirSync(join(root, 'test'));
    writeFileSync(join(root, 'scripts/secret-scan.mjs'), readFileSync(new URL('../scripts/secret-scan.mjs', import.meta.url)));
    // The real repository ignores tmp/. This fixture deliberately does not: the contract
    // is untracked AND non-ignored, not "scan all scratch files despite .gitignore".
    writeFileSync(join(root, '.gitignore'), 'ignored.js\n');
    writeFileSync(join(root, 'tracked.js'), '// clean\n');
    git('init', '-q'); git('add', 'tracked.js', '.gitignore');
    const scan = (...args) => spawnSync(process.execPath, ['scripts/secret-scan.mjs', ...args], { cwd: root, env, encoding: 'utf8', timeout: 30000 });
    const key = 'sk-' + 'A9qZ'.repeat(8);
    let result = scan(); assert.equal(result.status, 0, result.stdout + result.stderr);
    writeFileSync(join(root, 'tmp/leak-check.js'), `export const value = '${key}';\n`);
    result = scan(); assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /tmp\/leak-check\.js:1 openai-api-key/);
    assert.ok(!result.stdout.includes(key), 'findings must not echo credentials');
    rmSync(join(root, 'tmp/leak-check.js'));
    assert.equal(scan().status, 0);
    writeFileSync(join(root, 'ignored.js'), key);
    assert.equal(scan().status, 0);
    assert.equal(scan('ignored.js').status, 1, 'explicit paths keep their existing semantics');
    writeFileSync(join(root, 'test/synthetic.js'), 'sk-' + 'fixture' + 'A9qZ'.repeat(8));
    assert.equal(scan().status, 0);
    writeFileSync(join(root, 'test/real-looking.js'), key);
    assert.equal(scan().status, 1, 'test/ is not a blanket allowance');
    rmSync(join(root, 'test/real-looking.js'));
    writeFileSync(join(root, 'tracked.js'), key);
    result = scan(); assert.equal(result.status, 1);
    assert.equal(result.stdout.trim().split('\n').length, 1, 'tracked files must not be scanned twice');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

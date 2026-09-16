import { it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import vm from 'node:vm';

it('the actual docs link guard ignores scratch markdown but rejects broken tracked links', () => {
  const source = readFileSync(new URL('./docs-consistency-guard.test.js', import.meta.url), 'utf8');
  const begin = source.indexOf('function mdFiles() {');
  const end = source.indexOf('\nconst read =', begin);
  const guardBegin = source.indexOf("  it('every relative .md link in every tracked markdown file points at a file that exists'");
  const guardEnd = source.indexOf('\n  });', guardBegin) + '\n  });'.length;
  assert.ok(begin >= 0 && end > begin && guardBegin >= 0 && guardEnd > guardBegin);
  const root = mkdtempSync(join(tmpdir(), 'wa-doc-scope-'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  try {
    writeFileSync(join(root, 'README.md'), '[good](good.md)\n');
    writeFileSync(join(root, 'good.md'), '# Good\n');
    git('init', '-q'); git('add', 'README.md', 'good.md');
    for (const directory of ['tmp', '.claude/worktrees/old']) {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, 'scratch.md'), '[bad](missing.md)\n');
    }
    let check;
    const context = { ROOT: root, assert, execFileSync: (bin, args, opts) => execFileSync(bin, args, { ...opts, env }),
      readdirSync, existsSync, resolve, join, dirname, read: p => readFileSync(p, 'utf8'),
      rel: p => relative(root, p), it: (_name, fn) => { check = fn; },
    };
    vm.runInNewContext(source.slice(begin, end) + '\n' + source.slice(guardBegin, guardEnd), context);
    check();
    rmSync(join(root, 'tmp/scratch.md'));
    writeFileSync(join(root, 'README.md'), '[bad](missing.md)\n');
    assert.throws(check, /broken relative .md links/);
    writeFileSync(join(root, 'README.md'), '[good](good.md)\n');
    check();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// WHY THIS FILE EXISTS. The wire-byte gate compares the current tree against a
// released one, and CI picked that base with `git describe --tags --abbrev=0` —
// "nearest reachable tag", which at a tagged HEAD is HEAD's own tag. A rerun or a
// manual dispatch on a release commit then compared the tree with itself and
// produced evidence that changed with the tag set (2026-09-17 review, F5). The
// original release run 35174656666 did select 014204f / v3.9.35 at 02:30:17Z,
// before v3.9.36's tag existed: that evidence stands, and scripts/wire-base.mjs
// reproduces the same selection now that the tag is visible.
//
// The selection is exercised on REAL synthetic repositories — every case below is
// a git repo built and tagged by the test, not a grep of the workflow — because
// the defect only appears in what git actually answers for a given tag layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { selectBase } from '../scripts/wire-base.mjs';

const SCRIPT = resolve('scripts/wire-base.mjs');
const WORKFLOW = readFileSync('.github/workflows/ci.yml', 'utf8');
const GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = 'the wire-baseline fixtures need a real git on PATH';

function repo(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'wire-base-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.email', 'wire-fixture@example.test');
  git('config', 'user.name', 'wire baseline fixture');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  const commit = (subject) => {
    git('commit', '-q', '--allow-empty', '-m', subject);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, commit };
}

const run = (dir, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

test('a tagged HEAD compares against the previous release, never itself', { skip: GIT ? false : SKIP }, (t) => {
  const { dir, git, commit } = repo(t);
  commit('first');
  const second = commit('second');
  const third = commit('third');
  const head = commit('release commit');
  git('tag', '-a', 'v1.2.0', '-m', 'v1.2.0', second);
  git('tag', '-a', 'v1.3.0', '-m', 'v1.3.0', third);
  git('tag', '-a', 'v1.4.0', '-m', 'v1.4.0', head);

  // The defect, demonstrated on a real repository: describe answers with the tag
  // that IS HEAD, so the old gate compared c638bb8-style release commits with
  // themselves.
  assert.equal(git('describe', '--tags', '--abbrev=0'), 'v1.4.0');

  const selected = selectBase(dir);
  assert.equal(selected.tag, 'v1.3.0');
  assert.equal(selected.sha, third);
  assert.equal(selected.kind, 'annotated');
  assert.notEqual(selected.sha, head, 'the baseline must be a strict ancestor');

  // A rerun on the same tagged HEAD names the same release: the evidence is stable.
  assert.deepEqual(selectBase(dir), selected);

  const cli = run(dir, '--field', 'sha');
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), third);
  assert.equal(run(dir, '--field', 'nope').status, 2, 'an unknown field is a usage error');
});

test('an untagged descendant still compares against the newest release', { skip: GIT ? false : SKIP }, (t) => {
  const { dir, git, commit } = repo(t);
  commit('a');
  const released = commit('released');
  git('tag', '-a', 'v2.0.0', '-m', 'v2.0.0', commit('older'));
  git('tag', '-a', 'v2.1.0', '-m', 'v2.1.0', released);
  const head = commit('work in progress');

  const selected = selectBase(dir);
  assert.equal(selected.tag, 'v2.1.0');
  assert.equal(selected.sha, released);
  assert.notEqual(selected.sha, head);
});

test('unrelated tags are ignored and an annotated release outranks a newer lightweight tag', { skip: GIT ? false : SKIP }, (t) => {
  const { dir, git, commit } = repo(t);
  const base = commit('base');
  const trunk = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('tag', '-a', 'v3.0.0', '-m', 'v3.0.0', base);
  git('tag', 'v3.1.0', commit('lightweight-marked'));          // lightweight, newer, still an ancestor
  git('checkout', '-q', '-b', 'side', base);
  const side = commit('side work');
  git('tag', '-a', 'v9.9.9', '-m', 'v9.9.9', side);            // newest version, unrelated branch
  git('checkout', '-q', trunk);
  const head = commit('trunk head');

  const selected = selectBase(dir);
  assert.equal(selected.tag, 'v3.0.0', 'the annotated release tag wins over a newer lightweight one');
  assert.equal(selected.kind, 'annotated');
  assert.notEqual(selected.sha, head);
  assert.notEqual(selected.sha, side, 'a tag outside HEAD ancestry is not a baseline');
  assert.equal(JSON.stringify(selected).includes('9.9.9'), false);
});

test('lightweight tags are never baselines and an annotated non-ancestor fails closed', { skip: GIT ? false : SKIP }, (t) => {
  const { dir, git, commit } = repo(t);
  const released = commit('released');
  const trunk = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('tag', 'v4.0.0', released);                        // lightweight: not a release identity
  git('checkout', '-q', '-b', 'side', released);
  git('tag', '-a', 'v4.2.0', '-m', 'v4.2.0', commit('side work'));
  git('checkout', '-q', trunk);
  const head = commit('head');

  // A lightweight ancestor and an annotated non-ancestor: neither is a baseline.
  assert.equal(selectBase(dir), null);
  assert.equal(run(dir, '--field', 'tag').status, 3);
  assert.equal(run(dir).stdout.trim(), '');
  assert.match(run(dir).stderr, /no release tag is a strict ancestor of HEAD/);

  // A lightweight tag at HEAD does not become one either.
  git('tag', 'v4.1.0');
  assert.equal(selectBase(dir), null);
  assert.equal(run(dir).status, 3);

  // Annotating the ancestor qualifies it, and the newer annotated tag on the side
  // branch stays out of reach.
  git('tag', '-f', '-a', 'v4.0.0', '-m', 'v4.0.0', released);
  const selected = selectBase(dir);
  assert.equal(selected.tag, 'v4.0.0');
  assert.equal(selected.kind, 'annotated');
  assert.equal(selected.sha, released);
  assert.notEqual(selected.sha, head);
});

test('no usable baseline fails closed instead of comparing against nothing', { skip: GIT ? false : SKIP }, (t) => {
  const { dir, git, commit } = repo(t);
  commit('only commit');
  assert.equal(selectBase(dir), null);
  for (const args of [[], ['--field', 'sha'], ['--field', 'tag']]) {
    const cli = run(dir, ...args);
    assert.equal(cli.status, 3, `expected a fail-closed exit for ${JSON.stringify(args)}`);
    assert.equal(cli.stdout.trim(), '');
    assert.match(cli.stderr, /no release tag is a strict ancestor of HEAD/);
  }

  // A tag at HEAD is not a baseline either.
  git('tag', '-a', 'v5.0.0', '-m', 'v5.0.0');
  assert.equal(selectBase(dir), null);
  assert.equal(run(dir, '--field', 'tag').status, 3);

  // Neither is a tag that is not a release revision.
  const { dir: other, git: otherGit, commit: otherCommit } = repo(t);
  otherCommit('a');
  otherGit('tag', 'nightly');
  otherGit('tag', 'release-2');
  otherGit('tag', 'v5.9');
  otherCommit('b');
  assert.equal(selectBase(other), null);
  assert.equal(run(other).status, 3);
});

test('the wire job selects through the script and refuses a self-comparison', () => {
  const job = WORKFLOW.slice(WORKFLOW.indexOf('\n  wire-identity:\n'));
  const step = job.slice(job.indexOf('Select the release baseline'));
  const runStart = step.indexOf('run: |');
  const runEnd = step.indexOf('\n      - ', runStart);
  const runBlock = step.slice(runStart, runEnd === -1 ? undefined : runEnd);
  assert.notEqual(runStart, -1, 'the baseline step must still exist');
  assert.match(runBlock, /BASE_TAG=\$\(node scripts\/wire-base\.mjs --field tag\)/);
  assert.match(runBlock, /BASE_SHA=\$\(node scripts\/wire-base\.mjs --field sha\)/);
  assert.match(runBlock, /if \[ "\$BASE_SHA" = "\$HEAD_SHA" \]; then/);
  assert.match(runBlock, /refusing to compare \$HEAD_SHA against itself/);
  assert.match(runBlock, /git worktree add --detach "\$RUNNER_TEMP\/wire-base" "\$BASE_SHA"/);
  assert.match(runBlock, /WIRE_BASE_SHA=\$BASE_SHA/, 'the selected SHA must be recorded for the run log');
  assert.match(runBlock, /WIRE_BASE_REQUIRED=1/, 'a missing base must stay fatal in CI');
  assert.equal(runBlock.includes('git describe'), false,
    'describe selects the nearest tag, which at a tagged HEAD is HEAD itself — that was the defect');
});

test('this repository itself selects a released ancestor', { skip: GIT ? false : SKIP }, () => {
  const selected = selectBase(resolve('.'));
  if (!selected) {
    console.log('skip: this checkout has no release tag yet');
    return;
  }
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.notEqual(selected.sha, head);
  assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', selected.sha, head], { encoding: 'utf8' }).status, 0,
    'the selected baseline must be an ancestor of HEAD');
});

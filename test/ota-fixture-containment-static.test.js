// Static containment guards for the real-Git OTA fixtures.
//
// This test intentionally reads the fixture tests as plain text. It must never
// import them: those suites create repositories, run update.sh, spawn a
// dashboard child, and can push tags. Keeping this guard source-only lets the
// mutation spec sabotage the fixture safety rails without executing the
// sabotaged fixture itself.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { isolatedGitEnv, REAL_GIT, SAFE_TMP_ROOT, SKIP_REASON } from './git-fixture-env.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readTest = (name) => readFileSync(join(ROOT, 'test', name), 'utf8');

const RELEASE = readTest('update-script-release-target.test.js');
const DASHBOARD = readTest('self-update-gate.test.js');
const ROLLBACK = readTest('self-update-untracked-safety.test.js');
const GIT_ENV = readTest('git-fixture-env.js');
const HARNESS = readFileSync(join(ROOT, 'scripts', 'mutation-harness-utils.mjs'), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertBefore(source, guard, hazard, label) {
  const guardIndex = source.indexOf(guard);
  const hazardIndex = source.indexOf(hazard);
  assert.notEqual(guardIndex, -1, `${label}: missing guard`);
  assert.notEqual(hazardIndex, -1, `${label}: missing guarded operation`);
  assert.ok(guardIndex < hazardIndex, `${label}: guard must run before the guarded operation`);
}

function assertContainmentPredicate(source, label) {
  assert.ok(source.includes('const rootPath = resolve(fixture.root);'),
    `${label}: containment root must start from the resolved fixture root`);
  assert.ok(source.includes('const root = realpathSync(rootPath);'),
    `${label}: containment root must use its real path`);
  assert.ok(source.includes('const childPath = resolve(fixture[field]);'),
    `${label}: every checked path must start from its resolved fixture path`);
  assert.ok(source.includes('const child = realpathSync(childPath);'),
    `${label}: every checked path must use its real path`);
  assert.ok(source.includes('const rel = relative(root, child);'),
    `${label}: every checked path must be resolved relative to the real fixture root`);
  assert.match(source, /childStat\.isSymbolicLink\(\)/,
    `${label}: symlink fixture children must be rejected before Git use`);
  assert.ok(
    source.includes("assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),"),
    `${label}: containment must reject the root itself, parent escapes, and absolute escapes`,
  );
}

function assertTemporaryOriginSetup(source, executor, prefix, label) {
  assert.ok(source.includes(`const root = mkdtempSync(join(SAFE_TMP_ROOT, '${prefix}'));`),
    `${label}: fixture root must come from mkdtempSync(SAFE_TMP_ROOT)`);
  assert.ok(source.includes("const origin = join(root, 'origin.git');"),
    `${label}: bare origin must be a child of the temporary fixture root`);
  assert.ok(source.includes(`${executor}(root, ['init', '--bare', origin]);`),
    `${label}: bare repository must be initialized through its explicit temporary path`);
  assert.ok(source.includes(`${executor}(root, ['clone', origin, deployment]);`),
    `${label}: deployment must clone the explicit temporary origin`);
}

function assertEveryPushHasExplicitTemporaryTarget(source, executor, minimum, label) {
  const allPushes = [...source.matchAll(new RegExp(`\\b${executor}\\([^\\n]*\\['push',`, 'g'))];
  const explicitPushes = [...source.matchAll(
    new RegExp(`\\b${executor}\\([^\\n]*\\['push', (?:origin|fixture\\.origin),`, 'g'),
  )];
  assert.ok(allPushes.length >= minimum,
    `${label}: expected at least ${minimum} fixture push sites, found ${allPushes.length}`);
  assert.equal(explicitPushes.length, allPushes.length,
    `${label}: every push must name origin or fixture.origin as an explicit path argument`);
  assert.doesNotMatch(
    source,
    /\['push', ['"]origin['"]/,
    `${label}: a symbolic remote named origin can escape to the real checkout when cwd is lost`,
  );
}

describe('OTA real-Git fixtures fail closed before child-process use', () => {
  it('shared fixture environment removes every inherited GIT_* redirect', () => {
    assert.match(GIT_ENV, /export const REAL_GIT = trustedGitCandidate \? realpathSync\(trustedGitCandidate\) : null;/,
      'fixture Git must be selected through a trusted absolute executable path');
    assert.match(GIT_ENV, /export const SAFE_TMP_ROOT = existsSync\('\/tmp'\) \? '\/tmp' : tmpdir\(\);/,
      'fixture temporary state must live below a controlled temporary root');
    assert.match(GIT_ENV, /key\.startsWith\('GIT_'\)/,
      'fixture child environments must inspect the complete GIT_* namespace');
    assert.match(GIT_ENV, /if \(key\.startsWith\('GIT_'\)\) delete env\[key\];/,
      'fixture child environments must delete inherited Git redirect variables');
    for (const key of ['BASH_ENV', 'ENV', 'CDPATH', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND',
      'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH']) {
      assert.match(GIT_ENV, new RegExp(`'${key}'`),
        `fixture child environments must enumerate ${key} as an injection variable`);
      assert.match(GIT_ENV, new RegExp(`delete env\\[key\\];`),
        `fixture child environments must remove inherited ${key} shell state`);
    }
    assert.match(GIT_ENV, /env\.GIT_CONFIG_NOSYSTEM = '1';/,
      'fixture child environments must disable user/system Git configuration');
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
      assert.match(GIT_ENV, new RegExp(`env\\.${key} = '\\/dev\\/null';`),
        `fixture child environments must redirect ${key} to /dev/null`);
    }
    assert.match(GIT_ENV, /env\.GIT_TERMINAL_PROMPT = '0';/,
      'fixture child environments must disable interactive Git prompts');
    for (const key of ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ']) {
      assert.match(GIT_ENV, new RegExp(`\\b${key}:`),
        `fixture child environments must pin ${key}`);
    }
    assert.match(GIT_ENV, /PATH: TRUSTED_TOOL_PATH/,
      'fixture child PATH must contain only trusted system tool directories');
    assert.match(GIT_ENV, /HOME: EMPTY_HOME/,
      'fixture child HOME must not inherit the operator home directory');
    assert.match(GIT_ENV, /XDG_CONFIG_HOME: EMPTY_HOME/,
      'fixture child XDG config must not inherit user Git configuration');
    assert.match(GIT_ENV, /TMPDIR: SAFE_TMP_ROOT/,
      'fixture child temporary files must remain below the controlled root');
  });

  it('fixture Git helpers reject a missing cwd before trusted absolute execFileSync', () => {
    const helper = section(RELEASE, 'function git(cwd, args) {', '\n}\n\nfunction assertSafeFixture');
    assertBefore(
      helper,
      "if (!cwd) throw new Error('git fixture cwd is required');",
      "return execFileSync(REAL_GIT, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();",
      'update.sh fixture Git helper',
    );
    assert.match(helper, /env: isolatedGitEnv\(\)/,
      'update.sh fixture Git helper must scrub inherited Git environment');
    const dashboardHelper = section(DASHBOARD, 'function realGit(cwd, args) {', '\n}\n\nfunction assertSafeDashboardFixture');
    assertBefore(
      dashboardHelper,
      "if (!cwd) throw new Error('dashboard Git fixture cwd is required');",
      "return execFileSync(REAL_GIT, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();",
      'dashboard fixture Git helper',
    );
    assert.match(dashboardHelper, /env: isolatedGitEnv\(\)/,
      'dashboard fixture Git helper must scrub inherited Git environment');
    const rollbackHelper = section(ROLLBACK, 'function git(cwd, args) {', '\n}\n\nfunction fakeRes');
    assertBefore(
      rollbackHelper,
      "if (!cwd) throw new Error('self-update safety fixture cwd is required');",
      "return execFileSync(REAL_GIT, args, { cwd, env: isolatedGitEnv(), encoding: 'utf8' }).trim();",
      'rollback fixture Git helper',
    );
    assert.match(rollbackHelper, /env: isolatedGitEnv\(\)/,
      'rollback fixture Git helper must scrub inherited Git environment');
  });

  it('update.sh fixture contains origin, seed, deployment, and stubBin below its temporary root', () => {
    const guard = section(RELEASE, 'function assertSafeFixture(fixture) {', '\n}\n\nfunction writeExecutable');
    assert.ok(guard.includes("for (const field of ['root', 'origin', 'seed', 'deployment', 'stubBin']) {"),
      'all safety-critical fixture paths must be required and checked for existence');
    assert.ok(guard.includes("for (const field of ['origin', 'seed', 'deployment', 'stubBin']) assertBelowRoot(field);"),
      'every child path must pass the below-root predicate');
    assertContainmentPredicate(guard, 'update.sh fixture');
  });

  it('dashboard fixture contains origin, seed, and deployment below its temporary root', () => {
    const guard = section(DASHBOARD, 'function assertSafeDashboardFixture(fixture) {', '\n}\n\nfunction makeDashboardTagFixture');
    assert.ok(guard.includes("for (const field of ['root', 'origin', 'seed', 'deployment']) {"),
      'all dashboard fixture paths must be required and checked for existence');
    assert.ok(guard.includes("for (const field of ['origin', 'seed', 'deployment']) {"),
      'every dashboard child path must pass the below-root predicate');
    assertContainmentPredicate(guard, 'dashboard fixture');
  });

  it('update.sh fixture verifies that deployment origin resolves to fixture.origin exactly', () => {
    const guard = section(RELEASE, 'function assertSafeFixture(fixture) {', '\n}\n\nfunction writeExecutable');
    assert.ok(guard.includes("const deploymentOrigin = git(fixture.deployment, ['remote', 'get-url', 'origin']);"),
      'deployment origin must be read from the deployment repository');
    assert.ok(guard.includes('realpathSync(resolve(fixture.deployment, deploymentOrigin)),'),
      'deployment origin must be canonicalized before comparison');
    assert.ok(guard.includes('realpathSync(resolve(fixture.origin)),'),
      'fixture origin must be canonicalized before comparison');
  });

  it('dashboard fixture verifies that deployment origin resolves to fixture.origin exactly', () => {
    const guard = section(DASHBOARD, 'function assertSafeDashboardFixture(fixture) {', '\n}\n\nfunction makeDashboardTagFixture');
    assert.ok(guard.includes("const deploymentOrigin = realGit(fixture.deployment, ['remote', 'get-url', 'origin']);"),
      'dashboard deployment origin must be read from the deployment repository');
    assert.ok(guard.includes('realpathSync(resolve(fixture.deployment, deploymentOrigin)),'),
      'dashboard deployment origin must be canonicalized before comparison');
    assert.ok(guard.includes('realpathSync(resolve(fixture.origin)),'),
      'dashboard fixture origin must be canonicalized before comparison');
  });

  it('runUpdate validates the complete fixture before spawning update.sh', () => {
    const runner = section(RELEASE, 'function runUpdate(fixture, extraEnv = {}) {', '\n}\n\ndescribe(');
    assertBefore(runner, 'assertSafeFixture(fixture);', "return spawnSync('bash', ['update.sh'], {", 'runUpdate');
    assert.match(runner, /env: isolatedGitEnv\(\{/,
      'update.sh child must scrub inherited Git environment');
  });

  it('the direct source ./update.sh path validates the fixture before any lock setup or spawn', () => {
    const directSource = section(
      RELEASE,
      "it('treats kill-denied plus a present ps row as a live lock owner'",
      "it('does not delete a replacement lock when cleanup ownership no longer matches'",
    );
    assertBefore(directSource, 'assertSafeFixture(fixture);', 'const lockDir = join(', 'direct source fixture setup');
    assertBefore(
      directSource,
      'assertSafeFixture(fixture);',
      "spawnSync('bash', ['-c', 'kill() { return 1; }; source ./update.sh']",
      'direct source ./update.sh',
    );
  });

  it('dashboard child validates the complete fixture before constructing or spawning it', () => {
    const runner = section(DASHBOARD, 'function runDashboardUpdateCheck(fixture) {', '\n}\n\nfunction postUpdate');
    assertBefore(runner, 'assertSafeDashboardFixture(fixture);', 'const { deployment } = fixture;', 'dashboard fixture setup');
    assertBefore(runner, 'assertSafeDashboardFixture(fixture);', 'spawnSync(process.execPath, [', 'dashboard child spawn');
    assert.match(runner, /env: isolatedGitEnv\(\{/,
      'dashboard child must scrub inherited Git environment');
  });

  it('direct update.sh fixture spawns also scrub inherited Git environment', () => {
    const directSource = section(
      RELEASE,
      "it('fails before fetch or installation when pm2 is unavailable'",
      "it('installs the newest release tag and leaves post-tag commits unpublished'",
    );
    assert.match(directSource, /env: isolatedGitEnv\(\{/,
      'pm2 preflight child must scrub inherited Git environment');

    const liveLockSource = section(
      RELEASE,
      "it('treats kill-denied plus a present ps row as a live lock owner'",
      "it('does not delete a replacement lock when cleanup ownership no longer matches'",
    );
    assert.match(liveLockSource, /env: isolatedGitEnv\(\{/,
      'live-lock child must scrub inherited Git environment');
  });

  it('dashboard state tests relocate rollback metadata and the repository lock before use', () => {
    assert.ok(/const SELF_UPDATE_TEST_ROOT = mkdtempSync\(join\(SAFE_TMP_ROOT, 'wa-self-update-gate-state-'\)\);/.test(DASHBOARD),
      'dashboard self-update tests need an owned temporary state root');
    assertBefore(DASHBOARD, 'process.chdir(SELF_UPDATE_TEST_ROOT);', 'const BEFORE_JSON = join(SELF_UPDATE_TEST_ROOT',
      'dashboard state root');
    assert.ok(!/const BEFORE_JSON = join\(process\.cwd\(\),/.test(DASHBOARD),
      'dashboard tests must not bind cleanup paths to the real workspace');
  });

  it('in-process rollback fixture clears inherited Git environment around production calls', () => {
    assert.equal((ROLLBACK.match(/isolateProcessGitEnv\(\)/g) || []).length, 2,
      'each in-process rollback fixture must clear inherited Git environment');
    assert.equal((ROLLBACK.match(/restoreGitEnv\(\);/g) || []).length, 2,
      'each in-process rollback fixture must restore the caller environment');
  });

  it('update.sh fixture creates and uses only an explicit temporary bare origin', () => {
    const builder = section(RELEASE, 'function makeFixture({', 'function runUpdate');
    assertTemporaryOriginSetup(builder, 'git', 'wa-update-release-', 'update.sh fixture');
    assertEveryPushHasExplicitTemporaryTarget(RELEASE, 'git', 4, 'update.sh fixture');
  });

  it('dashboard fixture creates and uses only an explicit temporary bare origin', () => {
    const builder = section(DASHBOARD, 'function makeDashboardTagFixture() {', 'function runDashboardUpdateCheck');
    assertTemporaryOriginSetup(builder, 'realGit', 'wa-dashboard-release-tags-', 'dashboard fixture');
    assertEveryPushHasExplicitTemporaryTarget(DASHBOARD, 'realGit', 3, 'dashboard fixture');
  });

  it('all fixture Git helpers use the shared isolated environment and never a PATH-selected git', () => {
    for (const [source, helperStart, helperEnd, label] of [
      [RELEASE, 'function git(cwd, args) {', '\n}\n\nfunction assertSafeFixture', 'update.sh'],
      [DASHBOARD, 'function realGit(cwd, args) {', '\n}\n\nfunction assertSafeDashboardFixture', 'dashboard'],
      [ROLLBACK, 'function git(cwd, args) {', '\n}\n\nfunction fakeRes', 'rollback'],
    ]) {
      const helper = section(source, helperStart, helperEnd);
      assert.doesNotMatch(helper, /execFileSync\(['"]git['"]/, `${label}: must not resolve git through PATH`);
      assert.match(helper, /execFileSync\(REAL_GIT, args, \{ cwd, env: isolatedGitEnv\(\)/,
        `${label}: helper must pass the isolated fixture environment`);
    }
  });

  it('in-process rollback tests isolate and restore the complete process Git/shell environment', () => {
    assert.ok(/const restoreGitEnv = isolateProcessGitEnv\(\);/.test(ROLLBACK),
      'rollback tests must isolate process-level Git environment before production calls');
    assert.equal((ROLLBACK.match(/restoreGitEnv\(\);/g) || []).length, 2,
      'each rollback test must restore process-level Git environment');
  });

  it('in-process fixture isolation also removes credentials, proxies, auth flags, and real data paths', () => {
    for (const key of [
      'API_KEY', 'DASHBOARD_PASSWORD', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY',
      'CODEIUM_AUTH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'HTTP_PROXY',
      'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'DATA_DIR',
      'WINDSURFAPI_ALLOW_UNAUTHENTICATED', 'DASHBOARD_ALLOW_NO_AUTH',
    ]) {
      assert.match(GIT_ENV, new RegExp(`'${key}'`), `process fixture isolation must enumerate ${key}`);
    }
    assert.match(GIT_ENV, /&& !FIXTURE_SENSITIVE_ENV\.includes\(key\)/,
      'isolation must remove each sensitive key before production runs');
    assert.match(GIT_ENV, /\|\| FIXTURE_SENSITIVE_ENV\.includes\(key\)/,
      'restore cleanup must clear fixture values before reinstating the caller environment');
    assert.match(GIT_ENV, /process\.env\.WINDSURFAPI_SKIP_DOTENV = '1';/);
  });

  it('runtime fixture environments ignore poisoned system and global Git config', { skip: REAL_GIT ? false : SKIP_REASON }, () => {
    const root = mkdtempSync(join(SAFE_TMP_ROOT || tmpdir(), 'wa-fixture-env-sentinel-'));
    try {
      const home = join(root, 'home');
      const repo = join(root, 'repo');
      const system = join(root, 'system.gitconfig');
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, '.gitconfig'), '[fixture]\npoisoned = global\n');
      writeFileSync(system, '[fixture]\npoisoned = system\n');

      const safe = isolatedGitEnv();
      execFileSync(REAL_GIT, ['init', '--quiet', repo], { cwd: root, env: safe });

      const readPoison = (env) => {
        try {
          return execFileSync(REAL_GIT, ['-C', repo, 'config', '--get', 'fixture.poisoned'], {
            cwd: root,
            env,
            encoding: 'utf8',
          }).trim();
        } catch {
          return '';
        }
      };

      const systemProbe = isolatedGitEnv();
      systemProbe.GIT_CONFIG_SYSTEM = system;
      systemProbe.HOME = home;
      systemProbe.XDG_CONFIG_HOME = home;
      assert.equal(readPoison(systemProbe), '',
        'GIT_CONFIG_NOSYSTEM=1 must suppress a hostile system config even when its path is supplied');

      const globalProbe = isolatedGitEnv();
      globalProbe.HOME = home;
      globalProbe.XDG_CONFIG_HOME = home;
      assert.equal(readPoison(globalProbe), '',
        'GIT_CONFIG_GLOBAL=/dev/null must suppress a hostile user config');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('mutation harness stale-lock recovery claims before quarantining', () => {
    assert.match(HARNESS,
      /writeFileSync\(claimPath, `\$\{process\.pid\}\\n`, \{ encoding: 'utf8', flag: 'wx', mode: 0o600 \}\);/,
      'stale mutation-lock recovery must use an exclusive claim file');
    assert.match(HARNESS, /renameSync\(lockDir, quarantine\);/,
      'stale mutation-lock recovery must quarantine the claimed directory atomically');
  });
});

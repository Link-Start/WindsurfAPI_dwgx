import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname } from 'node:path';

const TRUSTED_GIT_CANDIDATES = [
  '/usr/bin/git',
  '/usr/local/bin/git',
  '/opt/homebrew/bin/git',
  '/run/current-system/sw/bin/git',
  '/nix/var/nix/profiles/default/bin/git',
];

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const trustedGitCandidate = TRUSTED_GIT_CANDIDATES.find(executable);
export const REAL_GIT = trustedGitCandidate ? realpathSync(trustedGitCandidate) : null;
export const SKIP_REASON = 'real-Git fixtures require git at a trusted absolute POSIX system path';
export const SAFE_TMP_ROOT = existsSync('/tmp') ? '/tmp' : tmpdir();
const TRUSTED_TOOL_DIRS = [...new Set([
  REAL_GIT ? dirname(REAL_GIT) : null,
  dirname(process.execPath),
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].filter(path => path && existsSync(path)))];
const TRUSTED_TOOL_PATH = TRUSTED_TOOL_DIRS.join(delimiter);
const EMPTY_HOME = '/nonexistent/windsurfapi-fixture-home';
const SHELL_INJECTION_ENV = [
  'BASH_ENV', 'ENV', 'CDPATH', 'SHELLOPTS', 'BASHOPTS', 'PROMPT_COMMAND',
  'NODE_OPTIONS', 'NODE_PATH', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
];
const FIXTURE_SENSITIVE_ENV = [
  'API_KEY', 'DASHBOARD_PASSWORD', 'DEVIN_CONNECT_TOKEN', 'WINDSURF_API_KEY',
  'CODEIUM_AUTH_TOKEN', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'HTTP_PROXY',
  'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'DATA_DIR', 'WINDSURFAPI_ALLOW_UNAUTHENTICATED',
  'DASHBOARD_ALLOW_NO_AUTH', 'WINDSURFAPI_SKIP_DOTENV', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'TZ', 'NO_COLOR',
];

export function trustedFixturePath(...prefixes) {
  return [...prefixes.filter(Boolean), ...TRUSTED_TOOL_DIRS].join(delimiter);
}

/**
 * Return a minimal child-process environment that cannot redirect Git away
 * from the fixture's explicit cwd. Starting from an allowlist also prevents
 * product behaviour flags, credential variables, Node preload flags, and shell
 * startup hooks from changing what a supposedly deterministic fixture runs.
 */
export function isolatedGitEnv(overrides = {}) {
  const env = {
    PATH: TRUSTED_TOOL_PATH,
    HOME: EMPTY_HOME,
    XDG_CONFIG_HOME: EMPTY_HOME,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    TMPDIR: SAFE_TMP_ROOT,
    ...overrides,
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  for (const key of SHELL_INJECTION_ENV) delete env[key];
  env.HOME = EMPTY_HOME;
  env.XDG_CONFIG_HOME = EMPTY_HOME;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

/**
 * Temporarily remove every GIT_* variable from this Node process. Use this for
 * fixtures that exercise production code in-process, where the production
 * execFile call correctly inherits process.env and cannot receive a test-only
 * child environment directly.
 */
export function isolateProcessGitEnv() {
  const saved = new Map();
  for (const key of Object.keys(process.env)) {
    if (!key.startsWith('GIT_')
        && !SHELL_INJECTION_ENV.includes(key)
        && !FIXTURE_SENSITIVE_ENV.includes(key)
        && !['PATH', 'HOME', 'XDG_CONFIG_HOME'].includes(key)) continue;
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.PATH = TRUSTED_TOOL_PATH;
  process.env.HOME = EMPTY_HOME;
  process.env.XDG_CONFIG_HOME = EMPTY_HOME;
  process.env.TMPDIR = SAFE_TMP_ROOT;
  process.env.TMP = SAFE_TMP_ROOT;
  process.env.TEMP = SAFE_TMP_ROOT;
  process.env.LANG = 'C';
  process.env.LC_ALL = 'C';
  process.env.TZ = 'UTC';
  process.env.NO_COLOR = '1';
  process.env.WINDSURFAPI_SKIP_DOTENV = '1';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  process.env.GIT_TERMINAL_PROMPT = '0';

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GIT_')
      || SHELL_INJECTION_ENV.includes(key)
      || FIXTURE_SENSITIVE_ENV.includes(key)
      || ['PATH', 'HOME', 'XDG_CONFIG_HOME'].includes(key)) delete process.env[key];
    }
    for (const [key, value] of saved) process.env[key] = value;
  };
}

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// src/config.js resolves .env as `resolve(EXE_DIR, '.env')`, and when `process.pkg`
// is truthy EXE_DIR becomes `dirname(process.execPath)`. So a child that sets
// `process.pkg` and pins execPath at a temp dir reads OUR fixture and never touches
// the repo's own .env (which does not exist; .gitignore excludes it).
//
// SCOPE NOTE, because it changed the verdict here. The audit first filed this as
// "the parser truncates an API key". It does — but so does every standard dotenv
// parser: a whitespace-preceded `#` starts a comment. `API_KEY=sk-live # note` is
// ambiguous by construction and NO parser can tell a note from a value. So this is
// not a parsing bug and the value is not recoverable. The defect is that it happened
// SILENTLY: the dashboard password kept working, the chat API answered 401, and
// nothing named the file just edited. The fix is a loud warning + a documented
// quoting rule — asserted below.

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseWith(fixtureLines) {
  const dir = mkdtempSync(join(tmpdir(), 'wa-dotenv-'));
  const fakeExe = join(dir, process.platform === 'win32' ? 'windsurfapi.exe' : 'windsurfapi');
  writeFileSync(fakeExe, '');
  writeFileSync(join(dir, '.env'), fixtureLines.join('\n') + '\n', 'utf8');
  const script = `
    process.pkg = {};
    Object.defineProperty(process, 'execPath', { value: ${JSON.stringify(fakeExe)}, configurable: true });
    await import('file://${REPO.replace(/\\/g, '/')}/src/config.js');
    process.stdout.write(JSON.stringify({
      API_KEY: process.env.API_KEY ?? null,
      PORT: process.env.PORT ?? null,
      _env: ${JSON.stringify(join(dir, '.env'))},
    }));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, WINDSURFAPI_SKIP_DOTENV: '0' },
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr || r.stdout}`);
  const parsed = JSON.parse(r.stdout);
  if (!existsSync(parsed._env)) throw new Error('fixture .env vanished');
  return { ...parsed, stderr: r.stderr || '' };
}

describe('.env parsing: the truncation is standard, the silence was the defect', () => {
  it('strips a whitespace-preceded comment (standard dotenv) AND warns about it', () => {
    const got = parseWith(['API_KEY=sk-live-abc123 # rotated 2026-09-01']);
    assert.equal(got.API_KEY, 'sk-live-abc123', 'standard dotenv semantics — kept as-is');
    assert.match(got.stderr, /inline comment stripped/, 'the operator must be told');
    assert.match(got.stderr, /API_KEY/, 'and told which key');
    assert.match(got.stderr, /quote it/, 'and told how to fix it');
  });

  it('quoted values keep the hash and produce no warning', () => {
    const got = parseWith(['API_KEY="sk-live # kept"']);
    assert.equal(got.API_KEY, 'sk-live # kept');
    assert.doesNotMatch(got.stderr, /inline comment stripped/);
  });

  it('a hash with no leading space is not a comment', () => {
    const got = parseWith(['API_KEY=sk-live-abc#def']);
    assert.equal(got.API_KEY, 'sk-live-abc#def');
    assert.doesNotMatch(got.stderr, /inline comment stripped/);
  });

  it('the documented plain case stays silent (PORT=3003 # port)', () => {
    const got = parseWith(['PORT=3003 # port']);
    assert.equal(got.PORT, '3003');
    assert.doesNotMatch(got.stderr, /inline comment stripped/, 'a short numeric note is not worth a warning');
  });
});

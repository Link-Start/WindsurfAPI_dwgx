#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);

const RULES = [
  {
    id: 'openai-api-key',
    regex: /sk-[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'literal-credential-assignment',
    regex: /\b(?:secret|token|password)\b\s*[:=]\s*["'][A-Za-z0-9_./+=-]{16,}["']/gi,
  },
  {
    id: 'private-key-block',
    regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    id: 'credentialed-email-example',
    regex: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}["']?\s*,\s*["']?password["']?\s*:/gi,
  },
  // ── Rules below added after audit round 13 measured what the four above MISS ──
  //
  // The gap they closed: `literal-credential-assignment` requires the secret to be a
  // quoted run of [A-Za-z0-9_./+=-]. That class has no `$`. This repo's OWN native
  // session-token format is `devin-session-token$<JWT>` — so a bare JWT was caught while
  // the exact string the code actually passes around was NOT. Verified before the fix:
  // a file containing `token: "devin-session-token$eyJ...".` scanned clean, exit 0.
  //
  // These match credential STRUCTURE, not field name. Field-name matching was tried and
  // rejected: `\b(idToken|apiKey|sessionToken|...)\b\s*[:=]\s*"..."` flagged 12 files of
  // legitimate synthetic fixtures. Same trap as the switch-registry regex that reported
  // DASHBOARD_PASSWORD as a switch — loosening until it matches is not the answer.
  {
    // A JWT is three base64url segments and the first two decode to `{"`. No synthetic
    // fixture in this tree has that shape (measured: 0 hits across 696 tracked files),
    // so this needs no allow-list. Covers devin-session-token$<JWT>, Firebase idToken,
    // and any bearer/access token, wherever it appears and whatever the field is called.
    id: 'jwt-literal',
    regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    // Session token whose payload is opaque rather than a JWT. Requires mixed case AND a
    // digit so that readable placeholders (`devin-session-token$definitely-not-in-pool`,
    // already in test/sticky-queue-on-pin.test.js) stay legal while real high-entropy
    // values do not.
    id: 'session-token-literal',
    regex: /devin-session-token\$(?=[^"'\s]*[0-9])(?=[^"'\s]*[a-z])(?=[^"'\s]*[A-Z])[A-Za-z0-9._~+/-]{20,}/g,
  },
  {
    // Firebase refresh token. Fixed vendor prefix, so no entropy heuristic needed.
    id: 'firebase-refresh-token',
    regex: /\bAMf-[A-Za-z0-9_-]{20,}/g,
  },
  {
    // The bulk-import account format (`email----password`). The existing
    // `credentialed-email-example` rule only sees the JSON `{email, password:}` spelling.
    id: 'account-credential-pair',
    regex: /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}----\S{8,}/g,
  },
];

const IGNORED_PATHS = new Set([
  'scripts/secret-scan.mjs',
  'test/secret-scan.test.js',
]);

// `test/` was skipped wholesale until 2026-08. Audit round 12 measured the cost:
// of ~2333 added lines in a typical round, ~1100 were never scanned — and a real key
// pasted into a fixture is exactly as leaked as one in src/. So test/ IS scanned now.
//
// What made the blanket skip tempting is that fixtures legitimately contain key-SHAPED
// strings (8 in the tree when this changed, all of the `sk-ws-01-fixturekey…` /
// `sk-1234567890…` form). Those are allow-listed below by SHAPE, not by path: a fixture
// must look obviously synthetic to pass. A random-looking 20-char secret in a test file
// still fails the scan, which is the point.
const IGNORED_PREFIXES = [
  'test/_research/',
];

// A match is a fixture only if the SECRET ITSELF advertises that it is fake. Keep this
// list tight: every entry is a hole, so it must be a shape no real credential has.
const FIXTURE_MARKERS = [
  'fixture',        // sk-ws-01-fixturekey1234567890abcdef
  'example',
  'placeholder',
  'dummy',
  'redacted',
  'fake',
  'not-real',       // throwaway-not-real
  'not-a-real',
  'not-a-valid',    // definitely-not-a-valid-token
  'invalid',
  'throwaway',
  'test-only',
];

// Sequential digits/letters — no issued credential looks like this.
const FIXTURE_SEQUENCES = [
  '1234567890',
  '0987654321',
  'abcdefghijklmnop',
];

function isSyntheticFixture(repoPath, matchText) {
  if (!repoPath.startsWith('test/')) return false;
  const lower = String(matchText).toLowerCase();
  if (FIXTURE_MARKERS.some((m) => lower.includes(m))) return true;
  return FIXTURE_SEQUENCES.some((s) => lower.includes(s));
}

const IGNORED_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.db',
]);

function toRepoPath(file) {
  return relative(root, resolve(root, file)).split(sep).join('/');
}

function isIgnored(file) {
  const repoPath = toRepoPath(file);
  if (!repoPath || repoPath.startsWith('..') || repoPath.includes('\0')) return true;
  if (IGNORED_PATHS.has(repoPath)) return true;
  if (IGNORED_PREFIXES.some(prefix => repoPath.startsWith(prefix))) return true;
  const lower = repoPath.toLowerCase();
  return [...IGNORED_EXTENSIONS].some(ext => lower.endsWith(ext));
}

function trackedFiles() {
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return [...new Set(output.split('\0').filter(Boolean))];
}

// An explicit path means "scan this", and a directory means "scan what is inside it".
// Before this, a directory argument was silently dropped by scanFile's regular-file
// check, so `secret-scan logs` scanned zero files and exited 0 — a guard that read as
// "checked, clean". The runtime paths that hold raw credentials (.wire-dump/, .trace/,
// logs/) are gitignored, so the default input set can never reach them; naming the
// directory is the only way an operator can ask.
function expandInput(entry) {
  const abs = resolve(root, entry);
  if (!existsSync(abs)) {
    console.error(`secret-scan: ${entry} does not exist — refusing to report a path that was never read as clean`);
    process.exit(2);
  }
  // The scanner's subject is this repository. A path outside it (including one on
  // another Windows drive, where path.relative returns an absolute path instead of
  // '..') would be dropped by isIgnored() and reported as a clean scan.
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    console.error(`secret-scan: ${entry} is outside ${root} — refusing to report a path that was never read as clean`);
    process.exit(2);
  }
  if (!statSync(abs).isDirectory()) return [entry];
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      console.error(`secret-scan: cannot read ${toRepoPath(dir)} (${e?.code || e?.message}) — a partial scan is not a clean scan`);
      process.exit(2);
    }
    for (const dirent of entries) {
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else if (dirent.isFile()) files.push(toRepoPath(full));
    }
  };
  walk(abs);
  return files;
}

function inputFiles() {
  if (args.length) return args.flatMap(expandInput);
  return trackedFiles();
}

function lineForOffset(text, offset) {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function scanFile(file) {
  if (isIgnored(file)) return [];
  const abs = resolve(root, file);
  if (!existsSync(abs) || !statSync(abs).isFile()) return [];
  const text = readFileSync(abs, 'utf8');
  const findings = [];
  const repoPath = toRepoPath(file);
  for (const rule of RULES) {
    rule.regex.lastIndex = 0;
    for (const match of text.matchAll(rule.regex)) {
      // Fixtures under test/ are exempt only when the matched text itself looks
      // synthetic. A real-looking secret in a test file is still a finding.
      if (isSyntheticFixture(repoPath, match[0])) continue;
      findings.push({
        path: repoPath,
        line: lineForOffset(text, match.index || 0),
        rule: rule.id,
      });
    }
  }
  return findings;
}

const findings = inputFiles().flatMap(scanFile)
  .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.rule.localeCompare(b.rule));

for (const finding of findings) {
  console.log(`${finding.path}:${finding.line} ${finding.rule}`);
}

if (findings.length) process.exitCode = 1;

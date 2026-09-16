import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const quietLog = { info() {}, warn() {}, error() {}, debug() {} };
const readSource = path => readFileSync(new URL(path, ROOT), 'utf8').replace(/\r\n/g, '\n');

function functionText(source, name, optional = false) {
  const start = new RegExp('^(?:export )?(?:async )?function ' + name + '\\(', 'm').exec(source);
  if (!start) {
    if (optional) return '';
    throw new Error('Missing function: ' + name);
  }
  const tail = source.slice(start.index);
  const end = /^\}/m.exec(tail);
  if (!end) throw new Error('Missing function end: ' + name);
  return tail.slice(0, end.index + 1).replace(/^export /, '') + '\n';
}

function withoutModuleSyntax(source) {
  return source
    .replace(/^import\s[\s\S]*?;\n/gm, '')
    .replace(/^export\s*\{[\s\S]*?;\n/gm, '')
    .replace(/^export (?=(?:async )?function|class|const|let)/gm, '');
}

function evaluate(source, names, globals = {}) {
  return runInNewContext(
    withoutModuleSyntax(source) + '\n;({ ' + names.join(', ') + ' });',
    { Buffer, console, process: { env: {} }, log: quietLog, ...globals },
    { timeout: 10000 },
  );
}
const plain = value => JSON.parse(JSON.stringify(value));

const ENV_014204F = "export function extractCallerEnvironment(messages) {\n  if (!Array.isArray(messages)) return '';\n  const seen = new Set();\n  const out = [];\n\n  // Match the cwd phrasing every Anthropic-format client we have seen in\n  // the wild emits, while staying narrow enough that prose mentions like\n  // \"the working directory in the docs\" don't trip it. Two formats matter:\n  //\n  //   (a) Canonical `<env>` key/value block (older Claude Code, opencode,\n  //       Cline): `Working directory: /path` on its own line. Must allow\n  //       a leading `<env>` tag, optional `-`/`*` bullet prefix, and `:`\n  //       or `=` separator.\n  //\n  //   (b) Claude Code 2.1+ prose system prompt: `…and the current working\n  //       directory is /path.`  No newline anchor, no separator, the path\n  //       just trails the phrase. (Confirmed via the env-NOT-lifted probe\n  //       diagnostic against Claude Code v2.1.114.)\n  //\n  // The capture group is locked to `[/~]…` so we only grab actual-looking\n  // paths — \"the working directory you choose\" or similar abstract prose\n  // never has a `/` or `~` in the captured slot and is rejected.\n  const PATH_TAIL = `(?:[\\\\/~]|[A-Za-z]:\\\\\\\\)[^\\\\s\\`'\"<>\\\\n.,;)]+`;\n  // Adjective slot for \"Working directory\" — Claude Code 2.x uses\n  // \"Primary working directory: D:\\...\" instead of the canonical\n  // \"Working directory: ...\". Other clients use \"Current\" / \"Initial\" /\n  // \"Default\" / \"Active\" / \"Project\" similarly. Optional, matched\n  // case-insensitively. (#106 / #107 follow-up: the user's 26 KB Claude\n  // Code system prompt mentions \"current working directory\" mid-prose\n  // first, then later has the actual `- Primary working directory: D:\\...`\n  // bullet — old regex only allowed the canonical key so the bullet\n  // never matched and env never lifted.)\n  const ADJ = `(?:Primary|Current|Initial|Default|Active|Project|My)\\\\s+`;\n  const PATTERNS = [\n    ['cwd', new RegExp(\n      // Form (a): line-anchored key/value, optional adjective prefix\n      `(?:^|\\\\n)\\\\s*(?:[-*]\\\\s+)?(?:${ADJ})?(?:Working\\\\s+directory|cwd)\\\\s*[:=]\\\\s*\\`?(${PATH_TAIL})\\`?` +\n      // Form (b): prose \"current working directory is /path\" (adjacent path)\n      `|(?:current\\\\s+working\\\\s+directory(?:\\\\s+is)?)\\\\s*[:=]?\\\\s*\\`?(${PATH_TAIL})\\`?` +\n      // Form (c): Codex / XML-style <cwd>/path/</cwd> tags (no :/= separator)\n      `|<cwd>\\\\s*(${PATH_TAIL})\\\\s*</cwd>`,\n      'gi'\n    ), (v) => `- Working directory: ${v}`],\n    // Git repo: accept \"Is directory a git repo\" (Claude Code <2.x) AND\n    // \"Is a git repository\" / \"Is git repo\" (Claude Code 2.x).\n    ['git', /(?:^|\\n)\\s*(?:[-*]\\s+)?Is(?:\\s+(?:directory\\s+)?(?:a\\s+)?)git\\s+repo(?:sitory)?\\s*[:=]\\s*([^\\n<]+)/i, (v) => `- Is the directory a git repo: ${v}`],\n    ['platform', /(?:^|\\n)\\s*(?:[-*]\\s+)?Platform\\s*[:=]\\s*([^\\n<]+)/i, (v) => `- Platform: ${v}`],\n    ['os', /(?:^|\\n)\\s*(?:[-*]\\s+)?OS\\s+[Vv]ersion\\s*[:=]\\s*([^\\n<]+)/i, (v) => `- OS version: ${v}`],\n  ];\n\n  for (const m of messages) {\n    if (!m) continue;\n    let content;\n    if (typeof m.content === 'string') content = m.content;\n    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\\n');\n    else continue;\n    if (!content) continue;\n\n    for (const [key, re, fmt] of PATTERNS) {\n      if (seen.has(key)) continue;\n      // For the cwd pattern (global flag), iterate matches and pick the\n      // first one that actually has a non-empty captured path. The earlier\n      // matches in a long system prompt may be prose mentions like\n      // \"...and the current working directory.\" with no adjacent path\n      // because the path lives in a later bullet — we must not stop at\n      // the first textual hit.\n      if (re.global) {\n        for (const match of content.matchAll(re)) {\n          const value = (match.slice(1).find(Boolean) || '').trim();\n          if (!value || /[\\x00-\\x1f]/.test(value) || value === '<workspace>') continue;\n          seen.add(key);\n          out.push(fmt(value));\n          break;\n        }\n      } else {\n        const match = content.match(re);\n        if (!match) continue;\n        const value = (match[1] || match[2] || '').trim();\n        if (!value || /[\\x00-\\x1f]/.test(value) || value === '<workspace>') continue;\n        seen.add(key);\n        out.push(fmt(value));\n      }\n    }\n    if (seen.size === PATTERNS.length) break;\n  }\n\n  // Only emit an environment block if we actually have the cwd. Platform /\n  // OS / git status without cwd are useless for the original goal (tell\n  // the model where to run tools) AND adding them anyway makes the\n  // tool_calling_section preamble look like a system prompt with no\n  // real signal — which trips Opus 4.7's injection guard, observed live\n  // when Claude Code v2.1.114 (which does NOT include cwd in its system\n  // prompt) caused us to emit an env block containing only Platform +\n  // OS Version, and Opus refused with \"the message I received is a\n  // system prompt for Claude Code along with truncated tool output\".\n  // Sticking to the rule \"no cwd → no block\" both removes the noise and\n  // lets the model learn cwd via its own `pwd` tool call (which already\n  // works on every Anthropic-format client we have tested).\n  if (!seen.has('cwd')) {\n    // #100 (yunduobaba) fallback — when the canonical extractors miss\n    // the cwd (some Claude Code forks / OpenCode variants don't emit\n    // a `<env>` block at all), scan the head of the first real user\n    // message for a bare absolute path. The user's prompt\n    //   \"C:\\Users\\renfei\\Downloads\\WindsurfAPI-master 分析下这个项目\"\n    // makes their intended workspace obvious — without this, cascade's\n    // built-in /tmp/windsurf-workspace prior wins and the model invents\n    // a JSON apology about Linux not being able to read Windows paths.\n    const cwd = scanUserMessageForBareCwd(messages);\n    if (cwd) return `- Working directory: ${cwd}`;\n\n    // #107 (zhangzhang-bit) fallback — the system prompt was 26 KB and\n    // referenced \"current working directory\" mid-prose with no adjacent\n    // path. The actual path was buried somewhere else as a bullet. The\n    // canonical regex now allows adjective prefixes (\"Primary working\n    // directory\") which covers the common Claude Code 2.x case, but\n    // some custom clients put the cwd on its own bullet with no key at\n    // all (just `- D:\\Project\\foo`). Scan all system messages for a\n    // standalone bullet/list line whose value is a single absolute path.\n    const bulletCwd = scanForBulletCwdInSystem(messages);\n    if (bulletCwd) return `- Working directory: ${bulletCwd}`;\n    return '';\n  }\n  return out.join('\\n');\n}\nfunction scanForBulletCwdInSystem(messages) {\n  if (!Array.isArray(messages)) return '';\n  const FILE_EXT = /\\.(?:js|mjs|cjs|ts|tsx|jsx|json|jsonc|md|mdx|py|pyc|go|rs|java|kt|swift|cpp|cc|cxx|c|h|hpp|html?|css|scss|sass|less|yaml|yml|toml|ini|cfg|conf|sh|bash|zsh|fish|ps1|bat|cmd|exe|dll|so|dylib|zip|tar|gz|bz2|xz|7z|rar|png|jpe?g|gif|webp|svg|ico|mp[34]|wav|flac|ogg|webm|mov|avi|mkv|pdf|docx?|xlsx?|pptx?|csv|tsv|sql|db|sqlite|log|lock|map|min\\.js|min\\.css)$/i;\n  const BULLET = /^[\\s]*[-*•]\\s+`?((?:[A-Za-z]:[\\\\/]|\\/[A-Za-z]|~[\\\\/])[^\\s`'\"<>\\n]+)`?\\s*$/m;\n  for (const m of messages) {\n    if (m?.role !== 'system') continue;\n    let content;\n    if (typeof m.content === 'string') content = m.content;\n    else if (Array.isArray(m.content)) content = m.content.filter(p => p?.type === 'text').map(p => p.text || '').join('\\n');\n    else continue;\n    if (!content) continue;\n    // matchAll requires the regex to be global; build a fresh global copy.\n    const re = new RegExp(BULLET.source, 'gm');\n    for (const match of content.matchAll(re)) {\n      const cand = match[1];\n      if (!cand || cand.length < 5) continue;\n      if (FILE_EXT.test(cand)) continue;\n      if (cand === '<workspace>') continue;\n      return cand;\n    }\n  }\n  return '';\n}\n";

function environmentHarness({ baseline = false } = {}) {
  const source = readSource('src/handlers/chat.js');
  let calls = 0;
  // Return native RegExp objects, not subclasses. matchAll's internal species
  // clone must not be counted as an explicit application constructor call.
  function CountingRegExp(...args) { calls++; return new RegExp(...args); }
  let constants = '';
  const begin = source.indexOf('const CALLER_ENV_PATH_TAIL = ');
  if (!baseline && begin !== -1) {
    const end = source.indexOf('export function extractCallerEnvironment', begin);
    assert(end > begin, 'Missing end of hoisted environment constants');
    constants = source.slice(begin, end);
  }
  const currentFunctions = ['extractCallerEnvironment', 'scanForBulletCwdInSystem']
    .map(name => functionText(source, name)).join('\n');
  const api = evaluate(constants + (baseline ? ENV_014204F : currentFunctions)
    + functionText(source, 'scanUserMessageForBareCwd'),
    ['extractCallerEnvironment', 'scanForBulletCwdInSystem'],
    { RegExp: CountingRegExp });
  calls = 0;
  return { ...api, calls: () => calls, reset: () => { calls = 0; } };
}

test('multiline, no-match, partial-match and repeated-call outputs match 014204f', () => {
  const old = environmentHarness({ baseline: true });
  const next = environmentHarness();
  const fixtures = [
    [],
    [{ role: 'system', content: 'No directory is supplied here.' }],
    [{ role: 'system', content: 'The current working directory.\nPlatform: linux\nOS version: example' }],
    [{ role: 'system', content: 'The current working directory.\n- Primary working directory: /home/dev/project\nPlatform: linux\nIs a git repository: true\nOS Version: sample' }],
    [{ role: 'system', content: 'Working directory: /home/first\nWorking directory: /home/second' }],
    [{ role: 'system', content: 'Working directory: <workspace>\n<cwd>/home/dev/project</cwd>' }],
    [{ role: 'system', content: '* /home/dev/file.js\n- /home/dev/project\n' }],
    [{ role: 'system', content: 'nothing' }, { role: 'system', content: '- D:\\Project\\example\n' }],
    [{ role: 'user', content: '- /home/not-a-system-bullet' }],
    [{ role: 'user', content: '/home/dev/project analyze it' }],
    [{ role: 'system', content: [{ type: 'text', text: '- /home/dev/project' }, { type: 'image' }] }],
    null, 'not-an-array',
  ];
  for (let repeat = 0; repeat < 5; repeat++) {
    for (const messages of fixtures) {
      assert.equal(next.extractCallerEnvironment(messages), old.extractCallerEnvironment(messages));
      assert.equal(next.scanForBulletCwdInSystem(messages), old.scanForBulletCwdInSystem(messages));
    }
  }
});

test('application RegExp constructors are absent from both request-time scans', () => {
  const next = environmentHarness();
  for (let i = 0; i < 10; i++) {
    assert.equal(next.extractCallerEnvironment([
      { role: 'system', content: 'The current working directory.\n' },
      { role: 'system', content: '- /home/dev/project\n' },
    ]), '- Working directory: /home/dev/project');
  }
  assert.equal(next.calls(), 0, 'hoisted constants must not be rebuilt by either path');
});

test('global source expressions reset the starting cursor before matchAll', () => {
  const source = readSource('src/handlers/chat.js');
  const begin = source.indexOf('const CALLER_ENV_PATH_TAIL = ');
  assert(begin >= 0);
  const end = source.indexOf('export function extractCallerEnvironment', begin);
  const api = evaluate(source.slice(begin, end)
    + functionText(source, 'extractCallerEnvironment')
    + functionText(source, 'scanForBulletCwdInSystem')
    + functionText(source, 'scanUserMessageForBareCwd')
    + '\nfunction poison() { CALLER_ENV_PATTERNS[0][1].lastIndex = 10000; CALLER_ENV_BULLET.lastIndex = 10000; }\n',
    ['extractCallerEnvironment', 'scanForBulletCwdInSystem', 'poison']);
  api.poison();
  assert.equal(api.extractCallerEnvironment([{ role: 'system', content: 'Working directory: /home/dev/project' }]),
    '- Working directory: /home/dev/project');
  api.poison();
  assert.equal(api.scanForBulletCwdInSystem([{ role: 'system', content: '- /home/dev/project' }]),
    '/home/dev/project');
});

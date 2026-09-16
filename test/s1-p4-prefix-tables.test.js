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

const CUT_014204F = "  _safeCutPoint(prevLen = 0) {\n    const buf = this.buffer;\n    const len = buf.length;\n\n    // audit S5 fast path: if buffer[0] is a construct still unresolved from the\n    // previous feed, the cut is 0 and we only walk the fresh tail. This is the\n    // O(N²)→O(N) win for long paths / big <workspace_*> blocks arriving over\n    // many chunks. Only consulted when prevLen>0 (mid-stream) — a fresh buffer\n    // has no prior hold to resume.\n    if (prevLen > 0 && this._resumeHeadHold(prevLen) === 0) return 0;\n\n    let cut = len;\n\n    // (1) unterminated full literal\n    for (const lit of SENSITIVE_LITERALS) {\n      let searchFrom = 0;\n      while (searchFrom < len) {\n        const idx = buf.indexOf(lit, searchFrom);\n        if (idx === -1) break;\n        let end = idx + lit.length;\n        while (end < len && PATH_BODY_RE.test(buf[end])) end++;\n        if (end === len) {\n          if (idx < cut) cut = idx;\n          break;\n        }\n        searchFrom = end + 1;\n      }\n    }\n\n    // (2) partial-prefix tail\n    for (const lit of SENSITIVE_LITERALS) {\n      const maxLen = Math.min(lit.length - 1, len);\n      for (let plen = maxLen; plen > 0; plen--) {\n        if (buf.endsWith(lit.slice(0, plen))) {\n          const start = len - plen;\n          if (start < cut) cut = start;\n          break;\n        }\n      }\n    }\n\n    // (3) v2.0.78 (#108) — XML block strip-tags. If the buffer contains\n    // an open `<workspace_information>` (etc.) without its matching\n    // close tag yet, hold the cut at the open-tag start so the next\n    // delta can extend the block; we only emit it once we see </tag>.\n    // Also handle the partial-prefix case where buffer ends with\n    // `<workspace_inform` (still being typed by the model).\n    for (const tag of STRIP_BLOCK_TAGS) {\n      const open = `<${tag}`;\n      const close = `</${tag}>`;\n      let searchFrom = 0;\n      while (searchFrom < len) {\n        const openIdx = buf.indexOf(open, searchFrom);\n        if (openIdx === -1) break;\n        const closeIdx = buf.indexOf(close, openIdx + open.length);\n        if (closeIdx === -1) {\n          // No close yet — hold from openIdx so the next feed can\n          // accumulate more of the block before we emit.\n          if (openIdx < cut) cut = openIdx;\n          break;\n        }\n        searchFrom = closeIdx + close.length;\n      }\n      // Partial-prefix tail of the open tag (`<workspace_inform`).\n      const openMax = Math.min(open.length - 1, len);\n      for (let plen = openMax; plen > 0; plen--) {\n        if (buf.endsWith(open.slice(0, plen))) {\n          const start = len - plen;\n          if (start < cut) cut = start;\n          break;\n        }\n      }\n    }\n\n    return cut;\n  }\n";
const FEED_014204F = "  feed(delta) {\n    if (!delta) return { text: '', toolCalls: [], items: [] };\n    // Oversize-drop state: swallow everything until the close marker, so the\n    // trailing `</tool_call>` / `\"}` cannot leak into the text stream after\n    // an over-limit tool_call was replaced with the placeholder. Must run\n    // BEFORE sentinel detection (a rebuilt full sentinel would otherwise\n    // flush the held W's as prose).\n    if (this._oversizeDropped) {\n      this.buffer += delta;\n      // B3: 丢弃态 buffer 硬上限 —— 超限直接清空（继续吞语义，防 OOM）\n      if (this.buffer.length > TOOL_XML_BODY_MAX * 2) this.buffer = '';\n      const closed = this.dialect === 'gpt_native'\n        ? this.buffer.includes('}')   // B2: 丢弃态只要出现闭合即恢复（`\"}}` 等裸闭合也认）\n        : this.buffer.includes('</tool_call>');\n      if (closed) {\n        this._oversizeDropped = false;\n        this.buffer = '';\n        // B1: 复位所有块状态 —— 否则 inToolCall/inToolResult 僵尸吞掉后续模型文本\n        this.inToolCall = false;\n        this.inToolResult = false;\n        this._toolResultOpenTag = '';\n      }\n      return { text: '', toolCalls: [], items: [] };\n    }\n    if (this.dialect !== 'openai_json_xml') {\n      this.buffer += delta;\n      // Stream text up to the first tool-tag sentinel so plain prose\n      // turns don't sit silent until end-of-stream. Hold back enough tail\n      // to detect a partial open tag split across chunks.\n      // v2.0.62 (#115) — gpt_native uses bare-JSON sentinels because\n      // the dialect's output is `{\"function_call\":{...}}` etc., no\n      // wrapper tag. The salvage pass at flush time then identifies\n      // and extracts the structured calls.\n      const sentinels = this.dialect === 'glm47'\n        ? ['<tool_call>']\n        : this.dialect === 'gpt_native'\n          ? ['{\"function_call\"', '{\"tool_calls\"', '{\"tool_call\"', '{\"function\"', '{\"name\"', '{ \"function_call\"', '{ \"tool_calls\"', '{ \"name\"']\n          : ['<|tool_calls_section_begin|>', '<tool_call>'];\n      let earliest = -1;\n      for (const s of sentinels) {\n        const idx = this.buffer.indexOf(s);\n        if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;\n      }\n      if (earliest === -1) {\n        let holdLen = 0;\n        for (const s of sentinels) {\n          const max = Math.min(s.length - 1, this.buffer.length);\n          for (let len = max; len > 0; len--) {\n            if (this.buffer.endsWith(s.slice(0, len))) {\n              holdLen = Math.max(holdLen, len);\n              break;\n            }\n          }\n        }\n        const emitUpto = this.buffer.length - holdLen;\n        if (emitUpto > 0) {\n          const text = this.buffer.slice(0, emitUpto);\n          this.buffer = this.buffer.slice(emitUpto);\n          return { text, toolCalls: [], items: [{ type: 'text', text }] };\n        }\n        return { text: '', toolCalls: [], items: [] };\n      }\n      // Sentinel seen — emit any text BEFORE it, hold the rest until flush.\n      if (earliest > 0) {\n        const text = this.buffer.slice(0, earliest);\n        this.buffer = this.buffer.slice(earliest);\n        return { text, toolCalls: [], items: [{ type: 'text', text }] };\n      }\n      // TOOL-2 — sentinel sits at buffer start (earliest===0): every later\n      // delta appends to the held buffer until flush. Unlike the XML path\n      // (which caps <tool_call>/<tool_result> bodies at TOOL_XML_BODY_MAX),\n      // this branch had no ceiling, so a model that opens a tool-call\n      // sentinel and then streams unbounded text pins it all in memory. Cap\n      // it the same way: once the held buffer exceeds the limit without a\n      // parseable close, flush it as ordinary text and reset so RSS stays\n      // bounded.\n      if (this.buffer.length > TOOL_XML_BODY_MAX) {\n        log.warn(`ToolCallStreamParser: ${this.dialect} sentinel body exceeds 65KB (${this.buffer.length} bytes), emitting placeholder`);\n        this.buffer = '';\n        this._oversizeDropped = true;\n        return { text: TOOL_OVER_LIMIT_PLACEHOLDER, toolCalls: [], items: [{ type: 'text', text: TOOL_OVER_LIMIT_PLACEHOLDER }] };\n      }\n      // 超限丢弃态：吞掉残余直到 JSON 平衡闭合，防 `\"}` 等裸泄漏\n      if (this._oversizeDropped) {\n        if (this._findClosingBrace() !== -1) this._oversizeDropped = false;\n        return { text: '', toolCalls: [], items: [] };\n      }\n      return { text: '', toolCalls: [], items: [] };\n    }\n    this.buffer += delta;\n    const safeParts = [];\n    const doneCalls = [];\n    const items = [];\n    const pushText = (text) => {\n      if (!text) return;\n      safeParts.push(text);\n      items.push({ type: 'text', text });\n    };\n    const pushTool = (toolCall) => {\n      if (!toolCall) return;\n      doneCalls.push(toolCall);\n      items.push({ type: 'tool_call', toolCall });\n      this._totalSeen++;\n    };\n    const TC_OPEN = GLM47_TOOL_OPEN;\n    const TC_CLOSE = GLM47_TOOL_CLOSE;\n    const TR_PREFIX = '<tool_result';\n    const TR_CLOSE = '</tool_result>';\n    const TC_CODE = '{\"tool_code\"';\n    const TC_BARE = '{\"name\"';\n\n    while (true) {\n      // ── Inside a <tool_result …>…</tool_result> block — discard body ──\n      if (this.inToolResult) {\n        if (this.buffer.length > TOOL_XML_BODY_MAX) {\n          log.warn(`ToolCallStreamParser: <tool_result> body exceeds 65KB (${this.buffer.length} bytes), dropping`);\n          this.buffer = '';\n          this.inToolResult = false;\n          this._toolResultOpenTag = '';\n          continue;\n        }\n        const closeIdx = this.buffer.indexOf(TR_CLOSE);\n        if (closeIdx === -1) break;\n        this.buffer = this.buffer.slice(closeIdx + TR_CLOSE.length);\n        this.inToolResult = false;\n        this._toolResultOpenTag = '';\n        continue;\n      }\n\n      // ── Inside a <tool_call>…</tool_call> block — parse JSON body ──\n      if (this.inToolCall) {\n        if (this.buffer.length > TOOL_XML_BODY_MAX) {\n          log.warn(`ToolCallStreamParser: <tool_call> body exceeds 65KB (${this.buffer.length} bytes), emitting placeholder`);\n          pushText(TOOL_OVER_LIMIT_PLACEHOLDER);\n          this.buffer = '';\n          this._oversizeDropped = true;   // 保持 inToolCall，吞掉残余直到 close，防 close 标记裸泄漏\n          continue;\n        }\n        if (this._oversizeDropped) {\n          // 超限丢弃态：等待 close 到达后整体丢弃，不再尝试解析\n          const closeIdx = this.buffer.indexOf(TC_CLOSE);\n          if (closeIdx === -1) break;\n          this.buffer = this.buffer.slice(closeIdx + TC_CLOSE.length);\n          this.inToolCall = false;\n          this._oversizeDropped = false;\n          continue;\n        }\n        const closeIdx = this.buffer.indexOf(TC_CLOSE);\n        if (closeIdx === -1) break;\n        const body = this.buffer.slice(0, closeIdx).trim();\n        this.buffer = this.buffer.slice(closeIdx + TC_CLOSE.length);\n        this.inToolCall = false;\n\n        const parsed = safeParseJson(body);\n        if (parsed && typeof parsed.name === 'string') {\n          const args = parsed.arguments;\n          const argsJson = typeof args === 'string' ? args : JSON.stringify(args ?? {});\n          log.debug(`ToolParser: matched xml format, name=${parsed.name}`);\n          pushTool({\n            id: `call_${this._totalSeen}_${Date.now().toString(36)}`,\n            name: parsed.name,\n            argumentsJson: argsJson,\n          });\n        } else {\n          pushText(`<tool_call>${body}</tool_call>`);\n        }\n        continue;\n      }\n\n      // ── Inside a {\"tool_code\": \"…\"} block ──\n      if (this.inToolCode) {\n        if (!this._consumeJsonBlock(s => this._parseToolCodeJson(s), pushTool, pushText)) break;\n        this.inToolCode = false;\n        continue;\n      }\n\n      // ── Inside a bare {\"name\":\"…\",\"arguments\":{…}} block ──\n      if (this.inBareCall) {\n        if (!this._consumeJsonBlock(s => this._parseBareToolCallJson(s), pushTool, pushText)) break;\n        this.inBareCall = false;\n        continue;\n      }\n\n      // ── Normal mode — scan for the next opening tag ──\n      const mode = TOOL_PARSE_MODE;\n      const tcIdx = (mode === 'auto' || mode === 'xml') ? this.buffer.indexOf(TC_OPEN) : -1;\n      // TOOL-3 — tighten <tool_result open-tag matching: the bare prefix must\n      // be followed by '>' or whitespace (i.e. `<tool_result>` or\n      // `<tool_result tool_call_id=…>`). A bare indexOf also matched\n      // substrings like `<tool_resultset`, spuriously opening a discard block\n      // and swallowing the model's real output. A prefix sitting exactly at\n      // the buffer tail (delimiter not yet streamed) is still returned as a\n      // candidate so the closeAngle check below holds it until more input\n      // arrives, rather than leaking a split real tag as text.\n      let trIdx = -1;\n      for (let p = this.buffer.indexOf(TR_PREFIX); p !== -1; p = this.buffer.indexOf(TR_PREFIX, p + 1)) {\n        const after = p + TR_PREFIX.length;\n        if (after >= this.buffer.length) { trIdx = p; break; }\n        const ch = this.buffer[after];\n        if (ch === '>' || ch === ' ' || ch === '\\t' || ch === '\\n' || ch === '\\r') { trIdx = p; break; }\n      }\n      const tcCodeIdx = this.parseToolCode && (mode === 'auto' || mode === 'tool_code') ? this.buffer.indexOf(TC_CODE) : -1;\n      const tcBareIdx = this.parseBareJson && (mode === 'auto' || mode === 'json') ? this.buffer.indexOf(TC_BARE) : -1;\n\n      let nextIdx = -1;\n      let tagType = null;\n      const candidates = [];\n      if (tcIdx !== -1) candidates.push({ idx: tcIdx, type: 'tc' });\n      if (trIdx !== -1) candidates.push({ idx: trIdx, type: 'tr' });\n      if (tcCodeIdx !== -1) candidates.push({ idx: tcCodeIdx, type: 'code' });\n      if (tcBareIdx !== -1 && tcBareIdx !== tcCodeIdx) candidates.push({ idx: tcBareIdx, type: 'bare' });\n      if (candidates.length) {\n        candidates.sort((a, b) => a.idx - b.idx);\n        nextIdx = candidates[0].idx;\n        tagType = candidates[0].type;\n      }\n\n      if (nextIdx === -1) {\n        let holdLen = 0;\n        const holdPrefixes = [TC_OPEN, TR_PREFIX];\n        if (this.parseToolCode) holdPrefixes.push(TC_CODE);\n        if (this.parseBareJson) holdPrefixes.push(TC_BARE);\n        for (const prefix of holdPrefixes) {\n          const maxHold = Math.min(prefix.length - 1, this.buffer.length);\n          for (let len = maxHold; len > 0; len--) {\n            if (this.buffer.endsWith(prefix.slice(0, len))) {\n              holdLen = Math.max(holdLen, len);\n              break;\n            }\n          }\n        }\n        const emitUpto = this.buffer.length - holdLen;\n        if (emitUpto > 0) pushText(this.buffer.slice(0, emitUpto));\n        this.buffer = this.buffer.slice(emitUpto);\n        break;\n      }\n\n      if (nextIdx > 0) pushText(this.buffer.slice(0, nextIdx));\n\n      if (tagType === 'tc') {\n        this.buffer = this.buffer.slice(nextIdx + TC_OPEN.length);\n        this.inToolCall = true;\n      } else if (tagType === 'tr') {\n        const closeAngle = this.buffer.indexOf('>', nextIdx + TR_PREFIX.length);\n        if (closeAngle === -1) {\n          this.buffer = this.buffer.slice(nextIdx);\n          break;\n        }\n        // Preserve the literal open tag for faithful regurgitation if the\n        // matching </tool_result> never arrives (TOOL-3).\n        this._toolResultOpenTag = this.buffer.slice(nextIdx, closeAngle + 1);\n        this.buffer = this.buffer.slice(closeAngle + 1);\n        this.inToolResult = true;\n      } else if (tagType === 'code') {\n        this.buffer = this.buffer.slice(nextIdx);\n        this.inToolCode = true;\n      } else if (tagType === 'bare') {\n        this.buffer = this.buffer.slice(nextIdx);\n        this.inBareCall = true;\n      }\n    }\n\n    return { text: safeParts.join(''), toolCalls: doneCalls, items };\n  }\n";

function methodText(source, name) {
  const start = new RegExp('^  ' + name + '\\(', 'm').exec(source);
  assert(start, 'Missing method ' + name);
  const tail = source.slice(start.index);
  const end = /^  \}/m.exec(tail);
  assert(end, 'Missing method end ' + name);
  return tail.slice(0, end.index + 3) + '\n';
}

function streamHarness({ baseline = false, countSlices = false, mode = 'auto' } = {}) {
  const pathName = 'src/sanitize.js';
  const toolName = 'src/handlers/tool-emulation.js';
  let pathSource = readSource(pathName).replaceAll('import.meta.url', JSON.stringify(new URL(pathName, ROOT).href));
  let toolSource = readSource(toolName);
  if (baseline) {
    pathSource = pathSource.replace(methodText(pathSource, '_safeCutPoint'), CUT_014204F);
    toolSource = toolSource.replace(methodText(toolSource, 'feed'), FEED_014204F);
  }
  const probe = watched => `
let __sliceCalls = 0;
${countSlices ? `const __probeWatched = ${watched};
const __nativeSlice = String.prototype.slice;
String.prototype.slice = function (...args) {
  if (__probeWatched.has(String(this)) && args[0] === 0) __sliceCalls++;
  return __nativeSlice.apply(this, args);
};` : ''}
function sliceCalls() { return __sliceCalls; }
function resetSliceCalls() { __sliceCalls = 0; }
`;
  class FixedDate extends Date { static now() { return 1700000000000; } }
  const pathApi = evaluate(pathSource + probe(
    'new Set([...SENSITIVE_LITERALS, ...STRIP_BLOCK_TAGS.map(tag => `<${tag}`)])'),
    ['PathSanitizeStream', 'sanitizeText', 'sliceCalls', 'resetSliceCalls'],
    { _fileURLToPath: fileURLToPath, process: { env: {}, cwd: () => fileURLToPath(ROOT) }, Date: FixedDate });
  // Construct the set once; the slice wrapper must not allocate a Set on each call.
  const watched = new Set([
    '<tool_call>', '<|tool_calls_section_begin|>', '<tool_result', '{"tool_code"',
    '{"function_call"', '{"tool_calls"', '{"tool_call"', '{"function"', '{"name"',
    '{ "function_call"', '{ "tool_calls"', '{ "name"',
  ]);
  const toolApi = evaluate(toolSource + probe('__watched'),
    ['ToolCallStreamParser', 'sliceCalls', 'resetSliceCalls'],
    { __watched: watched, process: { env: { TOOL_PARSE_MODE: mode } }, Date: FixedDate });
  return { path: pathApi, tool: toolApi };
}

function chunksAt(text, cuts) {
  let from = 0;
  const chunks = [];
  for (const end of [...cuts, text.length]) { chunks.push(text.slice(from, end)); from = end; }
  return chunks;
}
function streamRun(Constructor, chunks, options) {
  const stream = new Constructor(options);
  const output = chunks.map(chunk => stream.feed(chunk));
  output.push(stream.flush());
  return JSON.stringify(output);
}

test('a sensitive literal straddling two deltas is held without per-delta prefix slices', () => {
  const h = streamHarness({ countSlices: true });
  const stream = new h.path.PathSanitizeStream();
  assert.equal(stream.feed('visible /tmp/wind'), 'visible ');
  assert.equal(stream.feed('surf-workspace/private.txt '), '<workspace> ');
  assert.equal(stream.flush(), '');
  assert.equal(h.path.sliceCalls(), 0, 'static proper prefixes must be reused');
  for (const dialect of ['openai_json_xml', 'glm47', 'gpt_native', 'kimi_k2']) {
    const parser = new h.tool.ToolCallStreamParser({ dialect });
    parser.feed('ordinary prose ');
    parser.feed(dialect === 'gpt_native' ? '{"na' : '<tool_ca');
  }
  assert.equal(h.tool.sliceCalls(), 0, 'both tool-parser prefix loops must reuse static strings');
});

test('every sensitive-path and strip-tag split preserves each feed result and final flush', () => {
  const old = streamHarness({ baseline: true });
  const next = streamHarness();
  const root = fileURLToPath(ROOT).replace(/[/\\]$/, '');
  const strings = [
    'before /tmp/windsurf-workspace/private.txt after',
    'before /home/user/projects/workspace-ab12/src/a.js after',
    'before \\home\\user\\projects\\workspace-ab12\\src\\a.js after',
    'before /opt/windsurf/bin/app after',
    'before ' + root + '/src/file.js after',
    'before <workspace_information>private\ntext</workspace_information> after',
    'before <workspace_layout>private</workspace_layout> after',
    'before <user_information>private</user_information> after',
    'partial /tmp/wind', 'partial <workspace_inform', 'no matching input 中😀\ud800',
  ];
  for (const text of strings) {
    for (let cut = 0; cut <= text.length; cut++) {
      const chunks = chunksAt(text, [cut]);
      assert.equal(streamRun(next.path.PathSanitizeStream, chunks),
        streamRun(old.path.PathSanitizeStream, chunks), JSON.stringify({ text, cut }));
    }
    assert.equal(streamRun(next.path.PathSanitizeStream, text.split('')),
      streamRun(old.path.PathSanitizeStream, text.split('')));
  }
});

test('all tool dialects, toggles, parse modes and chunk boundaries remain identical', () => {
  for (const mode of ['auto', 'xml', 'json', 'tool_code']) {
    const old = streamHarness({ baseline: true, mode });
    const next = streamHarness({ mode });
    for (const dialect of ['openai_json_xml', 'glm47', 'gpt_native', 'kimi_k2']) {
      for (const parseToolCode of [false, true]) {
        for (const parseBareJson of [false, true]) {
          const options = { dialect, parseToolCode, parseBareJson };
          const strings = [
            'A <tool_call>{"name":"read","arguments":{"q":"中"}}</tool_call> B',
            'A <tool_result tool_call_id="synthetic">hidden</tool_result> B',
            'A <tool_resultset>ordinary</tool_resultset> B',
            'A {"tool_code":"read(\\"file\\")"} B',
            'A {"name":"read","arguments":{}} B',
            'A {"function_call":{"name":"read","arguments":{}}} B',
            'A <|tool_calls_section_begin|><tool_call>partial',
            'ordinary text only', '<tool_ca', '{"na',
          ];
          for (const text of strings) {
            for (let cut = 0; cut <= text.length; cut++) {
              const chunks = chunksAt(text, [cut]);
              assert.equal(streamRun(next.tool.ToolCallStreamParser, chunks, options),
                streamRun(old.tool.ToolCallStreamParser, chunks, options),
                JSON.stringify({ mode, options, text, cut }));
            }
          }
        }
      }
    }
  }
});

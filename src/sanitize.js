/**
 * Strip server-internal filesystem paths from model output before it reaches
 * the API caller.
 *
 * Background: Cascade's baked-in system context tells the model its workspace
 * lives at /tmp/windsurf-workspace. Even after we removed CascadeToolConfig
 * .run_command (see windsurf.js buildCascadeConfig) the model still
 *   (a) narrates "I'll look at /tmp/windsurf-workspace/config.yaml" in plain
 *       text, and
 *   (b) occasionally emits built-in edit_file / view_file / list_directory
 *       trajectory steps whose argumentsJson references these paths.
 * Both routes leak the proxy's internal filesystem layout to API callers.
 *
 * This module provides two scrubbers:
 *   - sanitizeText(s)        — one-shot, use on accumulated buffers
 *   - PathSanitizeStream     — incremental, use on streaming chunks
 *
 * The streaming version holds back any tail that could be an incomplete
 * prefix of a sensitive literal OR a match-in-progress whose path-tail hasn't
 * hit a terminator yet, so a path cannot slip through by straddling a chunk
 * boundary.
 */

// Detect the actual project root from this module's path so the sanitizer
// covers deployments outside /root/WindsurfAPI (e.g. /srv/WindsurfAPI).
import { fileURLToPath as _fileURLToPath } from 'url';
const _repoRoot = (() => {
  try {
    const thisFile = _fileURLToPath(import.meta.url);
    // sanitize.js is in src/, so project root is one directory up.
    // Handle both / and \ separators for cross-platform support.
    return thisFile.replace(/[/\\]src[/\\]sanitize\.js$/, '');
  } catch { return process.cwd(); }
})();

// Placeholder history: every marker has to avoid becoming either a fake path
// the model reuses in tool calls or a fake answer the model repeats to users.
//   ./tail                    → LLM Reads ./src/main.py → ENOENT → loops
//   [internal]                → LLM runs `ls [internal]` → ENOENT → loops
//   <redacted-path>           → LLM passes to Read/Bash → ENOENT (Linux) /
//                               Errno 22 (Windows) → loops
//   (internal path redacted)  → zsh parses `cd (internal path redacted)`
//                               as glob-qualifier syntax → cryptic
//                               "unknown file attribute: i" error
//   redacted internal path    → Opus 4.7 echoes it verbatim into bash
//                               commands; reads to the model as a
//                               plausible directory name and the
//                               failure mode is `cd: too many arguments`
//                               which still wastes 2-3 turns
//   …                         → avoids shell loops, but Sonnet 4.6 can echo
//                               it in prose as "your path is …", causing a
//                               user-visible answer loop when asked for the
//                               project path.
// Current marker is structural and explicit: it tells the user/model the
// workspace path is intentionally hidden, without looking like a real absolute
// path or a literal ellipsis answer. The proto/tool preamble also tells the
// model not to answer project-path questions by echoing this marker.
// Verified with the drift probe (scripts/_agent_drift_probe.py).
const REDACTED_PATH = '<workspace>';

// Path body char class: anything that's not whitespace or syntax-terminator.
// Used in patterns and in cut-point detection — must match.
// Note: `\\` is INSIDE the char class so backslash-separated tails (Windows
// style: `\home\user\projects\workspace-x\src\index.js`) keep extending the
// match instead of terminating at the first backslash.
const PATTERNS = [
  [/\/tmp\/windsurf-workspace(?:[/\\][^\s"'`<>)}\],*;]*)?/g, REDACTED_PATH],
  // Unix and Windows-mixed forms — issue #86 reports of
  // `C:\home\user\projects\workspace-devinxse` leaking despite the Unix-only
  // regex catching `/home/user/projects/workspace-skxwsx01`. Cover:
  //   /home/user/projects/workspace-x[/...]
  //   \home\user\projects\workspace-x[\...]
  //   C:\home\user\projects\workspace-x[\...]
  //   C:\home/user/projects/workspace-x  (mixed separators, GLM-style hallucination)
  [/(?:[A-Za-z]:)?[/\\]home[/\\]user[/\\]projects[/\\]workspace-[a-z0-9]+(?:[/\\][^\s"'`<>)}\],*;]*)?/g, REDACTED_PATH],
  [/\/opt\/windsurf(?:[/\\][^\s"'`<>)}\],*;]*)?/g, REDACTED_PATH],
  [new RegExp(_repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:[/\\\\][^\\s"\'`<>)}\\],*;]*)?', 'g'), REDACTED_PATH],
  // v2.0.78 (#108 zhangzhang-bit) — Cascade upstream injects these XML
  // blocks into the system prompt to describe its sandbox state:
  //   <workspace_information>...workspace path / metadata...</workspace_information>
  //   <workspace_layout>...file tree...</workspace_layout>
  //   <user_information>...account / config...</user_information>
  // The model sometimes echoes them verbatim into its response, leaking
  // server-internal sandbox state to API callers (the actual #108
  // screenshot showed `workspace-devinxse` paths surrounded by these
  // wrappers). Strip the entire block (greedy across newlines) — these
  // are upstream-injected and have no legitimate reason to surface in
  // client-facing output.
  [/<workspace_information>[\s\S]*?<\/workspace_information>/gi, ''],
  [/<workspace_layout>[\s\S]*?<\/workspace_layout>/gi, ''],
  [/<user_information>[\s\S]*?<\/user_information>/gi, ''],
];

// Tags whose ENTIRE block (open → close) is upstream-injected and must
// be held back during streaming until we see the closing tag — otherwise
// chunk N might emit `<workspace_information>file:///home/user/proj...`
// before chunk N+1 arrives with the rest. Used by PathSanitizeStream
// alongside SENSITIVE_LITERALS.
const STRIP_BLOCK_TAGS = ['workspace_information', 'workspace_layout', 'user_information'];

// Bare literals (no path tail) used by the streaming cut-point finder.
// Listed once per separator/prefix shape so the partial-prefix detection
// can hold back the right tail length on stream chunks.
const SENSITIVE_LITERALS = [
  '/tmp/windsurf-workspace',
  '/home/user/projects/workspace-',
  '\\home\\user\\projects\\workspace-',
  '/opt/windsurf',
  _repoRoot,
];

// Character class that counts as part of a path body. Mirrors the PATTERNS
// regex char class so cut-point detection matches replacement behaviour.
const PATH_BODY_RE = /[^\s"'`<>)}\],*;]/;

/**
 * Apply all path redactions to `s` in one pass. Safe to call on any string;
 * non-strings and empty strings are returned unchanged.
 */
export function sanitizeText(s) {
  if (typeof s !== 'string' || !s) return s;
  let out = s;
  for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
  return out;
}

/**
 * Incremental sanitizer for streamed deltas.
 *
 * Usage:
 *   const stream = new PathSanitizeStream();
 *   for (const chunk of deltas) emit(stream.feed(chunk));
 *   emit(stream.flush());
 *
 * The returned string from feed()/flush() is guaranteed to contain no
 * sensitive literal. Any trailing text that COULD extend into a sensitive
 * literal (either as a partial prefix or as an unterminated path tail) is
 * held internally until the next feed or the flush.
 */
// Index by UTF-16 prefix length, exactly matching slice(0, length).
// The bounded table is built once, rather than allocating each trial per delta.
function streamLiteralPrefixes(literal) {
  const prefixes = new Array(literal.length);
  for (let length = 1; length < literal.length; length++) {
    prefixes[length] = literal.slice(0, length);
  }
  return prefixes;
}

const PATH_STREAM_PREFIXES = new Map([
  ...SENSITIVE_LITERALS,
  ...STRIP_BLOCK_TAGS.map(tag => `<${tag}`),
].map(literal => [literal, streamLiteralPrefixes(literal)]));

export class PathSanitizeStream {
  constructor() {
    this.buffer = '';
    // audit S5 — incremental cut detection. feed() used to re-scan the ENTIRE
    // held-back buffer on every chunk, so a long sensitive path or a big
    // <workspace_layout> block streamed over K chunks cost O(N²) (each chunk
    // re-walks the whole accumulated hold). These two cursors let a chunk resume
    // the resolution scan of the head construct from where the previous chunk
    // left off (walking only the fresh tail), turning the two unbounded-growth
    // hold cases into O(N) amortized. Both are reset to 0 whenever the buffer
    // head changes (a slice with cut>0), and only trusted while the head is
    // unchanged (cut===0). Correctness is pinned by an exhaustive random-chunking
    // equivalence test against one-shot sanitizeText() (sanitize-stream-incremental).
    this._resumeBodyEnd = 0;  // literal-body walk cursor when head is an unterminated literal
    this._resumeClose = 0;    // close-tag search cursor when head is an unclosed strip block
  }

  feed(delta) {
    if (!delta) return '';
    const prevLen = this.buffer.length;
    this.buffer += delta;
    const cut = this._safeCutPoint(prevLen);
    if (cut === 0) return '';
    const safeRegion = this.buffer.slice(0, cut);
    this.buffer = this.buffer.slice(cut);
    // Head changed → resume cursors no longer describe buffer[0]; reset them.
    this._resumeBodyEnd = 0;
    this._resumeClose = 0;
    return sanitizeText(safeRegion);
  }

  // Fast path (audit S5): if buffer[0] begins a construct we were already
  // holding on last feed (an unterminated sensitive literal, or an unclosed
  // strip-block), the earliest hold is that head → cut is 0 as long as it stays
  // unresolved. Resume its resolution scan from the previous cursor + a straddle
  // overlap (so a terminator/close-tag spanning the chunk boundary is still
  // caught) instead of re-walking the whole held-back region. Returns 0 to hold,
  // or -1 to signal "head resolved / no fast-path hold — run the full scan".
  _resumeHeadHold(prevLen) {
    const buf = this.buffer;
    const len = buf.length;

    // 1a. Head is a sensitive literal with a live (unterminated) body. Char
    //     class is per-char and monotonic — a char already classified as body
    //     stays body when data is appended — so resuming the walk from the
    //     previous end is exact.
    for (const lit of SENSITIVE_LITERALS) {
      if (!lit || !buf.startsWith(lit)) continue;
      let end = Math.max(lit.length, this._resumeBodyEnd);
      while (end < len && PATH_BODY_RE.test(buf[end])) end++;
      if (end === len) { this._resumeBodyEnd = end; return 0; } // still unterminated → hold at 0
      return -1; // body terminated → let the full scan advance the cut
    }

    // 1b. Head is an unclosed strip-block open tag. Resume the close-tag search;
    //     back off by (close.length - 1) so a close tag straddling the previous
    //     chunk boundary is still found.
    for (const tag of STRIP_BLOCK_TAGS) {
      const open = `<${tag}`;
      if (!buf.startsWith(open)) continue;
      const close = `</${tag}>`;
      const from = Math.max(open.length, Math.min(this._resumeClose, prevLen) - (close.length - 1), 0);
      const closeIdx = buf.indexOf(close, from);
      if (closeIdx === -1) { this._resumeClose = len; return 0; } // still unclosed → hold at 0
      return -1; // block closed → let the full scan advance the cut
    }

    return -1; // no fast-path hold applies
  }

  // Largest index into this.buffer such that buffer[0:cut] contains no
  // match that could extend past `cut`. Two conditions back off the cut:
  //   (1) a full sensitive literal was found but its path body ran to the
  //       end of the buffer — the next delta might append more path chars,
  //       in which case the fully-rendered path would differ. Hold from the
  //       literal's start.
  //   (2) the buffer tail is itself a proper prefix of a sensitive literal
  //       (e.g., ends with "/tmp/win") — the next delta might complete it.
  //       Hold from that tail start.
  _safeCutPoint(prevLen = 0) {
    const buf = this.buffer;
    const len = buf.length;

    // audit S5 fast path: if buffer[0] is a construct still unresolved from the
    // previous feed, the cut is 0 and we only walk the fresh tail. This is the
    // O(N²)→O(N) win for long paths / big <workspace_*> blocks arriving over
    // many chunks. Only consulted when prevLen>0 (mid-stream) — a fresh buffer
    // has no prior hold to resume.
    if (prevLen > 0 && this._resumeHeadHold(prevLen) === 0) return 0;

    let cut = len;

    // (1) unterminated full literal
    for (const lit of SENSITIVE_LITERALS) {
      let searchFrom = 0;
      while (searchFrom < len) {
        const idx = buf.indexOf(lit, searchFrom);
        if (idx === -1) break;
        let end = idx + lit.length;
        while (end < len && PATH_BODY_RE.test(buf[end])) end++;
        if (end === len) {
          if (idx < cut) cut = idx;
          break;
        }
        searchFrom = end + 1;
      }
    }

    // (2) partial-prefix tail
    for (const lit of SENSITIVE_LITERALS) {
      const prefixes = PATH_STREAM_PREFIXES.get(lit);
      const maxLen = Math.min(lit.length - 1, len);
      for (let plen = maxLen; plen > 0; plen--) {
        if (buf.endsWith(prefixes[plen])) {
          const start = len - plen;
          if (start < cut) cut = start;
          break;
        }
      }
    }

    // (3) v2.0.78 (#108) — XML block strip-tags. If the buffer contains
    // an open `<workspace_information>` (etc.) without its matching
    // close tag yet, hold the cut at the open-tag start so the next
    // delta can extend the block; we only emit it once we see </tag>.
    // Also handle the partial-prefix case where buffer ends with
    // `<workspace_inform` (still being typed by the model).
    for (const tag of STRIP_BLOCK_TAGS) {
      const open = `<${tag}`;
      const close = `</${tag}>`;
      let searchFrom = 0;
      while (searchFrom < len) {
        const openIdx = buf.indexOf(open, searchFrom);
        if (openIdx === -1) break;
        const closeIdx = buf.indexOf(close, openIdx + open.length);
        if (closeIdx === -1) {
          // No close yet — hold from openIdx so the next feed can
          // accumulate more of the block before we emit.
          if (openIdx < cut) cut = openIdx;
          break;
        }
        searchFrom = closeIdx + close.length;
      }
      // Partial-prefix tail of the open tag (`<workspace_inform`).
      const prefixes = PATH_STREAM_PREFIXES.get(open);
      const openMax = Math.min(open.length - 1, len);
      for (let plen = openMax; plen > 0; plen--) {
        if (buf.endsWith(prefixes[plen])) {
          const start = len - plen;
          if (start < cut) cut = start;
          break;
        }
      }
    }

    return cut;
  }

  flush() {
    const out = sanitizeText(this.buffer);
    this.buffer = '';
    return out;
  }
}

/**
 * Sanitize a tool call before surfacing to the client. Covers three carriers
 * a leaked path can ride:
 *   - argumentsJson  (OpenAI-emulated + legacy native)
 *   - result         (native Cascade tool result)
 *   - input          (Anthropic-format parsed input dict — the hot path
 *                     used by Claude Code streaming, issue #38)
 * Without the `input` scrub, the stream handler would emit a tool_use
 * delta whose file_path still references /home/user/projects/workspace-x
 * and Claude Code would try to Read a path that doesn't exist locally.
 */
export function sanitizeToolCall(tc) {
  if (!tc) return tc;
  const out = { ...tc };
  if (typeof tc.argumentsJson === 'string') out.argumentsJson = sanitizeText(tc.argumentsJson);
  if (typeof tc.result === 'string') out.result = sanitizeText(tc.result);
  if (tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input)) {
    const safe = {};
    for (const [k, v] of Object.entries(tc.input)) {
      safe[k] = typeof v === 'string' ? sanitizeText(v) : v;
    }
    out.input = safe;
  }
  return out;
}

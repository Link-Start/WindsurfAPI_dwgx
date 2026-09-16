/**
 * Responses API server-side conversation state.
 *
 * WHY: `/v1/responses` advertises OpenAI Responses compatibility, whose defining
 * feature is that the SERVER holds the conversation. A client sends only the new
 * turn plus `previous_response_id` and the server prepends everything before it.
 *
 * Before this module `previous_response_id` was never read (grep: zero hits in
 * handlers/responses.js). A chained client therefore reached the upstream with a
 * SINGLE message every turn — the model answered each turn blind, with no error
 * and no warning, producing fluent but context-free replies the caller had no way
 * to diagnose. That silent-wrong-answer mode is the thing this fixes.
 *
 * Design:
 *   - Each stored entry holds the FULL accumulated message list for that turn
 *     (input + the assistant output), not a parent pointer. Resolution is then a
 *     single O(1) lookup instead of walking a chain, and a mid-chain eviction
 *     cannot silently truncate history — the lookup either has everything or
 *     fails loudly.
 *   - Entries are scoped by callerKey. A response id minted for one caller MUST
 *     NOT resolve for another, or tenant A could read tenant B's conversation by
 *     replaying an id. Lookup mismatch fails closed (treated as not found).
 *   - Bounded like every other in-memory table here: TTL, a hard cap, LRU
 *     eviction with a per-tenant fair share so one caller cannot flush everyone
 *     else's conversations (same lesson as account/sticky-session.js).
 *   - `store: false` on the request skips persistence, per the OpenAI contract —
 *     such a response cannot later be used as a `previous_response_id`. The value
 *     is NORMALIZED here rather than trusted as a boolean; see wantsPersistence.
 *
 * Configure via env:
 *   RESPONSE_STORE_ENABLED=0        — disable (default: on)
 *   RESPONSE_STORE_TTL_MS=3600000   — IDLE timeout in ms (default: 1 hour)
 *   RESPONSE_STORE_MAX_AGE_MS=86400000 — absolute retention bound (default: 24 hours)
 *   RESPONSE_STORE_MAX=2000         — max stored responses (default: 2000)
 *   RESPONSE_STORE_MAX_MESSAGES=400 — per-conversation message cap (default: 400)
 *   RESPONSE_STORE_MAX_BYTES=128m   — total byte budget (default: 128MB; b/k/kb/m/mb/g/gb)
 */

import { log } from './config.js';

const ENABLED = process.env.RESPONSE_STORE_ENABLED !== '0';

// IDLE timeout: measured from lastAccess, which every successful read refreshes.
// That refresh is deliberate — a chained agent loop touching the same id every few
// seconds must not have its context expire underneath it — but it means TTL_MS on
// its own bounds nothing: a client polling GET /v1/responses/{id} keeps an entry
// alive forever (measured at RESPONSE_STORE_TTL_MS=120: polled every 40ms for
// 1020ms, i.e. 8.5x the TTL, 25 successful reads, entry still alive). No floor
// either — `n > 0` accepts 1ms, which is fine for tuning and useless as a bound.
// MAX_AGE_MS below is the bound that does not depend on read traffic.
const TTL_MS = (() => {
  const n = parseInt(process.env.RESPONSE_STORE_TTL_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 60 * 60 * 1000; // 1 hour
})();

// ABSOLUTE retention bound, measured from createdAt and NOT refreshed by reads. It
// is what makes "retained for a limited time" true; the idle timeout above only
// says "collected when abandoned".
//
// 24 hours, chosen against the workload this store exists to serve rather than
// against the smallest defensible number. An agent loop can legitimately run for
// hours, and dropping its context mid-run is a worse failure than over-retention:
// the caller gets a 404 on a conversation it is actively using, with nothing to
// recover from. Note the bound is per response id and createdAt survives a
// same-id refresh, so a real chain is unaffected either way — every turn mints a
// NEW id and starts its own 24 hours. What the bound actually kills is the entry
// that is read but never superseded, which is exactly the shape that had no upper
// limit at all.
const MAX_AGE_MS = (() => {
  const n = parseInt(process.env.RESPONSE_STORE_MAX_AGE_MS || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 24 * 60 * 60 * 1000; // 24 hours
})();

const MAX_ENTRIES = (() => {
  const n = parseInt(process.env.RESPONSE_STORE_MAX || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

// A runaway agent loop would otherwise grow one conversation without bound. The
// cap keeps the OLDEST turns (the system prompt and early context matter most for
// coherence) — see truncateMessages.
const MAX_MESSAGES = (() => {
  const n = parseInt(process.env.RESPONSE_STORE_MAX_MESSAGES || '', 10);
  return Number.isFinite(n) && n > 0 ? n : 400;
})();

// Neither MAX_ENTRIES nor MAX_MESSAGES bounds actual MEMORY — they bound counts.
// Measured on realistic agent-loop conversations (8KB system prompt + 200
// tool_call/tool_result pairs with 4KB outputs, truncated to MAX_MESSAGES): ~167KB
// of heap per stored entry, so the default 2000 entries is ~327MB, and a
// text-heavy shape measured ~518MB. On the small VPSes this project explicitly
// targets (the README tells 2GB hosts to lower LS_MAX_INSTANCES) that is enough to
// matter on its own. So the store also carries a BYTE budget and evicts on
// whichever limit binds first.
/**
 * Parse a byte-size setting like `128m` / `512kb` / `1g` / a bare byte count.
 * Exported so the suffix contract is tested against THIS implementation instead of
 * a copy — a test that re-derives the regex passes even when production breaks.
 * Returns null for anything unusable so the caller applies its default.
 */
export function parseByteSize(raw) {
  const m = String(raw ?? '').trim().match(/^(\d+)\s*(b|k|kb|m|mb|g|gb)?$/i);
  if (!m) return null;
  const mult = { b: 1, k: 1024, kb: 1024, m: 1048576, mb: 1048576, g: 1073741824, gb: 1073741824 };
  const n = Number(m[1]) * (mult[(m[2] || 'b').toLowerCase()] || 1);
  return n > 0 ? n : null;
}

const MAX_BYTES = parseByteSize(process.env.RESPONSE_STORE_MAX_BYTES)
  ?? 128 * 1024 * 1024; // 128MB — roughly 800 realistic conversations

// Approximate retained size of a stored conversation. Deliberately cheap: string
// length (not byteLength) plus a flat per-message overhead. An exact figure would
// need to walk every part of every content array on the hot path; what matters is
// that the estimate is monotonic in the real cost so eviction tracks growth.
function approxBytes(messages) {
  let n = 0;
  for (const m of messages) {
    n += 64; // object + role + bookkeeping
    n += strBytes(m?.content);
    if (Array.isArray(m?.tool_calls)) {
      for (const tc of m.tool_calls) {
        n += 96 + strBytes(tc?.id) + strBytes(tc?.function?.name) + strBytes(tc?.function?.arguments);
      }
    }
    n += strBytes(m?.tool_call_id);
  }
  return n;
}

// Retained-size estimate for any content value. Two things this must get right,
// both found by review of the first cut:
//
//  - EVERY string field counts, not just `.text`. A Responses `input_image` is
//    normalized to `{type:'image_url', image_url:{url:'data:...;base64,...'}}`,
//    which has no `.text` — so a multi-megabyte data URI was charged a flat 32
//    bytes and the budget never fired on vision payloads (measured: 10 entries
//    holding ~20MB of base64 accounted as 960 bytes, ~15000x under).
//  - 2 bytes per character, not 1. V8 stores any non-Latin1 string as 2 bytes/char,
//    so `.length` undercounts CJK by exactly 2x. Charging 2 everywhere overcounts
//    pure ASCII by 2x, which is the safe direction for a memory bound.
function strBytes(v, depth = 0) {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length * 2;
  if (typeof v === 'number' || typeof v === 'boolean') return 8;
  if (depth > 4) return 32; // guard against a pathological nesting depth
  if (Array.isArray(v)) {
    let n = 0;
    for (const item of v) n += 32 + strBytes(item, depth + 1);
    return n;
  }
  if (typeof v === 'object') {
    let n = 0;
    for (const val of Object.values(v)) n += strBytes(val, depth + 1);
    return n;
  }
  return 0;
}

// Map<responseId, { messages, callerKey, model, createdAt, lastAccess, bytes }>
// Map iteration order is maintained as least-recently-used order: every read and
// refresh re-inserts, so the first key is always the LRU victim (O(1) eviction).
const _entries = new Map();
const _tenantCounts = new Map();
// Per-tenant BYTE totals. The byte-eviction loop needs a byte-denominated fair
// share; comparing an entry COUNT against MAX_ENTRIES/tenants let a byte-bound
// writer look under-share forever and evict strangers (see the loop below).
const _tenantBytes = new Map();

const _stats = { stored: 0, hits: 0, misses: 0, expires: 0, evictions: 0, rejected: 0 };
let _bytes = 0;   // running total of approxBytes across all entries

export function isResponseStoreEnabled() {
  return ENABLED;
}

/**
 * Tenant identity for quota purposes: the API-key prefix of the callerKey, not
 * the whole callerKey. One API key can mint unlimited distinct callerKeys (a
 * fresh body.user per request), so quota'ing the full callerKey would not bound
 * anything.
 */
function tenantOf(callerKey) {
  const key = String(callerKey || '');
  const i = key.indexOf(':');
  if (i < 0) return key;
  const j = key.indexOf(':', i + 1);
  return j < 0 ? key : key.slice(0, j);
}

function trackInsert(callerKey, bytes = 0) {
  const t = tenantOf(callerKey);
  _tenantCounts.set(t, (_tenantCounts.get(t) || 0) + 1);
  _tenantBytes.set(t, (_tenantBytes.get(t) || 0) + bytes);
}

function dropEntry(id) {
  const entry = _entries.get(id);
  if (!entry) return false;
  _entries.delete(id);
  _bytes -= entry.bytes || 0;
  if (_bytes < 0) _bytes = 0;
  const t = tenantOf(entry.callerKey);
  const n = (_tenantCounts.get(t) || 1) - 1;
  const b = (_tenantBytes.get(t) || 0) - (entry.bytes || 0);
  if (n > 0) { _tenantCounts.set(t, n); _tenantBytes.set(t, b > 0 ? b : 0); }
  else { _tenantCounts.delete(t); _tenantBytes.delete(t); }
  return true;
}

function oldestId(tenant = null, exclude = null) {
  for (const [id, entry] of _entries) {
    if (id === exclude) continue;
    if (!tenant || tenantOf(entry.callerKey) === tenant) return id;
  }
  return null;
}

// The two expiry predicates, named so the lookup path and the sweep cannot drift
// apart. `lastAccess` is refreshed by every read (idle timeout); `createdAt` is
// not (absolute bound).
function isPastIdle(entry, now) {
  return now - entry.lastAccess > TTL_MS;
}
function isPastMaxAge(entry, now) {
  return now - entry.createdAt > MAX_AGE_MS;
}

// Periodic sweep so an idle process does not hold expired conversations. The
// per-lookup TTL check is the primary enforcement; this is the safety net.
let _sweepTimer = null;
function ensureSweepTimer() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of [..._entries]) {
      // Both bounds, for the same reason getResponse checks both: an entry kept
      // warm by reads never trips the idle timeout, and one nobody ever reads
      // again would sit until the absolute bound if only that were checked here.
      if (isPastIdle(entry, now) || isPastMaxAge(entry, now)) {
        dropEntry(id);
        _stats.expires++;
      }
    }
  }, 5 * 60 * 1000).unref();
}

/**
 * Keep the conversation within MAX_MESSAGES, preserving the leading system
 * message(s) — dropping those loses the agent's instructions and changes
 * behaviour far more than dropping middle turns.
 */
function truncateMessages(messages) {
  if (messages.length <= MAX_MESSAGES) return messages;

  let lead = 0;
  while (lead < messages.length && messages[lead]?.role === 'system') lead++;

  // The leading system block gets at most HALF the budget. Without a cap on the
  // head, `MAX_MESSAGES - lead` goes negative once the system block alone reaches
  // the budget, and `slice(-negative)` silently becomes `slice(positive)` — it
  // returns most of the array instead of the last few entries, so the result grew
  // INSTEAD of shrinking (measured: 501 messages in, 901 stored). Codex-style
  // clients that send AGENTS.md / environment context as many separate developer
  // items reach that shape with no adversarial intent.
  // Cap the head only where it MUST be capped. The negative-slice bug fired at
  // lead >= MAX_MESSAGES; a head budget of MAX/2 also changed the outcome for lead
  // in (MAX/2, MAX), a range where the old code was already correct and preserved
  // every leading system message. Clamping to MAX_MESSAGES - 1 fixes the bug while
  // leaving that range byte-identical, and still guarantees room for one real turn.
  const head = messages.slice(0, Math.min(lead, MAX_MESSAGES - 1));
  const tailBudget = MAX_MESSAGES - head.length;
  const tail = tailBudget > 0 ? messages.slice(-tailBudget) : [];
  return [...head, ...tail];
}

// No single conversation may claim more than this share of the whole budget.
// Without a per-entry ceiling the eviction loop cannot converge fairly: a tenant
// whose one entry alone exceeds the budget has nothing of its OWN left to evict,
// so it falls through to the global scan and flushes strangers — which is exactly
// the cross-tenant DoS the byte-denominated fair share is meant to prevent.
const MAX_ENTRY_BYTES = Math.max(64 * 1024, Math.floor(MAX_BYTES / 4));

// Floor under the per-tenant byte share used by the eviction loop. `MAX_BYTES /
// tenants` is the fair-share rule, but taken literally it self-destructs at scale:
// past a few hundred tenants the share falls below one ordinary conversation, so
// EVERY tenant reads as over-share, each one only ever evicts its own oldest, and
// a tenant holding a single entry has nothing to evict at all — the loop breaks
// with the budget still exceeded. 1/64th of the budget (min 256KB) is the point
// below which a tenant is too small for self-eviction to bound anything, and the
// global LRU scan takes over. Above the floor the fair-share behaviour that
// prevents the cross-tenant DoS is unchanged.
const MIN_TENANT_BYTES = Math.max(256 * 1024, Math.floor(MAX_BYTES / 64));

/**
 * Trim a conversation until it fits MAX_ENTRY_BYTES, dropping from the MIDDLE.
 * The leading system block and the most recent turns are what a next turn needs;
 * the middle is the cheapest thing to lose, and losing it is strictly better than
 * either refusing the write or evicting other tenants to make room.
 */
function capEntryBytes(messages) {
  if (approxBytes(messages) <= MAX_ENTRY_BYTES) return messages;
  let lead = 0;
  while (lead < messages.length && messages[lead]?.role === 'system') lead++;
  const head = messages.slice(0, Math.min(lead, 8));
  let tailStart = messages.length;
  const out = [];
  // Walk backwards adding recent turns while they fit.
  let used = approxBytes(head);
  while (tailStart > lead) {
    const candidate = messages[tailStart - 1];
    const cost = approxBytes([candidate]);
    if (used + cost > MAX_ENTRY_BYTES && out.length) break;
    used += cost;
    out.unshift(candidate);
    tailStart--;
    if (used > MAX_ENTRY_BYTES) break;
  }
  const trimmed = [...head, ...out];
  // Dropping messages must never be SILENT. The backward walk stops as soon as one
  // message has been kept and the next does not fit, so an over-cap message with
  // any smaller message after it is excluded entirely — and because `trimmed` then
  // fits, the content-level fallback below never runs and no marker is written.
  // Reproduced at RESPONSE_STORE_MAX_BYTES=8m: a 2MB user turn followed by a short
  // assistant reply stored as `["assistant"]` — the user's question, including a
  // pasted file, vanished with no marker and no log line. The next chained turn
  // then asked the model about content it was never shown, and answered 200 with a
  // confident context-free reply: exactly the silent-wrong-answer mode this module
  // exists to remove. Small-VPS operators are explicitly told to lower this budget,
  // so the shape is ordinary rather than adversarial.
  const dropped = messages.length - trimmed.length;
  if (dropped > 0 && trimmed.length) {
    const note = `[... ${dropped} earlier message(s) dropped by the response store to stay `
      + 'within RESPONSE_STORE_MAX_BYTES ...]\n\n';
    const first = { ...trimmed[0] };
    // Prepended to the first SURVIVING message rather than added as a new one:
    // inserting a message would change the conversation's role sequence, which the
    // connect wire layer is sensitive to.
    if (typeof first.content === 'string') first.content = note + first.content;
    else if (Array.isArray(first.content)) first.content = [{ type: 'text', text: note }, ...first.content];
    else first.content = note;
    trimmed[0] = first;
    log.warn(`[response-store] dropped ${dropped} message(s) to fit RESPONSE_STORE_MAX_BYTES`);
  }
  // Last resort: a conversation whose SINGLE message already exceeds the ceiling
  // cannot be shrunk by dropping messages. Cut the text itself, otherwise the
  // store's one promise — total bytes stay within the budget — is false whenever
  // an operator configures a small budget (a 10MB request body, the server cap,
  // lands as ~20MB accounted). The marker keeps the truncation visible to whoever
  // reads the chained context instead of silently changing what the model saw.
  if (approxBytes(trimmed) > MAX_ENTRY_BYTES) return trimContentToFit(trimmed);
  return trimmed;
}

const TRUNCATION_MARKER = '\n\n[... truncated by the response store to stay within RESPONSE_STORE_MAX_BYTES ...]';

// Keys whose STRING value must never be cut, because it is an identifier or a
// discriminator rather than payload. `tool_call_id` and `id` pair an assistant
// tool_call with its tool result — cutting either breaks the pairing and the
// upstream rejects the whole conversation. `type` is the block discriminator the
// wire layer dispatches on; `role` and `name` are likewise structural.
const UNSHRINKABLE_KEYS = new Set(['type', 'role', 'id', 'tool_call_id', 'name']);

/**
 * Every string in a message that MAY be shortened, as a path from the message
 * object (e.g. `['content', 2, 'text']`, `['tool_calls', 0, 'function',
 * 'arguments']`, or `['content']` for the plain-string shape).
 *
 * WHY a walk rather than reading `.content`: the previous version read
 * `typeof m.content === 'string' ? m.content.length : 0`, so for the ARRAY content
 * shape — which is the DEFAULT for the Responses API, since responsesToChat
 * normalizes every input item into typed blocks — no candidate was ever found,
 * `biggest` stayed -1 and the loop broke on its first iteration. MAX_ENTRY_BYTES
 * was therefore a no-op for the common case, while approxBytes/strBytes counted
 * those arrays correctly: the metering was fixed and the enforcement was not,
 * which is why the byte-budget tests passed with the cap doing nothing.
 * MEASURED at RESPONSE_STORE_MAX_BYTES=400k (MAX_ENTRY_BYTES 102400):
 *   content as string, 200000 chars -> stored  50124 chars, marker present
 *   content as array,  200000 chars -> stored 200000 chars, NO marker, 400104 bytes
 * i.e. ~3.9x the per-entry ceiling, which is enough for one tenant to LRU-evict
 * the whole store.
 *
 * Depth 5 matches strBytes' own depth guard, so anything the metering charges for
 * is also reachable here.
 */
function shrinkableSlots(node, path = [], depth = 0, out = []) {
  if (depth > 5 || node == null || typeof node !== 'object') return out;
  const entries = Array.isArray(node)
    ? node.map((v, i) => [i, v])
    : Object.entries(node);
  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      if (typeof key === 'string' && UNSHRINKABLE_KEYS.has(key)) continue;
      // Below the marker length, replacing the text with the marker would GROW it.
      if (value.length <= TRUNCATION_MARKER.length) continue;
      out.push({ path: [...path, key], len: value.length });
    } else if (value && typeof value === 'object') {
      shrinkableSlots(value, [...path, key], depth + 1, out);
    }
  }
  return out;
}

/**
 * Copy-on-write assignment along `path`. Copies every node it descends through so
 * the CALLER's message objects are never mutated — `messages.map(m => ({...m}))`
 * is a shallow copy, so a content array and its blocks are still shared with the
 * live request body, and writing through them would rewrite what the upstream is
 * about to be sent.
 */
function withStringAt(node, path, value) {
  const [key, ...rest] = path;
  const copy = Array.isArray(node) ? [...node] : { ...node };
  copy[key] = rest.length ? withStringAt(node[key], rest, value) : value;
  return copy;
}

function trimContentToFit(messages) {
  let out = messages.map(m => ({ ...m }));
  // Shrink from the LARGEST string field down until the entry fits. The field may
  // live inside a content-block array or inside a tool_call, not only at
  // `m.content` — see shrinkableSlots.
  let guard = 64;
  while (approxBytes(out) > MAX_ENTRY_BYTES && guard-- > 0) {
    let biggest = null;
    for (let i = 0; i < out.length; i++) {
      for (const slot of shrinkableSlots(out[i], [i])) {
        if (!biggest || slot.len > biggest.len) biggest = slot;
      }
    }
    // No candidate left, or the biggest one is already at the floor: stop rather
    // than shrink forever. (Unchanged intent; shrinkableSlots applies the same
    // marker-length floor per candidate.)
    if (!biggest) break;
    const keep = Math.max(1, Math.floor(biggest.len / 2));
    const [msgIndex, ...rest] = biggest.path;
    const current = rest.reduce((n, k) => n[k], out[msgIndex]);
    const cut = current.slice(0, keep) + TRUNCATION_MARKER;
    // The block STRUCTURE is preserved: only the string at this path changes, so a
    // `{type:'text', text}` block stays a text block and the next turn can still be
    // replayed from the array. `rest` is never empty — shrinkableSlots always
    // appends at least one key to the message index.
    out[msgIndex] = withStringAt(out[msgIndex], rest, cut);
  }
  return out;
}

// Tokens a JSON client uses to mean "no" in a field the schema types as boolean.
const FALSY_STORE_TOKENS = new Set(['false', '0', 'no', 'off', '']);

/**
 * Does this `store` value ask for persistence?
 *
 * The check used to be `opts.store === false` — strict, on a value that arrives
 * RAW off the request body (handlers/responses.js passes `store: body.store` with
 * no normalization). So only a real JSON `false` opted out. MEASURED against HEAD:
 *   store=false  -> not stored (correct)
 *   store="false" / 0 / "no" / "off" / null / ""  -> ALL stored and retrievable
 * A client that spells the flag as a string — form-encoded relays, shell wrappers
 * and hand-rolled clients all do — got retention it explicitly opted out of, and
 * had no way to tell.
 *
 * WHERE this belongs: here, not only at the HTTP boundary. The retention decision
 * is the store's own contract ("`store:false` means this response is not
 * retained"), and the store is what would have to be audited if the promise were
 * broken. A boundary-only fix leaves the strict comparison in place for every
 * other caller, present and future, and this call site was added by exactly that
 * kind of later wiring. The boundary is still where a MALFORMED request should be
 * rejected outright; normalizing here means the store never over-retains even when
 * it is not.
 *
 * `undefined` means the field was absent, and the OpenAI default is store=true —
 * so absent must NOT read as opted out. An explicit `null` does: it is a value the
 * client chose to send, and for a retention decision the safe reading of an
 * ambiguous explicit value is "do not retain" (the cost is a 404 on a later chain
 * attempt, which is diagnosable; the cost of the other reading is silent retention
 * of data the caller may believe was never kept). An unrecognized token
 * ("maybe", {}) is not an opt-out signal and keeps the documented default.
 */
export function wantsPersistence(store) {
  if (store === undefined) return true;
  if (store === null) return false;
  if (typeof store === 'boolean') return store;
  if (typeof store === 'number') return store !== 0;
  if (typeof store === 'string') return !FALSY_STORE_TOKENS.has(store.trim().toLowerCase());
  return true;
}

/**
 * Store the accumulated conversation under a response id.
 *
 * @param {string} responseId  the id handed back to the client
 * @param {Array}  messages    FULL conversation for this turn (input + output)
 * @param {string} callerKey   tenant/identity scope
 * @param {object} [opts]      { model?: string, store?: boolean|string|number|null }
 * @returns {boolean} true when persisted
 */
export function putResponse(responseId, messages, callerKey, opts = {}) {
  if (!ENABLED || !responseId || !Array.isArray(messages) || !messages.length) return false;
  // The OpenAI contract: `store: false` means this response is not retained, so
  // it can never serve as a later previous_response_id. Normalized rather than
  // compared strictly — see wantsPersistence for what the strict check let through.
  if (!wantsPersistence(opts.store)) return false;
  // No caller scope means no way to isolate this conversation from another
  // tenant's — refuse rather than create a shared-readable entry.
  if (!callerKey) { _stats.rejected++; return false; }
  ensureSweepTimer();

  if (_entries.size >= MAX_ENTRIES && !_entries.has(responseId)) {
    // Fair share: a tenant already at or above its slice evicts its OWN oldest
    // conversation instead of a stranger's.
    const tenant = tenantOf(callerKey);
    const fairShare = Math.max(1, Math.floor(MAX_ENTRIES / Math.max(1, _tenantCounts.size)));
    const overShare = (_tenantCounts.get(tenant) || 0) >= fairShare;
    const victim = (overShare && oldestId(tenant)) || oldestId();
    if (victim) { dropEntry(victim); _stats.evictions++; }
  }

  const now = Date.now();
  const existing = _entries.get(responseId);
  // Existing limiters are copy-on-write. Clone only the retained graph, so
  // discarded history is not copied and no stored object aliases the caller.
  const kept = structuredClone(capEntryBytes(truncateMessages(messages)));
  const bytes = approxBytes(kept);
  const createdAt = existing?.createdAt || now;
  const model = opts.model || existing?.model || null;
  // The turn's terminal status, so a later retrieval reports what the CREATING
  // request reported. Without it GET had to hardcode 'completed' and contradicted
  // POST for the same id whenever the turn ended as `incomplete`.
  const status = opts.status || existing?.status || 'completed';
  const incompleteReason = opts.incompleteReason ?? existing?.incompleteReason ?? null;
  if (existing) dropEntry(responseId);
  trackInsert(callerKey, bytes);
  _entries.set(responseId, {
    messages: kept, callerKey, model, status, incompleteReason, createdAt, lastAccess: now, bytes,
  });
  _bytes += bytes;
  _stats.stored++;

  // Byte budget: entry/message counts bound cardinality, NOT memory, so evict
  // until the byte total fits as well.
  //
  // The fairness test must be BYTE-denominated. The first cut reused the count
  // test (`tenantCount >= MAX_ENTRIES / tenants`), which under any byte-bound
  // workload leaves the writer far below its entry share — so `overShare` was
  // always false, the loop fell through to the untenanted scan, and one caller
  // storing a large conversation flushed every other tenant's sessions.
  // Reproduced: 5 tenants x 5 conversations all readable, then a single 5MB write
  // evicted 25/25 of them. That is a cross-tenant DoS the count-only store never
  // had, so fairness here compares the tenant's BYTES against MAX_BYTES/tenants.
  //
  // `exclude: responseId` is load-bearing and NOT redundant with `size > 1`: the
  // Map-tail argument only holds for the untenanted scan. oldestId(tenant) can
  // return the entry just written when it is that tenant's oldest survivor, and
  // then putResponse returned true while the id 404'd immediately after
  // (reproduced with MAX=2, MAX_BYTES=200k). An earlier version dropped this
  // guard as dead code because the mutation test only exercised the untenanted
  // path.
  //
  // The share has a FLOOR. `MAX_BYTES / tenants` alone collapses as tenants grow:
  // at 600 tenants against the 2MB test budget the share is ~3.5KB, so every
  // tenant is over share, every iteration evicts the writer's own oldest, and once
  // the writer has nothing left of its own the loop breaks — with the budget still
  // blown. Reproduced: 600 tenants x one 20KB conversation → 5.88x the budget and
  // ZERO evictions, i.e. the byte bound stopped existing at exactly the scale it
  // was written to protect. The floor keeps eviction working past that point: a
  // tenant under MIN_TENANT_BYTES is treated as a small fry and the global LRU scan
  // reclaims from whoever is actually oldest, which is the only thing that can
  // bring a many-small-tenants total back under budget.
  let guard = _entries.size + 1;
  while (_bytes > MAX_BYTES && _entries.size > 1 && guard-- > 0) {
    const tenant = tenantOf(callerKey);
    const byteShare = Math.max(MIN_TENANT_BYTES, MAX_BYTES / Math.max(1, _tenantBytes.size));
    const overShare = (_tenantBytes.get(tenant) || 0) > byteShare;
    // An over-share tenant evicts its OWN oldest. If it has nothing of its own
    // left, stop — accepting a temporary overage is correct, because flushing
    // other tenants to make room for one caller is the DoS this guards against.
    // MAX_ENTRY_BYTES bounds how large that overage can be.
    const victim = overShare
      ? oldestId(tenant, responseId)
      : oldestId(null, responseId);
    if (!victim) break;
    dropEntry(victim);
    _stats.evictions++;
  }
  return true;
}

/**
 * Resolve a previous_response_id to its accumulated conversation.
 *
 * Returns a discriminated result so the caller can fail LOUDLY on a miss. Silently
 * proceeding with just the new turn is the bug this module exists to remove: the
 * model would answer with no context and the client could not tell.
 *
 * `createdAt` is returned so the retrieval endpoint can report the response's real
 * creation time instead of the time it happened to be read.
 *
 * @returns {{ ok: true, messages: Array, model: string|null, createdAt: number }
 *          | { ok: false, reason: 'disabled'|'not_found'|'expired'|'forbidden' }}
 */
export function getResponse(responseId, callerKey) {
  if (!ENABLED) return { ok: false, reason: 'disabled' };
  if (!responseId) return { ok: false, reason: 'not_found' };
  ensureSweepTimer();

  const entry = _entries.get(responseId);
  if (!entry) { _stats.misses++; return { ok: false, reason: 'not_found' }; }

  const now = Date.now();

  // Ownership is settled BEFORE anything is dropped. This used to be the other way
  // round: the expiry branch called dropEntry() and returned nine lines above this
  // guard, so a foreign caller who guessed a valid id DELETED the owner's expired
  // entry. Probing was indeed closed (the guard's own promise), but the branch above
  // it had already acted. MEASURED at RESPONSE_STORE_TTL_MS=60, entry owned by A:
  //   after expiry, B reads -> ok=false reason='expired'
  //   then A reads          -> ok=false reason='not_found'   <- B's read reaped it
  // Reordering keeps both properties, and the reason each case returns is:
  //   foreign caller, entry fresh OR expired -> 'forbidden', and NOTHING is dropped.
  //     The outward result is identical to a miss (handlers/responses.js maps
  //     'forbidden', 'expired' and 'not_found' to the same 404 body, so the reason
  //     was never the leak — the DELETION was), and the foreign caller now also
  //     cannot distinguish an expired id from a fresh one by its side effect.
  //   owner, entry expired -> 'expired', and the entry IS reaped, so the owner's
  //     own dead conversation is still collected on the lookup path rather than
  //     waiting for the 5-minute sweep.
  if (entry.callerKey !== callerKey) {
    _stats.rejected++;
    log.warn(`[response-store] rejected cross-caller lookup of ${String(responseId).slice(0, 24)}`);
    return { ok: false, reason: 'forbidden' };
  }

  // Two independent bounds, both reported as 'expired' because the client-visible
  // meaning is the same ("this conversation is gone, send full context"):
  // the IDLE timeout, which a read refreshes, and the ABSOLUTE age, which it does
  // not. Without the second one a periodic GET kept an entry alive without limit.
  if (isPastIdle(entry, now) || isPastMaxAge(entry, now)) {
    dropEntry(responseId);
    _stats.expires++;
    return { ok: false, reason: 'expired' };
  }

  entry.lastAccess = now;
  // Re-insert to keep Map order == LRU order.
  _entries.delete(responseId);
  _entries.set(responseId, entry);
  _stats.hits++;
  return {
    ok: true,
    // Each reader owns its result, including nested content/tool-call objects.
    messages: structuredClone(entry.messages),
    model: entry.model,
    createdAt: entry.createdAt,
    status: entry.status,
    incompleteReason: entry.incompleteReason,
  };
}

/** Explicit deletion (DELETE /v1/responses/{id}). Scoped like the lookup. */
export function deleteResponse(responseId, callerKey) {
  if (!ENABLED || !responseId) return false;
  const entry = _entries.get(responseId);
  if (!entry) return false;
  if (entry.callerKey !== callerKey) { _stats.rejected++; return false; }
  return dropEntry(responseId);
}

export function getResponseStoreStats() {
  return {
    ..._stats,
    size: _entries.size,
    bytes: _bytes,
    maxBytes: MAX_BYTES,
    // Both time bounds, reported for the same reason maxBytes is: an operator
    // asking "how long is a conversation kept?" has two different answers, and the
    // idle one on its own does not bound retention at all.
    ttlMs: TTL_MS,
    maxAgeMs: MAX_AGE_MS,
    enabled: ENABLED,
    tenants: _tenantCounts.size,
  };
}

/** Test/reset helper. */
export function resetResponseStore() {
  _entries.clear();
  _tenantCounts.clear();
  _tenantBytes.clear();
  _bytes = 0;
  for (const k of Object.keys(_stats)) _stats[k] = 0;
}

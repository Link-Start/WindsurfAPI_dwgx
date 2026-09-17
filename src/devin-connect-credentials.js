/**
 * DEVIN_CONNECT credential store — encrypted email/password at rest.
 *
 * WHY THIS EXISTS: the DEVIN_CONNECT session token (account.apiKey,
 * `devin-session-token$<JWT>`) is an opaque server-side session_id with NO
 * expiry claim and NO refresh path (Auth1 login returns hasRefresh:false). When
 * the server retires that session_id, the account goes permanently 'error' with
 * no recovery — a single point of failure for the whole DEVIN_CONNECT surface.
 *
 * The ONLY way to mint a fresh session token is a full email/password Auth1
 * login (windsurfLogin). So to auto-recover, we must hold the password. This
 * module keeps those credentials encrypted at rest with AES-256-GCM under a key
 * derived from the operator-supplied DEVIN_CONNECT_CRED_KEY.
 *
 * SECURITY POSTURE:
 *   - OFF by default: no DEVIN_CONNECT_CRED_KEY → store is disabled, nothing is
 *     written or read. Auto-relogin simply never triggers.
 *   - Key never touches disk; only the AES-GCM ciphertext + per-record salt/iv
 *     /authTag are persisted (accounts.creds.json, gitignored).
 *   - Plaintext passwords are NEVER logged. Callers reference records by email.
 *   - Tampering or a wrong key fails closed (GCM auth tag mismatch → throw).
 *
 * File shape (accounts.creds.json):
 *   { "v": 1, "records": { "<email-lower>": { salt, iv, tag, ct } } }   (all hex)
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, openSync, closeSync, unlinkSync, realpathSync, readdirSync, statSync, existsSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomUUID } from 'crypto';
import { hostname, uptime } from 'os';
import { config, log } from './config.js';
import { bumpConnect, __registerCredHealth } from './devin-connect-metrics.js';

// Bump the repair counter without letting a metrics hiccup break a cred read.
function bumpCredRepaired() {
  try { bumpConnect('cred_store_repaired'); } catch { /* metrics are best-effort */ }
}

function credFilePath(env = process.env) {
  return env.DEVIN_CONNECT_CRED_FILE
    || join(config.sharedDataDir || config.dataDir, 'accounts.creds.json');
}
const SCRYPT_KEYLEN = 32;             // AES-256
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const ALGO = 'aes-256-gcm';
const FILE_VERSION = 1;

// Decrypt-failure signal. A GCM auth-tag mismatch means the master key is wrong
// (rotated/typo'd) or the record is tampered — and because every record is
// keyed off the SAME master key, a wrong key fails IDENTICALLY for the whole
// fleet, silently disabling all auto-relogin. We surface that as a counter +
// last-error so ops/observability can alarm on it instead of it hiding in a
// per-account warn. Distinct from "credential absent", which is normal.
let _decryptFailures = 0;
let _lastDecryptError = null;
export function getCredHealth() {
  return { decryptFailures: _decryptFailures, lastDecryptError: _lastDecryptError };
}
export function resetCredHealth() { _decryptFailures = 0; _lastDecryptError = null; }

/** Resolve the master key material from env. Empty → store disabled. */
export function getCredKey(env = process.env) {
  return String(env.DEVIN_CONNECT_CRED_KEY || '').trim();
}

/** True when credential storage is enabled (a master key is configured). */
export function isCredStoreEnabled(env = process.env) {
  return getCredKey(env).length > 0;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

/** Derive a per-record AES key from the master key + record salt. */
function deriveKey(masterKey, salt) {
  return scryptSync(masterKey, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
}

// A stored record is { salt, iv, tag, ct } with all values lowercase hex. We
// validate shape before trusting a salvaged record so regex recovery can't
// inject garbage that later throws deep in the cipher.
function isValidRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  for (const f of ['salt', 'iv', 'tag', 'ct']) {
    if (typeof rec[f] !== 'string' || !/^[0-9a-fA-F]+$/.test(rec[f]) || rec[f].length === 0) return false;
  }
  return true;
}

// Tier 2: best-effort repair of a structurally-broken JSON wrapper before
// giving up. Handles the common real-world corruptions: a UTF-8 BOM, a trailing
// comma, and a half-written file truncated mid-object (crash/disk-full between
// write and rename, or a botched manual edit) — recover the largest prefix that
// closes cleanly at the last balanced `}`.
function tryRepairJson(text) {
  let s = String(text).replace(/^﻿/, '').trim();
  // Truncate to the last closing brace so a tail-truncated file still parses
  // its complete records.
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace !== -1) s = s.slice(0, lastBrace + 1);
  // Drop a dangling comma before the closing brace(s).
  s = s.replace(/,\s*(}|])/g, '$1');
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === 'object' && typeof parsed.records === 'object') return parsed;
  } catch { /* fall through to tier 3 */ }
  return null;
}

// Tier 3: the JSON wrapper is unsalvageable, but every record is an independent
// encrypted blob. Scan the raw text for `"<email>": { salt, iv, tag, ct }`
// fragments and rebuild the records map one entry at a time, keeping only those
// that pass shape validation. One mangled record is dropped; the rest survive.
function salvageRecordsByRegex(text) {
  const records = Object.create(null);
  // Match an email-ish key followed by an object literal containing the four
  // hex fields in any order. Non-greedy object body, capped to avoid runaway.
  const entryRe = /"([^"\n]+?)"\s*:\s*\{([^{}]{0,4000}?)\}/g;
  const fieldRe = (name) => new RegExp(`"${name}"\\s*:\\s*"([0-9a-fA-F]+)"`);
  let m;
  while ((m = entryRe.exec(text)) !== null) {
    const key = m[1];
    const body = m[2];
    const rec = {};
    let ok = true;
    for (const f of ['salt', 'iv', 'tag', 'ct']) {
      const fm = body.match(fieldRe(f));
      if (!fm) { ok = false; break; }
      rec[f] = fm[1];
    }
    if (ok && isValidRecord(rec) && key !== 'records' && key !== 'v') records[key] = rec;
  }
  return records;
}

// Synchronous callers already run to completion on one event loop. This guard
// also rejects reentrant calls; returning success for queued work would break
// the existing boolean/throw API and lose persistence errors at its callers.
const _saveInFlight = new Set();
// file → the claim INSTANCE this process holds. The instance, not the path, is
// the lock, so a release can only give back the exact claim that was taken.
const _heldClaims = new Map();

function credentialStoreError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function credentialStoreBusy() {
  return credentialStoreError('ERR_CRED_STORE_BUSY');
}

function canonicalCredFile(env) {
  const file = resolve(credFilePath(env));
  return join(realpathSync(dirname(file)), basename(file));
}

// ─── The store lock: claims are INSTANCES, never a path ─────────────────────
//
//   <store>.lock/                             coordination directory, kept forever
//     format.json                             {"v":2} — this directory is ours
//     claim-<host>-<pid>-<boot>-<token>/      one immutable claim per writer
//     owner.json                              pre-v2 stamp (legacy, read-only)
//
// WHY. The old layout kept a single owner.json at a fixed path and reclaimed it
// by re-reading that path, so two reclaimers could both judge the same dead
// owner and the slower one then deleted whatever occupied the path by then —
// including the lock a new writer had just taken (2026-09-17 review, P1). Here
// the identity IS the directory name, so a reclaim can only ever delete the
// exact instance whose writer it proved dead. Reclaim and release both name an
// instance, never a shared path, so "read once more before unlink" is not needed
// and the TOCTOU cannot come back.
//
// Nothing is written inside a claim, so mkdir publishes the whole identity in
// one atomic step: a writer killed at any instruction leaves either no claim or
// a complete, self-describing one. That is also why a partial write can no
// longer fence the store (2026-09-17 review, P2): there is no stamp to tear.
//
// Mutually exclusive because the container is read AFTER this writer's claim is
// created. Two writers can both be past their read only if each missed the
// other's claim, which requires the second claim to be created after the first
// read — but then the second read is later still and sees the first claim. A
// live claim is never removed, so the loser reads BUSY.
//
// LIMITS, stated rather than implied. Death is only provable for a same-host,
// same-boot pid (ESRCH) or for a claim older than this boot; a recycled pid that
// is now some unrelated live process therefore reads as BUSY, and a foreign host
// always does. A pre-v2 (owner.json) holder is refused unless its pid is provably
// dead. Worker threads share a pid, so a claim is held per process, not per
// thread. Finally this trusts the platform's readdir/mkdir visibility, i.e. a
// local filesystem, the same assumption the old mkdir-based lock already made.
const LOCK_FORMAT = 2;
const CLAIM_PREFIX = 'claim-';
const FORMAT_FILE = 'format.json';
const LEGACY_OWNER_FILE = 'owner.json';
const FORMAT_MARKER = JSON.stringify({ v: LOCK_FORMAT });
const CLAIM_ATTEMPTS = 3;
// A directory with no marker may belong to a pre-v2 writer that is still between
// its mkdir and its stamp, so one is adopted only once it has been untouched for
// this long. Nothing sleeps on it — the next save finds it settled.
const LEGACY_SETTLE_MS = 2000;
// A claim older than this machine's current boot cannot belong to a running
// process, which is what stops a reboot + recycled pid from fencing the store
// forever. The slack absorbs clock granularity; the comparison only ever proves
// death, never life, and it is only applied to this host's own claims.
const BOOT_SLACK_SECONDS = 5;

// Hex, not the raw name: it survives any hostname character and compares exactly.
function hostTag(host = hostname()) {
  return Buffer.from(String(host), 'utf8').toString('hex');
}

function lockDir(file) {
  return `${file}.lock`;
}

function claimName(token = randomUUID().replace(/-/g, '')) {
  return `${CLAIM_PREFIX}${hostTag()}-${process.pid}-${Math.max(0, Math.floor(uptime()))}-${token}`;
}

// Anything this module did not create parses to null, and callers must treat
// null as an occupant they cannot prove dead — never as something reclaimable.
function parseClaim(name) {
  if (typeof name !== 'string' || !name.startsWith(CLAIM_PREFIX)) return null;
  const parts = name.slice(CLAIM_PREFIX.length).split('-');
  if (parts.length !== 4) return null;
  const [host, pid, boot, token] = parts;
  if (!/^[0-9a-f]{2,512}$/.test(host)) return null;
  if (!/^[1-9][0-9]{0,9}$/.test(pid)) return null;
  if (!/^[0-9]{1,12}$/.test(boot)) return null;
  if (!/^[0-9a-f]{16,64}$/.test(token)) return null;
  return { host, pid: Number(pid), boot: Number(boot), token, name };
}

// 'dead' = this host provably cannot be running that writer any more. 'live' and
// 'unknown' both fence the store; 'unknown' covers another host, an EPERM we
// cannot interpret, and our own clock disagreeing with the claim.
function claimState(claim) {
  if (claim.host !== hostTag()) return 'unknown';
  if (Math.floor(uptime()) + BOOT_SLACK_SECONDS < claim.boot) return 'dead';
  try {
    process.kill(claim.pid, 0);
    return 'live';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

// Remove one claim INSTANCE. The name is the identity, so this can only delete
// the exact instance the caller proved dead. Never recursive: a claim is a leaf.
function removeClaim(dir, name) {
  const target = join(dir, name);
  let entries;
  try { entries = readdirSync(target, { withFileTypes: true }); }
  catch { return true; }                              // already gone
  for (const entry of entries) {
    if (!entry.isFile()) return false;
    try { unlinkSync(join(target, entry.name)); } catch { return false; }
  }
  try { rmdirSync(target); return true; } catch { return false; }
}

function markerState(dir) {
  let raw;
  try { raw = readFileSync(join(dir, FORMAT_FILE), 'utf8'); }
  catch (error) { return error.code === 'ENOENT' ? 'absent' : 'broken'; }
  try { return JSON.parse(raw)?.v === LOCK_FORMAT ? 'ok' : 'broken'; }
  catch { return 'broken'; }
}

// Pre-v2 stamp: the only legacy ownership this code understands. Its pid is
// checkable on this host; anything unreadable, foreign or malformed is 'unknown'
// and is refused instead of stolen. No age rule, no boot rule: a paused pre-v2
// writer can still resume and publish, so only the OS may call it dead.
function legacyOwnerState(dir) {
  let owner;
  try { owner = JSON.parse(readFileSync(join(dir, LEGACY_OWNER_FILE), 'utf8')); }
  catch { return 'unknown'; }
  if (!owner || typeof owner.host !== 'string' || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return 'unknown';
  if (owner.host !== hostname()) return 'unknown';
  try {
    process.kill(owner.pid, 0);
    return 'live';
  } catch (error) {
    return error.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

// Publish the marker through a rename so a torn marker can never exist: a
// half-written one would be indistinguishable from a foreign directory and would
// fence the store for good.
function writeFormatMarker(dir) {
  const tmp = join(dir, `.format.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
  try {
    writeFileSync(tmp, FORMAT_MARKER, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, join(dir, FORMAT_FILE));
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw error;
  }
}

// Bring the coordination directory to a state a claim can be created in, or
// refuse. Everything this code cannot prove dead is a refusal: a live or foreign
// writer, a damaged marker, an unknown artifact — and a pre-v2 directory is
// adopted only when its stamp is provably dead or when it has settled empty.
function openContainer(dir, attempt = 0) {
  let created = false;
  try { mkdirSync(dir, { mode: 0o700 }); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created) {
    try { writeFormatMarker(dir); }
    catch (error) {
      // A container without its marker is ambiguous to every later writer, and
      // it is empty and ours — hand it back instead of fencing the store. The
      // original error (ENOSPC/EACCES/...), not BUSY, reaches the caller.
      try { rmdirSync(dir); } catch { /* an operator can still remove it */ }
      throw error;
    }
    return;
  }
  let info = null;
  try { info = statSync(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (info === null) {
    if (attempt >= 1) throw credentialStoreBusy();
    return openContainer(dir, attempt + 1);      // a pre-v2 holder released it between the calls
  }
  if (!info.isDirectory()) throw credentialStoreBusy();
  const marker = markerState(dir);
  if (marker === 'broken') throw credentialStoreBusy();
  if (marker === 'ok') return;
  const entries = readdirSync(dir);
  for (const entry of entries) {
    if (entry !== LEGACY_OWNER_FILE) throw credentialStoreBusy();
  }
  if (entries.length === 0) {
    // Old writers left this behind (crash between mkdir and stamp) or a v2
    // bootstrap died before its marker landed: a settled empty directory is
    // adopted, a fresh one may still be initializing and is refused.
    if (Date.now() - info.mtimeMs < LEGACY_SETTLE_MS) throw credentialStoreBusy();
  } else {
    if (legacyOwnerState(dir) !== 'dead') throw credentialStoreBusy();
    try { unlinkSync(join(dir, LEGACY_OWNER_FILE)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    log.warn('credential store lock upgraded: removed the stamp of a dead pre-v2 writer');
  }
  writeFormatMarker(dir);
}

// Read the container AFTER this writer's claim was created — that read is what
// makes the claim exclusive (see the block comment above). Provably dead
// instances are cleaned up here; everything else is reported as the blocker.
function sweepClaims(dir, ownName) {
  let blocker = null;
  for (const entry of readdirSync(dir)) {
    if (entry === FORMAT_FILE || entry === ownName) continue;
    if (entry === LEGACY_OWNER_FILE) {
      if (legacyOwnerState(dir) !== 'dead') { if (!blocker) blocker = entry; continue; }
      // A dead pre-v2 stamp occupies nothing. It can only be litter here: a
      // pre-v2 writer's own mkdir would have failed on an existing directory.
      try { unlinkSync(join(dir, entry)); } catch { /* the next writer retries */ }
      continue;
    }
    const claim = parseClaim(entry);
    if (!claim) { if (!blocker) blocker = entry; continue; }   // not ours: never touched
    if (claimState(claim) !== 'dead') { if (!blocker) blocker = entry; continue; }
    if (removeClaim(dir, entry)) log.warn(`credential store lock reclaimed from a dead writer (pid ${claim.pid})`);
    else log.warn(`credential store: dead claim ${entry} could not be removed; it does not fence writes`);
  }
  return blocker;
}

function acquireClaim(file) {
  const dir = lockDir(file);
  openContainer(dir);
  let name = null;
  for (let tries = 0; tries < CLAIM_ATTEMPTS && !name; tries++) {
    const candidate = claimName();
    try { mkdirSync(join(dir, candidate), { mode: 0o700 }); name = candidate; }
    catch (error) {
      // Only a token collision is expected to be EEXIST; anything else (ENOSPC
      // included) created nothing, so it is reported as itself, not as BUSY.
      if (error.code !== 'EEXIST') throw error;
    }
  }
  if (!name) throw credentialStoreBusy();
  const claim = { dir, name, path: join(dir, name) };
  const blocker = sweepClaims(dir, name);
  if (blocker) {
    releaseClaim(claim);
    log.warn(`credential store lock held elsewhere (${blocker}); refusing to write`);
    throw credentialStoreBusy();
  }
  return claim;
}

function releaseClaim(claim) {
  try { rmdirSync(claim.path); return true; }
  catch (error) {
    if (error.code === 'ENOENT') return true;         // already gone, nothing to give back
    // A completed rename remains committed; the surviving claim instance fences
    // later writes exactly as long as this process can still publish.
    log.error(`credential store lock release failed (${error.code || 'UNKNOWN'}); writes remain fenced`);
    return false;
  }
}

// Last check before publishing. Two things must hold: this writer still holds
// its own claim INSTANCE, and no live/unknown occupant shares the container.
// The read below is the serialisation point — of two writers that both reach it,
// the later one sees the earlier one's claim (a live writer never gives its claim
// up) and refuses, so the two cannot both publish. Provably dead instances are
// ignored: they cannot publish anything.
function assertExclusive(file) {
  const claim = _heldClaims.get(file);
  if (!claim) throw credentialStoreError('ERR_CRED_STORE_UNLOCKED');
  if (!existsSync(claim.path)) throw credentialStoreBusy();
  for (const entry of readdirSync(claim.dir)) {
    if (entry === FORMAT_FILE || entry === claim.name) continue;
    if (entry === LEGACY_OWNER_FILE) {
      if (legacyOwnerState(claim.dir) !== 'dead') throw credentialStoreBusy();
      continue;
    }
    const other = parseClaim(entry);
    if (!other || claimState(other) !== 'dead') throw credentialStoreBusy();
  }
}

function withStoreLock(env, operation) {
  const file = canonicalCredFile(env);
  if (_saveInFlight.has(file)) throw credentialStoreBusy();
  _saveInFlight.add(file);
  let claim = null;
  try {
    claim = acquireClaim(file);
    _heldClaims.set(file, claim);
    return operation({ ...env, DEVIN_CONNECT_CRED_FILE: file });
  } finally {
    if (claim) {
      _heldClaims.delete(file);
      releaseClaim(claim);
    }
    _saveInFlight.delete(file);
  }
}

function copyRecordMap(records) {
  return Object.assign(Object.create(null), records || {});
}

function isStoreShape(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.records && typeof value.records === 'object' && !Array.isArray(value.records);
}

function readSnapshot(env) {
  let raw;
  try {
    raw = readFileSync(credFilePath(env));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { store: { v: FILE_VERSION, records: copyRecordMap() }, raw: null, corrupt: false };
  }
  const text = raw.toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (isStoreShape(parsed)) {
      return { store: { v: parsed.v || FILE_VERSION, records: copyRecordMap(parsed.records) }, raw, corrupt: false };
    }
  } catch { /* Inspect both recovery tiers without modifying the source. */ }

  const repaired = tryRepairJson(text);
  const salvaged = salvageRecordsByRegex(text);
  // Tier 2 can recover only a prefix. Always include intact tier-3 records
  // outside that prefix instead of publishing the smaller successful tier.
  const records = copyRecordMap(salvaged);
  if (isStoreShape(repaired)) Object.assign(records, repaired.records);
  return { store: { v: repaired?.v || FILE_VERSION, records }, raw, corrupt: true };
}

function assertRecordSetPreserved(before, after, removed = []) {
  const allowedRemovals = new Set(removed);
  for (const key of Object.keys(before)) {
    if (!allowedRemovals.has(key) && !Object.hasOwn(after, key)) {
      throw credentialStoreError('ERR_CRED_STORE_RECORD_LOSS');
    }
  }
}

function preserveCorruptSource(snapshot, env) {
  if (!snapshot.corrupt || snapshot.raw === null) return;
  const backup = `${credFilePath(env)}.corrupt.${process.pid}.${randomUUID()}.bak`;
  // Preserve the original bytes, not a UTF-8 roundtrip or a salvaged subset.
  // Failure must abort publication. Backups are never automatically merged
  // later: without tombstones that would resurrect deliberate deletions.
  writeFileSync(backup, snapshot.raw, { mode: 0o600, flag: 'wx' });
}

function writeStore(store, env = process.env) {
  const file = credFilePath(env);
  if (!_saveInFlight.has(file)) throw credentialStoreError('ERR_CRED_STORE_UNLOCKED');
  // Ownership is an instance, not a path: if this writer's claim is gone, or a
  // live competitor appeared since the lock was taken, the snapshot read below
  // (or already read) may be superseded, and publishing it would drop the
  // winner's records. Never publish without the exclusive instance.
  assertExclusive(file);
  // Match auth.js:617-622 and fs-atomic.js:111-121. Exclusive creation also
  // turns an improbable random-name collision into an error, not truncation.
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  let fd;
  let owned = false;
  let published = false;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    owned = true;
    writeFileSync(fd, JSON.stringify(store, null, 2));
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, file);
    published = true;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); }
      catch (error) { log.error(`credential store tmp close failed (${error.code || 'UNKNOWN'})`); }
    }
    if (owned && !published) {
      try { unlinkSync(tmp); }
      catch (error) {
        if (error.code !== 'ENOENT') log.error(`credential store tmp cleanup failed (${error.code || 'UNKNOWN'})`);
      }
    }
  }
}

function commitSnapshot(snapshot, next, env, removed = []) {
  assertRecordSetPreserved(snapshot.store.records, next.records, removed);
  preserveCorruptSource(snapshot, env);
  writeStore(next, env);
  if (snapshot.corrupt) {
    bumpCredRepaired();
    log.error(`credential store repaired; original bytes retained; published ${Object.keys(next.records).length} record(s)`);
  }
}

function readStore(env = process.env) {
  const first = readSnapshot(env);
  if (!first.corrupt) return first.store;
  if (Object.keys(first.store.records).length === 0) {
    bumpCredRepaired();
    log.error('credential store unrepairable; no intact records; source retained without overwrite');
    return first.store;
  }
  try {
    return withStoreLock(env, lockedEnv => {
      // Another writer may have published or deleted records since the first
      // read. Never heal from that stale snapshot, even if it has more keys.
      const current = readSnapshot(lockedEnv);
      if (current.corrupt && Object.keys(current.store.records).length > 0) {
        commitSnapshot(current, current.store, lockedEnv);
      }
      return current.store;
    });
  } catch (error) {
    bumpCredRepaired();
    log.warn(`credential store repair deferred (${error.code || 'UNKNOWN'}); source not overwritten by this reader`);
    return first.store;
  }
}

/**
 * Encrypt and persist a password for an email. No-op (returns false) when the
 * store is disabled. Plaintext is never logged.
 */
export function storeCredential(email, password, env = process.env) {
  const masterKey = getCredKey(env);
  if (!masterKey) return false;
  const key = normalizeEmail(email);
  if (!key || !password) throw new Error('storeCredential: email and password required');

  const salt = randomBytes(16);
  const iv = randomBytes(12); // 96-bit nonce, GCM standard
  const aesKey = deriveKey(masterKey, salt);
  const cipher = createCipheriv(ALGO, aesKey, iv);
  const ct = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  withStoreLock(env, lockedEnv => {
    const snapshot = readSnapshot(lockedEnv);
    const store = { v: snapshot.store.v, records: copyRecordMap(snapshot.store.records) };
    store.records[key] = {
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ct: ct.toString('hex'),
    };
    commitSnapshot(snapshot, store, lockedEnv);
  });
  log.info(`credential stored for ${key.replace(/(.{2}).*(@.*)/, '$1***$2')}`);
  return true;
}

/** True if an encrypted credential exists for this email (no decryption). */
export function hasCredential(email, env = process.env) {
  if (!isCredStoreEnabled(env)) return false;
  return Boolean(readStore(env).records[normalizeEmail(email)]);
}

/**
 * Decrypt and return the stored password for an email, or null when absent /
 * store disabled. Throws on a wrong key or tampered record (GCM auth failure) —
 * callers should treat that as "credential unusable", not "absent".
 */
export function getCredential(email, env = process.env) {
  const masterKey = getCredKey(env);
  if (!masterKey) return null;
  const rec = readStore(env).records[normalizeEmail(email)];
  if (!rec) return null;

  try {
    const aesKey = deriveKey(masterKey, Buffer.from(rec.salt, 'hex'));
    const decipher = createDecipheriv(ALGO, aesKey, Buffer.from(rec.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(rec.tag, 'hex'));
    const pt = Buffer.concat([decipher.update(Buffer.from(rec.ct, 'hex')), decipher.final()]);
    // A successful decrypt proves the key is right — clear any stale alarm.
    if (_decryptFailures > 0) { _decryptFailures = 0; _lastDecryptError = null; }
    return pt.toString('utf8');
  } catch (e) {
    // Wrong/rotated master key or tampered record — fleet-wide self-heal is now
    // broken. Track it loudly (counter + a single error-level line) so it can be
    // alarmed on, instead of vanishing into a per-account debug warn. Re-throw so
    // the caller still treats this as "credential unusable", not "absent".
    _decryptFailures += 1;
    _lastDecryptError = e.message;
    log.error(`DEVIN_CONNECT credential decrypt FAILED (wrong/rotated DEVIN_CONNECT_CRED_KEY or tampered store?) — auto-relogin is DISABLED until fixed. failures=${_decryptFailures}`);
    throw e;
  }
}

/** Remove a stored credential. Returns true if a record was deleted. */
export function deleteCredential(email, env = process.env) {
  if (!isCredStoreEnabled(env)) return false;
  const key = normalizeEmail(email);
  return withStoreLock(env, lockedEnv => {
    const snapshot = readSnapshot(lockedEnv);
    if (!Object.hasOwn(snapshot.store.records, key)) return false;
    const store = { v: snapshot.store.v, records: copyRecordMap(snapshot.store.records) };
    delete store.records[key];
    commitSnapshot(snapshot, store, lockedEnv, [key]);
    return true;
  });
}

/** List emails with stored credentials (for ops/diagnostics; no secrets). */
export function listCredentialEmails(env = process.env) {
  if (!isCredStoreEnabled(env)) return [];
  return Object.keys(readStore(env).records);
}

export const __testing = { credFilePath, deriveKey, normalizeEmail, tryRepairJson, salvageRecordsByRegex, isValidRecord, readStore, assertRecordSetPreserved, lockDir, claimName, parseClaim, claimState, removeClaim, legacyOwnerState, markerState, openContainer, acquireClaim, releaseClaim, sweepClaims };

// Surface decrypt health through the central connect-metrics endpoint without a
// static import cycle (metrics → credentials → config → ...). Registered at
// import time; the metrics module calls back into getCredHealth on demand.
__registerCredHealth(getCredHealth);

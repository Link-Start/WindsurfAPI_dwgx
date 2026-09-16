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

import { readFileSync, writeFileSync, renameSync, mkdirSync, rmdirSync, openSync, closeSync, unlinkSync, realpathSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomUUID } from 'crypto';
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

function credentialStoreError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function canonicalCredFile(env) {
  const file = resolve(credFilePath(env));
  return join(realpathSync(dirname(file)), basename(file));
}

function withStoreLock(env, operation) {
  const file = canonicalCredFile(env);
  if (_saveInFlight.has(file)) throw credentialStoreError('ERR_CRED_STORE_BUSY');
  const lock = `${file}.lock`;
  let held = false;
  _saveInFlight.add(file);
  try {
    try {
      // Non-recursive mkdir is the cross-process claim. Never steal by age:
      // a paused writer can still resume and publish its old snapshot.
      mkdirSync(lock, { mode: 0o700 });
      held = true;
    } catch (error) {
      if (error.code === 'EEXIST') throw credentialStoreError('ERR_CRED_STORE_BUSY');
      throw error;
    }
    return operation({ ...env, DEVIN_CONNECT_CRED_FILE: file });
  } finally {
    if (held) {
      try {
        rmdirSync(lock);
      } catch (error) {
        // A completed rename remains committed. The surviving lock fences
        // later writes until an operator resolves the cleanup failure.
        log.error(`credential store lock release failed (${error.code || 'UNKNOWN'}); writes remain fenced`);
      }
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

export const __testing = { credFilePath, deriveKey, normalizeEmail, tryRepairJson, salvageRecordsByRegex, isValidRecord, readStore, assertRecordSetPreserved };

// Surface decrypt health through the central connect-metrics endpoint without a
// static import cycle (metrics → credentials → config → ...). Registered at
// import time; the metrics module calls back into getCredHealth on demand.
__registerCredHealth(getCredHealth);

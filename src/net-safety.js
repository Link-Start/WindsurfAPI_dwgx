import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns';

function ipv4ToInt(ip) {
  const parts = ip.split('.').map(n => Number(n));
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return (((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0;
}

function ipv4InCidr(ip, base, bits) {
  const n = ipv4ToInt(ip);
  const b = ipv4ToInt(base);
  if (n == null || b == null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (n & mask) === (b & mask);
}

function expandIpv6(ip) {
  let input = ip.toLowerCase();
  const zone = input.indexOf('%');
  if (zone !== -1) input = input.slice(0, zone);
  if (input === '::') return Array(8).fill(0);
  const [leftRaw, rightRaw] = input.split('::');
  const left = leftRaw ? leftRaw.split(':').filter(Boolean) : [];
  const right = rightRaw ? rightRaw.split(':').filter(Boolean) : [];
  const parsePart = (part) => {
    if (part.includes('.')) {
      const n = ipv4ToInt(part);
      if (n == null) return [];
      return [(n >>> 16) & 0xffff, n & 0xffff];
    }
    return [parseInt(part || '0', 16)];
  };
  const leftNums = left.flatMap(parsePart);
  const rightNums = right.flatMap(parsePart);
  const missing = 8 - leftNums.length - rightNums.length;
  if (missing < 0) return null;
  return [...leftNums, ...Array(missing).fill(0), ...rightNums].map(n => Number.isFinite(n) ? n : 0);
}

function ipv6StartsWith(ip, prefix, bits) {
  const a = expandIpv6(ip);
  const p = expandIpv6(prefix);
  if (!a || !p) return false;
  let remaining = bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const take = Math.min(16, remaining);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((a[i] & mask) !== (p[i] & mask)) return false;
    remaining -= take;
  }
  return true;
}

// ─── IPv4-in-IPv6 carrier prefixes ─────────────────────────
//
// isPrivateIp must block "private space", and these prefixes CARRY an IPv4
// address in their low bits. Blocking v4 private space while letting its
// carriers through is a bypass: measured 2026-09-13, all of
// `64:ff9b:1::7f00:1` (NAT64 local-use, RFC 8215), `2002:7f00:1::1` (6to4,
// RFC 3056), `2001:0:c0a8:101::1` (Teredo, RFC 4380) and `::127.0.0.1`
// (v4-compatible) returned false while embedding loopback/RFC1918. The surface
// is real: src/image.js:423/436 gates image fetches on this, and net-safety's
// own proxy checks (:150/:158/:190/:203/:206) throw ERR_PROXY_PRIVATE_IP on it.

/**
 * Last 32 bits of an expanded IPv6 as a dotted quad — for the prefixes whose
 * embedded IPv4 sits in the LOW 32 bits: NAT64 (well-known `64:ff9b::/96` and
 * local-use `64:ff9b:1::/48`) and v4-compatible `::a.b.c.d`.
 *
 * The words are 6 and 7, NOT 4 and 5. Getting that wrong is silent: the
 * extracted "v4" reads 0.0.0.0, the caller is told the embedded address is not
 * private, and `::127.0.0.1` stays reachable. The first version of this fix had
 * exactly that defect — the tests caught it.
 */
function trailingIpv4(parts) {
  if (!parts || parts.length !== 8) return null;
  return `${parts[6] >>> 8}.${parts[6] & 255}.${parts[7] >>> 8}.${parts[7] & 255}`;
}

/** 6to4 2002::/16 — the embedded v4 is bits 16..48, i.e. words 1 and 2. */
function sixtofourIpv4(parts) {
  if (!parts || parts.length !== 8) return null;
  return `${parts[1] >>> 8}.${parts[1] & 255}.${parts[2] >>> 8}.${parts[2] & 255}`;
}

/** Teredo 2001:0::/32 — the client v4 is bits 64..96, stored one's-complemented. */
function teredoClientIpv4(parts) {
  if (!parts || parts.length !== 8) return null;
  const b = [parts[6] >>> 8, parts[6] & 255, parts[7] >>> 8, parts[7] & 255].map((x) => (~x) & 255);
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`;
}

/**
 * `::a.b.c.d` → `::aa:bb:cc:dd`, for the v4-COMPATIBLE branch only.
 *
 * Why: a dotted quad is ONE colon-separated field, so `'::127.0.0.1'.split(':')`
 * is `['', '', '127.0.0.1']` and expandIpv6 yields fewer than 8 words, which
 * makes trailingIpv4 return null. Note the asymmetry this hides: expandIpv6 DOES
 * splice a dotted quad into two words when it sits in the right-hand group of a
 * longer address — that is why the 6to4 / Teredo branches worked first try and
 * this one did not.
 */
function v4CompatibleToHexGroups(ip) {
  const m = ip.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (!m) return null;
  const n = ipv4ToInt(m[1]);
  if (n == null) return null;
  const g = (x) => x.toString(16).padStart(4, '0');
  return `::${g((n >>> 16) & 0xffff)}:${g(n & 0xffff)}`;
}

function mappedIpv4(ip) {
  const m = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return m[1];
  const parts = expandIpv6(ip);
  if (!parts) return null;
  if (parts.slice(0, 5).every(n => n === 0) && parts[5] === 0xffff) {
    return `${parts[6] >>> 8}.${parts[6] & 255}.${parts[7] >>> 8}.${parts[7] & 255}`;
  }
  return null;
}

export function isPrivateIp(address) {
  if (!address) return false;
  const ip = String(address).replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = mappedIpv4(ip);
  if (mapped) return isPrivateIp(mapped);
  const family = net.isIP(ip);
  // v4-compatible \`::a.b.c.d\` carries an IPv4 in its low bits and is not a normal
  // address family — net.isIP may report 0 for exotic spellings, which would fall
  // straight through to \`return false\`. Handled before the family switch because
  // there is no family to switch on.
  if (family === 0) {
    const cp = expandIpv6(v4CompatibleToHexGroups(ip) || ip);
    if (cp && cp.slice(0, 6).every((n) => n === 0)) {
      const compat = trailingIpv4(cp);
      if (compat && compat !== '0.0.0.0') return isPrivateIp(compat);
    }
    return false;
  }
  if (family === 4) {
    return ipv4InCidr(ip, '0.0.0.0', 8)
      || ipv4InCidr(ip, '10.0.0.0', 8)
      || ipv4InCidr(ip, '100.64.0.0', 10)
      || ipv4InCidr(ip, '127.0.0.0', 8)
      || ipv4InCidr(ip, '169.254.0.0', 16)
      || ipv4InCidr(ip, '172.16.0.0', 12)
      || ipv4InCidr(ip, '192.168.0.0', 16)
      // M2 (Grok audit, SSRF W4): IETF special-use / non-routable ranges an
      // attacker could still aim an SSRF at. 192.0.0.0/24 is NOT covered by
      // 192.168/16 (different mask). TEST-NET-1/2/3 + benchmarking + multicast
      // + reserved are all non-public and must be blocked like private space.
      || ipv4InCidr(ip, '192.0.0.0', 24)      // IETF protocol assignments
      || ipv4InCidr(ip, '192.0.2.0', 24)      // TEST-NET-1 (RFC 5737)
      || ipv4InCidr(ip, '198.18.0.0', 15)     // benchmarking (RFC 2544)
      || ipv4InCidr(ip, '198.51.100.0', 24)   // TEST-NET-2
      || ipv4InCidr(ip, '203.0.113.0', 24)    // TEST-NET-3
      || ipv4InCidr(ip, '224.0.0.0', 4)       // multicast (224/4)
      || ipv4InCidr(ip, '240.0.0.0', 4);      // reserved / future use (240/4)
  }
  if (family === 6) {
    const parts = expandIpv6(v4CompatibleToHexGroups(ip) || ip);
    // Carrier prefixes whose low bits ARE an IPv4 address: recurse on the embedded
    // v4 so private/loopback cannot be smuggled in through them. The \`64:ff9b::\`
    // branch below stays the well-known NAT64 prefix; this set adds the local-use
    // NAT64 prefix plus 6to4 / Teredo / v4-compatible.
    if (parts && parts.slice(0, 6).every((n) => n === 0)) {
      const compat = trailingIpv4(parts);
      if (compat && compat !== '0.0.0.0') return isPrivateIp(compat);
    }
    if (parts && parts[0] === 0x0064 && parts[1] === 0xff9b && parts[2] === 0x0001) {
      const nat64Local = trailingIpv4(parts);
      if (nat64Local) return isPrivateIp(nat64Local);
    }
    if (ipv6StartsWith(ip, '2002::', 16)) {
      const six = sixtofourIpv4(parts);
      if (six) return isPrivateIp(six);
    }
    if (ipv6StartsWith(ip, '2001:0::', 32)) {
      const teredo = teredoClientIpv4(parts);
      if (teredo) return isPrivateIp(teredo);
    }
    return ip === '::' || ip === '::1'
      || ipv6StartsWith(ip, 'fc00::', 7)
      || ipv6StartsWith(ip, 'fe80::', 10)
      || ipv6StartsWith(ip, 'ff00::', 8)      // M2: IPv6 multicast
      // NAT64 well-known prefix embeds an IPv4 in the low 32 bits — recurse on
      // the embedded v4 so 64:ff9b::<private-v4> can't smuggle SSRF past us.
      || ipv6StartsWith(ip, '64:ff9b::', 96);
  }
  return false;
}

// ─── Trusted client IP (XFF hop counting) ──────────────────
//
// Single source of truth for "which IP do we trust as the real client",
// shared by src/caller-key.js (per-caller pool/cache scope + brute-force
// bucket) and src/dashboard/api.js (dashboard lockout bucket + audit logs).
// These two used to carry byte-identical private copies kept in sync only by
// a "MUST stay identical" comment — a drift here re-opens XFF-1 (an attacker
// with the shared key rotating a spoofed leftmost XFF to dodge the lockout) or
// splits the caller/dashboard views of the same client. (audit S4)
//
// Policy: X-Forwarded-For is attacker-controllable and IGNORED unless the
// operator opts in with TRUST_PROXY_X_FORWARDED_FOR=1. When trusted, the real
// client is counted from the RIGHT by the number of trusted proxy hops in
// front of us (TRUST_PROXY_HOPS, default 1) — trusted proxies APPEND the peer
// they received the connection from, so the leftmost value stays spoofable and
// must never be taken. A header shorter than the hop count can't be trusted →
// fall back to the socket peer.
//
// Both env vars are read LIVE on every call (not captured at module load) so a
// process that flips them — or a test that sets them per-case — sees the
// change, and so the two former call sites can't disagree by one reading a
// module-load const while the other reads live.
export function trustedProxyHops(env = process.env) {
  const raw = Number(env.TRUST_PROXY_HOPS);
  return Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

export function trustedClientIp(req, env = process.env) {
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  if (env.TRUST_PROXY_X_FORWARDED_FOR !== '1') return remote;
  const parts = String(req?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) return remote;
  // The last `hops` entries were appended by our trusted proxy chain; the real
  // client IP is the entry just before them. If the header is shorter than the
  // configured hop count it can't be trusted — fall back to the socket peer.
  const idx = parts.length - trustedProxyHops(env);
  return (idx >= 0 ? parts[idx] : '') || remote;
}

export async function resolvePublicAddresses(hostname, lookupFn = dnsLookup) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!host || host.toLowerCase() === 'localhost') throw new Error('ERR_PROXY_PRIVATE_HOST');
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('ERR_PROXY_PRIVATE_IP');
    return [{ address: host, family: net.isIP(host) }];
  }
  const result = await new Promise((resolve, reject) => {
    lookupFn(host, { all: true }, (err, addrs) => err ? reject(err) : resolve(addrs));
  });
  const addrs = Array.isArray(result) ? result : [result];
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('ERR_PROXY_PRIVATE_IP');
  }
  return addrs;
}

export async function validateHostFormat(hostname, lookupFn = dnsLookup) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!host) throw new Error('ERR_INVALID_HOST');
  if (net.isIP(host)) {
    return [{ address: host, family: net.isIP(host) }];
  }
  const result = await new Promise((resolve, reject) => {
    lookupFn(host, { all: true }, (err, addrs) => err ? reject(err) : resolve(addrs));
  });
  return Array.isArray(result) ? result : [result];
}

// Resolve a proxy host and return a single VALIDATED IP literal to dial. The
// point is to close the TOCTOU / DNS-rebinding gap: validateProxyHost() resolved
// the name once for its check, but the later net.connect(host) / http CONNECT
// re-resolved it — a second lookup an attacker's DNS can answer with a private
// IP. By connecting to the literal returned here, the socket performs NO further
// resolution, so the address we vetted is exactly the address we dial.
//
// When allowPrivate is true (ALLOW_PRIVATE_PROXY_HOSTS=1) we still resolve to a
// literal (keeping the "connect the vetted address" invariant) but skip the
// private-IP rejection, matching validateHostFormat's laxer policy.
export async function resolveProxyConnectHost(hostname, { allowPrivate = false, lookupFn = dnsLookup } = {}) {
  const host = String(hostname || '').replace(/^\[|\]$/g, '');
  if (!host) throw new Error('ERR_INVALID_HOST');
  // An IP literal cannot be rebound; still enforce the private-IP policy on it.
  if (net.isIP(host)) {
    if (!allowPrivate && isPrivateIp(host)) throw new Error('ERR_PROXY_PRIVATE_IP');
    return host;
  }
  if (!allowPrivate && host.toLowerCase() === 'localhost') throw new Error('ERR_PROXY_PRIVATE_HOST');
  const result = await new Promise((resolve, reject) => {
    lookupFn(host, { all: true }, (err, addrs) => err ? reject(err) : resolve(addrs));
  });
  const addrs = (Array.isArray(result) ? result : [result]).filter(a => a && a.address);
  if (!addrs.length) throw new Error('ERR_PROXY_DNS_EMPTY');
  if (!allowPrivate) {
    // Reject if ANY resolved address is private (a rebinding answer often mixes
    // a public and a private A record); then dial the first public one.
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw new Error('ERR_PROXY_PRIVATE_IP');
    }
  }
  const pick = allowPrivate ? addrs[0] : (addrs.find(a => !isPrivateIp(a.address)) || addrs[0]);
  return pick.address;
}


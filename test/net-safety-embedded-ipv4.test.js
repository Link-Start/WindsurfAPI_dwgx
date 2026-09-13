import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIp } from '../src/net-safety.js';

// Every IPv6 form here EMBEDS a private/loopback IPv4 address, so a guard that
// intends to block "private space" must return true. Measured 2026-09-13: the
// existing branches covered only `64:ff9b::/96` (well-known NAT64 prefix) — a
// 12-byte prefix compare, not the /96 the comment claims — so the four classes
// below all returned FALSE and reached image.js's fetch (SSRF surface) and the
// proxy-address checks untouched.
//
// The point is not exotic IPv6 trivia: each of these is a documented transition
// / translation prefix in which the low bits ARE an IPv4 address. Blocking v4
// private space while letting its carrier prefixes through is the bug.
describe('isPrivateIp — IPv4-in-IPv6 carrier prefixes', () => {
  const carriers = [
    ['NAT64 local-use prefix (RFC 8215) embedding 127.0.0.1', '64:ff9b:1::7f00:1'],
    ['NAT64 local-use prefix embedding 10.0.0.1', '64:ff9b:1::a00:1'],
    ['6to4 (RFC 3056) embedding 127.0.0.1', '2002:7f00:1::1'],
    ['6to4 embedding 192.168.1.1', '2002:c0a8:101::1'],
    ['Teredo (RFC 4380) with obfuscated 192.168.1.1 client', '2001:0:c0a8:101::1'],
    ['v4-compatible ::127.0.0.1', '::127.0.0.1'],
  ];

  for (const [label, ip] of carriers) {
    it(`blocks ${label}`, () => {
      assert.equal(isPrivateIp(ip), true, `${ip} must be treated as private space`);
    });
  }
});

// Controls: these already worked and must keep working. If a future edit makes
// the carrier handling too broad and starts blocking public space, these fail.
describe('isPrivateIp — controls that must not regress', () => {
  const mustBlock = [
    ['loopback v4', '127.0.0.1'],
    ['mapped loopback', '::ffff:127.0.0.1'],
    ['ULA fc00::/7', 'fc00::1'],
    ['link-local fe80::/10', 'fe80::1'],
    ['v6 multicast', 'ff02::1'],
    ['NAT64 well-known + private v4', '64:ff9b::7f00:1'],
    ['RFC1918', '10.1.2.3'],
    ['CGNAT 100.64/10', '100.64.0.1'],
  ];
  for (const [label, ip] of mustBlock) {
    it(`still blocks ${label}`, () => assert.equal(isPrivateIp(ip), true, ip));
  }

  const mustAllow = [
    ['public v4', '8.8.8.8'],
    ['public v6', '2606:4700:4700::1111'],
    ['documentation-range v6 is NOT in our block list (upstream choice, recorded)', '2001:db8::1'],
    ['empty', ''],
  ];
  for (const [label, ip] of mustAllow) {
    it(`still allows ${label}`, () => assert.equal(isPrivateIp(ip), false, JSON.stringify(ip)));
  }
});

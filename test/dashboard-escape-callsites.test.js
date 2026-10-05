// The escape helpers were tested; their CALL SITES were not.
//
// dashboard-escape-behaviour.test.js proves esc() and escJsAttr() neutralise every
// breakout character. It says nothing about whether the template that renders an
// account label actually calls them — remove the esc() from a sink and both existing
// guards stay green. There are 200+ escape call sites against 1000+ interpolations, so
// "the helpers are correct" is a much weaker statement than it looks.
//
// This guard closes the gap for the fields that carry account-holder, upstream or
// caller data AND reach innerHTML.
//
// HISTORY, because it is the whole reason this file was rewritten (2026-09-13 audit):
// the first version policed ['lastError','apiKey_masked','keyPrefix','planName'] and
// matched ZERO of them as unescaped sinks. Its own "guard the guard" test passed,
// because every one of those fields DID have an escaped sink elsewhere in the file —
// so the guard reported success while enforcing nothing at all. The enforced list is
// now id/status/name, which matched 39 live sites on the day it was switched.
//
// Two consequences, both encoded below:
//   1. A guard whose candidate list is EMPTY must fail, not pass. Counting offenders
//      is not enough — the list must be shown to match real interpolations.
//   2. Every tolerated site is an explicit, reviewed entry with a reason. There is no
//      blanket "numeric-looking" or "inside a URL" escape hatch: a silent skip is how
//      this guard died the first time.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const DASHBOARD = new URL('../src/dashboard/index.html', import.meta.url);

/**
 * Fields whose values cross a trust boundary and reach innerHTML:
 *   id/status — account records echoed by /dashboard/api/accounts (the id is a
 *               server-generated UUID fragment, but it is still response data, and the
 *               panel renders it into <code>, class attributes and title attributes).
 *   name      — a field descriptor supplied by CALLER code (App.prompt) and read back
 *               out of the DOM via [data-name] -> values[el.dataset.name].
 */
const ENFORCED_FIELDS = ['id', 'status', 'name'];

/**
 * Interpolations that reach the DOM via textContent are safe without escaping.
 *
 * This is a CONTEXT check, and it is the one blanket rule in the file: an expression
 * whose surrounding statement assigns textContent/innerText cannot inject markup no
 * matter what it contains. Everything else must be escaped or allowlisted.
 */
const TEXT_CONTENT_SINKS = /textContent|innerText|\.title\s*=|toast\(/;

/**
 * Sites the enforced fields match that are deliberately left WITHOUT esc(), each with
 * the reason it cannot break out of its context. Keyed `line|field`.
 *
 * Line numbers move. That is the point: a stale entry fails the entry-exists check
 * below, forcing a re-review, rather than silently permitting whatever has since moved
 * into that line. The expression is carried in the entry so a reviewer can see what was
 * tolerated without re-reading the file.
 *
 * Reviewed 2026-09-13 by reading each site in the shipped dashboard. Four classes:
 *   A. not-in-DOM       — the interpolation builds a JS string (a cache signature) or
 *                         a non-HTML value; it is never assigned to innerHTML.
 *   B. url-or-selector  — it lands in a fetch URL, a percent-encoded path, or a
 *                         querySelector selector, not in markup.
 *   C. numeric-or-http  — an HTTP status code, a count, or a hardcoded literal.
 *   D. already-escaped  — the interpolation is fed an escaped local variable
 *                         (`const name = this.esc(...)`), so wrapping it again would
 *                         double-encode the visible text.
 */
const REVIEWED_NOT_SINKS = [
  { line: 4777, field: 'status', expr: 'hr.status', why: 'C numeric-or-http: Response.status in an Error message; Response.status is always a Number' },
  { line: 4989, field: 'id', expr: 'a.id', why: 'A not-in-DOM: `sig` is a cache comparison string, discarded, never assigned to innerHTML' },
  { line: 4989, field: 'status', expr: 'a.status', why: 'A not-in-DOM: same `sig` cache comparison string' },
  { line: 5086, field: 'name', expr: 'name', why: 'D already-escaped: local `name` is this.esc(a.email || String(a.id)) at line 5077' },
  { line: 6399, field: 'status', expr: 'h.status (login history)', why: 'A not-in-DOM: feeds errCode/errMsg, both this.esc()ed at the sink on line 6403' },
  { line: 6549, field: 'id', expr: 'encodeURIComponent(id)', why: 'B url-or-selector: percent-encoded into the /accounts/<id> fetch path' },
  { line: 6890, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id> fetch path (PATCH spend policy)' },
  { line: 6971, field: 'id', expr: 'models.map(m => ...)', why: 'A not-in-DOM: map callback head; the rendered m.id is this.esc()ed in its own title attribute' },
  { line: 7051, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id>/refresh-credits fetch path' },
  { line: 7456, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id> fetch path (PATCH tier)' },
  { line: 7484, field: 'id', expr: 'id', why: 'B url-or-selector: querySelector(`.model-row[data-detail="${id}"]`) selector, not markup' },
  { line: 7519, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id> fetch path (bulk enable)' },
  { line: 7520, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id> fetch path (bulk disable)' },
  { line: 7521, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id>/refresh-credits fetch path (bulk refresh)' },
  { line: 7522, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id>/probe fetch path (bulk probe)' },
  { line: 7523, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id> fetch path (bulk delete)' },
  { line: 7537, field: 'id', expr: 'id', why: 'B url-or-selector: /accounts/<id> fetch path (single delete)' },
  { line: 7751, field: 'id', expr: 'id', why: 'B url-or-selector: /proxy/accounts/<id> fetch path' },
  // C: `num(id, ...)` is called with ten hardcoded literals ('brk-err-threshold',
  // 'set-ip-lock-minutes', ...) at lines 9169-9178 and 9326-9329, and nothing else.
  { line: 9158, field: 'id', expr: 'id', why: 'C numeric-or-http: `num()` id argument is a hardcoded literal at every call site' },
  { line: 9159, field: 'id', expr: 'id', why: 'C numeric-or-http: `num()` id argument is a hardcoded literal at every call site' },
  { line: 9320, field: 'id', expr: 'id', why: 'C numeric-or-http: `num()` id argument is a hardcoded literal at every call site' },
  { line: 9321, field: 'id', expr: 'id', why: 'C numeric-or-http: `num()` id argument is a hardcoded literal at every call site' },
  { line: 9525, field: 'status', expr: 'stats.error ?? accounts.filter(a => a.status === ...).length', why: 'C numeric-or-http: the interpolated value is a count, not the status string' },
  { line: 9631, field: 'status', expr: 'res.status', why: 'C numeric-or-http: Response.status in an Error message; Response.status is always a Number' },
];

function dashboardSource() {
  return readFileSync(DASHBOARD, 'utf8');
}

/**
 * Every `${...}` in the file, with its line number and the surrounding statement.
 *
 * Comments are NOT stripped here on purpose: this looks for interpolations, and a
 * commented-out template would not contain a live one. What matters instead is that the
 * ESCAPE detection below reads the expression itself rather than nearby prose — a guard
 * in this repo was once satisfied by a call quoted in its own comment.
 */
function interpolations(src) {
  const out = [];
  const re = /\$\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const line = src.slice(0, m.index).split('\n').length;
    const ctxStart = Math.max(0, m.index - 220);
    out.push({ expr: m.group ? m.group(1) : m[1], line, context: src.slice(ctxStart, m.index + 60) });
  }
  return out;
}

function isEscaped(expr) {
  return /\besc\(|\bescJsAttr\(/.test(expr);
}

/**
 * Site key: `line|field`.
 *
 * Deliberately independent of the expression text. The guard's own `${...}` reader
 * truncates at the first `}`, so an expression-derived key would be a product of that
 * parser limitation rather than of the source — and a key with an invisible trailing
 * space cannot be typed back into this file.
 */
function siteKey(line, field) {
  return `${line}|${field}`;
}

/** The guard's candidate set: enforced field, no esc(), not a textContent sink. */
function candidateSites(src) {
  const sites = [];
  for (const { expr, line, context } of interpolations(src)) {
    if (isEscaped(expr)) continue;
    if (TEXT_CONTENT_SINKS.test(context)) continue;
    for (const field of ENFORCED_FIELDS) {
      // Match the field as a property access or bare identifier, so `planName` hits
      // but `t('plan.name')` and `field.labelFor` do not.
      if (!new RegExp(`(^|[.\\s(\\[{!?])${field}\\b`).test(expr)) continue;
      // i18n lookups render their own catalogue text, not the account's data.
      if (/I18n\.t\(|\bT\(/.test(expr)) break;
      sites.push({
        line,
        field,
        expr,
        key: siteKey(line, field),
        head: expr.trim().replace(/\s+/g, ' ').slice(0, 90),
      });
      break;
    }
  }
  return sites;
}

describe('dashboard escape call sites (not just the helpers)', () => {
  it('escapes every id/status/name interpolation that reaches innerHTML', () => {
    const src = dashboardSource();
    const reviewed = new Set(REVIEWED_NOT_SINKS.map((e) => siteKey(e.line, e.field)));
    const offenders = [];

    for (const site of candidateSites(src)) {
      if (reviewed.has(site.key)) continue;
      offenders.push(`index.html:${site.line} → \${${site.head}}`);
    }

    assert.deepEqual(offenders, [],
      'These interpolations render account/upstream/caller-controlled data into innerHTML '
      + 'without esc()/escJsAttr(). Wrap them with this.esc(...), or add a REVIEWED_NOT_SINKS '
      + 'entry naming the reason the value cannot break out. Offenders:\n  ' + offenders.join('\n  '));
  });

  it('the enforced field list actually matches live sites (a guard over nothing must FAIL)', () => {
    // This is the assertion the previous version of this file was missing. It policed
    // ['lastError','apiKey_masked','keyPrefix','planName'], matched zero unescaped
    // sites, and reported success. An empty candidate list is a broken guard, not a
    // clean file — so it fails here instead of passing above.
    const src = dashboardSource();
    const sites = candidateSites(src);
    assert.ok(sites.length > 0,
      `ENFORCED_FIELDS (${ENFORCED_FIELDS.join(', ')}) matched ZERO interpolations that reach `
      + 'innerHTML, so the check above enforces nothing. Update the field list to the current '
      + 'sink names; do not delete this test.');
    // Also require each field individually: one live field must not mask two dead ones.
    const deadFields = ENFORCED_FIELDS.filter((f) => !sites.some((s) => s.field === f));
    assert.deepEqual(deadFields, [],
      'These enforced fields match no live interpolation and are therefore not being policed: '
      + deadFields.join(', '));
  });

  it('every reviewed exemption still points at a real site', () => {
    // A stale exemption silently widens the allowlist. If a line moved or the source
    // changed shape, the entry must be re-reviewed rather than left dangling.
    const src = dashboardSource();
    const live = new Set(candidateSites(src).map((s) => s.key));
    const stale = REVIEWED_NOT_SINKS.map((e) => siteKey(e.line, e.field)).filter((k) => !live.has(k));
    assert.deepEqual(stale, [],
      'These REVIEWED_NOT_SINKS entries match no current interpolation, so they are no longer '
      + 'suppressing anything and may be hiding a regression elsewhere. Re-review and remove:\n  '
      + stale.join('\n  '));
  });

  it('the sinks this guard was written for stay escaped', () => {
    // Structural pins for the specific sites the 2026-09-13 audit found unescaped. The
    // tests above already fail on a revert; these name the regression in one line.
    const src = dashboardSource();
    const pins = [
      ['account id in the account table', /<code class="text-xs">\$\{this\.esc\(a\.id\)\}/],
      ['account status badge in the account table', /class="badge no-dot \$\{this\.esc\(a\.status\)\}">\$\{this\.esc\(a\.status\)\}/],
      ['account id in the account detail card', /<code>\$\{this\.esc\(a\.id\)\}<\/code>/],
      ['account status badge in the account detail card', /class="badge \$\{this\.esc\(a\.status\)\}">\$\{this\.esc\(a\.status\)\}/],
      ['account status badge in the bans table', /class="badge \$\{this\.esc\(a\.status\)\}">\$\{this\.esc\(a\.status\)\}/],
      ['imported account id/status in the login result', /this\.esc\(r\.account\.id\)[\s\S]{0,120}this\.esc\(r\.account\.status\)/],
      ['field descriptor name in data-name', /data-name="\$\{this\.esc\(f\.name\)\}"/],
      ['model id in the detail chip title', /title="\$\{this\.esc\(m\.id\)\}"/],
    ];
    for (const [what, re] of pins) {
      assert.match(src, re, `${what} must stay behind this.esc(); this pin exists so a revert names itself`);
    }
  });

  it('reads the shipped file, not a copy', () => {
    // Cheap tripwire: if the path breaks or the file is emptied, the checks above would
    // pass over zero interpolations.
    const src = dashboardSource();
    assert.ok(src.length > 50_000, 'the dashboard source should be substantial');
    assert.ok(interpolations(src).length > 500,
      `expected many interpolations to scan, found ${interpolations(src).length}`);
    assert.ok(/this\.esc\(/.test(src), 'the escape helper must be present in the source');
  });
});

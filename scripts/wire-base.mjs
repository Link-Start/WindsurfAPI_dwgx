#!/usr/bin/env node
// Pick the tree the wire-byte-identity gate compares against.
//
// WHY THIS EXISTS. CI used `git describe --tags --abbrev=0`, which answers
// "nearest reachable tag" — and at a tagged HEAD that is HEAD's own tag. A rerun
// or a manual dispatch on a release commit therefore compared the tree with
// itself: no evidence at all, and worse, evidence that changed with the tag set
// (2026-09-17 review, F5). The original release run 35174656666 did select the
// previous release (014204f / v3.9.35) at 02:30:17Z, before v3.9.36's tag
// existed — that evidence stands; this script makes the same selection
// reproducible instead of incidental.
//
// The baseline must be a STRICT ANCESTOR of the commit under test: an immutable
// released revision, never HEAD, so every run names the same pair of SHAs and a
// rerun of a release commit compares the release against the one before it.
//
// Selection:
//   1. tags shaped like a release (vX.Y.Z, optionally -suffix) reachable from HEAD;
//   2. drop any whose commit IS HEAD (strict ancestor only);
//   3. prefer annotated tags — the release identity this project tags with — and
//      among equals the highest version; a lightweight tag is used only when no
//      annotated candidate qualifies;
//   4. print the selection (JSON, or one field with --field) with the resolved SHA.
//
// Exit codes: 0 selected, 3 no valid baseline (the gate fails closed instead of
// comparing against nothing), 2 usage or git failure.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.]+))?$/;

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Every tag in one call: name, whether it is an annotated tag object, the commit
// it peels to, and the object it points at. `git tag --merged HEAD` in a second
// call is the ancestry filter — a tag merged into HEAD whose commit is not HEAD
// is exactly a strict ancestor, so no per-tag `merge-base` subprocess is needed
// (this repository has ~200 release tags; 200 spawns cost ~40 s on Windows).
function readTags(cwd) {
  const merged = new Set(git(['tag', '--merged', 'HEAD', '--list'], cwd).split('\n').filter(Boolean));
  const rows = git(['for-each-ref', '--format=%(refname:short) %(objecttype) %(*objectname) %(objectname)', 'refs/tags'], cwd);
  const tags = [];
  for (const row of rows.split('\n').filter(Boolean)) {
    const [name, type, peeled, object] = row.split(' ');
    if (!merged.has(name)) continue;
    tags.push({ name, annotated: type === 'tag', commit: type === 'tag' ? peeled : object });
  }
  return tags;
}

export function selectBase(cwd = process.cwd()) {
  const head = git(['rev-parse', 'HEAD'], cwd);
  const candidates = [];
  for (const { name, annotated, commit } of readTags(cwd)) {
    const match = RELEASE_TAG.exec(name);
    if (!match) continue;
    if (!/^[0-9a-f]{40,64}$/.test(commit)) continue;   // a tag on a tree/blob is not a revision
    if (commit === head) continue;                     // never the commit under test
    candidates.push({ tag: name, sha: commit, annotated, parts: match.slice(1, 4).map(Number), suffix: match[4] || '' });
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.annotated !== b.annotated) return a.annotated ? -1 : 1;
    for (let i = 0; i < 3; i++) { if (a.parts[i] !== b.parts[i]) return b.parts[i] - a.parts[i]; }
    if (a.suffix !== b.suffix) return a.suffix ? 1 : -1;   // a final release outranks its pre-release
    return a.tag < b.tag ? -1 : 1;
  });
  const best = candidates[0];
  return { tag: best.tag, sha: best.sha, kind: best.annotated ? 'annotated' : 'lightweight', head, releases: candidates.length };
}

function main() {
  const fieldIndex = process.argv.indexOf('--field');
  const field = fieldIndex === -1 ? null : process.argv[fieldIndex + 1];
  if (fieldIndex !== -1 && !field) {
    console.error('wire-base: --field needs one of tag|sha|kind|head');
    process.exit(2);
  }
  let selected;
  try {
    selected = selectBase(process.cwd());
  } catch (error) {
    console.error(`wire-base: git failed (${(error.stderr || error.message || '').toString().trim() || error.status})`);
    process.exit(2);
  }
  if (!selected) {
    console.error('wire-base: no release tag is a strict ancestor of HEAD; refusing to pick a baseline (a tagged HEAD needs the PREVIOUS release)');
    process.exit(3);
  }
  if (field) {
    if (!Object.hasOwn(selected, field)) {
      console.error(`wire-base: unknown field ${field} (tag|sha|kind|head)`);
      process.exit(2);
    }
    console.log(selected[field]);
    return;
  }
  console.log(JSON.stringify(selected, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

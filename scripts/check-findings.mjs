#!/usr/bin/env node
/**
 * Prove every recorded defect names a guard that exists.
 *
 * A findings report is easy to pad: "fixed" is a word, and a fix with no
 * regression test is a fix that silently comes undone. So each entry must name
 * a file that exists, and the report must not claim a guard in a file the
 * repository does not have.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPORT = join(ROOT, 'reports/findings.md');
const problems = [];

if (!existsSync(REPORT)) {
  console.error('findings FAILED');
  console.error('  - reports/findings.md does not exist');
  process.exit(1);
}

const text = readFileSync(REPORT, 'utf8');

// Each finding is an `## F<n> — title` section.
const sections = [...text.matchAll(/^## (F\d+)\s*[—-]\s*(.+)$/gm)];
if (sections.length === 0) problems.push('no findings are recorded, so this check would pass vacuously');

const ids = sections.map((m) => m[1]);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicates.length > 0) problems.push(`duplicate finding ids: ${[...new Set(duplicates)].join(', ')}`);

/** Split the report into per-finding bodies. */
function bodies() {
  const out = [];
  for (let i = 0; i < sections.length; i += 1) {
    const start = sections[i].index;
    const end = i + 1 < sections.length ? sections[i + 1].index : text.length;
    out.push({ id: sections[i][1], title: sections[i][2], body: text.slice(start, end) });
  }
  return out;
}

/** Repository paths a body claims as its guard, from backticked file paths. */
function claimedPaths(body) {
  const paths = new Set();
  for (const m of body.matchAll(/`((?:scripts|packages|web|tests|contracts|script)\/[\w./-]+)`/g)) {
    paths.add(m[1]);
  }
  return [...paths];
}

for (const { id, title, body } of bodies()) {
  if (!/\*\*Severity/.test(body)) problems.push(`${id} does not state a severity`);
  if (!/How it was found/i.test(body)) problems.push(`${id} does not say how it was found`);

  const deferred = /\*\*Deferred\*\*|not fixed/i.test(body);
  const hasGuard = /\*\*Guard/i.test(body) || /Verified\./.test(body);
  if (!deferred && !hasGuard) {
    problems.push(`${id} (${title}) claims no guard and is not marked deferred`);
  }

  const paths = claimedPaths(body);
  if (!deferred && paths.length === 0) {
    problems.push(`${id} names no repository file, so its guard cannot be located`);
  }
  for (const p of paths) {
    if (!existsSync(join(ROOT, p))) problems.push(`${id} names ${p}, which does not exist`);
  }
}

// Negative control: the path check must reject a file that is not there.
{
  const sink = claimedPaths('see `scripts/definitely-not-a-real-checker.mjs` for the guard');
  if (sink.length !== 1) problems.push('negative control failed: a claimed path was not extracted');
  else if (existsSync(join(ROOT, sink[0]))) problems.push('negative control failed: the decoy path exists');
}

if (problems.length > 0) {
  console.error('findings FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`${sections.length} findings recorded, each with a severity, a provenance and a locatable guard`);
console.log('findings verification passed');

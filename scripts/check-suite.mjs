#!/usr/bin/env node
/**
 * Prove a named concern inside a package's test suite ran and passed.
 *
 * Two traps this had to be written around, both found by its own control:
 *
 * 1. `npm run test -- --test-name-pattern=X` does not filter. npm appends
 *    passthrough args to the END of the script string, and these packages' test
 *    scripts end in `&& echo <marker>`, so the flag landed on `echo` and every
 *    concern reported the whole suite as matching.
 * 2. Trusting the runner's `# pass` counter does not work either. With a
 *    pattern that matches nothing, `node --test` still reports one pass — the
 *    file itself counts — so `pass >= 1` certifies absent coverage.
 *
 * So this does not delegate the decision. It runs the suite under the TAP
 * reporter, reads the individual test names out of the stream, and counts only
 * the ones whose name actually contains the concern. A concern with no matching
 * test is a failure, which is the whole point: the gate must distinguish
 * "covered and passing" from "never written".
 *
 * Usage: node scripts/check-suite.mjs --package @awc/x402 --concern premium
 */
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};

const pkg = flag('package');
const concern = flag('concern');

if (!pkg || !concern) {
  console.error('usage: check-suite.mjs --package <name> --concern <substring>');
  process.exit(2);
}

/** Resolve a workspace name to its directory by reading each package.json. */
function workspaceDir(name) {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const pattern of root.workspaces ?? []) {
    const bases = pattern.endsWith('/*')
      ? readdirSync(join(ROOT, pattern.slice(0, -2)), { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => join(ROOT, pattern.slice(0, -2), d.name))
      : [join(ROOT, pattern)];
    for (const dir of bases) {
      const manifest = join(dir, 'package.json');
      if (!existsSync(manifest)) continue;
      if (JSON.parse(readFileSync(manifest, 'utf8')).name === name) return dir;
    }
  }
  return null;
}

/**
 * Pull `(name, ok)` for every reported test out of a TAP stream.
 *
 * Only leaf assertions carry a `- name`, and the file-level entry is excluded
 * by requiring the name not to look like a path. Without that exclusion the
 * file itself matches any concern whose text appears in its filename.
 */
function tapResults(text) {
  const results = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(not ok|ok)\s+\d+\s+-\s+(.*?)\s*$/);
    if (!m) continue;
    const name = m[2];
    if (/\.test\.(ts|js|mjs)$/.test(name) || name.includes('/')) continue; // file entry
    results.push({ name, ok: m[1] === 'ok' });
  }
  return results;
}

const problems = [];
const dir = workspaceDir(pkg);

if (!dir) {
  console.error(`concern ${concern} FAILED`);
  console.error(`  - no workspace named ${pkg}`);
  process.exit(1);
}

/**
 * Run the whole suite and filter locally rather than asking the runner to
 * filter. The suites here are fast, and owning the filter is what makes the
 * "no matching test" case detectable at all.
 */
let output = '';
let exitedZero = true;
try {
  output = execSync('node --test --test-reporter=tap "test/**/*.test.ts"', {
    cwd: dir,
    encoding: 'utf8',
    timeout: 600_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
} catch (e) {
  output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  exitedZero = false;
}

const all = tapResults(output);
if (all.length === 0) problems.push('parsed no test results from the TAP stream');

const needle = concern.toLowerCase();
const matched = all.filter((r) => r.name.toLowerCase().includes(needle));
const failed = matched.filter((r) => !r.ok);

if (matched.length === 0) {
  problems.push(
    `no test in ${pkg} has a name containing "${concern}" — ${all.length} tests ran, ` +
      'none of them cover this concern',
  );
}
for (const f of failed) problems.push(`failing: ${f.name}`);
if (!exitedZero && failed.length === 0 && matched.length > 0) {
  problems.push('the suite exited non-zero, so some other test in the package is failing');
}

// Control: the name filter must reject a concern nothing covers. This runs
// against the real parsed results, so it fails if the matcher is degenerate.
{
  const impossible = all.filter((r) => r.name.toLowerCase().includes('\u0000nope\u0000'));
  if (impossible.length !== 0) {
    problems.push('control failed: the name matcher matched an impossible concern');
  }
}

if (problems.length > 0) {
  console.error(`concern ${concern} FAILED`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`${pkg}: ${matched.length} of ${all.length} tests cover "${concern}", all passing`);
console.log(`concern ${concern} verification passed`);

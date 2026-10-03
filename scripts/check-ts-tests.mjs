#!/usr/bin/env node
/**
 * Run every TypeScript workspace's tests and require each to actually run some.
 *
 * `npm test --workspaces` exits 0 when a workspace has no test script, so a
 * package whose tests stopped being collected looks identical to a package that
 * passed. This enumerates the workspaces and requires a success marker from each.
 */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const problems = [];

/** Expand the workspace globs the root package.json declares. */
const dirs = [];
for (const pattern of root.workspaces ?? []) {
  if (pattern.endsWith('/*')) {
    const base = join(ROOT, pattern.slice(0, -2));
    if (!existsSync(base)) continue;
    const { readdirSync, statSync } = await import('node:fs');
    for (const entry of readdirSync(base)) {
      const abs = join(base, entry);
      if (statSync(abs).isDirectory() && existsSync(join(abs, 'package.json'))) dirs.push(abs);
    }
  } else if (existsSync(join(ROOT, pattern, 'package.json'))) {
    dirs.push(join(ROOT, pattern));
  }
}

if (dirs.length === 0) problems.push('no workspaces resolved, so this check would pass vacuously');

let ran = 0;
let totalPassed = 0;
for (const dir of dirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  if (!pkg.scripts?.test) {
    problems.push(`${pkg.name} has no test script`);
    continue;
  }
  let out;
  try {
    out = execSync(`npm run --silent test --workspace ${pkg.name}`, {
      cwd: ROOT, encoding: 'utf8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    problems.push(`${pkg.name} tests failed`);
    continue;
  }
  const passed = Number(out.match(/^# pass (\d+)$|pass (\d+)/m)?.slice(1).find(Boolean) ?? 0);
  if (passed === 0) problems.push(`${pkg.name} ran 0 tests`);
  totalPassed += passed;
  ran += 1;
}

if (problems.length > 0) {
  console.error('ts tests FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`${ran} workspaces, ${totalPassed} tests passed`);
console.log('ts test verification passed');

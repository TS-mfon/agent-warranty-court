#!/usr/bin/env node
/**
 * Typecheck every TypeScript file in the workspace with no errors.
 *
 * `tsc --noEmit` over an explicit file list rather than a project reference
 * build: node runs these files by stripping types, so nothing is ever compiled,
 * and a project that only typechecks the files it happens to reference would let
 * an unreferenced module rot.
 */
import { execSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(entry)) out.push(abs);
  }
  return out;
}

const files = [...walk(join(ROOT, 'packages')), ...walk(join(ROOT, 'web'))];
if (files.length === 0) problems.push('found no TypeScript files, so this check would pass vacuously');

if (files.length > 0) {
  const rel = files.map((f) => relative(ROOT, f));
  try {
    execSync(
      `npx --no-install tsc --noEmit --strict --target es2023 --module nodenext ` +
        `--moduleResolution nodenext --skipLibCheck --allowImportingTsExtensions ` +
        `--erasableSyntaxOnly --resolveJsonModule --types node ${rel.map((f) => `"${f}"`).join(' ')}`,
      { cwd: ROOT, encoding: 'utf8', timeout: 300_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
    problems.push(`tsc reported ${errors.length} error(s)`);
    for (const line of errors.slice(0, 8)) problems.push(`  ${line}`);
  }
}

if (problems.length > 0) {
  console.error('typecheck FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`typechecked ${files.length} files with no errors`);
console.log('typecheck verification passed');

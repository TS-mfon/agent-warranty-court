#!/usr/bin/env node
/**
 * Prove the web app builds and that its generated data is current.
 *
 * "It builds" is weak evidence for a static site — the interesting failure is a
 * *stale* generated file, which builds perfectly and serves a dead deployment's
 * addresses. So this rebuilds, then checks the result is byte-identical to what
 * was committed. A drifted file fails.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATED = join(ROOT, 'web/generated/data.js');
const problems = [];

const before = existsSync(GENERATED) ? readFileSync(GENERATED, 'utf8') : null;
if (before === null) problems.push('web/generated/data.js does not exist; run `npm run build --workspace @awc/web`');

try {
  execFileSync('node', ['build.mjs'], { cwd: join(ROOT, 'web'), encoding: 'utf8', timeout: 120_000 });
} catch (e) {
  problems.push(`build failed: ${e.message.split('\n')[0]}`);
}

const after = existsSync(GENERATED) ? readFileSync(GENERATED, 'utf8') : null;

/** GENERATED_AT changes every run, so compare everything else. */
const withoutTimestamp = (s) => (s ?? '').replace(/export const GENERATED_AT = "[^"]*";/, '');

if (before !== null && after !== null && withoutTimestamp(before) !== withoutTimestamp(after)) {
  problems.push('web/generated/data.js is stale: rebuilding it changed the content');
}

// The five pages and every module they load. `app.js` was retired when the
// site became multi-page; its chain reads now live in `chain.js`.
const SHIPPED = [
  'web/index.html', 'web/monitor.html', 'web/how-it-works.html',
  'web/inspect.html', 'web/docs.html',
  'web/chrome.js', 'web/chain.js', 'web/monitor.js', 'web/inspect.js', 'web/docs.js',
  'web/styles.css', 'web/generated/data.js',
];

for (const file of SHIPPED) {
  if (!existsSync(join(ROOT, file))) problems.push(`${file} is missing`);
}

// Nothing the browser loads may carry an address literal.
for (const file of SHIPPED.filter((f) => /\.(html|js)$/.test(f) && !f.includes('generated/'))) {
  const path = join(ROOT, file);
  if (!existsSync(path)) continue;
  const hits = readFileSync(path, 'utf8').match(/0x[0-9a-fA-F]{40}\b/g);
  if (hits) problems.push(`${file} hardcodes ${hits.length} address literal(s)`);
}

// Every module the page imports must resolve.
if (after) {
  try {
    const mod = await import(GENERATED);
    for (const key of ['BASE', 'GENLAYER', 'SELECTORS', 'VERDICT_CODES', 'JOB_STATES']) {
      if (!(key in mod)) problems.push(`generated data is missing export ${key}`);
    }
    if (mod.BASE?.chainId !== 84_532) problems.push(`generated BASE.chainId is ${mod.BASE?.chainId}`);
  } catch (e) {
    problems.push(`generated data will not import: ${e.message}`);
  }
}

// Negative control: the staleness comparison must be able to fire.
if (withoutTimestamp('export const A = 1;') === withoutTimestamp('export const A = 2;')) {
  problems.push('negative control failed: the staleness comparison ignores content');
}

if (problems.length > 0) {
  console.error('web build FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('rebuilt generated data and confirmed it is current; no address literals in shipped files');
console.log('web build verification passed');

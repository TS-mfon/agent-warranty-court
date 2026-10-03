#!/usr/bin/env node
/**
 * Prove every consumer reads contract addresses from the deployment manifests.
 *
 * The failure this prevents is quiet: a keeper or a dashboard with its own copy
 * of an address keeps working after a redeploy, pointed at a contract the rest
 * of the system has abandoned. It shows confident numbers from a dead
 * deployment, which is worse than an error.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

/** Source trees that must never contain an address literal. */
const GUARDED = ['packages/keeper', 'packages/x402', 'web'];
/** Where addresses are allowed to be written down. */
const ALLOWED = [/^deployments\//, /^web\/generated\//, /^script\//, /^scripts\//, /^tests?\//, /\.md$/];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'generated' || entry.startsWith('.')) continue;
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|js|mjs|tsx|html|json)$/.test(entry)) out.push(abs);
  }
  return out;
}

const manifests = existsSync(join(ROOT, 'deployments'))
  ? readdirSync(join(ROOT, 'deployments')).filter((f) => f.endsWith('.json'))
  : [];
if (manifests.length === 0) problems.push('no deployment manifests exist, so there is nothing to wire to');

let scanned = 0;
for (const tree of GUARDED) {
  const dir = join(ROOT, tree);
  if (!existsSync(dir)) continue;
  for (const abs of walk(dir)) {
    const rel = relative(ROOT, abs).replaceAll('\\', '/');
    if (ALLOWED.some((re) => re.test(rel))) continue;
    scanned += 1;
    const text = readFileSync(abs, 'utf8');
    const hits = [...text.matchAll(/0x[0-9a-fA-F]{40}\b/g)].map((m) => m[0]);
    // The zero address is a sentinel, not a deployment.
    const real = hits.filter((h) => !/^0x0+$/.test(h));
    if (real.length > 0) {
      problems.push(`${rel} hardcodes ${real.length} address literal(s): ${real.slice(0, 2).join(', ')}`);
    }
  }
}

if (scanned === 0) problems.push('scanned no consumer files, so this check would pass vacuously');

// The shared loader must exist and must refuse a missing contract loudly.
try {
  const d = await import(join(ROOT, 'packages/shared/src/deployments.ts'));
  const fake = { chainId: 1, name: 'x', rpcUrl: 'x', deployer: 'x', contracts: {} };
  let threw = false;
  try {
    d.addressOf(fake, 'WarrantyEscrow');
  } catch {
    threw = true;
  }
  if (!threw) {
    problems.push('addressOf returned for a missing contract instead of throwing; undefined becomes the zero address downstream');
  }
  for (const m of manifests) {
    const id = Number(m.replace('.json', ''));
    const loaded = d.loadDeployment(id, ROOT);
    if (loaded.chainId !== id) problems.push(`loadDeployment(${id}) returned chainId ${loaded.chainId}`);
  }
} catch (e) {
  problems.push(`shared deployment loader unusable: ${e.message}`);
}

if (problems.length > 0) {
  console.error('address wiring FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`scanned ${scanned} consumer files across ${GUARDED.length} trees against ${manifests.length} manifests`);
console.log('address wiring verification passed');

#!/usr/bin/env node
/**
 * Prove the documentation describes the contracts that actually exist.
 *
 * Documentation drifts silently. A signature written from memory, an address
 * copied from an older deployment, a link to a file that was renamed — none of
 * these break a build, and all of them send an integrator down a path that
 * cannot work.
 *
 * So this parses the real sources to build the set of valid function names and
 * the set of valid addresses, and checks every claim in the docs against them.
 * The negative controls at the end feed the same logic a fabricated address, a
 * broken link and a nonexistent function, and fail if any is accepted.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

/** Minimum useful length. A stub that exists is not documentation. */
const EXPECTED = [
  ['docs/README.md', 800],
  ['docs/protocol.md', 3_000],
  ['docs/contracts.md', 5_000],
  ['docs/verdict-grammar.md', 2_500],
  ['docs/adjudication.md', 2_500],
  ['docs/integration.md', 3_000],
  ['docs/security.md', 3_000],
  ['README.md', 2_000],
];

const BASE_CONTRACTS = [
  'WarrantyEscrow', 'ProviderStake', 'VerdictInbox',
  'ReputationLog', 'CanonicalVerdictReceiver',
];

const problems = [];

// ---------------------------------------------------------------------------
// Build the truth sets from source
// ---------------------------------------------------------------------------

/** Every function, error and event name declared across the Base contracts. */
function solidityNames() {
  const names = new Set();
  for (const contract of BASE_CONTRACTS) {
    const path = join(ROOT, 'contracts/base', `${contract}.sol`);
    if (!existsSync(path)) {
      problems.push(`contracts/base/${contract}.sol does not exist`);
      continue;
    }
    const src = readFileSync(path, 'utf8');
    for (const m of src.matchAll(/\b(?:function|error|event)\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.add(m[1]);
    }
    // Public state variables and constants are callable too.
    for (const m of src.matchAll(/\bpublic\s+(?:constant\s+|immutable\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[;=]/g)) {
      names.add(m[1]);
    }
    for (const m of src.matchAll(/mapping\([^)]*\)\s*public\s+([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  }
  // Library helpers the docs legitimately reference.
  const lib = join(ROOT, 'contracts/shared/VerdictLib.sol');
  if (existsSync(lib)) {
    for (const m of readFileSync(lib, 'utf8').matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/** Every function name declared in the Intelligent Contract. */
function pythonNames() {
  const path = join(ROOT, 'contracts/genlayer/warranty_court.py');
  const names = new Set();
  if (!existsSync(path)) {
    problems.push('contracts/genlayer/warranty_court.py does not exist');
    return names;
  }
  for (const m of readFileSync(path, 'utf8').matchAll(/^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    names.add(m[1]);
  }
  return names;
}

/** Every address in every deployment manifest, lowercased. */
function manifestAddresses() {
  const addresses = new Set();
  const dir = join(ROOT, 'deployments');
  if (!existsSync(dir)) {
    problems.push('deployments/ does not exist');
    return addresses;
  }
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const text = readFileSync(join(dir, file), 'utf8');
    for (const m of text.matchAll(/0x[0-9a-fA-F]{40}\b/g)) addresses.add(m[0].toLowerCase());
  }
  if (addresses.size === 0) problems.push('no addresses found in any manifest');
  return addresses;
}

const VALID_NAMES = new Set([...solidityNames(), ...pythonNames()]);
const VALID_ADDRESSES = manifestAddresses();

// Addresses that are legitimately external and not ours to deploy.
const EXTERNAL_ADDRESSES = new Set([
  '0xc4fd2580c3487bba18d63f50301020132342fdbd', // GenLayer Bridgehub on Sepolia
  '0xf8ed76fa41624355f56bc6885e76a208fe039170', // chain 4221 diamond proxy
]);

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** Reusable so the negative controls exercise the same code. */
function checkAddresses(text, where, sink) {
  for (const m of text.matchAll(/0x[0-9a-fA-F]{40}\b/g)) {
    const addr = m[0].toLowerCase();
    if (/^0x0+$/.test(addr)) continue; // the zero address is a sentinel
    if (VALID_ADDRESSES.has(addr) || EXTERNAL_ADDRESSES.has(addr)) continue;
    sink.push(`${where}: address ${m[0]} appears in no deployment manifest`);
  }
}

function checkLinks(text, file, sink) {
  for (const m of text.matchAll(/\[[^\]]*\]\(([^)#\s]+)(#[^)\s]*)?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    const resolved = resolve(dirname(join(ROOT, file)), target);
    if (!existsSync(resolved)) sink.push(`${file}: link to ${target} does not resolve`);
  }
}

/**
 * Check claimed identifiers against the source.
 *
 * Only backticked `name(` forms are considered: prose mentions and shell
 * snippets would otherwise produce constant noise, and a gate that cries wolf
 * gets switched off.
 */
function checkNames(text, file, sink) {
  for (const m of text.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)\(/g)) {
    const name = m[1];
    if (VALID_NAMES.has(name)) continue;
    // Allowlist: TypeScript/JS helpers and shell builtins the docs also show.
    const allowed = new Set([
      'loadDeployment', 'addressOf', 'verdictCommitment', 'splitPremiumForChain',
      'isCoherent', 'isBreach', 'slashBpsFor', 'isBucket', 'readContract',
      'write_contract', 'read_contract', 'sha256', 'keccak', 'printf', 'seq',
      'curl', 'require', 'function', 'if', 'for',
    ]);
    if (allowed.has(name)) continue;
    sink.push(`${file}: documents \`${name}(\` which exists in no contract source`);
  }
}

for (const [rel, minBytes] of EXPECTED) {
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    problems.push(`${rel} does not exist`);
    continue;
  }
  const size = statSync(path).size;
  if (size < minBytes) problems.push(`${rel} is ${size} bytes, below the ${minBytes} minimum`);

  const text = readFileSync(path, 'utf8');
  checkAddresses(text, rel, problems);
  checkLinks(text, rel, problems);
  checkNames(text, rel, problems);
}

// The limitation must be stated, not implied. A reader who skims must still see
// that the trustless path is absent.
{
  const security = existsSync(join(DOCS, 'security.md'))
    ? readFileSync(join(DOCS, 'security.md'), 'utf8')
    : '';
  const readme = existsSync(join(ROOT, 'README.md')) ? readFileSync(join(ROOT, 'README.md'), 'utf8') : '';
  if (!/backstop is not active/i.test(security)) {
    problems.push('docs/security.md does not state that the backstop is not active');
  }
  if (!/timeoutChallenge/.test(security)) {
    problems.push('docs/security.md does not name timeoutChallenge as how a challenge resolves');
  }
  if (!/not active|not deployed/i.test(readme)) {
    problems.push('README.md does not state the backstop limitation');
  }
  if (!/[Uu]naudited/.test(readme)) problems.push('README.md does not say it is unaudited');
}

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

{
  const sink = [];
  checkAddresses('see 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef for details', 'control', sink);
  if (sink.length === 0) problems.push('negative control failed: a fabricated address was accepted');
}
{
  const sink = [];
  checkLinks('[broken](./definitely-not-a-file.md)', 'docs/README.md', sink);
  if (sink.length === 0) problems.push('negative control failed: a broken link was accepted');
}
{
  const sink = [];
  checkNames('call `definitelyNotAContractFunction(` now', 'control', sink);
  if (sink.length === 0) problems.push('negative control failed: a nonexistent function was accepted');
}
{
  // And the positive side: a real function must not be flagged.
  const sink = [];
  checkNames('call `fundJob(` now', 'control', sink);
  if (sink.length > 0) problems.push('control failed: a real function name was flagged as nonexistent');
}

if (problems.length > 0) {
  console.error('docs FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `${EXPECTED.length} documents checked against ${VALID_NAMES.size} source identifiers ` +
    `and ${VALID_ADDRESSES.size} manifest addresses; 4 controls exercised`,
);
console.log('docs verification passed');

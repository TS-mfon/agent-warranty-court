#!/usr/bin/env node
/**
 * Prove the developer skill is well-formed and tells the truth.
 *
 * A skill is installed into someone else's agent and then trusted. The failure
 * mode is not a crash — it is a skill that confidently teaches a grammar the
 * chain no longer accepts, or quotes an address from a dead deployment. So the
 * facts it states are checked against the same sources the contracts use.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(ROOT, 'integrations/skill/agent-warranty-court/SKILL.md');
const problems = [];

if (!existsSync(SKILL)) {
  console.error('skill FAILED');
  console.error(`  - ${SKILL} does not exist`);
  process.exit(1);
}

const text = readFileSync(SKILL, 'utf8');

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

function frontmatter(md) {
  if (!md.startsWith('---\n')) return null;
  const end = md.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const block = md.slice(4, end);
  const fields = {};
  // Single-level key: value, which is all a skill header needs.
  for (const m of block.matchAll(/^([a-zA-Z_][\w-]*):\s*(.*)$/gm)) fields[m[1]] = m[2].trim();
  return fields;
}

const fm = frontmatter(text);
if (!fm) {
  problems.push('no YAML frontmatter delimited by --- at the top of the file');
} else {
  if (!fm.name) problems.push('frontmatter has no name');
  else if (fm.name !== 'agent-warranty-court') problems.push(`frontmatter name is ${fm.name}`);

  if (!fm.description) problems.push('frontmatter has no description');
  else {
    // A description is what decides whether the skill ever triggers. One that
    // only names the product describes nothing a model can match a task against.
    if (fm.description.length < 120) {
      problems.push(`description is ${fm.description.length} chars; too short to trigger reliably`);
    }
    const triggers = ['escrow', 'dispute', 'verdict', 'stake'];
    const missing = triggers.filter((t) => !fm.description.toLowerCase().includes(t));
    if (missing.length > 0) problems.push(`description names no situation involving: ${missing.join(', ')}`);
  }
}

// ---------------------------------------------------------------------------
// Addresses must exist in a manifest
// ---------------------------------------------------------------------------

function manifestAddresses() {
  const dir = join(ROOT, 'deployments');
  const set = new Set();
  if (!existsSync(dir)) return set;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    for (const m of readFileSync(join(dir, f), 'utf8').matchAll(/0x[0-9a-fA-F]{40}\b/g)) {
      set.add(m[0].toLowerCase());
    }
  }
  return set;
}

const VALID = manifestAddresses();
if (VALID.size === 0) problems.push('no manifest addresses found, so this check would pass vacuously');

function checkAddresses(body, sink) {
  for (const m of body.matchAll(/0x[0-9a-fA-F]{40}\b/g)) {
    const a = m[0].toLowerCase();
    if (/^0x0+$/.test(a)) continue;
    if (!VALID.has(a)) sink.push(`address ${m[0]} appears in no deployment manifest`);
  }
}
checkAddresses(text, problems);

// ---------------------------------------------------------------------------
// Referenced files must exist
// ---------------------------------------------------------------------------

function checkLinks(body, fromFile, sink) {
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)#\s]+)(#[^)\s]*)?\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:)/.test(target)) continue;
    if (!existsSync(resolve(dirname(fromFile), target))) {
      sink.push(`link to ${target} does not resolve`);
    }
  }
  // Bare repo paths the skill tells a reader to open.
  for (const m of body.matchAll(/`((?:integrations|docs|packages|contracts|deployments)\/[\w./-]+)`/g)) {
    const rel = m[1];
    if (!existsSync(join(ROOT, rel))) sink.push(`references ${rel}, which does not exist`);
  }
}
checkLinks(text, SKILL, problems);

// ---------------------------------------------------------------------------
// The grammar it teaches must match the contract
// ---------------------------------------------------------------------------

const lib = existsSync(join(ROOT, 'contracts/shared/VerdictLib.sol'))
  ? readFileSync(join(ROOT, 'contracts/shared/VerdictLib.sol'), 'utf8')
  : '';

if (!lib) {
  problems.push('contracts/shared/VerdictLib.sol not found, so the grammar cannot be checked');
} else {
  // Every code the skill lists must exist at the number it claims.
  for (const m of text.matchAll(/^\|\s*(\d)\s*\|\s*`([A-Z_]+)`/gm)) {
    const [, claimed, name] = m;
    const actual = lib.match(new RegExp(`constant\\s+${name}\\s*=\\s*(\\d+)\\s*;`));
    if (!actual) problems.push(`skill documents code ${name}, which VerdictLib does not define`);
    else if (actual[1] !== claimed) {
      problems.push(`skill says ${name} is ${claimed}; VerdictLib says ${actual[1]}`);
    }
  }
  // And the buckets must be the contract's buckets.
  const body = lib.match(/function isBucket\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
  const real = body
    ? [...body[1].matchAll(/bps\s*==\s*([0-9_]+)/g)].map((m) => m[1].replaceAll('_', ''))
    : [];
  for (const bucket of real) {
    if (!text.includes(bucket)) problems.push(`skill never mentions payout bucket ${bucket}`);
  }
}

// The enum order this project actually got wrong.
{
  const escrow = join(ROOT, 'contracts/base/WarrantyEscrow.sol');
  if (existsSync(escrow)) {
    const block = readFileSync(escrow, 'utf8').match(/enum\s+State\s*\{([^}]*)\}/);
    const members = block ? block[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (members.length > 0 && !text.includes(members.join(', '))) {
      problems.push(`skill does not state the State enum in contract order (${members.join(', ')})`);
    }
  }
}

// ---------------------------------------------------------------------------
// The limitation must be stated
// ---------------------------------------------------------------------------

if (!/backstop is not deployed|backstop is not active/i.test(text)) {
  problems.push('skill does not state that the canonical backstop is absent');
}
if (!/timeoutChallenge/.test(text)) problems.push('skill does not name timeoutChallenge');
if (!/[Uu]naudited/.test(text)) problems.push('skill does not say the protocol is unaudited');
if (!/testnet only/i.test(text)) problems.push('skill does not say testnet only');

// ---------------------------------------------------------------------------
// Negative controls
// ---------------------------------------------------------------------------

{
  const sink = [];
  checkAddresses('use 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', sink);
  if (sink.length === 0) problems.push('negative control failed: a fabricated address was accepted');
}
{
  const sink = [];
  checkLinks('[x](./nope-not-a-file.md) and `docs/not-real.md`', SKILL, sink);
  if (sink.length < 2) problems.push('negative control failed: a broken link or path was accepted');
}
{
  const sink = [];
  checkAddresses([...VALID][0] ?? '0x0', sink);
  if (sink.length > 0) problems.push('control failed: a real manifest address was flagged');
}

if (problems.length > 0) {
  console.error('skill FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `frontmatter valid, every referenced path resolves, codes and buckets match ` +
    `VerdictLib, limitation stated, checked against ${VALID.size} manifest addresses`,
);
console.log('skill verification passed');

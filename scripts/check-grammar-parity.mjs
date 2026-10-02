#!/usr/bin/env node
/**
 * Prove the four copies of the verdict grammar agree.
 *
 * The grammar exists in four places by design — Solidity, Python, TypeScript,
 * and the Python EVM interface declaration — because each hop re-derives it
 * rather than trusting its neighbour. That design is only safe if the copies
 * are actually equal, and a comment asking people to remember is not a
 * mechanism. This script parses the real Solidity and Python sources, imports
 * the real TypeScript module, and compares them.
 *
 * It ends with a negative control. Every assertion below could pass because the
 * comparison logic is broken rather than because the sources agree, and an
 * absence check that cannot fail is worse than no check: it certifies. So the
 * last step feeds the comparator a deliberately corrupted copy and fails if the
 * comparator accepts it.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const fail = (msg) => problems.push(msg);

const read = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch (e) {
    fail(`cannot read ${rel}: ${e.message}`);
    return '';
  }
};

// ---------------------------------------------------------------------------
// Solidity
// ---------------------------------------------------------------------------

const sol = read('contracts/shared/VerdictLib.sol');

/** `uint8 internal constant NAME = 7;` → 7 */
function solConst(name) {
  const m = sol.match(new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`));
  if (!m) {
    fail(`VerdictLib.sol: constant ${name} not found`);
    return null;
  }
  return Number(m[1].replaceAll('_', ''));
}

const solCodes = {
  NO_BREACH: solConst('NO_BREACH'),
  UNSUPPORTED_FACT_HALLUCINATION: solConst('UNSUPPORTED_FACT_HALLUCINATION'),
  SCHEMA_MALFORMED_OUTPUT: solConst('SCHEMA_MALFORMED_OUTPUT'),
  DEAD_LINK_CITATION: solConst('DEAD_LINK_CITATION'),
  UNAUTHORIZED_TOOL_CALL: solConst('UNAUTHORIZED_TOOL_CALL'),
  SILENT_FAILURE: solConst('SILENT_FAILURE'),
  EVIDENCE_UNAVAILABLE: solConst('EVIDENCE_UNAVAILABLE'),
};
const solMaxCode = solConst('MAX_CODE');
const solMaxSeverity = solConst('MAX_SEVERITY');
const solBpsDenominator = solConst('BPS_DENOMINATOR');
const solMinBreachPayout = solConst('MIN_BREACH_PAYOUT_BPS');

/** Buckets live in the body of `isBucket`, not in constants. */
function solBuckets() {
  const body = sol.match(/function isBucket\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
  if (!body) {
    fail('VerdictLib.sol: isBucket body not found');
    return [];
  }
  const found = [...body[1].matchAll(/bps\s*==\s*([0-9_]+)/g)].map((m) =>
    Number(m[1].replaceAll('_', '')),
  );
  if (found.length === 0) fail('VerdictLib.sol: isBucket lists no buckets');
  return found.sort((a, b) => a - b);
}

/** `if (severity == 1) return 1_000;` → {1: 1000, ...} */
function solSlashTable() {
  const body = sol.match(/function slashBpsFor\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
  if (!body) {
    fail('VerdictLib.sol: slashBpsFor body not found');
    return {};
  }
  const table = {};
  for (const m of body[1].matchAll(/severity\s*==\s*(\d+)\)\s*return\s+([0-9_]+)/g)) {
    table[Number(m[1])] = Number(m[2].replaceAll('_', ''));
  }
  if (Object.keys(table).length === 0) fail('VerdictLib.sol: slashBpsFor has no branches');
  return table;
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const py = read('contracts/genlayer/warranty_court.py');

/** The ordered VIOLATION_CODES tuple. Its index *is* the Solidity code. */
function pyViolationCodes() {
  const m = py.match(/^VIOLATION_CODES\s*=\s*\(([\s\S]*?)\)/m);
  if (!m) {
    fail('warranty_court.py: VIOLATION_CODES tuple not found');
    return [];
  }
  const names = [];
  for (const line of m[1].split('\n')) {
    const bare = line.replace(/#.*$/, '').trim().replace(/,$/, '');
    if (!bare) continue;
    const quoted = bare.match(/^"([A-Z_]+)"$/);
    // `NO_BREACH` is referenced as a bare name, the rest are string literals.
    if (quoted) names.push(quoted[1]);
    else if (/^[A-Z_]+$/.test(bare)) names.push(bare);
    else fail(`warranty_court.py: unparsed VIOLATION_CODES entry ${JSON.stringify(bare)}`);
  }
  if (names.length === 0) fail('warranty_court.py: VIOLATION_CODES is empty');
  return names;
}

function pyConst(name) {
  const m = py.match(new RegExp(`^${name}\\s*=\\s*([0-9_]+)\\s*$`, 'm'));
  if (!m) {
    fail(`warranty_court.py: constant ${name} not found`);
    return null;
  }
  return Number(m[1].replaceAll('_', ''));
}

function pyBuckets() {
  const m = py.match(/^PAYOUT_BUCKETS\s*=\s*\(([^)]*)\)/m);
  if (!m) {
    fail('warranty_court.py: PAYOUT_BUCKETS not found');
    return [];
  }
  const found = m[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s.replaceAll('_', '')));
  if (found.some(Number.isNaN)) fail('warranty_court.py: unparsed PAYOUT_BUCKETS entry');
  return found.sort((a, b) => a - b);
}

/** The EVM interface's declared Solidity signature, built from annotations. */
function pyEmitSignature() {
  const block = py.match(/def publishVerdict\(([\s\S]*?)\)\s*->/);
  if (!block) {
    fail('warranty_court.py: publishVerdict declaration not found');
    return null;
  }
  const typeMap = { 'gl.evm.bytes32': 'bytes32', u8: 'uint8', u16: 'uint16', u256: 'uint256' };
  const types = [];
  for (const raw of block[1].split(',')) {
    const part = raw.trim();
    if (!part || part === 'self' || part === '/') continue;
    const [, ann] = part.split(':').map((s) => s.trim());
    if (!ann) {
      fail(`warranty_court.py: publishVerdict parameter ${JSON.stringify(part)} has no annotation`);
      continue;
    }
    if (!(ann in typeMap)) {
      fail(`warranty_court.py: unmapped emit parameter type ${JSON.stringify(ann)}`);
      continue;
    }
    types.push(typeMap[ann]);
  }
  // Positional-only is an SDK requirement; without the `/` the interface
  // generator asserts at load time rather than producing a wrong selector.
  if (!block[1].includes('/')) {
    fail('warranty_court.py: publishVerdict parameters are not positional-only (missing `/`)');
  }
  return `publishVerdict(${types.join(',')})`;
}

/** The signature Foundry computed for the deployed emitter. */
function solidityEmitSignature() {
  let artifact;
  try {
    artifact = JSON.parse(read('out/VerdictEmitter.sol/VerdictEmitter.json'));
  } catch {
    fail('out/VerdictEmitter.sol/VerdictEmitter.json unreadable; run `forge build` first');
    return null;
  }
  const ids = artifact?.methodIdentifiers ?? {};
  const sig = Object.keys(ids).find((k) => k.startsWith('publishVerdict('));
  if (!sig) fail('VerdictEmitter ABI has no publishVerdict');
  return sig ?? null;
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

const ts = await import('../packages/shared/src/verdict.ts');

/**
 * The comparator, isolated so the negative control can exercise the same code
 * path rather than a convenient re-implementation of it.
 */
function compare(tsMod, solidity, python, sink) {
  const note = (m) => sink.push(m);

  for (const [name, code] of Object.entries(solidity.codes)) {
    if (tsMod.VIOLATION_CODE[name] !== code) {
      note(`code ${name}: Solidity ${code} vs TypeScript ${tsMod.VIOLATION_CODE[name]}`);
    }
  }

  // The load-bearing one: a code's index in the Python tuple must equal its
  // Solidity number, because the contract maps them with `.index()`.
  python.codes.forEach((name, index) => {
    if (solidity.codes[name] !== index) {
      note(`code ${name}: Python index ${index} vs Solidity ${solidity.codes[name]}`);
    }
  });

  // EVIDENCE_UNAVAILABLE is a status in Python, so it must be absent from the
  // tuple and numbered explicitly instead.
  if (python.codes.includes('EVIDENCE_UNAVAILABLE')) {
    note('EVIDENCE_UNAVAILABLE must not appear in VIOLATION_CODES; it is a status, not a finding');
  }
  if (python.evidenceUnavailable !== solidity.codes.EVIDENCE_UNAVAILABLE) {
    note(
      `EVIDENCE_UNAVAILABLE: Python ${python.evidenceUnavailable} vs ` +
        `Solidity ${solidity.codes.EVIDENCE_UNAVAILABLE}`,
    );
  }
  if (python.codes.length !== solidity.maxCode) {
    note(`VIOLATION_CODES has ${python.codes.length} entries; Solidity MAX_CODE is ${solidity.maxCode}`);
  }

  const tsNames = tsMod.VIOLATION_CODE_NAMES;
  python.codes.forEach((name, i) => {
    if (tsNames[i] !== name) note(`name at index ${i}: Python ${name} vs TypeScript ${tsNames[i]}`);
  });
  if (tsNames[solidity.codes.EVIDENCE_UNAVAILABLE] !== null) {
    note('TypeScript VIOLATION_CODE_NAMES must hold null at the EVIDENCE_UNAVAILABLE index');
  }

  const scalars = [
    ['MAX_CODE', solidity.maxCode, tsMod.MAX_CODE],
    ['MAX_SEVERITY', solidity.maxSeverity, tsMod.MAX_SEVERITY],
    ['BPS_DENOMINATOR', solidity.bpsDenominator, tsMod.BPS_DENOMINATOR],
    ['MIN_BREACH_PAYOUT_BPS', solidity.minBreachPayout, tsMod.MIN_BREACH_PAYOUT_BPS],
    ['MIN_BREACH_PAYOUT (py)', python.minBreachPayout, tsMod.MIN_BREACH_PAYOUT_BPS],
  ];
  for (const [label, expected, actual] of scalars) {
    if (expected !== actual) note(`${label}: ${expected} vs ${actual}`);
  }

  const tsBuckets = [...tsMod.PAYOUT_BUCKETS].sort((a, b) => a - b);
  const j = (a) => JSON.stringify(a);
  if (j(solidity.buckets) !== j(tsBuckets)) {
    note(`buckets: Solidity ${j(solidity.buckets)} vs TypeScript ${j(tsBuckets)}`);
  }
  if (j(python.buckets) !== j(tsBuckets)) {
    note(`buckets: Python ${j(python.buckets)} vs TypeScript ${j(tsBuckets)}`);
  }

  for (const [sev, bps] of Object.entries(solidity.slash)) {
    if (tsMod.slashBpsFor(Number(sev)) !== bps) {
      note(`slash severity ${sev}: Solidity ${bps} vs TypeScript ${tsMod.slashBpsFor(Number(sev))}`);
    }
  }
  if (tsMod.slashBpsFor(0) !== 0) note('slash at severity 0 must be 0');

  if (solidity.emitSignature && python.emitSignature && solidity.emitSignature !== python.emitSignature) {
    note(`emit signature: Solidity ABI ${solidity.emitSignature} vs Python ${python.emitSignature}`);
  }
  return sink;
}

const solidity = {
  codes: solCodes,
  maxCode: solMaxCode,
  maxSeverity: solMaxSeverity,
  bpsDenominator: solBpsDenominator,
  minBreachPayout: solMinBreachPayout,
  buckets: solBuckets(),
  slash: solSlashTable(),
  emitSignature: solidityEmitSignature(),
};
const python = {
  codes: pyViolationCodes(),
  evidenceUnavailable: pyConst('SOLIDITY_EVIDENCE_UNAVAILABLE'),
  minBreachPayout: pyConst('MIN_BREACH_PAYOUT'),
  buckets: pyBuckets(),
  emitSignature: pyEmitSignature(),
};

compare(ts, solidity, python, problems);

// ---------------------------------------------------------------------------
// Negative control
// ---------------------------------------------------------------------------

const controls = [
  ['a shifted Python enum', (s, p) => ({ s, p: { ...p, codes: ['SILENT_FAILURE', ...p.codes] } })],
  ['a renumbered Solidity code', (s, p) => ({ s: { ...s, codes: { ...s.codes, SILENT_FAILURE: 9 } }, p })],
  ['an extra payout bucket', (s, p) => ({ s: { ...s, buckets: [...s.buckets, 1_234] }, p })],
  ['a changed slash table', (s, p) => ({ s: { ...s, slash: { ...s.slash, 2: 9_999 } }, p })],
  ['a mistyped emit signature', (s, p) => ({ s, p: { ...p, emitSignature: 'publishVerdict(bytes,bytes,uint8,uint16,uint8)' } })],
  ['EVIDENCE_UNAVAILABLE smuggled into the tuple', (s, p) => ({ s, p: { ...p, codes: [...p.codes, 'EVIDENCE_UNAVAILABLE'] } })],
];

for (const [label, mutate] of controls) {
  const { s, p } = mutate(solidity, python);
  if (compare(ts, s, p, []).length === 0) {
    problems.push(`negative control did not fail: the comparator accepted ${label}`);
  }
}

if (problems.length > 0) {
  console.error('grammar parity FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `checked ${python.codes.length + 1} codes, ${solidity.buckets.length} buckets, ` +
    `${Object.keys(solidity.slash).length} slash tiers, emit ${solidity.emitSignature}, ` +
    `and ${controls.length} negative controls`,
);
console.log('grammar parity verification passed');

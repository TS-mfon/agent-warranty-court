/**
 * The verdict grammar, parsed out of the project's own sources at startup.
 *
 * This file deliberately contains no codes, no buckets and no slash tiers. The
 * grammar already exists in four places — Solidity, Python, TypeScript and the
 * EVM ABI — and `scripts/check-grammar-parity.mjs` exists because four copies
 * of one rule set is a liability. A fifth copy, living in a server a developer
 * installs once and never updates, would be the worst of them: it would drift
 * silently and teach agents a grammar Base no longer accepts.
 *
 * So everything below is derived from `contracts/shared/VerdictLib.sol`. If the
 * contract changes, this server follows on the next start. If the contract
 * cannot be found or parsed, the server refuses to start rather than falling
 * back to remembered values.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repo root, resolved from this file: integrations/mcp/src → ../../.. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const VERDICT_LIB = join(ROOT, 'contracts/shared/VerdictLib.sol');
const ESCROW_SOL = join(ROOT, 'contracts/base/WarrantyEscrow.sol');
const INBOX_SOL = join(ROOT, 'contracts/base/VerdictInbox.sol');

function mustRead(path, what) {
  if (!existsSync(path)) {
    throw new Error(
      `cannot derive ${what}: ${path} not found. This server reads the protocol's ` +
        'own sources on purpose and will not serve remembered values.',
    );
  }
  return readFileSync(path, 'utf8');
}

const lib = mustRead(VERDICT_LIB, 'the verdict grammar');

function solConst(name) {
  const m = lib.match(new RegExp(`constant\\s+${name}\\s*=\\s*([0-9_]+)\\s*;`));
  if (!m) throw new Error(`VerdictLib.sol: constant ${name} not found`);
  return Number(m[1].replaceAll('_', ''));
}

/** Code names in declaration order, so the array index is the uint8 value. */
function violationCodes() {
  const names = [];
  for (const m of lib.matchAll(/uint8\s+internal\s+constant\s+([A-Z_]+)\s*=\s*(\d+)\s*;/g)) {
    const [, name, value] = m;
    if (['MAX_CODE', 'MAX_SEVERITY'].includes(name)) continue;
    names[Number(value)] = name;
  }
  if (names.length === 0 || names.some((n) => n === undefined)) {
    throw new Error('VerdictLib.sol: violation codes did not parse into a dense array');
  }
  return names;
}

function buckets() {
  const body = lib.match(/function isBucket\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
  if (!body) throw new Error('VerdictLib.sol: isBucket body not found');
  const found = [...body[1].matchAll(/bps\s*==\s*([0-9_]+)/g)].map((m) => Number(m[1].replaceAll('_', '')));
  if (found.length === 0) throw new Error('VerdictLib.sol: isBucket lists no buckets');
  return found.sort((a, b) => a - b);
}

function slashTable() {
  const body = lib.match(/function slashBpsFor\([^)]*\)[^{]*\{([\s\S]*?)\n    \}/);
  if (!body) throw new Error('VerdictLib.sol: slashBpsFor body not found');
  const table = {};
  for (const m of body[1].matchAll(/severity\s*==\s*(\d+)\)\s*return\s+([0-9_]+)/g)) {
    table[Number(m[1])] = Number(m[2].replaceAll('_', ''));
  }
  if (Object.keys(table).length === 0) throw new Error('VerdictLib.sol: slashBpsFor has no branches');
  return table;
}

/** An enum's members in declaration order, from a Solidity source. */
function solEnum(path, name, what) {
  const src = mustRead(path, what);
  const block = src.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]*)\\}`));
  if (!block) throw new Error(`${name} enum not found in ${path}`);
  const members = block[1].split(',').map((l) => l.replace(/\/\/.*$/gm, '').trim()).filter(Boolean);
  if (members.length === 0) throw new Error(`${name} enum in ${path} has no members`);
  return members;
}

export const GRAMMAR = Object.freeze({
  codes: violationCodes(),
  buckets: buckets(),
  slashBySeverity: slashTable(),
  maxCode: solConst('MAX_CODE'),
  maxSeverity: solConst('MAX_SEVERITY'),
  bpsDenominator: solConst('BPS_DENOMINATOR'),
  minBreachPayoutBps: solConst('MIN_BREACH_PAYOUT_BPS'),
  noBreach: solConst('NO_BREACH'),
  evidenceUnavailable: solConst('EVIDENCE_UNAVAILABLE'),
});

export const JOB_STATES = Object.freeze(solEnum(ESCROW_SOL, 'State', 'job states'));
export const VERDICT_STATUSES = Object.freeze(solEnum(INBOX_SOL, 'Status', 'verdict statuses'));

/** `VerdictLib.isCoherent`, with the reason Base would reject it. */
export function coherence(code, payoutBps, severity) {
  const reasons = [];
  const isInt = (n) => Number.isInteger(n);

  if (!isInt(code) || code < 0 || code > GRAMMAR.maxCode) {
    reasons.push(`code must be an integer 0..${GRAMMAR.maxCode}, got ${JSON.stringify(code)}`);
  }
  if (!isInt(severity) || severity < 0 || severity > GRAMMAR.maxSeverity) {
    reasons.push(`severity must be an integer 0..${GRAMMAR.maxSeverity}, got ${JSON.stringify(severity)}`);
  }
  if (!isInt(payoutBps) || !GRAMMAR.buckets.includes(payoutBps)) {
    reasons.push(`payoutBps must be one of ${GRAMMAR.buckets.join(', ')}, got ${JSON.stringify(payoutBps)}`);
  }

  if (reasons.length === 0) {
    const zeroPayoutCode = code === GRAMMAR.noBreach || code === GRAMMAR.evidenceUnavailable;
    if (zeroPayoutCode) {
      if (severity !== 0) reasons.push(`code ${code} (${GRAMMAR.codes[code]}) requires severity 0, got ${severity}`);
      if (payoutBps !== 0) reasons.push(`code ${code} (${GRAMMAR.codes[code]}) requires payoutBps 0, got ${payoutBps}`);
    } else {
      if (severity < 1) reasons.push(`a breach code requires severity >= 1, got ${severity}`);
      if (payoutBps < GRAMMAR.minBreachPayoutBps) {
        reasons.push(`a breach requires payoutBps >= ${GRAMMAR.minBreachPayoutBps}, got ${payoutBps}`);
      }
    }
  }

  return {
    coherent: reasons.length === 0,
    wouldRevert: reasons.length === 0 ? null : 'IncoherentVerdict(code, payoutBps, severity)',
    reasons,
  };
}

/** The verdict commitment. Field order frozen; reasoning last. */
export function verdictCommitment({ caseId, violationCode, payoutBps, severity, reasoning }) {
  const intString = (v, field) => {
    const n = typeof v === 'string' ? Number(v) : v;
    if (!Number.isSafeInteger(n)) throw new Error(`${field} must be an integer, got ${JSON.stringify(v)}`);
    return String(n);
  };
  const joined = [
    caseId,
    violationCode,
    intString(payoutBps, 'payoutBps'),
    intString(severity, 'severity'),
    reasoning ?? '',
  ].join('\n');
  return '0x' + createHash('sha256').update(joined, 'utf8').digest('hex');
}

export function loadManifest(chainId) {
  const path = join(ROOT, 'deployments', `${chainId}.json`);
  if (!existsSync(path)) throw new Error(`no deployment manifest for chain ${chainId}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  if (parsed.chainId !== chainId) {
    throw new Error(`manifest ${path} declares chainId ${parsed.chainId}`);
  }
  return parsed;
}

/**
 * Function selectors, reused from `web/generated/data.js`.
 *
 * Not typed in. Hand-written selectors have been wrong three separate times in
 * this project — twice in `check-deployment.mjs` and twice again in the first
 * draft of this server — and the failure is quiet: a wrong selector hits the
 * fallback, `eth_call` returns empty, and the caller reads it as state 0, which
 * for both of these enums means "unknown". A plausible wrong answer.
 *
 * That generated file is produced with `cast sig` and is itself gated by
 * `scripts/check-web-build.mjs`, so it is the one place in the repository where
 * a selector is known to be right.
 */
export async function loadSelectors() {
  const path = join(ROOT, 'web/generated/data.js');
  if (!existsSync(path)) {
    throw new Error(
      `cannot load selectors: ${path} not found. Run \`node web/build.mjs\` ` +
        '(it derives them with `cast sig`). This server will not guess a selector.',
    );
  }
  const mod = await import(`file://${path}`);
  const selectors = mod.SELECTORS;
  if (!selectors || typeof selectors !== 'object') {
    throw new Error('web/generated/data.js exports no SELECTORS map');
  }
  for (const [sig, sel] of Object.entries(selectors)) {
    if (!/^0x[0-9a-f]{8}$/.test(sel)) throw new Error(`selector for ${sig} is malformed: ${sel}`);
  }
  return selectors;
}

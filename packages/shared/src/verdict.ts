/**
 * The verdict grammar, in TypeScript.
 *
 * This is the fourth copy. The others are `contracts/shared/VerdictLib.sol`,
 * `VIOLATION_CODES` in `contracts/genlayer/warranty_court.py`, and the enum the
 * adjudication prompt is allowed to emit. Four copies of one rule set is a
 * liability, and the honest mitigation is not a comment asking people to
 * remember: `scripts/check-grammar-parity.mjs` parses the Solidity and the
 * Python and fails if either disagrees with this file.
 *
 * The duplication itself is deliberate. The relayer sits between two chains and
 * is the only party that is merely bonded rather than trusted, so each hop
 * re-derives the grammar instead of inheriting a neighbour's verdict.
 */

/** Violation codes. The numbering is Solidity's and the ordering is Python's. */
export const VIOLATION_CODE = {
  NO_BREACH: 0,
  UNSUPPORTED_FACT_HALLUCINATION: 1,
  SCHEMA_MALFORMED_OUTPUT: 2,
  DEAD_LINK_CITATION: 3,
  UNAUTHORIZED_TOOL_CALL: 4,
  SILENT_FAILURE: 5,
  /**
   * Not a violation on GenLayer — a case *status* there. The relayer maps that
   * status onto this code so Base can tell an adjudicated acquittal (settle
   * now) from a court that could not read the evidence (cure window first).
   * Both carry a zero payout, so without the distinction the cure window could
   * never trigger.
   */
  EVIDENCE_UNAVAILABLE: 6,
} as const;

export type ViolationCodeName = keyof typeof VIOLATION_CODE;
export type ViolationCode = (typeof VIOLATION_CODE)[ViolationCodeName];

/**
 * The names GenLayer uses, indexed by Solidity code.
 *
 * Index 6 is `null` on purpose rather than the string `"EVIDENCE_UNAVAILABLE"`:
 * that value is a status in the Python contract and is absent from its
 * `VIOLATION_CODES` tuple, so claiming a name here would make the parity check
 * compare a tuple of 6 against a list of 7 and paper over the difference.
 */
export const VIOLATION_CODE_NAMES: readonly (ViolationCodeName | null)[] = [
  'NO_BREACH',
  'UNSUPPORTED_FACT_HALLUCINATION',
  'SCHEMA_MALFORMED_OUTPUT',
  'DEAD_LINK_CITATION',
  'UNAUTHORIZED_TOOL_CALL',
  'SILENT_FAILURE',
  null,
];

export const MAX_CODE = 6;
export const MAX_SEVERITY = 3;
export const BPS_DENOMINATOR = 10_000;
export const MIN_BREACH_PAYOUT_BPS = 2_500;

/**
 * Payout buckets. A consensus requirement, not a simplification: independent
 * validators never converge on a free integer and converge reliably on five
 * values.
 */
export const PAYOUT_BUCKETS = [0, 2_500, 5_000, 7_500, 10_000] as const;

export interface Verdict {
  readonly code: number;
  readonly payoutBps: number;
  readonly severity: number;
}

const isUint = (n: number, max: number): boolean =>
  Number.isInteger(n) && n >= 0 && n <= max;

export function isBucket(bps: number): boolean {
  return (PAYOUT_BUCKETS as readonly number[]).includes(bps);
}

/**
 * Cross-field coherence, mirroring `VerdictLib.isCoherent` and the Python
 * `_normalize` rules.
 *
 * Individually valid fields can still be incoherent together, and that specific
 * shape — `NO_BREACH` carrying a full refund — is what a half-successful prompt
 * injection produces. The integrality guard is extra here rather than a
 * translation of Solidity: `uint8` cannot hold `2.5` or `NaN`, but a JSON number
 * off the wire can, and a keeper that accepted one would compute a payout
 * Solidity would then reject.
 */
export function isCoherent(v: Verdict): boolean {
  if (!isUint(v.code, MAX_CODE)) return false;
  if (!isUint(v.severity, MAX_SEVERITY)) return false;
  if (!Number.isInteger(v.payoutBps) || !isBucket(v.payoutBps)) return false;

  if (v.code === VIOLATION_CODE.NO_BREACH || v.code === VIOLATION_CODE.EVIDENCE_UNAVAILABLE) {
    return v.severity === 0 && v.payoutBps === 0;
  }
  return v.severity >= 1 && v.payoutBps >= MIN_BREACH_PAYOUT_BPS;
}

export function isBreach(code: number): boolean {
  return code !== VIOLATION_CODE.NO_BREACH && code !== VIOLATION_CODE.EVIDENCE_UNAVAILABLE;
}

/** Stake slashed on a breach, as a fraction of job value. */
export function slashBpsFor(severity: number): number {
  if (severity === 1) return 1_000;
  if (severity === 2) return 2_500;
  if (severity === 3) return 5_000;
  return 0;
}

/**
 * Map a GenLayer verdict onto its Solidity code.
 *
 * `status` is consulted first because `EVIDENCE_UNAVAILABLE` arrives as a status
 * carrying `violation_code: "NO_BREACH"`. Reading only the code would collapse
 * the two into an acquittal and settle immediately, skipping the cure window
 * that exists so an unreachable evidence host cannot be used to attack either
 * party.
 */
export function solidityCode(violationCode: string, status: string): number {
  if (status === 'EVIDENCE_UNAVAILABLE') return VIOLATION_CODE.EVIDENCE_UNAVAILABLE;
  const index = VIOLATION_CODE_NAMES.indexOf(violationCode as ViolationCodeName);
  if (index < 0) throw new Error(`off-enum violation code: ${JSON.stringify(violationCode)}`);
  return index;
}

import { createHash } from 'node:crypto';

/**
 * The verdict commitment, reproduced from `_verdict_commitment` in the
 * Intelligent Contract.
 *
 * This is the single most drift-sensitive function in the TypeScript tree. The
 * keeper posts this hash to `VerdictInbox` as `verdictHash`; a challenger
 * recomputes it to prove the keeper posted something else. If this
 * implementation and the Python one disagree by one byte, every verdict the
 * keeper posts is overturnable and every relayer bond is forfeit — while every
 * unit test that only checks this function against itself still passes. So
 * `scripts/check-commitment-parity.mjs` runs the actual Python contract helper
 * and compares, rather than trusting this comment.
 *
 * Newline-joined rather than JSON: object key order is a serializer detail, and
 * a commitment whose bytes depend on a serializer's mood is not a commitment.
 * `reasoning` goes last because it is the only field allowed to contain a
 * newline — anywhere else it could forge a field boundary.
 */
export interface CommitmentInput {
  readonly caseId: string;
  readonly violationCode: string;
  readonly payoutBps: number | string;
  readonly severity: number | string;
  readonly reasoning: string;
}

/** Field order, frozen. Mirrors `COMMITMENT_FIELDS` in the Python contract. */
export const COMMITMENT_FIELDS = [
  'case_id',
  'violation_code',
  'payout_bps',
  'severity',
  'reasoning',
] as const;

const asIntString = (value: number | string, field: string): string => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (!Number.isInteger(n)) {
    throw new Error(`${field} must be an integer for commitment, got ${JSON.stringify(value)}`);
  }
  // `String(Number)` and Python's `str(int(...))` agree on every integer in
  // range, but diverge on exponential notation (1e21). Verdict fields are
  // bounded far below that, and asserting it is cheaper than discovering it.
  if (!Number.isSafeInteger(n)) throw new Error(`${field} out of safe integer range`);
  return String(n);
};

export function verdictCommitment(input: CommitmentInput): string {
  const joined = [
    input.caseId,
    input.violationCode,
    asIntString(input.payoutBps, 'payoutBps'),
    asIntString(input.severity, 'severity'),
    input.reasoning,
  ].join('\n');
  return '0x' + createHash('sha256').update(joined, 'utf8').digest('hex');
}

/** A `0x`-prefixed 32-byte hex string — the shape of a Base `caseId`. */
export function isBytes32Hex(value: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(value);
}

export function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

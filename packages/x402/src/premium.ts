/**
 * The warranty premium split, derived from the deployment manifest.
 *
 * This file exists because the x402 intake quotes a number *before* the chain
 * sees the trade. `WarrantyEscrow.fundJob` recomputes the same split in
 * Solidity, and if the two disagree by one wei the server has quoted a figure
 * the contract will not honour: the payer signs an EIP-3009 authorization for a
 * gross amount, the escrow splits it its own way, and the difference surfaces
 * as an unexplained shortfall in either the vault or the escrow balance.
 *
 * So the arithmetic below is a transcription of `fundJob`, not an
 * approximation of it:
 *
 *     uint256 premium  = (amount   * premiumBps)       / BPS_DENOMINATOR;
 *     uint256 escrowed = amount - premium;
 *     uint256 required = (escrowed * requiredStakeBps) / BPS_DENOMINATOR;
 *
 * Three properties of that are load-bearing and are each easy to get wrong in
 * TypeScript:
 *
 *   1. It truncates. Solidity integer division floors, and every quantity here
 *      is non-negative, so `bigint`'s truncate-toward-zero division is exactly
 *      equivalent. `Number` arithmetic is not — it would quote 61728.35.
 *   2. The multiplication happens *before* the division. Dividing first loses
 *      the low-order digits that decide the truncation.
 *   3. `requiredStake` is a fraction of `escrowed`, not of `gross`. Taking it
 *      from the gross over-quotes the provider's stake requirement by 5% of 5%
 *      and makes jobs look unfundable that the contract would accept.
 *
 * The rates themselves are never written down here. They come from
 * `deployments/<chainId>.json`, which is the same file the deploy script fed to
 * the constructor, because a hardcoded "5%" is a value that can drift away from
 * the live immutable without anything failing.
 */
import {
  BPS_DENOMINATOR as BPS_DENOMINATOR_NUMBER,
  CHAINS,
  MAX_SEVERITY,
  loadDeployment,
  slashBpsFor,
  type Deployment,
} from '@awc/shared';

/** `VerdictLib.BPS_DENOMINATOR`, as a bigint so it can divide bigints. */
export const BPS_DENOMINATOR = BigInt(BPS_DENOMINATOR_NUMBER);

/**
 * `WarrantyEscrow`'s own ceiling on the premium (`PremiumTooHigh`). Asserted
 * against the manifest so a fat-fingered manifest is caught at quote time
 * rather than at `fundJob` revert time.
 */
export const MAX_PREMIUM_BPS = 1_000;

/** The rates the escrow was constructed with. */
export interface PremiumRates {
  readonly premiumBps: number;
  readonly requiredStakeBps: number;
}

/** What a payer is told it is buying, in USDC base units. */
export interface PremiumSplit {
  /** What the payer authorizes: the full `amount` argument to `fundJob`. */
  readonly gross: bigint;
  /** Skimmed to `warrantyVault` at funding time. This is the insurance. */
  readonly premium: bigint;
  /** What the escrow actually holds, and the ceiling on any dispute payout. */
  readonly escrowed: bigint;
  /** Provider collateral `fundJob` locks; the gate on accepting the job. */
  readonly requiredStake: bigint;
}

/**
 * The manifest carries deploy-time parameters alongside the addresses, but
 * `@awc/shared`'s `Deployment` deliberately types only the parts every consumer
 * needs. This narrows that for the two rates we read.
 */
interface ManifestWithParams extends Deployment {
  readonly params?: Readonly<Record<string, unknown>>;
}

const asBps = (value: unknown, field: string, chainId: number): number => {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error(
      `chain ${chainId} manifest params.${field} must be an integer basis-point ` +
        `value, got ${JSON.stringify(value)}`,
    );
  }
  if (value < 0 || value > BPS_DENOMINATOR_NUMBER) {
    throw new Error(`chain ${chainId} manifest params.${field} out of range: ${value}`);
  }
  return value;
};

/**
 * Read `premiumBps` / `requiredStakeBps` out of a manifest, re-applying the
 * constructor's own guards.
 *
 * Re-checking the bounds here is not paranoia about the file: it is the
 * difference between "the quote endpoint returns a number no `fundJob` call can
 * reproduce" and "intake refuses to start".
 */
export function ratesFrom(deployment: Deployment): PremiumRates {
  const params = (deployment as ManifestWithParams).params;
  if (!params) {
    throw new Error(`chain ${deployment.chainId} manifest has no params block`);
  }
  const premiumBps = asBps(params['premiumBps'], 'premiumBps', deployment.chainId);
  const requiredStakeBps = asBps(params['requiredStakeBps'], 'requiredStakeBps', deployment.chainId);

  if (premiumBps > MAX_PREMIUM_BPS) {
    throw new Error(
      `premiumBps ${premiumBps} exceeds the escrow's PremiumTooHigh ceiling ${MAX_PREMIUM_BPS}`,
    );
  }
  // Mirrors the constructor's `requiredStakeBps_ < slashBpsFor(MAX_SEVERITY)`
  // check: stake below the worst-case slash would make the harshest verdict
  // unenforceable.
  const floor = slashBpsFor(MAX_SEVERITY);
  if (requiredStakeBps < floor) {
    throw new Error(
      `requiredStakeBps ${requiredStakeBps} is below the maximum-severity slash ${floor}`,
    );
  }
  return { premiumBps, requiredStakeBps };
}

/** Convenience: the rates for a chain, straight from its manifest. */
export function ratesForChain(chainId: number = CHAINS.baseSepolia, root?: string): PremiumRates {
  return ratesFrom(root === undefined ? loadDeployment(chainId) : loadDeployment(chainId, root));
}

/**
 * The split, bit for bit as `WarrantyEscrow.fundJob` computes it.
 *
 * `gross` is a bigint and not a number on purpose: USDC's 6 decimals fit in a
 * double today, but the contract's argument is a `uint256` and the moment a
 * quote is derived through floating point the truncation stops matching.
 */
export function splitPremium(gross: bigint, rates: PremiumRates): PremiumSplit {
  if (typeof gross !== 'bigint') {
    throw new TypeError('gross must be a bigint in USDC base units');
  }
  // `fundJob` reverts with ZeroAmount, so a zero quote is not a quote.
  if (gross <= 0n) throw new Error(`gross must be positive, got ${gross}`);

  const premium = (gross * BigInt(rates.premiumBps)) / BPS_DENOMINATOR;
  const escrowed = gross - premium;
  const requiredStake = (escrowed * BigInt(rates.requiredStakeBps)) / BPS_DENOMINATOR;

  return { gross, premium, escrowed, requiredStake };
}

/** The split for a chain, reading the rates from its manifest. */
export function splitPremiumForChain(
  gross: bigint,
  chainId: number = CHAINS.baseSepolia,
  root?: string,
): PremiumSplit {
  return splitPremium(gross, ratesForChain(chainId, root));
}

/**
 * Parse a base-unit amount off the wire.
 *
 * Deliberately strict: no decimal point, no sign, no `0x`, no exponent, no
 * underscores. `BigInt('5.0')` throws but `BigInt(' 5 ')` does not, and an
 * amount that silently survives whitespace trimming in one component and not
 * another is how a quote and a signature end up describing different trades.
 */
export function parseBaseUnits(raw: string): bigint {
  if (typeof raw !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(raw)) {
    throw new Error(`amount must be a decimal string in USDC base units, got ${JSON.stringify(raw)}`);
  }
  return BigInt(raw);
}

/** The split rendered for JSON: bigints become decimal strings, losslessly. */
export function serializeSplit(split: PremiumSplit): Readonly<Record<keyof PremiumSplit, string>> {
  return {
    gross: split.gross.toString(10),
    premium: split.premium.toString(10),
    escrowed: split.escrowed.toString(10),
    requiredStake: split.requiredStake.toString(10),
  };
}

/**
 * The HTTP 402 payment-requirements challenge for a warranty-court job.
 *
 * x402 inverts the usual payment flow: the server states its terms in the 402
 * body, the payer signs an authorization matching those terms, and retries. The
 * challenge is therefore a contract offer, and everything in it that the payer
 * cannot independently derive is something the payer has to take on trust.
 *
 * Which is why the premium split travels inside the challenge. The whole point
 * of this leg is that the warranty is bought at payment time rather than
 * bolted on afterwards, and a payer that is told only `maxAmountRequired` has
 * no way to see how much of its money becomes insurance. `extra.split` lets it
 * recompute the escrow's arithmetic from `extra.premiumBps` before signing, and
 * `extra.warrantyVault` tells it where the premium lands.
 *
 * Nothing here is written as a literal address. Every address is read out of
 * `deployments/<chainId>.json` through `@awc/shared`, including the chain id in
 * the `eip155:` network string, so a challenge can never advertise one chain's
 * token under another chain's id.
 */
import { isAddress, type Hex } from 'viem';
import { CHAINS, addressOf, loadDeployment, type Deployment } from '@awc/shared';
import { X402Error } from './authorization.ts';
import {
  parseBaseUnits,
  ratesFrom,
  serializeSplit,
  splitPremium,
  type PremiumRates,
  type PremiumSplit,
} from './premium.ts';

/** The x402 envelope version this package speaks. */
export const X402_VERSION = 1;

/**
 * The `exact` scheme: the payer authorizes precisely `maxAmountRequired`, no
 * more and no less. `fundJob` takes a single `amount` and derives everything
 * from it, so there is no metered or upper-bound variant that would make sense
 * here — an over-payment would silently inflate someone's escrow.
 */
export const X402_SCHEME = 'exact';

/** CAIP-2, so the id is machine-comparable rather than a nickname like "base-sepolia". */
export function networkIdFor(chainId: number): string {
  return `eip155:${chainId}`;
}

export function chainIdFromNetworkId(network: string): number | null {
  const match = /^eip155:([1-9][0-9]{0,18})$/.exec(network);
  if (!match?.[1]) return null;
  return Number(match[1]);
}

/** The five `fundJob` arguments, in the order the ABI takes them. */
export interface JobRequest {
  readonly jobId: Hex;
  readonly provider: Hex;
  readonly amount: bigint;
  readonly deliveryWindow: bigint;
  readonly erc8004TokenId: bigint;
}

const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

export const REQUEST_ERROR = { malformedJobRequest: 'malformed_job_request' } as const;

/**
 * Validate an untrusted job request, applying `fundJob`'s own preconditions.
 *
 * Every check here has a matching `revert` in the contract: `ZeroAddress`,
 * `ZeroAmount`, `DeliveryWindowTooShort`. Enforcing them at intake is what
 * stops the server from issuing a 402 for a job that could never be funded, and
 * from taking a signature in payment for it.
 */
export function parseJobRequest(raw: unknown): JobRequest {
  const bad = (why: string): never => {
    throw new X402Error(REQUEST_ERROR.malformedJobRequest, `job request ${why}`);
  };
  if (typeof raw !== 'object' || raw === null) return bad('must be a JSON object');
  const o = raw as Record<string, unknown>;

  const jobId = o['jobId'];
  if (typeof jobId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(jobId)) {
    bad(`jobId must be a 32-byte hex string, got ${JSON.stringify(jobId)}`);
  }
  const provider = o['provider'];
  if (typeof provider !== 'string' || !isAddress(provider, { strict: false })) {
    bad(`provider must be an address, got ${JSON.stringify(provider)}`);
  }
  // `fundJob` reverts ZeroAddress; a job escrowed against address(0) is
  // unreleasable and its stake unlockable by nobody.
  if ((provider as string).toLowerCase() === `0x${'0'.repeat(40)}`) bad('provider is the zero address');

  let amount: bigint;
  try {
    amount = parseBaseUnits(String(o['amount']));
  } catch (error) {
    return bad((error as Error).message);
  }
  if (amount === 0n) bad('amount is zero (fundJob reverts ZeroAmount)');
  if (amount > UINT256_MAX) bad('amount exceeds uint256');

  let deliveryWindow: bigint;
  try {
    deliveryWindow = parseBaseUnits(String(o['deliveryWindow']));
  } catch {
    return bad(`deliveryWindow must be a positive integer number of seconds, got ${JSON.stringify(o['deliveryWindow'])}`);
  }
  if (deliveryWindow === 0n) bad('deliveryWindow is zero (fundJob reverts DeliveryWindowTooShort)');
  if (deliveryWindow > UINT64_MAX) bad('deliveryWindow exceeds uint64');

  const rawToken = o['erc8004TokenId'];
  let erc8004TokenId = 0n;
  if (rawToken !== undefined && rawToken !== null) {
    try {
      erc8004TokenId = parseBaseUnits(String(rawToken));
    } catch {
      return bad(`erc8004TokenId must be a non-negative integer, got ${JSON.stringify(rawToken)}`);
    }
    if (erc8004TokenId > UINT256_MAX) bad('erc8004TokenId exceeds uint256');
  }

  return {
    jobId: (jobId as string).toLowerCase() as Hex,
    provider: (provider as string).toLowerCase() as Hex,
    amount,
    deliveryWindow,
    erc8004TokenId,
  };
}

/**
 * Everything the intake needs about a deployment, resolved once.
 *
 * Resolved once rather than per request because `loadDeployment` reads and
 * parses a file: doing that inside the request path turns a manifest edit into
 * a mid-flight change of terms, where a 402 is issued under one asset address
 * and the retry verified under another.
 */
export interface IntakeContext {
  readonly chainId: number;
  readonly network: string;
  readonly asset: Hex;
  readonly payTo: Hex;
  readonly escrow: Hex;
  readonly warrantyVault: Hex;
  readonly rates: PremiumRates;
  readonly deployment: Deployment;
}

interface ManifestWithParams extends Deployment {
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface IntakeContextOptions {
  readonly chainId?: number;
  readonly root?: string;
  /**
   * Where the EIP-3009 transfer must land.
   *
   * `fundJob` pulls the gross from *its own* caller (`safeTransferFrom(msg.sender, ...)`)
   * and only then splits off the premium, so the authorization cannot name the
   * escrow as `to` — it has no EIP-3009 receive hook and USDC parked there is
   * unaccounted. The money must therefore land on the account that will submit
   * `fundJob`, which the manifest records as `deployer`. Operators running
   * intake from a different settler account pass it explicitly; what is never
   * allowed is a literal in this file.
   */
  readonly payTo?: string;
}

const requireAddress = (value: string, label: string): Hex => {
  if (!isAddress(value, { strict: false })) {
    throw new Error(`${label} is not an address: ${value}`);
  }
  return value.toLowerCase() as Hex;
};

export function loadIntakeContext(options: IntakeContextOptions = {}): IntakeContext {
  const chainId = options.chainId ?? CHAINS.baseSepolia;
  const deployment =
    options.root === undefined ? loadDeployment(chainId) : loadDeployment(chainId, options.root);
  const params = (deployment as ManifestWithParams).params ?? {};
  const vault = params['warrantyVault'];
  if (typeof vault !== 'string') {
    throw new Error(`chain ${chainId} manifest has no params.warrantyVault`);
  }

  return {
    chainId: deployment.chainId,
    network: networkIdFor(deployment.chainId),
    asset: requireAddress(addressOf(deployment, 'USDC'), 'manifest USDC'),
    payTo: requireAddress(options.payTo ?? deployment.deployer, 'payTo'),
    escrow: requireAddress(addressOf(deployment, 'WarrantyEscrow'), 'manifest WarrantyEscrow'),
    warrantyVault: requireAddress(vault, 'manifest params.warrantyVault'),
    rates: ratesFrom(deployment),
    deployment,
  };
}

/** The 402 body's `accepts[]` entry. Every numeric field is a decimal string. */
export interface PaymentRequirements {
  readonly scheme: string;
  readonly network: string;
  readonly asset: Hex;
  readonly payTo: Hex;
  readonly maxAmountRequired: string;
  readonly nonce: Hex;
  readonly validAfter: string;
  readonly validBefore: string;
  readonly maxTimeoutSeconds: number;
  readonly resource: string;
  readonly description: string;
  readonly mimeType: string;
  readonly extra: PaymentRequirementsExtra;
}

export interface PaymentRequirementsExtra {
  /** EIP-712 domain fields, so the payer can build the digest without guessing. */
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Hex;
  /** The rates, from the manifest, so the split below is reproducible. */
  readonly premiumBps: number;
  readonly requiredStakeBps: number;
  readonly split: Readonly<Record<keyof PremiumSplit, string>>;
  readonly warrantyVault: Hex;
  readonly escrow: Hex;
  readonly jobId: Hex;
  readonly provider: Hex;
  readonly deliveryWindow: string;
  readonly erc8004TokenId: string;
}

export interface RequirementsOptions {
  /** Unix seconds. Injected so tests and clock-skew policy are not guesswork. */
  readonly now?: number;
  readonly nonce?: Hex;
  /** How long the quote stands. Also the authorization's `validBefore` offset. */
  readonly ttlSeconds?: number;
  /**
   * Backdating for `validAfter`. USDC compares against *block* timestamp, which
   * can legitimately sit a little behind the server's clock; an authorization
   * stamped `validAfter = now` can be rejected on-chain for being early.
   */
  readonly clockSkewSeconds?: number;
  readonly maxTimeoutSeconds?: number;
  readonly resource?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export const DEFAULT_TTL_SECONDS = 300;
export const DEFAULT_CLOCK_SKEW_SECONDS = 60;
export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;

/** 32 random bytes. EIP-3009 nonces are arbitrary bytes32, unique per payer. */
export function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex as Hex;
}

export function buildPaymentRequirements(
  job: JobRequest,
  context: IntakeContext,
  options: RequirementsOptions = {},
): PaymentRequirements {
  const now = options.now ?? Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (!Number.isInteger(now) || now <= 0) throw new Error(`now must be unix seconds, got ${now}`);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error(`ttlSeconds must be positive, got ${ttl}`);

  const split = splitPremium(job.amount, context.rates);
  const validAfter = Math.max(0, now - skew);

  return {
    scheme: X402_SCHEME,
    network: context.network,
    asset: context.asset,
    payTo: context.payTo,
    maxAmountRequired: split.gross.toString(10),
    nonce: options.nonce ?? randomNonce(),
    validAfter: String(validAfter),
    validBefore: String(now + ttl),
    maxTimeoutSeconds: options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS,
    resource: options.resource ?? `/jobs/${job.jobId}`,
    description:
      options.description ??
      `Warranty-court job ${job.jobId}: ${split.escrowed} escrowed, ` +
        `${split.premium} warranty premium (${context.rates.premiumBps} bps) captured at funding.`,
    mimeType: options.mimeType ?? 'application/json',
    extra: {
      name: 'USDC',
      version: '2',
      chainId: context.chainId,
      verifyingContract: context.asset,
      premiumBps: context.rates.premiumBps,
      requiredStakeBps: context.rates.requiredStakeBps,
      split: serializeSplit(split),
      warrantyVault: context.warrantyVault,
      escrow: context.escrow,
      jobId: job.jobId,
      provider: job.provider,
      deliveryWindow: job.deliveryWindow.toString(10),
      erc8004TokenId: job.erc8004TokenId.toString(10),
    },
  };
}

/** The 402 response body. */
export interface PaymentChallenge {
  readonly x402Version: number;
  readonly error: string;
  readonly accepts: readonly PaymentRequirements[];
}

export function buildChallenge(
  requirements: PaymentRequirements,
  error = 'X-PAYMENT header is required',
): PaymentChallenge {
  return { x402Version: X402_VERSION, error, accepts: [requirements] };
}

/**
 * The exact `fundJob` call the verified payment entitles, as data.
 *
 * Returned rather than executed: settlement is out of scope for this package,
 * and a verifier that also submits transactions is a verifier whose failures
 * cost money.
 */
export interface FundJobCall {
  readonly chainId: number;
  readonly contract: Hex;
  readonly signature: string;
  readonly args: {
    readonly jobId: Hex;
    readonly provider: Hex;
    readonly amount: string;
    readonly deliveryWindow: string;
    readonly erc8004TokenId: string;
  };
  /** Positional form, in ABI order, for a client that encodes by tuple. */
  readonly argsOrdered: readonly string[];
}

export const FUND_JOB_SIGNATURE = 'fundJob(bytes32,address,uint256,uint64,uint256)';

export function fundJobCall(job: JobRequest, context: IntakeContext): FundJobCall {
  const args = {
    jobId: job.jobId,
    provider: job.provider,
    amount: job.amount.toString(10),
    deliveryWindow: job.deliveryWindow.toString(10),
    erc8004TokenId: job.erc8004TokenId.toString(10),
  };
  return {
    chainId: context.chainId,
    contract: context.escrow,
    signature: FUND_JOB_SIGNATURE,
    args,
    argsOrdered: [args.jobId, args.provider, args.amount, args.deliveryWindow, args.erc8004TokenId],
  };
}

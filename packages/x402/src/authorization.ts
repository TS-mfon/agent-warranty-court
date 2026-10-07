/**
 * EIP-3009 `TransferWithAuthorization` for USDC on Base Sepolia.
 *
 * This is the payment instrument behind the x402 `exact` scheme. The payer never
 * sends a transaction: it signs a typed-data struct authorizing a pull of
 * exactly `value` from itself to `to`, valid only inside a window and only once
 * per `nonce`. Whoever holds the signature can submit it, which is what makes an
 * HTTP request a payment.
 *
 * Two deliberate choices:
 *
 *   - The EIP-712 encoding comes from `viem`'s `hashTypedData` rather than a
 *     hand-rolled `keccak256(abi.encode(...))`. Hand-rolling EIP-712 is where
 *     this kind of code goes wrong — a struct field in the wrong order or a
 *     string hashed instead of its contents produces a digest that is perfectly
 *     self-consistent and that USDC will reject, and no unit test that checks
 *     the implementation against itself can see it. The constants below are
 *     instead checked against what the live token reports (see the test suite).
 *
 *   - Signature canonicalisation mirrors `WarrantyEscrow._requireProviderSignature`
 *     exactly: upper-half `s` rejected, `v` constrained to {27, 28}. The escrow
 *     refuses malleable signatures on the *delivery* leg, and a payment leg that
 *     accepted both halves of every signature would be the weaker half of the
 *     system — the same authorization could be presented twice under different
 *     bytes, which matters precisely because replay defence here is keyed on
 *     bytes the server has already seen.
 */
import { hashTypedData, isAddress, recoverAddress, type Hex } from 'viem';
import { CHAINS, addressOf, loadDeployment } from '@awc/shared';

/** The EIP-712 struct, field order frozen. Changing the order changes the hash. */
export const TRANSFER_WITH_AUTHORIZATION_FIELDS = [
  { name: 'from', type: 'address' },
  { name: 'to', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' },
  { name: 'validBefore', type: 'uint256' },
  { name: 'nonce', type: 'bytes32' },
] as const;

export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION_FIELDS,
} as const;

export const TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE = 'TransferWithAuthorization';

/**
 * Circle's `FiatTokenV2` reports `name() = "USDC"` and `version() = "2"` for the
 * Base Sepolia deployment. These two strings are the entire difference between a
 * digest the token accepts and one it does not, so the test suite pins the
 * resulting domain separator against the value the live token returns from
 * `DOMAIN_SEPARATOR()`.
 */
export const USDC_EIP712_NAME = 'USDC';
export const USDC_EIP712_VERSION = '2';

/**
 * `(n - 1) / 2` for secp256k1 — the same literal
 * `WarrantyEscrow._requireProviderSignature` compares against. An `s` above this
 * is the mirror image of a valid signature over the same message.
 */
export const SECP256K1_HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export interface Eip712Domain {
  readonly name: string;
  readonly version: string;
  readonly chainId: number;
  readonly verifyingContract: Hex;
}

/** The authorization a payer signs. All integers are bigints; nonce is bytes32. */
export interface TransferAuthorization {
  readonly from: Hex;
  readonly to: Hex;
  readonly value: bigint;
  readonly validAfter: bigint;
  readonly validBefore: bigint;
  readonly nonce: Hex;
}

/** A split ECDSA signature, as `v`/`r`/`s` rather than 65 packed bytes. */
export interface Vrs {
  readonly v: number;
  readonly r: Hex;
  readonly s: Hex;
}

/** Distinct, named reasons an authorization or its signature is unacceptable. */
export const AUTHORIZATION_ERROR = {
  malformedAuthorization: 'malformed_authorization',
  malformedSignature: 'malformed_signature',
  nonCanonicalV: 'non_canonical_v',
  highSSignature: 'high_s_signature',
  signatureMismatch: 'signature_mismatch',
} as const;

export type AuthorizationErrorCode =
  (typeof AUTHORIZATION_ERROR)[keyof typeof AUTHORIZATION_ERROR];

/**
 * A rejection carrying a stable machine-readable code.
 *
 * Written as a function rather than a `class` with parameter properties because
 * `erasableSyntaxOnly` is on: parameter properties are syntax Node's type
 * stripper cannot erase.
 */
export class X402Error extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'X402Error';
    this.code = code;
  }
}

const isHexOfBytes = (value: unknown, bytes: number): value is Hex =>
  typeof value === 'string' && new RegExp(`^0x[0-9a-fA-F]{${bytes * 2}}$`).test(value);

export const isBytes32 = (value: unknown): value is Hex => isHexOfBytes(value, 32);

/** The USDC EIP-712 domain for a chain, with every field read from the manifest. */
export function usdcDomain(chainId: number = CHAINS.baseSepolia, root?: string): Eip712Domain {
  const deployment = root === undefined ? loadDeployment(chainId) : loadDeployment(chainId, root);
  const asset = addressOf(deployment, 'USDC');
  if (!isAddress(asset, { strict: false })) {
    throw new Error(`chain ${chainId} manifest USDC entry is not an address: ${asset}`);
  }
  return {
    name: USDC_EIP712_NAME,
    version: USDC_EIP712_VERSION,
    // From the manifest, not from the argument: a domain whose chainId disagrees
    // with the manifest it drew the token address from is not a domain any
    // deployment answers to.
    chainId: deployment.chainId,
    verifyingContract: asset as Hex,
  };
}

/**
 * Type-check an authorization that arrived as untrusted JSON.
 *
 * Rejects rather than coerces. A `value` that arrived as the number `5000000`
 * and a `value` that arrived as `"5000000"` must not both be accepted silently,
 * because only one of them survives a round trip through a 2^53 boundary.
 */
export function parseAuthorization(raw: unknown): TransferAuthorization {
  const bad = (why: string): never => {
    throw new X402Error(AUTHORIZATION_ERROR.malformedAuthorization, `authorization ${why}`);
  };
  if (typeof raw !== 'object' || raw === null) return bad('must be an object');
  const o = raw as Record<string, unknown>;

  for (const field of ['from', 'to'] as const) {
    const v = o[field];
    if (typeof v !== 'string' || !isAddress(v, { strict: false })) {
      bad(`field ${field} is not an address: ${JSON.stringify(v)}`);
    }
  }
  const uint = (field: 'value' | 'validAfter' | 'validBefore'): bigint => {
    const v = o[field];
    if (typeof v === 'bigint') return v >= 0n ? v : bad(`field ${field} is negative`);
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(v)) {
      return bad(`field ${field} must be a decimal string, got ${JSON.stringify(v)}`);
    }
    return BigInt(v);
  };
  const value = uint('value');
  const validAfter = uint('validAfter');
  const validBefore = uint('validBefore');
  if (!isBytes32(o['nonce'])) bad(`field nonce is not bytes32: ${JSON.stringify(o['nonce'])}`);

  return {
    from: (o['from'] as string).toLowerCase() as Hex,
    to: (o['to'] as string).toLowerCase() as Hex,
    value,
    validAfter,
    validBefore,
    nonce: (o['nonce'] as string).toLowerCase() as Hex,
  };
}

/**
 * Normalise a signature from either shape the wire uses: `{v, r, s}` fields or
 * 65 packed bytes. `v` is accepted as 0/1 as well as 27/28 only insofar as
 * `assertCanonicalVrs` then rejects it — the normalisation does not quietly
 * repair a non-canonical `v`, because doing so would make the escrow's rule
 * unenforceable on this leg.
 */
export function parseVrs(raw: unknown): Vrs {
  const bad = (why: string): never => {
    throw new X402Error(AUTHORIZATION_ERROR.malformedSignature, `signature ${why}`);
  };
  if (typeof raw === 'string') {
    if (!isHexOfBytes(raw, 65)) return bad('must be 65 packed bytes of hex');
    return {
      r: `0x${raw.slice(2, 66)}` as Hex,
      s: `0x${raw.slice(66, 130)}` as Hex,
      v: Number.parseInt(raw.slice(130, 132), 16),
    };
  }
  if (typeof raw !== 'object' || raw === null) return bad('must be an object or packed hex');
  const o = raw as Record<string, unknown>;
  const r = o['r'];
  const s = o['s'];
  const v = o['v'];
  if (!isBytes32(r)) bad(`field r is not bytes32: ${JSON.stringify(r)}`);
  if (!isBytes32(s)) bad(`field s is not bytes32: ${JSON.stringify(s)}`);
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 255) {
    bad(`field v is not a byte: ${JSON.stringify(v)}`);
  }
  return { r: r as Hex, s: s as Hex, v: v as number };
}

/**
 * The malleability gate, identical in effect to the escrow's.
 *
 * Both halves are necessary. Rejecting high-`s` alone still leaves `v` free to
 * carry a chain-id-encoded or 0/1-style value that some recovery
 * implementations accept, and the point of the check is that one authorization
 * has exactly one acceptable encoding.
 */
export function assertCanonicalVrs(sig: Vrs): void {
  const r = BigInt(sig.r);
  const s = BigInt(sig.s);
  if (r === 0n || s === 0n) {
    throw new X402Error(AUTHORIZATION_ERROR.malformedSignature, 'signature has a zero r or s');
  }
  if (s > SECP256K1_HALF_ORDER) {
    throw new X402Error(
      AUTHORIZATION_ERROR.highSSignature,
      `signature s is in the upper half of the curve order (malleable): ${sig.s}`,
    );
  }
  if (sig.v !== 27 && sig.v !== 28) {
    throw new X402Error(
      AUTHORIZATION_ERROR.nonCanonicalV,
      `signature v must be 27 or 28, got ${sig.v}`,
    );
  }
}

/** The EIP-712 digest the payer signs. */
export function authorizationDigest(
  authorization: TransferAuthorization,
  domain: Eip712Domain,
): Hex {
  return hashTypedData({
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
    message: {
      from: authorization.from,
      to: authorization.to,
      value: authorization.value,
      validAfter: authorization.validAfter,
      validBefore: authorization.validBefore,
      nonce: authorization.nonce,
    },
  });
}

/** Recover the signer, after refusing any non-canonical encoding. */
export async function recoverAuthorizationSigner(
  authorization: TransferAuthorization,
  domain: Eip712Domain,
  sig: Vrs,
): Promise<Hex> {
  assertCanonicalVrs(sig);
  const recovered = await recoverAddress({
    hash: authorizationDigest(authorization, domain),
    signature: { r: sig.r, s: sig.s, v: BigInt(sig.v) },
  });
  return recovered.toLowerCase() as Hex;
}

/**
 * Recover and require the signer to be the `from` of the authorization.
 *
 * `from` is the account whose balance moves, so a signature by anyone else is
 * not a weaker authorization — it is no authorization at all.
 */
export async function verifyAuthorizationSignature(
  authorization: TransferAuthorization,
  domain: Eip712Domain,
  sig: Vrs,
): Promise<Hex> {
  const signer = await recoverAuthorizationSigner(authorization, domain, sig);
  if (signer !== authorization.from.toLowerCase()) {
    throw new X402Error(
      AUTHORIZATION_ERROR.signatureMismatch,
      `signature recovers to ${signer}, not the authorization from ${authorization.from}`,
    );
  }
  return signer;
}

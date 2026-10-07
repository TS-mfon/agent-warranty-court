/**
 * The x402 intake server.
 *
 * Two endpoints, deliberately no framework:
 *
 *   GET  /quote?amount=   the premium split, so a payer can see what it is
 *                         insuring before it signs anything.
 *   POST /jobs            402 with a payment challenge when no `X-PAYMENT`
 *                         header is present; on a valid one, the verified
 *                         authorization plus the exact `fundJob` arguments.
 *
 * `node:http` rather than express because the whole value of this process is
 * that it holds no secrets and makes no chain writes — it verifies a signature
 * and hands back calldata. A dependency tree is a liability on a service whose
 * job is that small.
 *
 * ## What this server does NOT do
 *
 * It does not settle. It returns the verified authorization and the arguments
 * for `fundJob`, and something holding a key submits them. That boundary is the
 * point: settlement needs a funded signer, and a public HTTP surface that can
 * move money is a different threat model from one that can only say "this
 * signature is valid for this trade".
 *
 * ## Replay
 *
 * EIP-3009 authorizations are single-use by nonce, and USDC enforces that on
 * chain. The in-process `seenNonces` set here is therefore not the security
 * boundary — it is a courtesy that fails a replay fast with a legible error
 * instead of letting the caller discover it from a reverted transaction. It is
 * per-process and deliberately not presented as durable: `NonceStore` exists so
 * a deployment that wants cross-process replay rejection can supply one.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Hex } from 'viem';

import {
  AUTHORIZATION_ERROR,
  X402Error,
  parseAuthorization,
  parseVrs,
  usdcDomain,
  verifyAuthorizationSignature,
  type TransferAuthorization,
  type Vrs,
} from './authorization.ts';
import {
  DEFAULT_CLOCK_SKEW_SECONDS,
  REQUEST_ERROR,
  X402_SCHEME,
  X402_VERSION,
  buildChallenge,
  buildPaymentRequirements,
  fundJobCall,
  loadIntakeContext,
  networkIdFor,
  parseJobRequest,
  type IntakeContext,
  type JobRequest,
  type PaymentRequirements,
} from './requirements.ts';
import { parseBaseUnits, serializeSplit, splitPremium } from './premium.ts';

/** Failures that belong to the payment leg rather than to a signature. */
export const PAYMENT_ERROR = {
  missingPayment: 'missing_payment',
  malformedPayment: 'malformed_payment',
  wrongScheme: 'wrong_scheme',
  wrongNetwork: 'wrong_network',
  wrongAsset: 'wrong_asset',
  wrongPayTo: 'wrong_pay_to',
  amountBelowRequired: 'amount_below_required',
  authorizationExpired: 'authorization_expired',
  authorizationNotYetValid: 'authorization_not_yet_valid',
  nonceReplayed: 'nonce_replayed',
} as const;

/** A replay guard. In-process by default; swap in something shared if needed. */
export interface NonceStore {
  has(nonce: Hex): boolean;
  add(nonce: Hex): void;
}

export function inMemoryNonceStore(): NonceStore {
  const seen = new Set<string>();
  return {
    has: (nonce) => seen.has(nonce.toLowerCase()),
    add: (nonce) => void seen.add(nonce.toLowerCase()),
  };
}

export interface PaymentPayload {
  readonly x402Version: number;
  readonly scheme: string;
  readonly network: string;
  readonly payload: {
    readonly authorization: TransferAuthorization;
    readonly signature: Vrs;
  };
}

/**
 * Decode the `X-PAYMENT` header.
 *
 * x402 sends the payload base64-encoded. Both the decode and the JSON parse are
 * caller-controlled, so each failure is reported as `malformedPayment` rather
 * than thrown as an unhandled error — an intake endpoint that 500s on a bad
 * header is a denial-of-service surface.
 */
export function decodePaymentHeader(header: string): PaymentPayload {
  let text: string;
  try {
    text = Buffer.from(header, 'base64').toString('utf8');
    // Reject a header that was not really base64: Buffer is permissive and
    // will happily decode arbitrary bytes into mojibake.
    if (Buffer.from(text, 'utf8').toString('base64').replace(/=+$/, '') !== header.replace(/=+$/, '')) {
      throw new Error('not canonical base64');
    }
  } catch {
    throw new X402Error(PAYMENT_ERROR.malformedPayment, 'X-PAYMENT is not base64');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new X402Error(PAYMENT_ERROR.malformedPayment, 'X-PAYMENT is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new X402Error(PAYMENT_ERROR.malformedPayment, 'X-PAYMENT is not an object');
  }

  const raw = parsed as Record<string, unknown>;
  const inner = raw['payload'];
  if (typeof inner !== 'object' || inner === null) {
    throw new X402Error(PAYMENT_ERROR.malformedPayment, 'X-PAYMENT has no payload');
  }
  const innerRec = inner as Record<string, unknown>;

  return {
    x402Version: typeof raw['x402Version'] === 'number' ? raw['x402Version'] : -1,
    scheme: typeof raw['scheme'] === 'string' ? raw['scheme'] : '',
    network: typeof raw['network'] === 'string' ? raw['network'] : '',
    payload: {
      authorization: parseAuthorization(innerRec['authorization']),
      signature: parseVrs(innerRec['signature']),
    },
  };
}

export interface VerifyOptions {
  readonly now?: number;
  readonly clockSkewSeconds?: number;
  readonly nonces?: NonceStore;
}

export interface VerifiedPayment {
  readonly payer: Hex;
  readonly authorization: TransferAuthorization;
  readonly split: ReturnType<typeof splitPremium>;
  readonly fundJob: ReturnType<typeof fundJobCall>;
}

/**
 * Check a payment against the job it claims to pay for.
 *
 * Order matters. Everything cheap and local is checked before the elliptic-curve
 * recovery, so a caller cannot make the server do signature work by sending
 * nonsense. The signature is the last gate, not the first.
 */
export async function verifyPayment(
  payment: PaymentPayload,
  job: JobRequest,
  context: IntakeContext,
  options: VerifyOptions = {},
): Promise<VerifiedPayment> {
  const skew = BigInt(options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS);
  const now = BigInt(Math.floor((options.now ?? Date.now()) / 1_000));
  const auth = payment.payload.authorization;

  if (payment.x402Version !== X402_VERSION) {
    throw new X402Error(
      PAYMENT_ERROR.malformedPayment,
      `unsupported x402Version ${payment.x402Version}, expected ${X402_VERSION}`,
    );
  }
  if (payment.scheme !== X402_SCHEME) {
    throw new X402Error(PAYMENT_ERROR.wrongScheme, `unsupported scheme ${JSON.stringify(payment.scheme)}`);
  }
  // The network is part of the signed domain, but checking it here turns a
  // confusing signature mismatch into an accurate diagnosis.
  if (payment.network !== context.network) {
    throw new X402Error(
      PAYMENT_ERROR.wrongNetwork,
      `payment is for ${JSON.stringify(payment.network)}, this intake serves ${context.network}`,
    );
  }
  if (auth.to.toLowerCase() !== context.payTo.toLowerCase()) {
    throw new X402Error(PAYMENT_ERROR.wrongPayTo, `authorization pays ${auth.to}, expected ${context.payTo}`);
  }

  // Validity window, with the same skew allowance the challenge advertised.
  if (auth.validAfter > now + skew) {
    throw new X402Error(
      PAYMENT_ERROR.authorizationNotYetValid,
      `authorization is valid from ${auth.validAfter}, now ${now}`,
    );
  }
  if (auth.validBefore <= now - skew) {
    throw new X402Error(
      PAYMENT_ERROR.authorizationExpired,
      `authorization expired at ${auth.validBefore}, now ${now}`,
    );
  }

  const split = splitPremium(job.amount, context.rates);
  // `>=`, not `===`: an overpayment is the payer's business, an underpayment is
  // a trade the escrow cannot fund.
  if (auth.value < split.gross) {
    throw new X402Error(
      PAYMENT_ERROR.amountBelowRequired,
      `authorization covers ${auth.value}, job requires ${split.gross}`,
    );
  }

  const nonces = options.nonces;
  if (nonces?.has(auth.nonce)) {
    throw new X402Error(PAYMENT_ERROR.nonceReplayed, `nonce ${auth.nonce} has already been seen`);
  }

  // Canonicality (low-`s`, v in {27,28}) and recovery happen inside
  // `verifyAuthorizationSignature`, against the USDC domain for this chain.
  //
  // Argument order is (authorization, domain, sig). Getting it wrong does not
  // fail to compile — both are plain objects — it hashes the domain as the
  // message and surfaces as a TypeError from deep inside viem's typed-data
  // validator, which reads as a library bug rather than a caller mistake.
  const domain = usdcDomain(context.chainId);
  const payer = await verifyAuthorizationSignature(auth, domain, payment.payload.signature);

  nonces?.add(auth.nonce);
  return { payer, authorization: auth, split, fundJob: fundJobCall(job, context) };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1_024;

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    // Bounded before buffering, not after: an unbounded request body on a
    // public endpoint is a memory-exhaustion lever.
    if (size > MAX_BODY_BYTES) throw new X402Error(REQUEST_ERROR.malformedJobRequest, 'request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

export interface IntakeServerOptions {
  readonly context?: IntakeContext;
  readonly nonces?: NonceStore;
  readonly now?: () => number;
  readonly resourceBase?: string;
}

export interface IntakeHandlerResult {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}

/**
 * The routing core, separated from `node:http` so it is testable without
 * binding a port. The tests exercise this directly; `createIntakeServer` only
 * adapts it.
 */
export function createIntakeHandler(options: IntakeServerOptions = {}) {
  const context = options.context ?? loadIntakeContext();
  const nonces = options.nonces ?? inMemoryNonceStore();
  const now = options.now ?? (() => Date.now());
  const resourceBase = options.resourceBase ?? 'https://agent-warranty-court.vercel.app';

  return async function handle(
    method: string,
    url: string,
    headers: Record<string, string | string[] | undefined>,
    body: string,
  ): Promise<IntakeHandlerResult> {
    const parsed = new URL(url, resourceBase);

    if (method === 'GET' && parsed.pathname === '/quote') {
      const raw = parsed.searchParams.get('amount');
      if (raw === null) {
        return { status: 400, body: { error: REQUEST_ERROR.malformedJobRequest, message: 'amount is required' } };
      }
      try {
        const split = splitPremium(parseBaseUnits(raw), context.rates);
        return {
          status: 200,
          body: {
            network: context.network,
            asset: context.asset,
            rates: context.rates,
            split: serializeSplit(split),
            warrantyVault: context.warrantyVault,
            escrow: context.escrow,
          },
        };
      } catch (err) {
        return { status: 400, body: { error: REQUEST_ERROR.malformedJobRequest, message: (err as Error).message } };
      }
    }

    if (method === 'POST' && parsed.pathname === '/jobs') {
      let job: JobRequest;
      try {
        job = parseJobRequest(body.length === 0 ? null : JSON.parse(body));
      } catch (err) {
        const code = err instanceof X402Error ? err.code : REQUEST_ERROR.malformedJobRequest;
        return { status: 400, body: { error: code, message: (err as Error).message } };
      }

      const header = headers['x-payment'];
      const paymentHeader = Array.isArray(header) ? header[0] : header;

      if (!paymentHeader) {
        // The 402 itself. `accepts` tells the payer exactly what to sign.
        const requirements: PaymentRequirements = buildPaymentRequirements(job, context, {
          now: now(),
          resource: new URL('/jobs', resourceBase).toString(),
        });
        return {
          status: 402,
          // (requirements, error), not the reverse. Both orders type-check
          // loosely enough to compile and the wrong one puts the requirements
          // array in `error`, which a client reads as an unintelligible failure
          // rather than as a payment challenge.
          body: buildChallenge(requirements, PAYMENT_ERROR.missingPayment),
          headers: { 'x-payment-required': String(X402_VERSION) },
        };
      }

      try {
        const payment = decodePaymentHeader(paymentHeader);
        const verified = await verifyPayment(payment, job, context, { now: now(), nonces });
        return {
          status: 200,
          body: {
            x402Version: X402_VERSION,
            payer: verified.payer,
            split: serializeSplit(verified.split),
            authorization: {
              from: verified.authorization.from,
              to: verified.authorization.to,
              value: verified.authorization.value.toString(10),
              validAfter: verified.authorization.validAfter.toString(10),
              validBefore: verified.authorization.validBefore.toString(10),
              nonce: verified.authorization.nonce,
            },
            fundJob: verified.fundJob,
          },
        };
      } catch (err) {
        const code = err instanceof X402Error ? err.code : AUTHORIZATION_ERROR.malformedAuthorization;
        // 402 rather than 400 for a payment that was present but unacceptable:
        // the caller should retry with a better payment, not give up.
        return { status: 402, body: { x402Version: X402_VERSION, error: code, message: (err as Error).message } };
      }
    }

    if (method === 'GET' && parsed.pathname === '/healthz') {
      return { status: 200, body: { ok: true, network: context.network, escrow: context.escrow } };
    }

    return { status: 404, body: { error: 'not_found', message: `no route for ${method} ${parsed.pathname}` } };
  };
}

export function createIntakeServer(options: IntakeServerOptions = {}): Server {
  const handle = createIntakeHandler(options);
  return createServer((req, res) => {
    void (async () => {
      try {
        const body = req.method === 'POST' ? await readBody(req) : '';
        const result = await handle(req.method ?? 'GET', req.url ?? '/', req.headers, body);
        send(res, result.status, result.body, result.headers);
      } catch (err) {
        const code = err instanceof X402Error ? err.code : 'internal_error';
        send(res, err instanceof X402Error ? 400 : 500, { error: code, message: (err as Error).message });
      }
    })();
  });
}

export { networkIdFor };

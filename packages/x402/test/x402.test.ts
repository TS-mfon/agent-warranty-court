import { test } from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

import {
  TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  X402_SCHEME,
  X402_VERSION,
  PAYMENT_ERROR,
  AUTHORIZATION_ERROR,
  REQUEST_ERROR,
  createIntakeHandler,
  decodePaymentHeader,
  inMemoryNonceStore,
  loadIntakeContext,
  parseBaseUnits,
  ratesFrom,
  splitPremium,
  usdcDomain,
  type IntakeContext,
  type PremiumRates,
} from '../src/index.ts';

// A throwaway key. Never a real one: a test fixture that happens to be a funded
// account is a key published to every clone of the repository.
const PAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const payer = privateKeyToAccount(PAYER_KEY);

const JOB_ID = ('0x' + '11'.repeat(32)) as Hex;
const PROVIDER = ('0x' + 'bb'.repeat(20)) as Hex;
const NOW_MS = 1_800_000_000_000;

const context: IntakeContext = loadIntakeContext();

function jobBody(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    jobId: JOB_ID,
    provider: PROVIDER,
    amount: '5000000',
    deliveryWindow: '86400',
    erc8004TokenId: '1',
    ...overrides,
  });
}

/** Sign a real EIP-3009 authorization against the live USDC domain. */
async function signedPayment(
  overrides: {
    value?: bigint;
    to?: Hex;
    nonce?: Hex;
    validAfter?: bigint;
    validBefore?: bigint;
    network?: string;
    scheme?: string;
    x402Version?: number;
    tamperS?: boolean;
    badV?: boolean;
    signWithOther?: boolean;
  } = {},
): Promise<string> {
  const nowSec = BigInt(Math.floor(NOW_MS / 1_000));
  const authorization = {
    from: payer.address.toLowerCase() as Hex,
    to: (overrides.to ?? context.payTo).toLowerCase() as Hex,
    value: overrides.value ?? 5_000_000n,
    validAfter: overrides.validAfter ?? nowSec - 60n,
    validBefore: overrides.validBefore ?? nowSec + 300n,
    nonce: overrides.nonce ?? (('0x' + 'ab'.repeat(32)) as Hex),
  };

  const signer = overrides.signWithOther
    ? privateKeyToAccount(('0x' + '42'.repeat(32)) as Hex)
    : payer;

  const sig = await signer.signTypedData({
    domain: usdcDomain(context.chainId) as never,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES as never,
    primaryType: TRANSFER_WITH_AUTHORIZATION_PRIMARY_TYPE as never,
    message: authorization as never,
  });

  const r = ('0x' + sig.slice(2, 66)) as Hex;
  let s = ('0x' + sig.slice(66, 130)) as Hex;
  let v = Number.parseInt(sig.slice(130, 132), 16);

  if (overrides.tamperS) {
    // Flip `s` to its high-order counterpart: n - s. Same curve point, a second
    // valid signature for the same message, which the canonical check rejects.
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    s = ('0x' + (N - BigInt(s)).toString(16).padStart(64, '0')) as Hex;
  }
  if (overrides.badV) v = 29;

  const payload = {
    x402Version: overrides.x402Version ?? X402_VERSION,
    scheme: overrides.scheme ?? X402_SCHEME,
    network: overrides.network ?? context.network,
    payload: {
      authorization: {
        from: authorization.from,
        to: authorization.to,
        value: authorization.value.toString(10),
        validAfter: authorization.validAfter.toString(10),
        validBefore: authorization.validBefore.toString(10),
        nonce: authorization.nonce,
      },
      signature: { v, r, s },
    },
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function handler() {
  return createIntakeHandler({
    context,
    nonces: inMemoryNonceStore(),
    now: () => NOW_MS,
  });
}

async function post(body: string, paymentHeader?: string) {
  return handler()('POST', '/jobs', paymentHeader ? { 'x-payment': paymentHeader } : {}, body);
}

// ---------------------------------------------------------------------------
// The split — the number the contract must agree with
// ---------------------------------------------------------------------------

test('premium split matches fundJob exactly for a 5 USDC job', () => {
  const rates = ratesFrom(context.deployment);
  assert.equal(rates.premiumBps, 500);
  assert.equal(rates.requiredStakeBps, 5_000);

  const split = splitPremium(5_000_000n, rates);
  assert.equal(split.gross, 5_000_000n);
  assert.equal(split.premium, 250_000n);
  assert.equal(split.escrowed, 4_750_000n);
  assert.equal(split.requiredStake, 2_375_000n);
  // The invariant the escrow relies on: nothing is created or destroyed.
  assert.equal(split.premium + split.escrowed, split.gross);
});

test('premium split truncates exactly where Solidity truncates', () => {
  const rates: PremiumRates = { premiumBps: 500, requiredStakeBps: 5_000 };

  // 19 base units: 19 * 500 / 10000 = 0.95 -> floors to 0. The whole amount is
  // escrowed and the warranty pool gets nothing, which is what the contract
  // does too. A Number-based implementation would quote 0.95.
  const tiny = splitPremium(19n, rates);
  assert.equal(tiny.premium, 0n);
  assert.equal(tiny.escrowed, 19n);
  assert.equal(tiny.requiredStake, 9n); // 19 * 5000 / 10000 = 9.5 -> 9

  // 1_234_567: premium = 61728.35 -> 61728; escrowed 1_172_839;
  // requiredStake = 586419.5 -> 586419.
  const odd = splitPremium(1_234_567n, rates);
  assert.equal(odd.premium, 61_728n);
  assert.equal(odd.escrowed, 1_172_839n);
  assert.equal(odd.requiredStake, 586_419n);
  assert.equal(odd.premium + odd.escrowed, odd.gross);
});

test('premium rates come from the manifest, not a literal', () => {
  // A manifest whose premium exceeds the escrow's own ceiling must be refused
  // at quote time rather than at fundJob revert time.
  const bad = { ...context.deployment, params: { premiumBps: 1_001, requiredStakeBps: 5_000 } };
  assert.throws(() => ratesFrom(bad as never), /PremiumTooHigh ceiling/);

  // Stake below the maximum-severity slash would make the harshest verdict
  // unenforceable; the constructor rejects it and so does this.
  const weak = { ...context.deployment, params: { premiumBps: 500, requiredStakeBps: 4_999 } };
  assert.throws(() => ratesFrom(weak as never), /below the maximum-severity slash/);
});

test('base-unit parsing refuses anything that is not an exact integer', () => {
  assert.equal(parseBaseUnits('5000000'), 5_000_000n);
  assert.equal(parseBaseUnits('0'), 0n);
  for (const bad of ['5.0', ' 5 ', '0x5', '5e6', '1_000', '-5', '', '05']) {
    assert.throws(() => parseBaseUnits(bad), /base units/, `accepted ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// The 402 challenge
// ---------------------------------------------------------------------------

test('an unpaid request gets a 402 carrying everything needed to pay', async () => {
  const res = await post(jobBody());
  assert.equal(res.status, 402);

  const body = res.body as Record<string, unknown>;
  assert.equal(body['x402Version'], X402_VERSION);
  assert.equal(body['error'], PAYMENT_ERROR.missingPayment);

  const accepts = body['accepts'] as Record<string, unknown>[];
  assert.equal(accepts.length, 1);
  const req = accepts[0]!;
  assert.equal(req['scheme'], X402_SCHEME);
  assert.equal(req['network'], context.network);
  assert.equal(String(req['asset']).toLowerCase(), context.asset.toLowerCase());
  assert.equal(String(req['payTo']).toLowerCase(), context.payTo.toLowerCase());
  assert.equal(req['maxAmountRequired'], '5000000');
  assert.match(String(req['nonce']), /^0x[0-9a-f]{64}$/);
  // The payer must be told what it is insuring, not just what it owes.
  const extra = req['extra'] as Record<string, unknown>;
  assert.equal((extra['split'] as Record<string, string>)['premium'], '250000');
});

test('each 402 carries a fresh nonce', async () => {
  const a = (await post(jobBody())).body as { accepts: { nonce: string }[] };
  const b = (await post(jobBody())).body as { accepts: { nonce: string }[] };
  assert.notEqual(a.accepts[0]!.nonce, b.accepts[0]!.nonce);
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

test('a valid payment returns the payer and the exact fundJob arguments', async () => {
  const res = await post(jobBody(), await signedPayment());
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const body = res.body as Record<string, unknown>;
  assert.equal(String(body['payer']).toLowerCase(), payer.address.toLowerCase());
  assert.deepEqual(body['split'], {
    gross: '5000000',
    premium: '250000',
    escrowed: '4750000',
    requiredStake: '2375000',
  });

  const call = body['fundJob'] as Record<string, unknown>;
  assert.equal(call['signature'], 'fundJob(bytes32,address,uint256,uint64,uint256)');
  assert.equal(String(call['contract']).toLowerCase(), context.escrow.toLowerCase());
  assert.deepEqual(call['args'], {
    jobId: JOB_ID,
    provider: PROVIDER,
    amount: '5000000',
    deliveryWindow: '86400',
    erc8004TokenId: '1',
  });
  // Positional form must agree with the named form, in ABI order.
  assert.deepEqual(call['argsOrdered'], [JOB_ID, PROVIDER, '5000000', '86400', '1']);
});

test('an overpayment is accepted; the job still funds at its own amount', async () => {
  const res = await post(jobBody(), await signedPayment({ value: 6_000_000n }));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const body = res.body as { split: Record<string, string> };
  assert.equal(body.split['gross'], '5000000');
});

// ---------------------------------------------------------------------------
// Rejections, each a distinct named failure
// ---------------------------------------------------------------------------

const rejects = async (header: string, code: string, body = jobBody()) => {
  const res = await post(body, header);
  assert.equal(res.status, 402, JSON.stringify(res.body));
  assert.equal((res.body as Record<string, unknown>)['error'], code, JSON.stringify(res.body));
};

test('an underpayment is rejected', async () => {
  await rejects(await signedPayment({ value: 4_999_999n }), PAYMENT_ERROR.amountBelowRequired);
});

test('a payment to the wrong recipient is rejected', async () => {
  await rejects(await signedPayment({ to: ('0x' + 'cc'.repeat(20)) as Hex }), PAYMENT_ERROR.wrongPayTo);
});

test('a payment for another network is rejected', async () => {
  await rejects(await signedPayment({ network: 'eip155:1' }), PAYMENT_ERROR.wrongNetwork);
});

test('an unknown scheme is rejected', async () => {
  await rejects(await signedPayment({ scheme: 'upto' }), PAYMENT_ERROR.wrongScheme);
});

test('an expired authorization is rejected', async () => {
  const past = BigInt(Math.floor(NOW_MS / 1_000)) - 3_600n;
  await rejects(await signedPayment({ validBefore: past }), PAYMENT_ERROR.authorizationExpired);
});

test('an authorization that is not yet valid is rejected', async () => {
  const future = BigInt(Math.floor(NOW_MS / 1_000)) + 3_600n;
  await rejects(await signedPayment({ validAfter: future }), PAYMENT_ERROR.authorizationNotYetValid);
});

test('a high-s signature is rejected as malleable', async () => {
  // The escrow rejects high-s for delivery signatures; the payment leg must not
  // be weaker, or one authorization has two valid encodings.
  await rejects(await signedPayment({ tamperS: true }), AUTHORIZATION_ERROR.highSSignature);
});

test('a v outside {27,28} is rejected', async () => {
  await rejects(await signedPayment({ badV: true }), AUTHORIZATION_ERROR.nonCanonicalV);
});

test('a signature from a different key is rejected', async () => {
  await rejects(await signedPayment({ signWithOther: true }), AUTHORIZATION_ERROR.signatureMismatch);
});

test('a replayed nonce is rejected by the same handler instance', async () => {
  const handle = handler();
  const header = await signedPayment();
  const first = await handle('POST', '/jobs', { 'x-payment': header }, jobBody());
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const second = await handle('POST', '/jobs', { 'x-payment': header }, jobBody());
  assert.equal(second.status, 402);
  assert.equal((second.body as Record<string, unknown>)['error'], PAYMENT_ERROR.nonceReplayed);
});

test('a malformed X-PAYMENT header never crashes the endpoint', async () => {
  for (const header of ['not-base64!!', Buffer.from('{').toString('base64'), Buffer.from('[]').toString('base64')]) {
    const res = await post(jobBody(), header);
    assert.equal(res.status, 402, header);
    assert.match(String((res.body as Record<string, unknown>)['error']), /malformed/);
  }
});

test('decodePaymentHeader rejects non-canonical base64', () => {
  assert.throws(() => decodePaymentHeader('@@@@'), /base64/);
});

// ---------------------------------------------------------------------------
// Job request validation
// ---------------------------------------------------------------------------

test('a malformed job request is a 400 before any signature work', async () => {
  const cases: [string, Record<string, unknown>][] = [
    ['short jobId', { jobId: '0x11' }],
    ['zero provider', { provider: '0x' + '0'.repeat(40) }],
    ['zero amount', { amount: '0' }],
    ['zero deliveryWindow', { deliveryWindow: '0' }],
    ['decimal amount', { amount: '5.0' }],
  ];
  for (const [label, override] of cases) {
    const res = await post(jobBody(override));
    assert.equal(res.status, 400, label);
    assert.equal((res.body as Record<string, unknown>)['error'], REQUEST_ERROR.malformedJobRequest, label);
  }
});

test('quote returns the split without requiring any payment', async () => {
  const res = await handler()('GET', '/quote?amount=5000000', {}, '');
  assert.equal(res.status, 200);
  const body = res.body as Record<string, unknown>;
  assert.deepEqual(body['split'], {
    gross: '5000000',
    premium: '250000',
    escrowed: '4750000',
    requiredStake: '2375000',
  });
  assert.equal(String(body['asset']).toLowerCase(), context.asset.toLowerCase());
});

test('quote refuses a malformed amount', async () => {
  for (const q of ['/quote', '/quote?amount=', '/quote?amount=5.0', '/quote?amount=-1']) {
    const res = await handler()('GET', q, {}, '');
    assert.equal(res.status, 400, q);
  }
});

test('an unknown route is a 404', async () => {
  const res = await handler()('GET', '/nope', {}, '');
  assert.equal(res.status, 404);
});

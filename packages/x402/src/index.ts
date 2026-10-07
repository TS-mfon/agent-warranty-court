/**
 * `@awc/x402` — the x402 payment leg for the Agent Warranty Court.
 *
 * The warranty premium is captured at payment time rather than at delivery, so
 * every trade is insured before execution begins. That ordering is the reason
 * this package exists as its own thing: by the time a dispute is filed it is
 * far too late to ask the buyer to fund the warranty pool.
 *
 * Three modules, one responsibility each:
 *
 *   premium       the 95/5 split, transcribed bit for bit from
 *                 `WarrantyEscrow.fundJob`, with the rates read from the
 *                 deployment manifest rather than written down.
 *   authorization the EIP-3009 `TransferWithAuthorization` typed data, its USDC
 *                 domain, and canonical-signature recovery.
 *   server        the HTTP 402 intake: quote, challenge, verify, and hand back
 *                 the exact `fundJob` arguments.
 */
export * from './premium.ts';
export * from './authorization.ts';
export * from './server.ts';
export * from './requirements.ts';

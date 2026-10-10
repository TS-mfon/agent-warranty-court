#!/usr/bin/env node
/**
 * MCP server for the Agent Warranty Court.
 *
 * Gives an agent the protocol as tools rather than as prose it has to remember:
 * the live addresses, the verdict grammar, a coherence check that explains why
 * Base would reject a verdict, the commitment hash, and live reads of job and
 * case state.
 *
 * Everything it reports about the grammar is parsed from the project's own
 * sources at startup (see `grammar.mjs`). That is the whole design: an MCP
 * server is installed once and then trusted indefinitely, so a hand-typed copy
 * of the rules would be the most dangerous copy in the project.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  GRAMMAR, JOB_STATES, VERDICT_STATUSES,
  coherence, verdictCommitment, loadManifest, loadSelectors,
} from './grammar.mjs';

const BASE_SEPOLIA = 84_532;
const GENLAYER_STUDIONET = 61_999;

/**
 * Selectors for the live reads, loaded from the repository's `cast sig`-derived
 * artifact rather than typed here. Both values in the first draft of this file
 * were wrong, and a wrong selector returns empty data that reads as enum 0 —
 * "unknown" — rather than as an error.
 */
const SELECTORS = await loadSelectors();

const LIMITATION =
  'The trustless canonical backstop is NOT deployed. A challenged verdict ' +
  'resolves through timeoutChallenge after canonicalTimeout (14 days), with the ' +
  'posted verdict standing and the challenger forfeiting its bond. The relayer ' +
  'is bonded but not provably falsifiable. Unaudited, testnet only.';

const TOOLS = [
  {
    name: 'get_deployment',
    description:
      'Live contract addresses and deploy-time parameters for a chain, read from the ' +
      'deployment manifest. Use this instead of hardcoding an address.',
    inputSchema: {
      type: 'object',
      properties: {
        chainId: {
          type: 'number',
          description: `${BASE_SEPOLIA} for Base Sepolia, ${GENLAYER_STUDIONET} for GenLayer studionet.`,
          default: BASE_SEPOLIA,
        },
      },
    },
  },
  {
    name: 'get_verdict_grammar',
    description:
      'The closed verdict enum, payout buckets, severity-to-slash table and coherence ' +
      'rules, parsed from VerdictLib.sol. The array index of a code is its on-chain uint8.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_verdict_coherence',
    description:
      'Decide whether Base would accept a verdict, and say precisely why not if it ' +
      'would not. Call this before postVerdict: an incoherent verdict reverts ' +
      'IncoherentVerdict and is unsettleable.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'number', description: 'violation code 0..6' },
        payoutBps: { type: 'number', description: 'basis points; one of the closed buckets' },
        severity: { type: 'number', description: '0..3' },
      },
      required: ['code', 'payoutBps', 'severity'],
    },
  },
  {
    name: 'compute_verdict_commitment',
    description:
      'The verdict commitment hash Base stores as verdictHash. sha256 over the ' +
      'newline-joined fields in frozen order, reasoning last.',
    inputSchema: {
      type: 'object',
      properties: {
        caseId: { type: 'string', description: '0x-prefixed 32-byte hex' },
        violationCode: { type: 'string', description: 'the code NAME, e.g. DEAD_LINK_CITATION' },
        payoutBps: { type: 'number' },
        severity: { type: 'number' },
        reasoning: { type: 'string' },
      },
      required: ['caseId', 'violationCode', 'payoutBps', 'severity', 'reasoning'],
    },
  },
  {
    name: 'get_job_state',
    description:
      'Read WarrantyEscrow.stateOf for a bytes32 job id over Base Sepolia and return the ' +
      'state name from the contract enum.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string', description: '0x-prefixed 32-byte hex' } },
      required: ['jobId'],
    },
  },
  {
    name: 'get_case_status',
    description: 'Read VerdictInbox.statusOf for a bytes32 case id over Base Sepolia.',
    inputSchema: {
      type: 'object',
      properties: { caseId: { type: 'string', description: '0x-prefixed 32-byte hex' } },
      required: ['caseId'],
    },
  },
  {
    name: 'explain_lifecycle',
    description:
      'The ordered steps of a warranty job with the exact call, chain and caller for each, ' +
      'including the permissionless escape hatches.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const LIFECYCLE = [
  { step: 1, call: 'register_provider(erc8004TokenId, slaUrl, slaDigest)', chain: 'GenLayer', who: 'provider', note: 'once; the SLA digest is pinned so obligations cannot be rewritten later' },
  { step: 2, call: 'stake(amount)', chain: 'Base', who: 'provider', note: 'needs requiredStakeBps of escrowed value available; 21-day unbonding' },
  { step: 3, call: 'fundJob(jobId, provider, amount, deliveryWindow, erc8004TokenId)', chain: 'Base', who: 'client', note: 'splits premium/escrow and locks collateral atomically' },
  { step: 4, call: 'submitDelivery(jobId, transcriptDigest, v, r, s)', chain: 'Base', who: 'anyone holding the provider signature', note: 'get the digest from deliveryDigestFor; v in {27,28}, low-s only' },
  { step: 5, call: 'openDispute(jobId) -> caseId', chain: 'Base', who: 'client', note: 'before acceptanceDeadline; freezes provider stake; MAX_DISPUTES is 2' },
  { step: 6, call: 'open_case(caseId, provider, escrowRef, transcriptUri, transcriptDigest, claimedViolation, clientStatement, disputedUrls)', chain: 'GenLayer', who: 'client', note: 'commits evidence digests; claimedViolation may not be NO_BREACH' },
  { step: 7, call: 'adjudicate(caseId)', chain: 'GenLayer', who: 'anyone', note: 'validators re-derive independently; transient failures leave the case OPEN' },
  { step: 8, call: 'postVerdict(caseId, verdictHash, code, payoutBps, severity, genlayerTxId)', chain: 'Base', who: 'anyone, against relayerBond', note: 'only a verdict already final on GenLayer; coherence re-checked here' },
  { step: 9, call: 'finalizeVerdict(caseId)', chain: 'Base', who: 'anyone, after challengeWindow', note: 'permissionless; refunds the relayer bond' },
  { step: 10, call: 'settle(jobId)', chain: 'Base', who: 'anyone', note: 'pays per bucket, slashes per severity; code 6 opens a cure window instead' },
];

const ESCAPES = [
  { call: 'release(jobId)', when: 'Delivered, after acceptanceDeadline, undisputed', who: 'anyone' },
  { call: 'refundStale(jobId)', when: 'Funded, after deliveryDeadline, never delivered', who: 'anyone' },
  { call: 'settleAfterCure(jobId)', when: 'after cureDeadline on an EVIDENCE_UNAVAILABLE verdict', who: 'anyone' },
  { call: 'timeoutChallenge(caseId)', when: 'Challenged, after canonicalTimeout', who: 'anyone', note: 'the posted verdict stands; on this deployment every challenge resolves here' },
];

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

let rpcId = 0;

async function ethCall(rpcUrl, to, data) {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to, data }, 'latest'] }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message ?? 'RPC error');
  return body.result;
}

const pad32 = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const toNumber = (hex) => (!hex || hex === '0x' ? 0 : Number(BigInt(hex)));

/** Look up an enum index, never guessing past the end of the list. */
function enumName(list, index, what) {
  const name = list[index];
  if (name === undefined) {
    return { name: null, note: `index ${index} is outside the known ${what} enum (${list.length} members)` };
  }
  return { name };
}

async function readEnum(selectorKey, list, id, what) {
  const base = loadManifest(BASE_SEPOLIA);
  const contract = selectorKey === 'stateOf(bytes32)' ? 'WarrantyEscrow' : 'VerdictInbox';
  const address = base.contracts[contract];
  if (!address) throw new Error(`${contract} missing from the chain ${BASE_SEPOLIA} manifest`);

  const raw = await ethCall(base.rpcUrl, address, SELECTORS[selectorKey] + pad32(id));
  const index = toNumber(raw);
  const resolved = enumName(list, index, what);

  return {
    id,
    index,
    ...resolved,
    contract,
    address,
    chainId: base.chainId,
    // Both enums use 0 for "unknown", and an id that was never created reads
    // identically to one that is brand new. Saying so prevents an agent from
    // treating an unrecognised id as a real, empty record.
    note: index === 0
      ? `${list[0]} — this contract has no record of ${id}; it may belong to another deployment`
      : resolved.note,
  };
}

const json = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

const server = new Server(
  { name: 'agent-warranty-court', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const args = request.params.arguments ?? {};

  try {
    switch (name) {
      case 'get_deployment': {
        const chainId = Number(args.chainId ?? BASE_SEPOLIA);
        const manifest = loadManifest(chainId);
        return json({ ...manifest, limitation: LIMITATION });
      }

      case 'get_verdict_grammar':
        return json({
          codes: GRAMMAR.codes.map((codeName, code) => ({
            code,
            name: codeName,
            isBreach: code !== GRAMMAR.noBreach && code !== GRAMMAR.evidenceUnavailable,
          })),
          payoutBuckets: GRAMMAR.buckets,
          slashBpsBySeverity: GRAMMAR.slashBySeverity,
          maxSeverity: GRAMMAR.maxSeverity,
          minBreachPayoutBps: GRAMMAR.minBreachPayoutBps,
          bpsDenominator: GRAMMAR.bpsDenominator,
          coherenceRules: [
            `codes ${GRAMMAR.noBreach} and ${GRAMMAR.evidenceUnavailable} require severity 0 and payoutBps 0`,
            `every other code requires severity >= 1 and payoutBps >= ${GRAMMAR.minBreachPayoutBps}`,
            'payoutBps must be exactly one of the buckets',
          ],
          jobStates: JOB_STATES,
          verdictStatuses: VERDICT_STATUSES,
          source: 'parsed from contracts/shared/VerdictLib.sol at server start',
        });

      case 'check_verdict_coherence': {
        const result = coherence(Number(args.code), Number(args.payoutBps), Number(args.severity));
        return json({
          ...result,
          input: { code: args.code, payoutBps: args.payoutBps, severity: args.severity },
          codeName: GRAMMAR.codes[Number(args.code)] ?? null,
          slashBps: result.coherent ? (GRAMMAR.slashBySeverity[Number(args.severity)] ?? 0) : null,
        });
      }

      case 'compute_verdict_commitment': {
        if (!BYTES32.test(String(args.caseId))) {
          throw new Error(`caseId must be 0x followed by 64 hex characters, got ${JSON.stringify(args.caseId)}`);
        }
        if (!GRAMMAR.codes.includes(String(args.violationCode))) {
          throw new Error(
            `violationCode must be one of ${GRAMMAR.codes.join(', ')}, got ${JSON.stringify(args.violationCode)}`,
          );
        }
        return json({
          verdictHash: verdictCommitment({
            caseId: String(args.caseId),
            violationCode: String(args.violationCode),
            payoutBps: args.payoutBps,
            severity: args.severity,
            reasoning: String(args.reasoning ?? ''),
          }),
          preimageFormat: 'sha256(caseId \\n violationCode \\n payoutBps \\n severity \\n reasoning)',
        });
      }

      case 'get_job_state': {
        if (!BYTES32.test(String(args.jobId))) throw new Error('jobId must be 0x + 64 hex characters');
        return json(await readEnum('stateOf(bytes32)', JOB_STATES, String(args.jobId), 'job state'));
      }

      case 'get_case_status': {
        if (!BYTES32.test(String(args.caseId))) throw new Error('caseId must be 0x + 64 hex characters');
        return json(await readEnum('statusOf(bytes32)', VERDICT_STATUSES, String(args.caseId), 'verdict status'));
      }

      case 'explain_lifecycle':
        return json({ lifecycle: LIFECYCLE, permissionlessEscapes: ESCAPES, limitation: LIMITATION });

      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    // Returned as an error result rather than thrown, so the agent sees the
    // reason and can correct its arguments instead of losing the connection.
    return { isError: true, content: [{ type: 'text', text: `${name} failed: ${err.message}` }] };
  }
});

await server.connect(new StdioServerTransport());

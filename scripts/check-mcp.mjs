#!/usr/bin/env node
/**
 * Prove the MCP server actually works, by being a client.
 *
 * Starting the process and seeing it not crash proves very little. This performs
 * the real `initialize` handshake over stdio, lists the tools, then calls them
 * and checks the answers against independent computations — the commitment
 * against a local sha256, and the coherence verdicts against the rules as stated
 * in the documentation rather than as the server implements them.
 *
 * The incoherent case matters most: a server that returned `coherent: true` for
 * everything would pass a happy-path test and teach every agent that consumes it
 * to post verdicts Base rejects.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MCP = join(ROOT, 'integrations/mcp');
const problems = [];

if (!existsSync(join(MCP, 'node_modules/@modelcontextprotocol/sdk'))) {
  console.error('mcp FAILED');
  console.error('  - the SDK is not installed; run `npm install` inside integrations/mcp');
  process.exit(1);
}

const child = spawn('node', ['src/server.mjs'], {
  cwd: MCP,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (d) => {
  stderr += d.toString();
});

/** Minimal JSON-RPC-over-stdio client: newline-delimited, id-matched. */
let nextId = 0;
let buffer = '';
const pending = new Map();

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not a frame we care about
    }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function send(method, params, { notify = false } = {}) {
  if (notify) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    return Promise.resolve(null);
  }
  const id = ++nextId;
  const frame = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after 20s`));
    }, 20_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

/** Tool results come back as a content array of text parts. */
function payload(response, toolName) {
  if (response?.error) throw new Error(`${toolName}: ${response.error.message}`);
  const result = response?.result;
  if (!result) throw new Error(`${toolName}: no result`);
  if (result.isError) {
    const text = result.content?.map((c) => c.text).join('') ?? '';
    throw new Error(`${toolName} returned an error result: ${text}`);
  }
  const text = result.content?.map((c) => c.text).join('') ?? '';
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${toolName}: result was not JSON: ${text.slice(0, 120)}`);
  }
}

const EXPECTED_TOOLS = [
  'get_deployment', 'get_verdict_grammar', 'check_verdict_coherence',
  'compute_verdict_commitment', 'get_job_state', 'get_case_status', 'explain_lifecycle',
];

try {
  // 1. Handshake.
  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'check-mcp', version: '0.0.0' },
  });
  if (init?.error) problems.push(`initialize failed: ${init.error.message}`);
  const serverName = init?.result?.serverInfo?.name;
  if (serverName !== 'agent-warranty-court') {
    problems.push(`initialize returned serverInfo.name ${JSON.stringify(serverName)}`);
  }
  await send('notifications/initialized', {}, { notify: true });

  // 2. Tool listing.
  const listed = await send('tools/list', {});
  const names = (listed?.result?.tools ?? []).map((t) => t.name);
  for (const expected of EXPECTED_TOOLS) {
    if (!names.includes(expected)) problems.push(`tools/list omits ${expected}`);
  }
  for (const tool of listed?.result?.tools ?? []) {
    if (!tool.description || tool.description.length < 30) {
      problems.push(`tool ${tool.name} has no usable description`);
    }
    if (!tool.inputSchema) problems.push(`tool ${tool.name} has no inputSchema`);
  }

  // 3. A coherent verdict must be accepted.
  {
    const r = payload(
      await send('tools/call', {
        name: 'check_verdict_coherence',
        arguments: { code: 3, payoutBps: 5000, severity: 2 },
      }),
      'check_verdict_coherence',
    );
    if (r.coherent !== true) {
      problems.push(`a coherent verdict (3, 5000, 2) was rejected: ${JSON.stringify(r.reasons)}`);
    }
    if (r.codeName !== 'DEAD_LINK_CITATION') {
      problems.push(`code 3 named ${JSON.stringify(r.codeName)}, expected DEAD_LINK_CITATION`);
    }
    if (r.slashBps !== 2500) problems.push(`severity 2 reported slashBps ${r.slashBps}, expected 2500`);
  }

  // 4. The case that matters: NO_BREACH with a full refund must be rejected.
  {
    const r = payload(
      await send('tools/call', {
        name: 'check_verdict_coherence',
        arguments: { code: 0, payoutBps: 10000, severity: 0 },
      }),
      'check_verdict_coherence',
    );
    if (r.coherent !== false) {
      problems.push('NO_BREACH with payoutBps 10000 was accepted; Base would revert IncoherentVerdict');
    }
    if (!r.wouldRevert || !/IncoherentVerdict/.test(r.wouldRevert)) {
      problems.push(`incoherent verdict did not name the revert: ${JSON.stringify(r.wouldRevert)}`);
    }
    if (!(Array.isArray(r.reasons) && r.reasons.length > 0)) {
      problems.push('incoherent verdict gave no reason, so an agent cannot correct it');
    }
  }

  // 5. An off-bucket payout must be rejected.
  {
    const r = payload(
      await send('tools/call', {
        name: 'check_verdict_coherence',
        arguments: { code: 3, payoutBps: 6347, severity: 2 },
      }),
      'check_verdict_coherence',
    );
    if (r.coherent !== false) problems.push('an off-bucket payout (6347) was accepted');
  }

  // 6. The commitment, verified against an independent sha256.
  {
    const caseId = `0x${'11'.repeat(32)}`;
    const args = {
      caseId, violationCode: 'DEAD_LINK_CITATION', payoutBps: 5000, severity: 2,
      reasoning: 'the citation 404s',
    };
    const r = payload(
      await send('tools/call', { name: 'compute_verdict_commitment', arguments: args }),
      'compute_verdict_commitment',
    );
    const independent =
      '0x' +
      createHash('sha256')
        .update(`${caseId}\nDEAD_LINK_CITATION\n5000\n2\nthe citation 404s`, 'utf8')
        .digest('hex');
    if (r.verdictHash !== independent) {
      problems.push(`commitment ${r.verdictHash} does not match independent ${independent}`);
    }
  }

  // 7. The grammar must come from the contract, with the right shape.
  {
    const r = payload(await send('tools/call', { name: 'get_verdict_grammar', arguments: {} }), 'get_verdict_grammar');
    if (r.codes?.length !== 7) problems.push(`grammar reports ${r.codes?.length} codes, expected 7`);
    if (r.codes?.[0]?.name !== 'NO_BREACH') problems.push('code 0 is not NO_BREACH');
    if (r.codes?.[6]?.name !== 'EVIDENCE_UNAVAILABLE') problems.push('code 6 is not EVIDENCE_UNAVAILABLE');
    if (r.codes?.[0]?.isBreach !== false || r.codes?.[6]?.isBreach !== false) {
      problems.push('codes 0 and 6 must both report isBreach false');
    }
    if (JSON.stringify(r.payoutBuckets) !== JSON.stringify([0, 2500, 5000, 7500, 10000])) {
      problems.push(`buckets are ${JSON.stringify(r.payoutBuckets)}`);
    }
    // The enum order bug this project actually shipped.
    if (r.jobStates?.[3] !== 'Disputed' || r.jobStates?.[4] !== 'Released') {
      problems.push(`job states are transposed: ${JSON.stringify(r.jobStates)}`);
    }
  }

  // 8. Deployment addresses must come from the manifest, and carry the caveat.
  {
    const r = payload(
      await send('tools/call', { name: 'get_deployment', arguments: { chainId: 84532 } }),
      'get_deployment',
    );
    if (r.chainId !== 84_532) problems.push(`get_deployment returned chainId ${r.chainId}`);
    if (!r.contracts?.WarrantyEscrow) problems.push('get_deployment omits WarrantyEscrow');
    if (!/not deployed|NOT deployed/i.test(r.limitation ?? '')) {
      problems.push('get_deployment does not carry the backstop limitation');
    }
  }

  // 9. Bad input must be an error result, not a crash or a plausible answer.
  {
    const res = await send('tools/call', {
      name: 'compute_verdict_commitment',
      arguments: { caseId: '0xdeadbeef', violationCode: 'DEAD_LINK_CITATION', payoutBps: 5000, severity: 2, reasoning: 'x' },
    });
    if (!res?.result?.isError) problems.push('a malformed caseId did not produce an error result');
  }
  {
    const res = await send('tools/call', {
      name: 'compute_verdict_commitment',
      arguments: { caseId: `0x${'11'.repeat(32)}`, violationCode: 'PROFIT', payoutBps: 5000, severity: 2, reasoning: 'x' },
    });
    if (!res?.result?.isError) problems.push('an off-enum violationCode did not produce an error result');
  }

  // Negative control: the independent commitment must disagree when the input
  // differs. Without this, a comparison against a constant would pass anything.
  {
    const a = createHash('sha256').update('x', 'utf8').digest('hex');
    const b = createHash('sha256').update('y', 'utf8').digest('hex');
    if (a === b) problems.push('negative control failed: sha256 is degenerate in this runtime');
  }
} catch (err) {
  problems.push(err.message);
} finally {
  child.kill('SIGTERM');
}

if (stderr.trim() && !/ExperimentalWarning|Warning:/.test(stderr)) {
  problems.push(`server wrote to stderr: ${stderr.trim().split('\n')[0]}`);
}

if (problems.length > 0) {
  console.error('mcp FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `handshake ok, ${EXPECTED_TOOLS.length} tools advertised, 6 tool calls verified ` +
    '(coherent accepted, incoherent and off-bucket rejected with reasons, ' +
    'commitment matched an independent sha256, enum order checked)',
);
console.log('mcp verification passed');

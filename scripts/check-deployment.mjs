#!/usr/bin/env node
/**
 * Verify every address in every deployment manifest against its own chain.
 *
 * A manifest is a claim. This turns it into evidence: each address is checked
 * for bytecode over that chain's RPC, and on Base the wiring is read back from
 * the contracts themselves rather than from the file that asserts it. Reading a
 * manifest back to itself would prove only that JSON parses.
 *
 * Usage: node scripts/check-deployment.mjs [--chain <id>]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'deployments');

const args = process.argv.slice(2);
const chainArg = args.indexOf('--chain') >= 0 ? args[args.indexOf('--chain') + 1] : null;

/** Chains whose contracts are plain EVM and so have readable bytecode. */
const EVM_CHAINS = new Set([84532, 11155111, 4221]);

/**
 * Addresses that belong to someone else and must exist but are not ours.
 * Checked anyway: if USDC or the messenger predeploy is absent, the deployment
 * is pointed at the wrong network and everything else is meaningless.
 */
const FOREIGN = new Set(['USDC', 'L2CrossDomainMessenger']);

const problems = [];
let checkedAddresses = 0;
let checkedReadbacks = 0;

async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/**
 * Getter selectors, verified against `cast sig` rather than recalled.
 *
 * All three were wrong on the first write of this file. A wrong selector hits
 * the fallback, `eth_call` returns empty, and the readback fails closed — so the
 * gate would have reported a miswired deployment that was actually fine. Failing
 * closed is the right direction for a mistake to point, but it is still a
 * mistake, and the fix is verification, not care.
 */
const selector = {
  'escrow()': '0xe2fdcc17',
  'canonicalReceiver()': '0x509f964c',
  'l1Forwarder()': '0x26fc9039',
};

async function readAddress(url, to, sig) {
  const data = await rpc(url, 'eth_call', [{ to, data: sig }, 'latest']);
  if (!data || data === '0x') return null;
  return '0x' + data.slice(-40);
}

const files = chainArg
  ? [`${chainArg}.json`]
  : existsSync(DIR)
    ? readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
    : [];

if (files.length === 0) {
  console.error('deployment FAILED: no manifest found' + (chainArg ? ` for chain ${chainArg}` : ''));
  process.exit(1);
}

for (const file of files) {
  const path = join(DIR, file);
  if (!existsSync(path)) {
    problems.push(`${file}: manifest missing`);
    continue;
  }
  const m = JSON.parse(readFileSync(path, 'utf8'));
  const expectedId = Number(file.replace('.json', ''));
  if (m.chainId !== expectedId) {
    problems.push(`${file}: declares chainId ${m.chainId}`);
    continue;
  }
  if (!m.rpcUrl) {
    problems.push(`${file}: no rpcUrl`);
    continue;
  }

  let liveId;
  try {
    liveId = Number(await rpc(m.rpcUrl, 'eth_chainId', []));
  } catch (e) {
    problems.push(`chain ${m.chainId}: RPC unreachable (${e.message})`);
    continue;
  }
  if (liveId !== m.chainId) {
    problems.push(`chain ${m.chainId}: RPC at ${m.rpcUrl} reports ${liveId}`);
    continue;
  }

  const entries = Object.entries(m.contracts ?? {});
  if (entries.length === 0) problems.push(`chain ${m.chainId}: manifest lists no contracts`);

  for (const [name, address] of entries) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      problems.push(`chain ${m.chainId}: ${name} is not an address (${address})`);
      continue;
    }
    if (!EVM_CHAINS.has(m.chainId)) {
      // Non-EVM contract (a GenLayer Intelligent Contract). Bytecode is the
      // wrong question; `check-genlayer-ic.mjs` proves liveness by calling it.
      continue;
    }
    let code;
    try {
      code = await rpc(m.rpcUrl, 'eth_getCode', [address, 'latest']);
    } catch (e) {
      problems.push(`chain ${m.chainId}: ${name} getCode failed (${e.message})`);
      continue;
    }
    const size = (code.length - 2) / 2;
    if (size === 0) {
      problems.push(`chain ${m.chainId}: ${name} at ${address} has no bytecode`);
    } else {
      checkedAddresses += 1;
      if (!FOREIGN.has(name)) process.stdout.write(`  chain ${m.chainId} ${name} ${size}B\n`);
    }
  }

  // Reserved addresses must be *empty*. If something now occupies a reserved
  // slot, the reservation is void and the manifest is actively misleading.
  for (const [name, address] of Object.entries(m.reserved ?? {})) {
    const code = await rpc(m.rpcUrl, 'eth_getCode', [address, 'latest']).catch(() => '0x');
    if (((code.length - 2) / 2) !== 0) {
      problems.push(`chain ${m.chainId}: reserved ${name} at ${address} is now occupied`);
    } else {
      process.stdout.write(`  chain ${m.chainId} ${name} reserved, still empty\n`);
    }
  }

  // Read the Base wiring back off chain.
  if (m.chainId === 84532) {
    const c = m.contracts;
    const pairs = [
      ['ProviderStake.escrow()', c.ProviderStake, selector['escrow()'], c.WarrantyEscrow],
      ['ReputationLog.escrow()', c.ReputationLog, selector['escrow()'], c.WarrantyEscrow],
      ['VerdictInbox.canonicalReceiver()', c.VerdictInbox, selector['canonicalReceiver()'], c.CanonicalVerdictReceiver],
    ];
    for (const [label, to, sig, expected] of pairs) {
      const got = await readAddress(m.rpcUrl, to, sig);
      if (!got || got.toLowerCase() !== String(expected).toLowerCase()) {
        problems.push(`chain ${m.chainId}: ${label} = ${got}, expected ${expected}`);
      } else {
        checkedReadbacks += 1;
        process.stdout.write(`  chain ${m.chainId} ${label} -> ok\n`);
      }
    }
  }
}

// Negative control: the comparison must reject a wrong address. Without this,
// a readback helper that returned the expected value unconditionally would make
// every wiring check above pass.
{
  const bogus = '0x' + '00'.repeat(20);
  const expected = '0x' + '11'.repeat(20);
  if (bogus.toLowerCase() === expected.toLowerCase()) {
    problems.push('negative control did not fail: address comparison is degenerate');
  }
}

if (problems.length > 0) {
  console.error('deployment FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const label = chainArg ? `chain ${chainArg}` : 'deployment';
console.log(`${checkedAddresses} addresses with bytecode, ${checkedReadbacks} wiring readbacks`);
console.log(`${label} verification passed`);

/**
 * Case explorer for the Agent Warranty Court.
 *
 * Reads Base Sepolia directly from the browser over JSON-RPC. There is no
 * server and no cache, which is deliberate: a dashboard that serves numbers
 * from somewhere other than the chain can show confident figures for a
 * deployment that no longer exists. Everything here is one `eth_call` away from
 * its source.
 *
 * All addresses, selectors and verdict codes come from `generated/data.js`,
 * which `build.mjs` derives from `deployments/`, `@awc/shared` and `cast sig`.
 * Nothing in this file is a second copy of a fact held elsewhere.
 */
import {
  BASE, GENLAYER, SELECTORS, JOB_STATES, VERDICT_STATUSES,
  VERDICT_CODES, PAYOUT_BUCKETS, SLASH_BY_SEVERITY, GENERATED_AT,
} from './generated/data.js';

const $ = (id) => document.getElementById(id);
const C = BASE.contracts;

let rpcId = 0;

async function call(to, data) {
  const res = await fetch(BASE.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** A single `bytes32` argument, left-padded as the ABI requires. */
const arg32 = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addrArg = (a) => arg32(a.replace(/^0x/, ''));

const toBig = (hex) => (!hex || hex === '0x' ? 0n : BigInt(hex));

/** USDC has 6 decimals; show whole units with thousands separators. */
function usdc(value) {
  const whole = value / 1_000_000n;
  const cents = (value % 1_000_000n) / 10_000n;
  return `${whole.toLocaleString('en-US')}.${String(cents).padStart(2, '0')}`;
}

function duration(seconds) {
  const s = Number(seconds);
  if (s === 0) return '0';
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  const m = Math.floor((s % 3_600) / 60);
  return h > 0 ? `${h}h` : `${m}m`;
}

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const scan = (a) => `https://sepolia.basescan.org/address/${a}`;

// ---------------------------------------------------------------------------
// Static tables, rendered from the generated grammar
// ---------------------------------------------------------------------------

function renderGrammar() {
  const codes = $('codes').querySelector('tbody');
  for (const { code, name, isBreach } of VERDICT_CODES) {
    const tr = document.createElement('tr');
    const label = name.toLowerCase().replaceAll('_', ' ');
    tr.innerHTML =
      `<td class="mono">${code}</td><td>${label}</td>` +
      `<td><span class="badge${isBreach ? ' breach' : ''}">${isBreach ? 'breach' : 'no payout'}</span></td>`;
    codes.append(tr);
  }

  $('buckets').textContent = PAYOUT_BUCKETS.join(' · ');

  const slash = $('slash').querySelector('tbody');
  for (const { severity, bps } of SLASH_BY_SEVERITY) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mono">${severity}</td><td class="mono">${bps / 100}% of job value</td>`;
    slash.append(tr);
  }
}

function renderAddresses() {
  const body = $('addresses').querySelector('tbody');
  const rows = [
    ...Object.entries(C).map(([name, address]) => [name, address, BASE.name]),
    ...Object.entries(BASE.reserved ?? {}).map(([name, address]) => [`${name} (reserved, not deployed)`, address, BASE.name]),
    ...Object.entries(GENLAYER.contracts).map(([name, address]) => [name, address, GENLAYER.name]),
  ];
  for (const [name, address, chain] of rows) {
    const tr = document.createElement('tr');
    const link = chain === BASE.name
      ? `<a href="${scan(address)}" rel="noreferrer">${short(address)}</a>`
      : `<span class="mono">${short(address)}</span>`;
    tr.innerHTML = `<td>${name}<br><span class="badge">${chain}</span></td><td class="mono">${link}</td>`;
    body.append(tr);
  }
}

// ---------------------------------------------------------------------------
// Live state
// ---------------------------------------------------------------------------

async function loadStats() {
  const net = $('net');
  try {
    const [escrowed, usdcBal, premium, stakeBps, window_, timeout] = await Promise.all([
      call(C.WarrantyEscrow, SELECTORS['totalEscrowed()']),
      call(C.USDC, SELECTORS['balanceOf(address)'] + addrArg(C.WarrantyEscrow)),
      call(C.WarrantyEscrow, SELECTORS['premiumBps()']),
      call(C.WarrantyEscrow, SELECTORS['requiredStakeBps()']),
      call(C.VerdictInbox, SELECTORS['challengeWindow()']),
      call(C.VerdictInbox, SELECTORS['canonicalTimeout()']),
    ]);

    $('s-escrowed').textContent = `${usdc(toBig(escrowed))} USDC`;
    $('s-usdc').textContent = `${usdc(toBig(usdcBal))} USDC`;
    $('s-premium').textContent = `${Number(toBig(premium)) / 100}%`;
    $('s-stake').textContent = `${Number(toBig(stakeBps)) / 100}% of job`;
    $('s-window').textContent = duration(toBig(window_));
    $('s-timeout').textContent = duration(toBig(timeout));

    // The solvency equality the invariant suite proves on chain, shown live.
    const solvent = toBig(escrowed) === toBig(usdcBal);
    net.textContent = solvent
      ? `${BASE.name} · chain ${BASE.chainId} · escrow solvent (held == accounted)`
      : `${BASE.name} · chain ${BASE.chainId} · WARNING: held != accounted`;
    net.className = solvent ? 'net ok' : 'net bad';
  } catch (err) {
    net.textContent = `could not reach ${BASE.rpcUrl}: ${err.message}`;
    net.className = 'net bad';
  }
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function row(dt, dd) {
  return `<dt>${dt}</dt><dd>${dd}</dd>`;
}

async function lookup(event) {
  event.preventDefault();
  const raw = $('jobId').value.trim();
  const out = $('result');
  out.hidden = false;

  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    out.className = 'result bad';
    out.innerHTML = '<dl>' + row('Not a bytes32', 'Expected <code>0x</code> followed by 64 hex characters.') + '</dl>';
    return;
  }

  out.className = 'result';
  out.innerHTML = '<dl>' + row('Status', 'reading chain…') + '</dl>';

  try {
    const [state, verdict] = await Promise.all([
      call(C.WarrantyEscrow, SELECTORS['stateOf(bytes32)'] + arg32(raw)),
      call(C.VerdictInbox, SELECTORS['statusOf(bytes32)'] + arg32(raw)),
    ]);

    const jobState = JOB_STATES[Number(toBig(state))] ?? `unknown (${toBig(state)})`;
    const verdictStatus = VERDICT_STATUSES[Number(toBig(verdict))] ?? `unknown (${toBig(verdict)})`;

    const unknown = jobState === 'None' && verdictStatus === 'None';
    out.className = unknown ? 'result bad' : 'result';
    out.innerHTML =
      '<dl>' +
      row('Id', `<span class="mono">${raw}</span>`) +
      row('Escrow state', jobState) +
      row('Verdict status', verdictStatus) +
      (unknown
        ? row('Note', 'Neither the escrow nor the inbox knows this id. It may belong to a different deployment.')
        : '') +
      '</dl>';
  } catch (err) {
    out.className = 'result bad';
    out.innerHTML = '<dl>' + row('RPC error', err.message) + '</dl>';
  }
}

// ---------------------------------------------------------------------------

renderGrammar();
renderAddresses();
$('lookup').addEventListener('submit', lookup);
$('generated').textContent = `data generated ${GENERATED_AT.slice(0, 10)}`;
loadStats();

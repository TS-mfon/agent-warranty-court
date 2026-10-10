/**
 * The monitor page: live protocol state from Base Sepolia.
 *
 * Every figure is one `eth_call`. The solvency row is the interesting one: it
 * compares what the escrow says it holds against what the token says it holds,
 * which is the same equality the invariant suite proves on chain. If those two
 * ever disagree, the page says so in warning colour rather than rounding the
 * problem away.
 */
import { BASE, GENLAYER } from './generated/data.js';
import {
  ChainError, callNullary, callWith, toBig, usdc, duration,
  shortAddress, basescan, tweenTo, prefersReducedMotion,
} from './chain.js';

const $ = (id) => document.getElementById(id);
const C = BASE.contracts;
const reduced = prefersReducedMotion();

function setStatus(kind, text) {
  const node = $('net');
  node.className = `status ${kind}`;
  $('net-text').textContent = text;
}

function fail(message) {
  setStatus('bad', message);
  for (const id of ['s-escrowed', 's-usdc', 's-solvent', 's-premium', 's-stake', 's-window', 's-timeout']) {
    const node = $(id);
    node.classList.remove('loading');
    node.textContent = '—';
  }
}

function renderAddresses() {
  const body = $('addresses');
  const rows = [
    ...Object.entries(C).map(([name, address]) => [name, BASE.name, address, true]),
    ...Object.entries(BASE.reserved ?? {}).map(([name, address]) => [
      `${name} · reserved, not deployed`, BASE.name, address, false,
    ]),
    ...Object.entries(GENLAYER.contracts).map(([name, address]) => [name, GENLAYER.name, address, false]),
  ];

  for (const [name, chain, address, linked] of rows) {
    const tr = document.createElement('tr');

    const th = document.createElement('th');
    th.scope = 'row';
    th.textContent = name;
    tr.append(th);

    const chainCell = document.createElement('td');
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = chain;
    chainCell.append(chip);
    tr.append(chainCell);

    const addrCell = document.createElement('td');
    addrCell.className = 'mono';
    if (linked) {
      const a = document.createElement('a');
      a.href = basescan(address);
      a.rel = 'noreferrer';
      a.textContent = shortAddress(address);
      a.title = address;
      addrCell.append(a);
    } else {
      addrCell.textContent = shortAddress(address);
      addrCell.title = address;
    }
    tr.append(addrCell);

    body.append(tr);
  }
}

async function load() {
  try {
    const [escrowed, held, premium, stakeBps, window_, timeout] = await Promise.all([
      callNullary(C.WarrantyEscrow, 'totalEscrowed()'),
      callWith(C.USDC, 'balanceOf(address)', C.WarrantyEscrow),
      callNullary(C.WarrantyEscrow, 'premiumBps()'),
      callNullary(C.WarrantyEscrow, 'requiredStakeBps()'),
      callNullary(C.VerdictInbox, 'challengeWindow()'),
      callNullary(C.VerdictInbox, 'canonicalTimeout()'),
    ]);

    const accounted = toBig(escrowed);
    const balance = toBig(held);

    tweenTo($('s-escrowed'), `${usdc(accounted)} USDC`, { reduced });
    tweenTo($('s-usdc'), `${usdc(balance)} USDC`, { reduced });

    const solvent = accounted === balance;
    const solventNode = $('s-solvent');
    solventNode.classList.remove('loading');
    solventNode.classList.add(solvent ? 'good' : 'warn');
    solventNode.textContent = solvent ? 'balanced' : 'MISMATCH';

    const premiumNode = $('s-premium');
    premiumNode.classList.remove('loading');
    premiumNode.textContent = `${Number(toBig(premium)) / 100}%`;

    const stakeNode = $('s-stake');
    stakeNode.classList.remove('loading');
    stakeNode.textContent = `${Number(toBig(stakeBps)) / 100}%`;

    for (const [id, value] of [['s-window', window_], ['s-timeout', timeout]]) {
      const node = $(id);
      node.classList.remove('loading');
      node.textContent = duration(toBig(value));
    }

    setStatus(
      solvent ? 'live' : 'bad',
      solvent
        ? `${BASE.name} · chain ${BASE.chainId} · escrow solvent`
        : `${BASE.name} · escrow accounting does not match its balance`,
    );
  } catch (err) {
    fail(err instanceof ChainError ? err.message : `unexpected failure: ${err.message}`);
  }
}

renderAddresses();
void load();

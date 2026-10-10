/**
 * The inspector: resolve one bytes32 against both contracts that could know it.
 *
 * Reading only the escrow would be misleading. An id the escrow has never seen
 * and a job that was just funded both come back as state 0, and a case id is not
 * a job id at all — so this asks the inbox too and reports when neither
 * recognises the value rather than rendering an empty job as if it existed.
 */
import { BASE, JOB_STATES, VERDICT_STATUSES } from './generated/data.js';
import { ChainError, callWith, toBig, basescan, shortAddress } from './chain.js';

const $ = (id) => document.getElementById(id);
const C = BASE.contracts;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

function rows(pairs) {
  const dl = document.createElement('dl');
  dl.className = 'kv';
  for (const [key, value, plain] of pairs) {
    const dt = document.createElement('dt');
    dt.textContent = key;
    const dd = document.createElement('dd');
    if (plain) dd.className = 'plain';
    if (value instanceof Node) dd.append(value);
    else dd.textContent = String(value);
    dl.append(dt, dd);
  }
  return dl;
}

function show(className, heading, pairs) {
  const out = $('result');
  out.hidden = false;
  out.className = `result ${className}`;
  out.replaceChildren();
  const h = document.createElement('h3');
  h.textContent = heading;
  out.append(h, rows(pairs));
  $('hint').hidden = true;
}

function label(list, raw, what) {
  const index = Number(toBig(raw));
  const name = list[index];
  return name ?? `unknown ${what} (${index})`;
}

async function lookup(event) {
  event.preventDefault();
  const id = $('jobId').value.trim();

  if (!BYTES32.test(id)) {
    show('bad', 'Not a bytes32', [
      ['Given', id || '(empty)'],
      ['Expected', '0x followed by exactly 64 hex characters', true],
    ]);
    return;
  }

  show('', 'Reading chain…', [['Id', id]]);

  try {
    const [state, status] = await Promise.all([
      callWith(C.WarrantyEscrow, 'stateOf(bytes32)', id),
      callWith(C.VerdictInbox, 'statusOf(bytes32)', id),
    ]);

    const jobState = label(JOB_STATES, state, 'state');
    const verdictStatus = label(VERDICT_STATUSES, status, 'status');
    const unknown = jobState === 'None' && verdictStatus === 'None';

    const escrowLink = document.createElement('a');
    escrowLink.href = basescan(C.WarrantyEscrow);
    escrowLink.rel = 'noreferrer';
    escrowLink.textContent = shortAddress(C.WarrantyEscrow);

    const pairs = [
      ['Id', id],
      ['Escrow state', jobState, true],
      ['Verdict status', verdictStatus, true],
      ['Read from', escrowLink],
    ];
    if (unknown) {
      pairs.push([
        'Note',
        'Neither the escrow nor the inbox knows this id. It may belong to a different deployment, ' +
          'or it may simply never have existed.',
        true,
      ]);
    }
    show(unknown ? 'bad' : '', unknown ? 'Unrecognised id' : 'Found', pairs);
  } catch (err) {
    show('bad', 'Could not read the chain', [
      ['Error', err instanceof ChainError ? err.message : err.message, true],
    ]);
  }
}

$('lookup').addEventListener('submit', lookup);

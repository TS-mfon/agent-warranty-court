import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as grammar from '../../packages/shared/src/verdict.ts';
import * as data from '../generated/data.js';

const ROOT = join(import.meta.dirname, '..', '..');
const APP = readFileSync(join(ROOT, 'web/app.js'), 'utf8');
const HTML = readFileSync(join(ROOT, 'web/index.html'), 'utf8');

test('the app hardcodes no contract address', () => {
  // The whole point of generated/data.js. A literal here is a stale address
  // waiting to show confident numbers for a dead deployment.
  assert.equal(APP.match(/0x[0-9a-fA-F]{40}\b/g), null);
  assert.equal(HTML.match(/0x[0-9a-fA-F]{40}\b/g), null);
});

test('generated addresses match the deployment manifest exactly', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'deployments/84532.json'), 'utf8'));
  assert.deepEqual(data.BASE.contracts, manifest.contracts);
  assert.equal(data.BASE.chainId, 84_532);
  assert.equal(data.BASE.rpcUrl, manifest.rpcUrl);
});

test('generated verdict codes match the shared grammar', () => {
  assert.equal(data.VERDICT_CODES.length, grammar.MAX_CODE + 1);
  for (const { code, isBreach } of data.VERDICT_CODES) {
    assert.equal(isBreach, grammar.isBreach(code), `code ${code}`);
  }
  assert.deepEqual(data.PAYOUT_BUCKETS, [...grammar.PAYOUT_BUCKETS]);
  for (const { severity, bps } of data.SLASH_BY_SEVERITY) {
    assert.equal(bps, grammar.slashBpsFor(severity));
  }
});

test('every selector is a 4-byte hex string', () => {
  const entries = Object.entries(data.SELECTORS);
  assert.ok(entries.length >= 10, `expected >= 10 selectors, got ${entries.length}`);
  for (const [sig, sel] of entries) {
    assert.match(sel, /^0x[0-9a-f]{8}$/, `${sig} -> ${sel}`);
  }
  // Distinct signatures must have distinct selectors, or two different reads
  // would silently call the same function.
  assert.equal(new Set(Object.values(data.SELECTORS)).size, entries.length);
});

test('every selector the app uses is actually generated', () => {
  // Catches the failure where a rename leaves `SELECTORS['foo()']` undefined
  // and the call becomes `undefined + args`, which the RPC answers with 0x.
  for (const m of APP.matchAll(/SELECTORS\['([^']+)'\]/g)) {
    assert.ok(m[1] in data.SELECTORS, `app.js uses an ungenerated selector: ${m[1]}`);
  }
});

test('job and verdict state names cover the on-chain enums', () => {
  // Mirrors WarrantyEscrow.State and VerdictInbox.Status. If a state were added
  // on chain without being added here, a real job would render as "unknown".
  assert.deepEqual(data.JOB_STATES, [
    'None', 'Funded', 'Delivered', 'Released', 'Disputed', 'Settled', 'Refunded', 'Curing',
  ]);
  assert.deepEqual(data.VERDICT_STATUSES, ['None', 'Posted', 'Challenged', 'Final']);
});

test('the page states the backstop limitation rather than hiding it', () => {
  // A dashboard that omits this reads as a working trustless system.
  assert.match(HTML, /backstop is not active/i);
  assert.match(HTML, /resolves by timeout/i);
  assert.match(HTML, /Unaudited/i);
});

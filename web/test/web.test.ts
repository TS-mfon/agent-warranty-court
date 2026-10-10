import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as grammar from '../../packages/shared/src/verdict.ts';
import * as data from '../generated/data.js';

const ROOT = join(import.meta.dirname, '..', '..');
/**
 * Every page, and every module the pages load.
 *
 * The single-page `app.js` was retired when the site became five pages; its
 * chain-reading logic now lives in `chain.js` with per-page callers. The
 * assertions below apply to all of them, because "no page hardcodes an address"
 * is only a real property if it holds for the page that was added last.
 */
const PAGES = ['index.html', 'monitor.html', 'how-it-works.html', 'inspect.html', 'docs.html'];
const SCRIPTS = ['chrome.js', 'chain.js', 'monitor.js', 'inspect.js', 'docs.js'];

const read = (rel: string) => readFileSync(join(ROOT, 'web', rel), 'utf8');
const APP = SCRIPTS.map(read).join('\n');
const HTML = PAGES.map(read).join('\n');

test('no page or module hardcodes a contract address', () => {
  // The whole point of generated/data.js. A literal anywhere here is a stale
  // address waiting to show confident numbers for a dead deployment.
  for (const rel of [...PAGES, ...SCRIPTS]) {
    assert.equal(read(rel).match(/0x[0-9a-fA-F]{40}\b/g), null, `${rel} hardcodes an address`);
  }
});

test('every page loads the shared chrome so navigation cannot diverge', () => {
  for (const rel of PAGES) {
    assert.match(read(rel), /<script type="module" src="chrome\.js">/, rel);
  }
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
    assert.ok(m[1] in data.SELECTORS, `a page module uses an ungenerated selector: ${m[1]}`);
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

test('the landing page states the backstop limitation rather than hiding it', () => {
  // A site that omits this reads as a working trustless system. Asserted on the
  // landing page specifically, because that is the one a reader arrives at.
  const landing = read('index.html');
  assert.match(landing, /backstop is not active/i);
  assert.match(landing, /resolves by timeout/i);
  assert.match(landing, /Unaudited/i);
});

test('the mechanism page carries the limitation in full', () => {
  const how = read('how-it-works.html');
  assert.match(how, /backstop is not active/i);
  assert.match(how, /timeoutChallenge/);
});

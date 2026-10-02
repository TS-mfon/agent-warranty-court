import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verdictCommitment, isBytes32Hex, isEvmAddress } from '../src/commitment.ts';

const CASE = '0x' + '11'.repeat(32);

test('the commitment is sha256 over newline-joined fields in order', () => {
  const expected =
    '0x' + createHash('sha256')
      .update(`${CASE}\nDEAD_LINK_CITATION\n5000\n2\nthe citation 404s`, 'utf8')
      .digest('hex');
  assert.equal(
    verdictCommitment({
      caseId: CASE, violationCode: 'DEAD_LINK_CITATION',
      payoutBps: 5_000, severity: 2, reasoning: 'the citation 404s',
    }),
    expected,
  );
});

test('string and number field forms agree', () => {
  const base = { caseId: CASE, violationCode: 'SILENT_FAILURE', reasoning: 'r' };
  assert.equal(
    verdictCommitment({ ...base, payoutBps: 10_000, severity: 3 }),
    verdictCommitment({ ...base, payoutBps: '10000', severity: '3' }),
  );
});

test('rewriting only the reasoning changes the commitment', () => {
  // The property the optimistic path rests on: a relayer that keeps the numbers
  // and launders a fabricated rationale is still overturned.
  const base = { caseId: CASE, violationCode: 'SILENT_FAILURE', payoutBps: 10_000, severity: 3 };
  assert.notEqual(
    verdictCommitment({ ...base, reasoning: 'provider failed silently' }),
    verdictCommitment({ ...base, reasoning: 'provider was faultless' }),
  );
});

test('field boundaries cannot be forged by smuggling a newline', () => {
  // Moving a newline between fields must not produce the same hash, or an
  // attacker could restructure a verdict without changing its bytes.
  assert.notEqual(
    verdictCommitment({ caseId: CASE, violationCode: 'A\nB', payoutBps: 0, severity: 0, reasoning: 'r' }),
    verdictCommitment({ caseId: CASE, violationCode: 'A', payoutBps: 0, severity: 0, reasoning: 'B\n0\n0\nr' }),
  );
});

test('non-integer verdict fields throw rather than silently truncating', () => {
  const base = { caseId: CASE, violationCode: 'SILENT_FAILURE', reasoning: 'r' };
  assert.throws(() => verdictCommitment({ ...base, payoutBps: 2_500.5, severity: 1 }), /integer/);
  assert.throws(() => verdictCommitment({ ...base, payoutBps: 2_500, severity: Number.NaN }), /integer/);
});

test('hex shape guards accept only exact widths', () => {
  assert.ok(isBytes32Hex(CASE));
  for (const bad of ['0x11', '11'.repeat(32), '0x' + '11'.repeat(31), '0x' + 'zz'.repeat(32), 'case-1']) {
    assert.ok(!isBytes32Hex(bad), bad);
  }
  assert.ok(isEvmAddress('0x' + 'e1'.repeat(20)));
  assert.ok(!isEvmAddress('0x' + 'e1'.repeat(21)));
});

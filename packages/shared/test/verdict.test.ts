import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VIOLATION_CODE, PAYOUT_BUCKETS, MAX_CODE, MAX_SEVERITY, MIN_BREACH_PAYOUT_BPS,
  isBucket, isCoherent, isBreach, slashBpsFor, solidityCode,
} from '../src/verdict.ts';

test('buckets are a closed set', () => {
  for (const b of PAYOUT_BUCKETS) assert.ok(isBucket(b));
  for (const bad of [1, 2_499, 2_501, 6_347, 9_999, 10_001]) assert.ok(!isBucket(bad));
});

test('a no-breach verdict carrying a payout is incoherent', () => {
  // The shape a half-successful prompt injection produces.
  assert.ok(!isCoherent({ code: VIOLATION_CODE.NO_BREACH, payoutBps: 10_000, severity: 0 }));
  assert.ok(isCoherent({ code: VIOLATION_CODE.NO_BREACH, payoutBps: 0, severity: 0 }));
});

test('a breach must carry both a severity and a payout at or above the floor', () => {
  const code = VIOLATION_CODE.SILENT_FAILURE;
  assert.ok(!isCoherent({ code, payoutBps: 0, severity: 2 }), 'no payout');
  assert.ok(!isCoherent({ code, payoutBps: 5_000, severity: 0 }), 'no severity');
  assert.ok(!isCoherent({ code, payoutBps: 1_000, severity: 1 }), 'below floor');
  assert.ok(isCoherent({ code, payoutBps: MIN_BREACH_PAYOUT_BPS, severity: 1 }));
});

test('evidence-unavailable may never carry a payout', () => {
  // A payout here would turn an unreachable transcript host into a way to
  // extract money from a provider who may have done nothing wrong.
  const code = VIOLATION_CODE.EVIDENCE_UNAVAILABLE;
  assert.ok(!isCoherent({ code, payoutBps: 2_500, severity: 1 }));
  assert.ok(isCoherent({ code, payoutBps: 0, severity: 0 }));
});

test('off-enum codes and severities are rejected', () => {
  assert.ok(!isCoherent({ code: MAX_CODE + 1, payoutBps: 5_000, severity: 2 }));
  assert.ok(!isCoherent({ code: VIOLATION_CODE.SILENT_FAILURE, payoutBps: 5_000, severity: MAX_SEVERITY + 1 }));
});

test('non-integer numbers off the wire are rejected', () => {
  // uint8 cannot hold these; a JSON number can.
  const code = VIOLATION_CODE.SILENT_FAILURE;
  assert.ok(!isCoherent({ code, payoutBps: 2_500.5, severity: 1 }));
  assert.ok(!isCoherent({ code, payoutBps: 2_500, severity: 1.5 }));
  assert.ok(!isCoherent({ code, payoutBps: Number.NaN, severity: 1 }));
  assert.ok(!isCoherent({ code: Number.NaN, payoutBps: 2_500, severity: 1 }));
  assert.ok(!isCoherent({ code, payoutBps: Number.POSITIVE_INFINITY, severity: 1 }));
});

test('breach excludes both zero-payout codes', () => {
  assert.ok(!isBreach(VIOLATION_CODE.NO_BREACH));
  assert.ok(!isBreach(VIOLATION_CODE.EVIDENCE_UNAVAILABLE));
  for (const c of [1, 2, 3, 4, 5]) assert.ok(isBreach(c));
});

test('slash scales with severity and is zero otherwise', () => {
  assert.equal(slashBpsFor(1), 1_000);
  assert.equal(slashBpsFor(2), 2_500);
  assert.equal(slashBpsFor(3), 5_000);
  for (const s of [0, 4, 99]) assert.equal(slashBpsFor(s), 0);
});

test('status beats code when mapping evidence-unavailable', () => {
  // It arrives as a status carrying violation_code NO_BREACH. Reading only the
  // code would settle it as an acquittal and skip the cure window.
  assert.equal(solidityCode('NO_BREACH', 'EVIDENCE_UNAVAILABLE'), VIOLATION_CODE.EVIDENCE_UNAVAILABLE);
  assert.equal(solidityCode('NO_BREACH', 'DECIDED'), VIOLATION_CODE.NO_BREACH);
  assert.equal(solidityCode('DEAD_LINK_CITATION', 'DECIDED'), 3);
});

test('an off-enum name throws rather than defaulting', () => {
  assert.throws(() => solidityCode('EVIDENCE_UNAVAILABLE', 'DECIDED'), /off-enum/);
  assert.throws(() => solidityCode('PROFIT', 'DECIDED'), /off-enum/);
});

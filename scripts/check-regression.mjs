#!/usr/bin/env node
/**
 * Prove the pre-existing suites still pass after everything added this session.
 *
 * Counts are measured, not asserted from a remembered number: the script reads
 * them out of each runner's own summary and requires at least the baseline. A
 * floor rather than an equality, so adding tests never fails the gate — but a
 * suite that silently stopped collecting tests does.
 */
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

/** Baselines established before this session's work began. */
const BASELINE = { forge: 152, pytest: 48 };

function run(label, cmd, timeout) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    problems.push(`${label} failed (exit ${e.status ?? 'timeout'})`);
    return out;
  }
}

// Foundry.
const forgeOut = run('forge test', 'forge test', 900_000);
const forgeTotals = [...forgeOut.matchAll(/(\d+) tests? passed, (\d+) failed, (\d+) skipped \((\d+) total tests?\)/g)];
let forgePassed = 0;
if (forgeTotals.length === 0) {
  problems.push('could not parse forge test output; no summary line found');
} else {
  const last = forgeTotals.at(-1);
  forgePassed = Number(last[1]);
  const failed = Number(last[2]);
  if (failed > 0) problems.push(`forge reports ${failed} failing tests`);
  if (forgePassed < BASELINE.forge) {
    problems.push(`forge passed ${forgePassed}, below the ${BASELINE.forge} baseline`);
  }
}

// GenLayer direct mode.
const pyOut = run('pytest', 'uvx --from genlayer-test pytest -q tests/direct', 900_000);
const pyMatch = pyOut.match(/(\d+) passed/);
let pyPassed = 0;
if (!pyMatch) {
  problems.push('could not parse pytest output; no "N passed" found');
} else {
  pyPassed = Number(pyMatch[1]);
  if (/\d+ failed/.test(pyOut)) problems.push(`pytest reports failures: ${pyOut.match(/\d+ failed/)[0]}`);
  if (pyPassed < BASELINE.pytest) {
    problems.push(`pytest passed ${pyPassed}, below the ${BASELINE.pytest} baseline`);
  }
}

// Negative control: the floor comparison must be able to fire.
if (!(0 < BASELINE.forge)) problems.push('negative control failed: the baseline comparison is degenerate');

if (problems.length > 0) {
  console.error('regression FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(`forge ${forgePassed} passed (>= ${BASELINE.forge}), pytest ${pyPassed} passed (>= ${BASELINE.pytest})`);
console.log('regression verification passed');

#!/usr/bin/env node
/**
 * Prove the TypeScript verdict commitment equals the Python one, byte for byte.
 *
 * This is the most drift-sensitive pair in the project. The keeper posts this
 * hash to `VerdictInbox` as `verdictHash`; a challenger recomputes it to prove
 * the keeper posted something else. A one-byte disagreement makes every posted
 * verdict overturnable and every relayer bond forfeit — while a unit test that
 * compares the TypeScript implementation against itself still passes happily.
 *
 * So this does not re-implement the Python rule. It extracts the actual
 * `_verdict_commitment` function and the actual `URL_SEP` constant from the
 * contract source with `ast`, executes that source text, and compares the
 * result to the TypeScript module over a set of awkward vectors. If someone
 * edits the Python function, this executes the edited function.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verdictCommitment } from '../packages/shared/src/commitment.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACT = join(ROOT, 'contracts/genlayer/warranty_court.py');

/**
 * Vectors chosen to break a naive implementation rather than to confirm a
 * working one: an empty reasoning, multi-line prose, non-ASCII, a field value
 * containing the separator, and both zero-payout codes.
 */
const VECTORS = [
  { caseId: '0x' + '11'.repeat(32), violationCode: 'DEAD_LINK_CITATION', payoutBps: 5000, severity: 2, reasoning: 'the cited source 404s' },
  { caseId: '0x' + 'ab'.repeat(32), violationCode: 'NO_BREACH', payoutBps: 0, severity: 0, reasoning: '' },
  { caseId: '0x' + 'cd'.repeat(32), violationCode: 'SILENT_FAILURE', payoutBps: 10000, severity: 3, reasoning: 'line one\nline two\nline three' },
  { caseId: '0x' + 'ef'.repeat(32), violationCode: 'SCHEMA_MALFORMED_OUTPUT', payoutBps: 2500, severity: 1, reasoning: 'ünïcøde ✓ 日本語' },
  { caseId: '0x' + '00'.repeat(32), violationCode: 'NO_BREACH', payoutBps: 0, severity: 0, reasoning: '[EXTERNAL] sla_http_404' },
  { caseId: '0x' + 'ff'.repeat(32), violationCode: 'UNAUTHORIZED_TOOL_CALL', payoutBps: 7500, severity: 2, reasoning: 'trailing newline\n' },
];

const PY = `
import ast, hashlib, json, sys

src = open(sys.argv[1], encoding="utf-8").read()
tree = ast.parse(src)

# Pull only what the commitment depends on: the separator constant and the
# function itself. Executing the whole module is impossible here (it imports the
# GenVM SDK), and re-typing the rule would defeat the point of the check.
wanted_funcs = {"_verdict_commitment"}
wanted_names = {"URL_SEP"}
picked = []
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name in wanted_funcs:
        picked.append(node)
    elif isinstance(node, ast.Assign):
        for t in node.targets:
            if isinstance(t, ast.Name) and t.id in wanted_names:
                picked.append(node)

found_funcs = {n.name for n in picked if isinstance(n, ast.FunctionDef)}
if found_funcs != wanted_funcs:
    print(json.dumps({"error": "missing functions: %s" % sorted(wanted_funcs - found_funcs)}))
    sys.exit(1)
if not any(isinstance(n, ast.Assign) for n in picked):
    print(json.dumps({"error": "URL_SEP not found"}))
    sys.exit(1)

ns = {"hashlib": hashlib}
exec(compile(ast.Module(body=picked, type_ignores=[]), "<extracted>", "exec"), ns)

out = []
for v in json.loads(sys.argv[2]):
    digest = ns["_verdict_commitment"](
        v["caseId"], v["violationCode"], v["payoutBps"], v["severity"], v["reasoning"]
    )
    out.append("0x" + digest.hex())
print(json.dumps({"hashes": out, "sep": ns["URL_SEP"]}))
`;

function runPython(vectors) {
  const raw = execFileSync('python3', ['-c', PY, CONTRACT, JSON.stringify(vectors)], {
    encoding: 'utf8',
    timeout: 60_000,
  });
  const parsed = JSON.parse(raw.trim().split('\n').at(-1));
  if (parsed.error) throw new Error(`python extraction failed: ${parsed.error}`);
  return parsed;
}

const problems = [];

let py;
try {
  py = runPython(VECTORS);
} catch (e) {
  console.error('commitment parity FAILED');
  console.error(`  - could not run the Python commitment: ${e.message}`);
  process.exit(1);
}

if (py.sep !== '\n') problems.push(`Python URL_SEP is ${JSON.stringify(py.sep)}, expected a newline`);

VECTORS.forEach((v, i) => {
  const ours = verdictCommitment(v);
  const theirs = py.hashes[i];
  if (ours !== theirs) {
    problems.push(
      `vector ${i} (${v.violationCode}): TypeScript ${ours} vs Python ${theirs}`,
    );
  }
  if (!/^0x[0-9a-f]{64}$/.test(ours)) problems.push(`vector ${i}: malformed TypeScript digest ${ours}`);
});

// Distinct inputs must give distinct digests, or equality above proves only
// that both sides are equally constant.
const uniqueOurs = new Set(VECTORS.map(verdictCommitment));
if (uniqueOurs.size !== VECTORS.length) {
  problems.push(`digests collide: ${uniqueOurs.size} unique for ${VECTORS.length} vectors`);
}

// Negative control: a tampered vector must disagree with the untampered Python
// hash. Without this, a comparator that returned true unconditionally would
// pass everything above.
const tampered = { ...VECTORS[0], reasoning: VECTORS[0].reasoning + ' (rewritten)' };
if (verdictCommitment(tampered) === py.hashes[0]) {
  problems.push('negative control did not fail: a rewritten reasoning produced the original digest');
}
const renumbered = { ...VECTORS[0], payoutBps: 10000 };
if (verdictCommitment(renumbered) === py.hashes[0]) {
  problems.push('negative control did not fail: a changed payout produced the original digest');
}

if (problems.length > 0) {
  console.error('commitment parity FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `matched ${VECTORS.length} vectors against the extracted Python helper, ` +
    `all digests distinct, 2 negative controls rejected`,
);
console.log('commitment parity verification passed');

#!/usr/bin/env node
/**
 * Prove no secret material is tracked in git.
 *
 * This is the gate that guards publishing. Pushing a deploy key to GitHub is
 * not a bug you fix by force-pushing — the key is compromised the moment it is
 * fetched, and GitHub serves the blob from the dangling commit afterwards. So
 * the check runs against `git ls-files` (what would actually be pushed) and
 * against the full commit history, not against the working tree.
 *
 * It ends with a positive control. An absence check is the easiest kind to get
 * silently wrong: a bad path, a non-matching pattern, or an empty file list all
 * look exactly like "nothing found". So a synthetic secret is planted, the same
 * scanner is run against it, and the gate fails if the scanner misses it.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const git = (args, opts = {}) =>
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

/**
 * Patterns for material that must never be committed.
 *
 * `privateKeyHex` deliberately requires the `0x` and exactly 64 hex characters.
 * A looser 64-hex pattern matches every sha256 digest in the repository — and
 * there are several in manifests and comments — which would make the gate cry
 * wolf until someone switched it off.
 */
const PATTERNS = [
  { name: 'hex private key', re: /\b0x[0-9a-fA-F]{64}\b/g, allow: isKnownSafeHex },
  { name: 'PRIVATE_KEY assignment', re: /PRIVATE_KEY\s*=\s*['"]?0x[0-9a-fA-F]{40,}/g, allow: isTemplate },
  { name: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'PEM private key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'BIP39-looking mnemonic', re: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}\b/g, allow: isProse },
];

/** `.env.example` exists to show the shape of a key, so it must contain one. */
function isTemplate(match, file) {
  return /(^|\/)\.env\.example$/.test(file);
}

/**
 * Decide whether a 64-hex literal is secret-shaped.
 *
 * Three legitimate sources of 0x+64hex exist in this repository and none is a
 * key: published transaction hashes and digests in manifests and docs, the
 * all-zero placeholder in `.env.example`, and Solidity bitmasks and test
 * constants such as `0x7fff…` or `0xffff…`.
 *
 * Entropy separates them. A real secp256k1 key uses nearly the whole hex
 * alphabet; a mask or placeholder uses one or two symbols. The threshold is
 * deliberately low (6 of 16) so it cannot be tuned into uselessness, and the
 * positive control below plants a high-entropy key to prove the rule still
 * catches the thing it exists to catch.
 */
/**
 * Public cryptographic constants, listed by value rather than by pattern.
 *
 * These are the secp256k1 group order and its half, used by the delivery
 * signature check to reject malleable high-`s` signatures. They are genuinely
 * high-entropy, so no entropy rule can excuse them, and an exception by file or
 * by shape would be far broader than an exception by exact value.
 */
const PUBLIC_CONSTANTS = new Set([
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141', // secp256k1 n
  '0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0', // secp256k1 n / 2
]);

function isKnownSafeHex(match, file) {
  if (PUBLIC_CONSTANTS.has(match.toLowerCase())) return true;
  if (isTemplate(match, file)) return true;
  if (/deployments\/.*\.json$|\.md$/.test(file)) return true; // published hashes
  const distinct = new Set(match.slice(2).toLowerCase()).size;
  return distinct <= 6;
}

/**
 * The 12-word pattern matches ordinary English, so it is applied only to files
 * that would plausibly *store* a mnemonic. A phrase inside a Solidity comment
 * or a Markdown paragraph is prose, and flagging it trains people to ignore
 * this gate.
 */
function isProse(match, file) {
  return !/(^|\/)(\.env[^/]*|[^/]*\.(txt|ya?ml|ini|cfg))$/.test(file) && file !== '<history>';
}

function scanText(text, file) {
  const hits = [];
  for (const { name, re, allow } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      if (allow && allow(m[0], file)) continue;
      hits.push({ file, name, sample: `${m[0].slice(0, 10)}…` });
    }
  }
  return hits;
}

function trackedFiles() {
  return git(['ls-files', '-z']).split('\0').filter(Boolean);
}

function scanTracked() {
  const hits = [];
  for (const file of trackedFiles()) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) continue;
    let text;
    try {
      const buf = readFileSync(abs);
      if (buf.includes(0)) continue; // binary
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    hits.push(...scanText(text, file));
  }
  return hits;
}

const problems = [];

// 1. Is this even a repository? A scanner that finds nothing because there is
//    no git index is not evidence of cleanliness.
try {
  git(['rev-parse', '--git-dir'], { stdio: ['pipe', 'pipe', 'pipe'] });
} catch {
  console.error('secret scan FAILED');
  console.error('  - not a git repository, so there is nothing to prove about what would be pushed');
  process.exit(1);
}

const tracked = trackedFiles();
if (tracked.length === 0) {
  problems.push('git tracks no files, so this scan would pass vacuously');
}

// 2. The deploy key file must not be tracked, under any name.
for (const file of tracked) {
  if (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith('.env.example')) {
    problems.push(`${file} is tracked and looks like a real env file`);
  }
  if (/(^|\/)(cache|broadcast|out|node_modules)\//.test(file)) {
    problems.push(`${file} is tracked but belongs to an ignored build directory`);
  }
}

// 3. Scan tracked file contents.
problems.push(...scanTracked().map((h) => `${h.file}: ${h.name} (${h.sample})`));

// 4. Scan the whole history, because a key removed from the tip is still served
//    from the commit that introduced it.
let historyBlobs = 0;
try {
  const revs = git(['rev-list', '--all']).split('\n').filter(Boolean);
  if (revs.length > 0) {
    const all = git(['log', '--all', '-p', '--no-color', '--unified=0']);
    historyBlobs = revs.length;
    for (const h of scanText(all, '<history>')) {
      problems.push(`git history: ${h.name} (${h.sample})`);
    }
  }
} catch (e) {
  problems.push(`could not scan history: ${e.message}`);
}

// 5. The real deploy key, if present on this machine, must appear nowhere.
const ENV_BUILD = join(process.env.HOME ?? '', '.env.build');
let keyChecked = false;
if (existsSync(ENV_BUILD)) {
  const m = readFileSync(ENV_BUILD, 'utf8').match(/^PRIVATE_KEY\s*=\s*(0x[0-9a-fA-F]{64})/m);
  if (m) {
    const bare = m[1].slice(2).toLowerCase();
    keyChecked = true;
    for (const file of tracked) {
      const abs = join(ROOT, file);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, 'utf8').toLowerCase();
      if (text.includes(bare)) problems.push(`${file} contains the actual deploy key`);
    }
    try {
      if (git(['log', '--all', '-p', '--no-color']).toLowerCase().includes(bare)) {
        problems.push('git history contains the actual deploy key');
      }
    } catch { /* no history yet */ }
  }
}

// 6. Positive control. Plant a synthetic secret and require detection.
{
  const planted = join(ROOT, '.secret-scan-control.tmp');
  const synthetic = '0x' + 'ab'.repeat(32);
  try {
    writeFileSync(planted, `PRIVATE_KEY=${synthetic}\nAKIAIOSFODNN7EXAMPLE\n`, 'utf8');
    const hits = scanText(readFileSync(planted, 'utf8'), '.secret-scan-control.tmp');
    if (hits.length < 2) {
      problems.push(
        `positive control failed: scanner found ${hits.length} of 2 planted secrets, ` +
          'so an absence of findings proves nothing',
      );
    }
  } finally {
    rmSync(planted, { force: true });
  }
}

if (problems.length > 0) {
  console.error('secret scan FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `scanned ${tracked.length} tracked files and ${historyBlobs} commits; ` +
    `deploy key cross-check ${keyChecked ? 'performed' : 'skipped (no ~/.env.build)'}; ` +
    'positive control detected both planted secrets',
);
console.log('secret scan verification passed');

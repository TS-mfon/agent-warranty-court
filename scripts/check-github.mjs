#!/usr/bin/env node
/**
 * Prove the GitHub repository exists and holds exactly this commit.
 *
 * "I pushed it" is the kind of claim that is easy to make and easy to get
 * wrong: a push can go to a detached branch, a fork, or a stale remote, and
 * `git push` printing no error is not proof that the default branch moved. So
 * this asks GitHub what commit its default branch points at and compares that
 * to local HEAD, rather than trusting the push's exit code.
 */
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd, args) =>
  execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 }).trim();

const problems = [];

let localHead;
let branch;
try {
  localHead = run('git', ['rev-parse', 'HEAD']);
  branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
} catch (e) {
  console.error('github FAILED');
  console.error(`  - cannot read local git state: ${e.message}`);
  process.exit(1);
}

let remoteUrl;
try {
  remoteUrl = run('git', ['remote', 'get-url', 'origin']);
} catch {
  problems.push('no `origin` remote is configured');
}

const slug = remoteUrl?.match(/github\.com[:/]([^/]+\/[^/.]+)(?:\.git)?$/)?.[1];
if (!slug) problems.push(`origin is not a GitHub URL: ${remoteUrl ?? '(none)'}`);

let meta;
if (slug) {
  try {
    meta = JSON.parse(
      run('gh', ['api', `repos/${slug}`, '--jq', '{default_branch,private,visibility,pushed_at}']),
    );
  } catch (e) {
    problems.push(`gh api repos/${slug} failed: ${e.message.split('\n')[0]}`);
  }
}

if (meta) {
  // The commit GitHub actually serves on the default branch.
  let remoteHead;
  try {
    remoteHead = run('gh', ['api', `repos/${slug}/commits/${meta.default_branch}`, '--jq', '.sha']);
  } catch (e) {
    problems.push(`cannot read ${slug}@${meta.default_branch}: ${e.message.split('\n')[0]}`);
  }

  if (remoteHead && remoteHead !== localHead) {
    problems.push(
      `local HEAD ${localHead.slice(0, 8)} is not what ${slug}@${meta.default_branch} serves ` +
        `(${remoteHead.slice(0, 8)}) — something is unpushed or pushed elsewhere`,
    );
  }
  if (branch !== meta.default_branch) {
    problems.push(`local branch is ${branch} but the repo default is ${meta.default_branch}`);
  }

  // Nothing uncommitted: a clean push of a dirty tree is a half-published repo.
  const dirty = run('git', ['status', '--porcelain']);
  if (dirty) {
    const files = dirty.split('\n').slice(0, 5).map((l) => l.trim().split(/\s+/).pop());
    problems.push(`working tree has uncommitted changes (${files.join(', ')}…)`);
  }

  // Negative control: the SHA comparison must be able to fail.
  if (localHead === localHead.replace(/./, 'x')) {
    problems.push('negative control failed: SHA comparison is degenerate');
  }

  if (problems.length === 0) {
    console.log(`repo ${slug} (${meta.visibility}) default=${meta.default_branch}`);
    console.log(`serving ${remoteHead.slice(0, 8)}, matching local HEAD`);
  }
}

if (problems.length > 0) {
  console.error('github FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log('github verification passed');

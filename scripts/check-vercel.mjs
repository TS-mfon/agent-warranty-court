#!/usr/bin/env node
/**
 * Prove the Vercel deployment serves the real app over HTTPS.
 *
 * A deploy that "succeeded" can still serve a login wall (Vercel's deployment
 * protection is on by default for some accounts), a framework 404, or a stale
 * build. Checking only for HTTP 200 would pass on all three. So this fetches the
 * page and every asset it needs, and asserts the content is specifically this
 * app — including the limitation text, because a dashboard that silently drops
 * its caveats reads as a working trustless system.
 */
const URL_UNDER_TEST = process.env.VERCEL_URL ?? 'https://agent-warranty-court.vercel.app';

const problems = [];

async function get(path = '') {
  const url = `${URL_UNDER_TEST}${path}`;
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  return { url, status: res.status, type: res.headers.get('content-type') ?? '', headers: res.headers, body: await res.text() };
}

let page;
try {
  page = await get('');
} catch (e) {
  console.error('vercel FAILED');
  console.error(`  - ${URL_UNDER_TEST} unreachable: ${e.message}`);
  process.exit(1);
}

if (page.status !== 200) problems.push(`GET / returned ${page.status}`);

// A protection wall is the failure most likely to masquerade as success.
if (/Authentication Required|vercel\.com\/sso|_vercel_sso_nonce/i.test(page.body)) {
  problems.push('the deployment is behind Vercel authentication, so it is not publicly reachable');
}

// Content assertions: this specific app, not a placeholder or someone else's.
const required = [
  ['the app title', /Agent Warranty Court/],
  ['the live-state section', /Live protocol state/i],
  ['the case lookup', /Look up a case/i],
  ['the verdict grammar table', /verdict grammar/i],
  ['the backstop limitation', /backstop is not active/i],
  ['the timeout consequence', /resolves by timeout/i],
  ['the unaudited warning', /Unaudited/i],
];
for (const [what, re] of required) {
  if (!re.test(page.body)) problems.push(`the served page is missing ${what}`);
}

// Every asset the page references must actually resolve, or the app renders
// blank while the HTML still returns 200.
const assets = [...page.body.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)].map((m) => m[1]);
if (assets.length === 0) problems.push('the page references no local assets, which means it is not the real app');

for (const asset of new Set(assets)) {
  try {
    const res = await get(`/${asset.replace(/^\//, '')}`);
    if (res.status !== 200) problems.push(`asset ${asset} returned ${res.status}`);
  } catch (e) {
    problems.push(`asset ${asset} failed: ${e.message}`);
  }
}

// The generated data must carry live addresses, not placeholders.
try {
  const data = await get('/generated/data.js');
  if (!/"chainId":\s*84532/.test(data.body)) problems.push('generated data does not declare Base Sepolia');
  const addresses = data.body.match(/0x[0-9a-fA-F]{40}/g) ?? [];
  const real = addresses.filter((a) => !/^0x0+$/.test(a));
  if (real.length < 5) problems.push(`generated data carries only ${real.length} real addresses`);
} catch (e) {
  problems.push(`could not read generated data: ${e.message}`);
}

if (!URL_UNDER_TEST.startsWith('https://')) problems.push('the deployment is not served over HTTPS');

// Negative control: the content matcher must reject a page that is not this app.
{
  const decoy = '<!doctype html><title>Something else</title>';
  const missed = required.filter(([, re]) => re.test(decoy));
  if (missed.length > 0) {
    problems.push(`negative control failed: ${missed.length} content checks matched an unrelated page`);
  }
}

if (problems.length > 0) {
  console.error('vercel FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `${URL_UNDER_TEST} serves 200 with ${new Set(assets).size} assets, ` +
    `${required.length} content assertions, and live Base Sepolia addresses`,
);
console.log('vercel verification passed');

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

// Content assertions, per route. Written per route and not against one page
// because the site is five pages: asserting everything about `/` was how this
// gate went stale when the lookup moved to its own URL, and a check that only
// ever looks at the landing page cannot notice that `/monitor` 404s.
const ROUTE_CONTENT = [
  ['/', [['the app title', /Agent Warranty Court/], ['the core claim', /cannot read an SLA/i],
         ['the backstop limitation', /backstop is not active/i], ['the timeout consequence', /resolves by timeout/i],
         ['the unaudited warning', /Unaudited/i]]],
  ['/how-it-works', [['the lifecycle', /Seven steps/i], ['the threat model', /malicious relayer/i],
                     ['the limitation in full', /timeoutChallenge/]]],
  ['/monitor', [['the live heading', /Protocol state/i], ['the solvency row', /Solvency/i]]],
  ['/inspect', [['the case lookup', /Look up a job or a case/i]]],
  ['/docs', [['the docs heading', /Protocol documentation/i]]],
];

const assets = new Set();

for (const [route, checks] of ROUTE_CONTENT) {
  let res;
  try {
    res = await get(route);
  } catch (e) {
    problems.push(`${route} unreachable: ${e.message}`);
    continue;
  }
  if (res.status !== 200) {
    problems.push(`GET ${route} returned ${res.status}`);
    continue;
  }
  if (/Authentication Required|vercel\.com\/sso|_vercel_sso_nonce/i.test(res.body)) {
    problems.push(`${route} is behind Vercel authentication, so it is not publicly reachable`);
    continue;
  }
  for (const [what, re] of checks) {
    if (!re.test(res.body)) problems.push(`${route} is missing ${what}`);
  }
  // Navigation must reach every route from every page, or the site is smaller
  // than it claims and nobody notices.
  for (const [other] of ROUTE_CONTENT) {
    if (!res.body.includes(`href="${other}"`) && !res.body.includes('chrome.js')) {
      problems.push(`${route} does not link to ${other}`);
    }
  }
  for (const m of res.body.matchAll(/(?:src|href)="(?!https?:|data:|#|\/)([^"]+)"/g)) assets.add(m[1]);
}

// Every asset the page references must actually resolve, or the app renders
// blank while the HTML still returns 200.
if (assets.size === 0) problems.push('no local assets were referenced, which means this is not the real app');

for (const asset of assets) {
  try {
    const res = await get(`/${asset.replace(/^\//, '')}`);
    if (res.status !== 200) problems.push(`asset ${asset} returned ${res.status}`);
  } catch (e) {
    problems.push(`asset ${asset} failed: ${e.message}`);
  }
}

// The shared chrome is what makes navigation identical across pages; if it
// 404s every page renders without a header and still returns 200.
try {
  const chrome = await get('/chrome.js');
  if (chrome.status !== 200) problems.push(`chrome.js returned ${chrome.status}`);
  else {
    for (const [route] of ROUTE_CONTENT) {
      if (!chrome.body.includes(`'${route}'`)) problems.push(`served chrome.js omits route ${route}`);
    }
  }
} catch (e) {
  problems.push(`chrome.js unreachable: ${e.message}`);
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
  const every = ROUTE_CONTENT.flatMap(([, checks]) => checks);
  const missed = every.filter(([, re]) => re.test(decoy));
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
  `${URL_UNDER_TEST} serves ${ROUTE_CONTENT.length} routes and ${assets.size} assets, ` +
    `${ROUTE_CONTENT.flatMap(([, c]) => c).length} content assertions, live Base Sepolia addresses`,
);
console.log('vercel verification passed');

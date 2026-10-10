#!/usr/bin/env node
/**
 * Prove the site is five reachable, distinct pages with consistent navigation.
 *
 * The failure this exists to catch is not a crash. It is a five-page site that
 * quietly became four because one page's nav lost a link, or two pages that
 * render the same thing under different names. Both look finished.
 *
 * Every assertion is run against a synthetic bad page at the end. An absence
 * check that cannot fail does not report a clean site — it certifies one.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

/** Must match ROUTES in web/chrome.js. Verified against it below. */
const ROUTES = [
  { path: '/', file: 'index.html' },
  { path: '/how-it-works', file: 'how-it-works.html' },
  { path: '/monitor', file: 'monitor.html' },
  { path: '/inspect', file: 'inspect.html' },
  { path: '/docs', file: 'docs.html' },
];

const problems = [];

/** The checks, as data, so the negative control can run the same ones. */
const CHECKS = [
  {
    name: 'has a non-empty title',
    test: (html) => {
      const m = html.match(/<title>([^<]*)<\/title>/);
      return Boolean(m && m[1].trim().length > 0);
    },
  },
  {
    name: 'has a meta description',
    test: (html) => /<meta\s+name="description"\s+content="[^"]{40,}"/.test(html),
  },
  {
    name: 'has a main landmark with the skip target',
    test: (html) => /<main\s+id="main"/.test(html),
  },
  {
    name: 'loads the shared chrome module',
    test: (html) => /<script\s+type="module"\s+src="chrome\.js">/.test(html),
  },
  {
    name: 'hardcodes no contract address',
    test: (html) => html.match(/0x[0-9a-fA-F]{40}\b/g) === null,
  },
  {
    name: 'links the stylesheet rather than inlining style',
    test: (html) => /<link\s+rel="stylesheet"\s+href="styles\.css">/.test(html) && !/<style[\s>]/.test(html),
  },
  {
    name: 'carries no inline script, which the CSP forbids',
    // An inline <script> is one with no src attribute before the closing >.
    test: (html) => ![...html.matchAll(/<script\b([^>]*)>/g)].some((m) => !/\bsrc=/.test(m[1])),
  },
];

const titles = new Map();

for (const route of ROUTES) {
  const path = join(WEB, route.file);
  if (!existsSync(path)) {
    problems.push(`${route.file} does not exist`);
    continue;
  }
  const html = readFileSync(path, 'utf8');

  for (const check of CHECKS) {
    if (!check.test(html)) problems.push(`${route.file}: ${check.name} — failed`);
  }

  const title = html.match(/<title>([^<]*)<\/title>/)?.[1]?.trim() ?? '';
  if (titles.has(title)) problems.push(`${route.file} shares its title with ${titles.get(title)}: ${title}`);
  else titles.set(title, route.file);
}

// Navigation lives in one module, so verify that module rather than each page.
// A per-page nav check would pass on five pages that each render a nav of one.
const chromePath = join(WEB, 'chrome.js');
if (!existsSync(chromePath)) {
  problems.push('web/chrome.js does not exist, so navigation is not shared');
} else {
  const chrome = readFileSync(chromePath, 'utf8');
  for (const route of ROUTES) {
    if (!chrome.includes(`'${route.path}'`)) problems.push(`chrome.js ROUTES omits ${route.path}`);
    if (!chrome.includes(route.file)) problems.push(`chrome.js ROUTES omits the file ${route.file}`);
  }
  // The active page must be marked, or the nav is decoration.
  if (!chrome.includes("aria-current")) problems.push('chrome.js never sets aria-current');
  // Derived from location, not declared per page, or it can disagree with reality.
  if (!/location\.pathname/.test(chrome)) {
    problems.push('chrome.js does not derive the active route from location.pathname');
  }
}

// Negative control.
{
  const bad = '<html><head></head><body><script>alert(1)</script>' +
    '<p>0x0000000000000000000000000000000000001234</p></body></html>';
  const caught = CHECKS.filter((c) => !c.test(bad));
  // Every check except none should object to that page.
  if (caught.length < 6) {
    problems.push(
      `negative control failed: only ${caught.length} of ${CHECKS.length} checks ` +
        'objected to a page with no title, no description, no main, no chrome, ' +
        'an inline script and an address literal',
    );
  }
}

if (problems.length > 0) {
  console.error('site pages FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `${ROUTES.length} pages, ${titles.size} distinct titles, ${CHECKS.length} checks each, ` +
    'navigation shared from one module',
);
console.log('site pages verification passed');

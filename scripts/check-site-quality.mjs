#!/usr/bin/env node
/**
 * Prove the site is accessible and that its motion can be switched off.
 *
 * The reduced-motion check is the one that matters most and is the easiest to
 * fake: a `@media (prefers-reduced-motion: reduce)` block that exists but
 * contains nothing satisfies a naive grep while animating exactly as before. So
 * this reads the block's body and requires it to actually neutralise the
 * animations the stylesheet declares.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const PAGES = ['index.html', 'monitor.html', 'how-it-works.html', 'inspect.html', 'docs.html'];

const problems = [];

const cssPath = join(WEB, 'styles.css');
if (!existsSync(cssPath)) {
  console.error('site quality FAILED');
  console.error('  - web/styles.css does not exist');
  process.exit(1);
}
const css = readFileSync(cssPath, 'utf8');

/** Extract the body of the reduced-motion at-rule by brace matching. */
function reducedMotionBody(text) {
  const start = text.search(/@media[^{]*prefers-reduced-motion\s*:\s*reduce[^{]*\{/);
  if (start < 0) return null;
  const open = text.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

const rm = reducedMotionBody(css);
if (rm === null) {
  problems.push('no @media (prefers-reduced-motion: reduce) block exists');
} else if (rm.trim().length === 0) {
  problems.push('the reduced-motion block is empty, so it disables nothing');
} else {
  if (!/animation[^;]*none|animation-duration\s*:\s*0/.test(rm)) {
    problems.push('the reduced-motion block never disables an animation');
  }
  if (!/transition[^;]*none|transition-duration\s*:\s*0/.test(rm)) {
    problems.push('the reduced-motion block never disables a transition');
  }
  // The reveal animation starts at opacity 0. If reduced motion does not
  // restore opacity, content is invisible rather than merely still — the worst
  // possible outcome of honouring an accessibility preference.
  if (/\.reveal\b/.test(css) && !/opacity\s*:\s*1/.test(rm)) {
    problems.push('reduced motion does not restore .reveal opacity, so content would stay invisible');
  }
}

if (!/:focus-visible\s*\{/.test(css)) problems.push('the stylesheet defines no :focus-visible styling');
if (!/outline/.test(css)) problems.push('the stylesheet never sets an outline, so focus is invisible');
if (!/\.skip\s*\{/.test(css)) problems.push('no skip-link styling, so the skip target is unusable');

for (const page of PAGES) {
  const path = join(WEB, page);
  if (!existsSync(path)) {
    problems.push(`${page} does not exist`);
    continue;
  }
  const html = readFileSync(path, 'utf8');
  if (!/<main\s+id="main"/.test(html)) problems.push(`${page}: no <main id="main"> landmark`);
  if (!/<html\s+lang="[a-z]{2}/.test(html)) problems.push(`${page}: <html> has no lang`);
  if (!/<meta\s+name="viewport"/.test(html)) problems.push(`${page}: no viewport meta, so it will not scale`);

  for (const m of html.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = m[1];
    const id = attrs.match(/\bid="([^"]+)"/)?.[1];
    const labelled = id ? new RegExp(`<label[^>]*for="${id}"`).test(html) : false;
    if (!labelled && !/aria-label=/.test(attrs)) {
      problems.push(`${page}: an <input> has neither a <label for> nor an aria-label`);
    }
  }

  for (const m of html.matchAll(/<svg\b([^>]*)>/g)) {
    const attrs = m[1];
    if (/role="img"/.test(attrs) && !/aria-labelledby=|aria-label=/.test(attrs)) {
      problems.push(`${page}: an <svg role="img"> has no accessible name`);
    }
  }
}

// Negative controls for the brace matcher and the emptiness test.
{
  const emptyBlock = '@media (prefers-reduced-motion: reduce) {\n}\n';
  if ((reducedMotionBody(emptyBlock) ?? 'x').trim().length !== 0) {
    problems.push('negative control failed: an empty reduced-motion block was not seen as empty');
  }
  if (reducedMotionBody('body { color: red; }') !== null) {
    problems.push('negative control failed: a stylesheet with no reduced-motion block appeared to have one');
  }
  const decorative = reducedMotionBody('@media (prefers-reduced-motion: reduce) { .x { color: red; } }') ?? '';
  if (/animation[^;]*none|animation-duration\s*:\s*0/.test(decorative)) {
    problems.push('negative control failed: a block that disables nothing looked like it disabled animation');
  }
}

if (problems.length > 0) {
  console.error('site quality FAILED');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `${PAGES.length} pages checked for landmarks, lang, viewport, labelled inputs and named SVGs; ` +
    'reduced motion disables animation, transition and reveal opacity',
);
console.log('site quality verification passed');

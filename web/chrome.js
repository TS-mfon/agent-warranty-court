/**
 * Shared site chrome: header, navigation, footer, and the reveal-on-scroll
 * observer.
 *
 * Injected from one module rather than copied into five HTML files. The
 * duplication that matters here is not the markup, it is the nav list: a page
 * that quietly lacks a link is how a five-page site becomes a four-page site,
 * and nobody notices because every page still looks finished.
 *
 * The active link is derived from the document's own path rather than declared
 * per page, so `aria-current` cannot disagree with where the reader actually is.
 *
 * Content-Security-Policy forbids inline script, so this is a module file and
 * never an inline handler.
 */

/** The whole site, in nav order. `path` is the clean URL Vercel serves. */
export const ROUTES = [
  { path: '/', file: 'index.html', label: 'Overview' },
  { path: '/how-it-works', file: 'how-it-works.html', label: 'How it works' },
  { path: '/monitor', file: 'monitor.html', label: 'Monitor' },
  { path: '/inspect', file: 'inspect.html', label: 'Inspect' },
  { path: '/docs', file: 'docs.html', label: 'Docs' },
];

const REPO = 'https://github.com/TS-mfon/agent-warranty-court';

/** Which route this document is. Tolerates `/monitor`, `/monitor.html`, `/`. */
function currentRoute() {
  const raw = location.pathname.replace(/\/+$/, '') || '/';
  const file = raw.split('/').pop() ?? '';
  return (
    ROUTES.find((r) => r.path === raw) ??
    ROUTES.find((r) => r.file === file) ??
    ROUTES.find((r) => r.file === `${file}.html`) ??
    ROUTES[0]
  );
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = String(v);
    else node.setAttribute(k, String(v));
  }
  for (const child of children) node.append(child);
  return node;
}

function header(active) {
  const nav = el('nav', { class: 'site-nav', 'aria-label': 'Primary' });
  for (const route of ROUTES) {
    const link = el('a', { href: route.path, text: route.label });
    // Set only on the active link: `aria-current="false"` is valid but
    // meaningless to assistive tech, and the stylesheet keys off presence.
    if (route === active) link.setAttribute('aria-current', 'page');
    nav.append(link);
  }

  return el('header', { class: 'site-header' }, [
    el('div', { class: 'wrap' }, [
      el('a', { class: 'brand', href: '/', 'aria-label': 'Agent Warranty Court, home' }, [
        el('span', { class: 'glyph', 'aria-hidden': 'true', text: '⚖' }),
        el('span', { text: 'Agent Warranty Court' }),
      ]),
      nav,
    ]),
  ]);
}

function footer() {
  const nav = el('nav', { 'aria-label': 'Footer' });
  for (const route of ROUTES) nav.append(el('a', { href: route.path, text: route.label }));
  nav.append(el('a', { href: REPO, rel: 'noreferrer', text: 'Source' }));

  return el('footer', { class: 'site-footer' }, [
    el('div', { class: 'wrap' }, [
      nav,
      el('p', {
        class: 'footer-note small faint',
        text:
          'Unaudited and testnet only. The trustless canonical backstop is not ' +
          'active: a challenged verdict resolves by timeout after 14 days with ' +
          'the posted verdict standing.',
      }),
    ]),
  ]);
}

/**
 * Reveal sections as they scroll in.
 *
 * Guarded three ways, because an animation that fails to start must leave the
 * content readable rather than invisible: the `.js` class is only added when
 * this module actually runs, `prefers-reduced-motion` short-circuits to
 * immediately-visible, and a missing IntersectionObserver does the same.
 */
function observeReveals() {
  const targets = document.querySelectorAll('.reveal');
  if (targets.length === 0) return;

  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduced || typeof IntersectionObserver === 'undefined') {
    for (const t of targets) t.classList.add('in');
    return;
  }

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  );
  for (const t of targets) io.observe(t);
}

/** Mount the chrome. Called by every page's own module. */
export function mountChrome() {
  const active = currentRoute();
  document.documentElement.classList.add('js');

  const skip = el('a', { class: 'skip', href: '#main', text: 'Skip to content' });
  document.body.prepend(header(active));
  document.body.prepend(skip);
  document.body.append(footer());

  observeReveals();
  return active;
}

mountChrome();

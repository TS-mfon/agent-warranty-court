/**
 * The docs page.
 *
 * Renders from `generated/docs.js`, which the web build produces from the
 * canonical markdown in `docs/`. There is deliberately no second copy of the
 * prose here: a documentation page that paraphrases the real documentation is a
 * page that drifts away from it silently.
 *
 * When the generated module is absent the page says so plainly and links to the
 * source, rather than rendering an empty shell that reads like the protocol has
 * no documentation.
 */
const $ = (id) => document.getElementById(id);
const REPO_DOCS = 'https://github.com/TS-mfon/agent-warranty-court/tree/main/docs';

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function renderFallback(reason) {
  const doc = $('doc');
  const box = document.createElement('div');
  box.className = 'empty-state';

  const h = document.createElement('h3');
  h.textContent = 'Documentation is generated at build time';
  const p1 = document.createElement('p');
  p1.textContent = reason;
  const p2 = document.createElement('p');
  p2.append(document.createTextNode('The canonical source lives in the repository: '));
  const a = document.createElement('a');
  a.href = REPO_DOCS;
  a.rel = 'noreferrer';
  a.textContent = 'docs/';
  p2.append(a, document.createTextNode('.'));

  box.append(h, p1, p2);
  doc.replaceChildren(box);

  // A table of contents that names the real documents, so the page is still
  // useful about what exists even when it cannot render it.
  const expected = [
    ['protocol', 'Protocol lifecycle and economics'],
    ['contracts', 'Contract reference'],
    ['adjudication', 'How GenLayer decides'],
    ['integration', 'Integration guide'],
    ['verdict-grammar', 'Verdict grammar'],
    ['security', 'Threat model'],
  ];
  const toc = $('toc');
  for (const [slug, title] of expected) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `${REPO_DOCS}/${slug}.md`;
    link.rel = 'noreferrer';
    link.textContent = title;
    li.append(link);
    toc.append(li);
  }
}

function renderDocs(pages) {
  const toc = $('toc');
  const doc = $('doc');

  for (const page of pages) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `#${page.slug}`;
    link.textContent = page.title;
    li.append(link);
    toc.append(li);

    const section = document.createElement('section');
    section.id = page.slug;

    const h = document.createElement('h2');
    h.textContent = page.title;
    section.append(h);

    // `html` is produced by our own build from our own markdown, never from
    // user input, so inserting it is not a sanitisation question — but it is
    // the one place that assumption is worth naming.
    const body = document.createElement('div');
    body.innerHTML = page.html;
    section.append(body);

    doc.append(section);
  }

  // Mark the section currently in view, so a long page keeps its place.
  const links = [...toc.querySelectorAll('a')];
  const sections = pages.map((p) => document.getElementById(p.slug)).filter(Boolean);
  if (typeof IntersectionObserver === 'undefined' || sections.length === 0) return;

  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const a of links) a.removeAttribute('aria-current');
        const active = links.find((a) => a.hash === `#${entry.target.id}`);
        active?.setAttribute('aria-current', 'true');
      }
    },
    { rootMargin: '-15% 0px -70% 0px' },
  );
  for (const s of sections) io.observe(s);
}

try {
  const mod = await import('./generated/docs.js');
  const pages = mod.DOCS;
  if (!Array.isArray(pages) || pages.length === 0) {
    renderFallback('The generated documentation module is present but contains no pages.');
  } else {
    renderDocs(
      pages.map((p) => ({ slug: p.slug ?? slugify(p.title ?? 'untitled'), title: p.title ?? p.slug, html: p.html ?? '' })),
    );
  }
} catch {
  renderFallback('This deployment was built without the generated documentation bundle.');
}

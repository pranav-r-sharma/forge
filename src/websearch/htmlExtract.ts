/**
 * Zero-dependency "readability-lite" HTML → plain text extractor for
 * web_fetch. Forge deliberately ships with no runtime npm dependencies (see
 * README), so this can't reach for cheerio/jsdom/@mozilla/readability the
 * way most Node tools handling this problem would. Instead it's a
 * regex/string-scan pipeline tuned for the common case — a normal article,
 * docs page, or reference page — not a full HTML parser. It will do worse
 * than a real DOM-based readability algorithm on adversarial/unusual markup;
 * that's a known, accepted tradeoff for staying dependency-free (see
 * CHANGELOG/README's "known limitations" for how this is disclosed).
 */

const REMOVE_WHOLESALE_TAGS = ['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'head'];
// Boilerplate containers: stripped by content, not by structure, since a
// regex can't reliably track nesting depth for tags that CAN legitimately
// nest (div/section). These four are rarely nested inside themselves in
// real-world markup, so a non-nesting-aware removal is a safe-enough
// approximation for this use case.
const REMOVE_BOILERPLATE_TAGS = ['nav', 'header', 'footer', 'aside', 'form'];
// 'li' is deliberately NOT in this list — it gets its own "- " marker
// treatment in htmlToPlainText (see below), which needs to run before this
// generic tag-boundary pass would otherwise consume <li>/</li> as plain
// newlines with no marker.
const BLOCK_TAGS = ['p', 'div', 'section', 'article', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'table', 'ul', 'ol'];

export interface ExtractedPage {
  title: string | undefined;
  text: string;
}

/** Extracts a readable title + plain-text body from raw HTML. */
export function extractReadablePage(html: string): ExtractedPage {
  const title = extractTitle(html);
  let doc = html;

  // Comments first — a commented-out <script> or stray markup shouldn't leak through.
  doc = doc.replace(/<!--[\s\S]*?-->/g, ' ');

  for (const tag of REMOVE_WHOLESALE_TAGS) {
    doc = stripTagAndContents(doc, tag);
  }

  // Prefer <main> or <article> content when present — most publishing
  // platforms (docs sites, blogs, news) wrap the actual content in one of
  // these, and the rest of the page is navigation/sidebar/comments cruft
  // that just dilutes what we hand back to the model. Falls back to the
  // whole (now nav/header/footer/script-stripped) document otherwise.
  const preferred = extractLargestOf(doc, ['main', 'article']);
  if (preferred && preferred.length > 200) {
    doc = preferred;
  } else {
    for (const tag of REMOVE_BOILERPLATE_TAGS) {
      doc = stripTagAndContents(doc, tag);
    }
  }

  const text = htmlToPlainText(doc);
  return { title, text };
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (m) {
    const decoded = decodeEntities(m[1]).replace(/\s+/g, ' ').trim();
    if (decoded) return decoded;
  }
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const decoded = decodeEntities(stripTags(h1[1])).replace(/\s+/g, ' ').trim();
    if (decoded) return decoded;
  }
  return undefined;
}

/** Removes every `<tag ...> ... </tag>` span (and bare self-closing/void instances) for a given tag name, non-nesting-aware (see the module doc comment). */
function stripTagAndContents(html: string, tag: string): string {
  const pairedRe = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, 'gi');
  return html.replace(pairedRe, ' ');
}

/** Returns the contents of the largest matching `<tag>...</tag>` block among the given tag names, or undefined if none are found. Used to prefer <main>/<article> over the whole document. */
function extractLargestOf(html: string, tags: string[]): string | undefined {
  let best: string | undefined;
  for (const tag of tags) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      if (!best || m[1].length > best.length) best = m[1];
    }
  }
  return best;
}

/** Strips all tags, leaving raw (still entity-encoded) text — used for small fragments like a `<h1>` title, not the main pipeline (which needs block-boundary newlines first, see htmlToPlainText). */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function htmlToPlainText(html: string): string {
  let doc = html;
  // Turn <br> and block-tag boundaries into newlines BEFORE stripping tags,
  // so paragraphs/list items/headings don't all run together into one wall
  // of text once the tags themselves are gone.
  doc = doc.replace(/<br\s*\/?>/gi, '\n');
  // List items read better with a leading marker — handled explicitly
  // (unconditionally, not dependent on a preceding newline already being
  // there) rather than folded into the generic BLOCK_TAGS loop below, since
  // an <li> is not always immediately preceded by a tag boundary (e.g. two
  // adjacent <li> elements with no whitespace between them).
  doc = doc.replace(/<li(?:\s[^>]*)?>/gi, '\n- ');
  doc = doc.replace(/<\/li>/gi, '\n');
  for (const tag of BLOCK_TAGS) {
    doc = doc.replace(new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'gi'), '\n');
    doc = doc.replace(new RegExp(`<\\/${tag}>`, 'gi'), '\n');
  }

  doc = doc.replace(/<[^>]+>/g, ' '); // everything else (inline tags) — collapse, don't newline
  doc = decodeEntities(doc);

  // Collapse whitespace: multiple spaces -> one, 3+ newlines -> 2 (one blank line), trim each line.
  doc = doc
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n');
  doc = doc.replace(/\n{3,}/g, '\n\n').trim();
  return doc;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
  reg: '®',
  trade: '™',
  bull: '•',
};

/** Minimal HTML entity decoder covering named entities common in prose plus numeric/hex references — enough for real-world article text without pulling in a dependency. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => (NAMED_ENTITIES[name.toLowerCase()] !== undefined ? NAMED_ENTITIES[name.toLowerCase()] : m));
}

function safeFromCodePoint(code: number): string {
  try {
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

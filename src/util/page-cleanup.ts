// HTML cleanup pipeline for the `read_page` tool. Goal: take raw
// HTML from a `fetch()` and produce a slimmed-down version a Claude
// agent can consume directly — no nested LLM render step, no
// browser, no JS execution.
//
// What we keep:
//   - body content + structure (headings, paragraphs, lists, tables, code)
//   - inline links with their hrefs (resolved to absolute URLs)
//   - signal-bearing metadata (title, OpenGraph, Twitter card, JSON-LD)
//   - lazy-loaded image srcs (de-placeholdered)
//
// What we strip:
//   - scripts, styles, iframes, svg, canvas, video, audio
//   - cookie/consent banners, newsletter prompts (heuristic match)
//   - presentational attributes (class, style, id, data-*, event handlers)
//   - ARIA attributes (LLMs don't need them; they're for screen readers)
//   - HTML comments
//
// What we DON'T do:
//   - execute JavaScript (the whole point — agent calls `read_page`
//     specifically to skip the browser path)
//   - fetch external resources (CSS / JS / images)
//   - normalize encoding beyond what `fetch()` already does
//
// Returns the cleaned HTML, the structured-data summary, and stats.
// Caller (read-page tool) hands the result to the agent as a
// `tool_result` block; the agent reads it natively.

import { load } from 'cheerio';

const DEFAULT_MAX_BYTES = 80_000;

const DROP_TAGS = new Set([
  'script', 'style', 'noscript', 'iframe', 'svg', 'canvas',
  'audio', 'video', 'source', 'track', 'object', 'embed',
  'template', 'slot',
]);

const KEEP_HEAD_TAGS = new Set(['title', 'meta', 'link']);

const KEEP_META = new Set([
  'description', 'keywords', 'author',
  'og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'og:site_name',
  'twitter:title', 'twitter:description', 'twitter:image', 'twitter:card',
  'article:published_time', 'article:author',
]);

const DROP_ATTRS = new Set([
  'class', 'style',
  'role', 'aria-label', 'aria-labelledby', 'aria-describedby',
  'tabindex', 'contenteditable', 'draggable',
  'data-testid', 'data-cy',
  'onclick', 'onmouseover', 'onmouseout', 'onload', 'onerror', 'onsubmit',
  'onfocus', 'onblur', 'onchange', 'onkeydown', 'onkeyup', 'onkeypress',
]);

export interface StructuredData {
  meta: Record<string, string>;
  jsonLd: unknown[];
}

export interface CleanResult {
  /** Cleaned HTML, suitable for direct LLM consumption. */
  html: string;
  /** OpenGraph / Twitter / JSON-LD summary, extracted before stripping. */
  structured: StructuredData;
  /** What happened during cleanup. */
  stats: {
    originalBytes: number;
    cleanedBytes: number;
    truncated: boolean;
    reductionRatio: number;
  };
}

/**
 * Clean raw HTML for direct LLM consumption.
 *
 * @param rawHtml - the raw HTML string from `fetch()`
 * @param baseUrl - the URL the HTML was fetched from. Used to
 *   resolve relative `href` / `src` attributes to absolute URLs.
 * @param opts.maxBytes - hard size cap. Default 80KB.
 */
export function cleanHtml(rawHtml: string, baseUrl: string, opts: { maxBytes?: number } = {}): CleanResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const $ = load(rawHtml);

  // ── 1. Capture structured data BEFORE we strip <head> + <script>.
  const structured = extractStructuredData($);

  // ── 2. Drop tag classes we never want.
  for (const tag of DROP_TAGS) {
    $(tag).remove();
  }

  // ── 3. Slim down <head>: keep title + selected metas + canonical link.
  $('head > *').each((_, el) => {
    const tagName = (el as { tagName?: string }).tagName?.toLowerCase();
    if (!tagName || !KEEP_HEAD_TAGS.has(tagName)) {
      $(el).remove();
      return;
    }
    if (tagName === 'meta') {
      const name = ($(el).attr('name') || $(el).attr('property') || '').toLowerCase();
      if (!KEEP_META.has(name)) {
        $(el).remove();
        return;
      }
    }
    if (tagName === 'link') {
      const rel = ($(el).attr('rel') || '').toLowerCase();
      if (rel !== 'canonical') {
        $(el).remove();
      }
    }
  });

  // ── 4. Strip HTML comments.
  $('*')
    .contents()
    .each((_, node) => {
      if ((node as { type?: string }).type === 'comment') $(node).remove();
    });

  // ── 4.5. Common-noise pruning by class/id BEFORE attributes get
  //         stripped — selectors like `[class*="cookie"]` won't
  //         match once we delete class attributes in step 5.
  $('[aria-label*="cookie" i], [class*="cookie" i], [id*="cookie" i]').remove();
  $('[class*="consent" i], [id*="consent" i]').remove();

  // ── 5. Drop noisy attributes across all elements. Resolve href/src.
  $('*').each((_, el) => {
    const elt = el as { attribs?: Record<string, string> };
    if (!elt.attribs) return;
    for (const attr of Object.keys(elt.attribs)) {
      if (attr.startsWith('data-') && attr !== 'data-src') {
        delete elt.attribs[attr];
        continue;
      }
      if (attr === 'id') {
        delete elt.attribs[attr];
        continue;
      }
      if (DROP_ATTRS.has(attr)) {
        delete elt.attribs[attr];
      }
    }
    // Resolve href + src relative paths to absolute URLs so the
    // agent can follow them without holding the source URL in
    // working memory.
    const href = elt.attribs?.['href'];
    if (href) {
      const resolved = resolveUrl(href, baseUrl);
      if (resolved) elt.attribs!['href'] = resolved;
    }
    const src = elt.attribs?.['src'];
    if (src) {
      const resolved = resolveUrl(src, baseUrl);
      if (resolved) elt.attribs!['src'] = resolved;
    }
  });

  // ── 7. Inline lazy-loaded image srcs.
  $('img[data-src]').each((_, el) => {
    const $el = $(el);
    const real = $el.attr('data-src');
    if (real) {
      const resolved = resolveUrl(real, baseUrl);
      if (resolved) $el.attr('src', resolved);
    }
    $el.removeAttr('data-src');
  });

  // ── 8. Collapse repeated whitespace.
  let html = $.html().trim();
  html = html.replace(/\s{3,}/g, '  ');

  // ── 9. Hard size cap.
  const originalLen = html.length;
  let truncated = false;
  if (html.length > maxBytes) {
    html = html.slice(0, maxBytes) + '\n<!-- [page-cleanup: HTML truncated at ' + maxBytes + ' bytes; original was ' + originalLen + '] -->';
    truncated = true;
  }

  return {
    html,
    structured,
    stats: {
      originalBytes: rawHtml.length,
      cleanedBytes: html.length,
      truncated,
      reductionRatio: html.length / Math.max(1, rawHtml.length),
    },
  };
}

function extractStructuredData($: ReturnType<typeof load>): StructuredData {
  const out: StructuredData = { meta: {}, jsonLd: [] };

  const title = $('head > title').first().text().trim();
  if (title) out.meta['title'] = title;

  $('meta').each((_, el) => {
    const name = ($(el).attr('name') || $(el).attr('property') || '').toLowerCase();
    if (KEEP_META.has(name)) {
      const content = $(el).attr('content');
      if (content) out.meta[name] = content;
    }
  });

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).text().trim();
    if (!raw) return;
    try {
      out.jsonLd.push(JSON.parse(raw));
    } catch {
      // malformed JSON-LD; skip rather than crash
    }
  });

  return out;
}

/**
 * Resolve a possibly-relative URL against a base URL. Returns null
 * for malformed inputs (caller keeps the original value).
 */
function resolveUrl(href: string, baseUrl: string): string | null {
  if (!href) return null;
  // Already absolute, or a fragment/data/javascript URI — leave alone.
  if (/^[a-z][a-z0-9+\-.]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
    // Protocol-relative URLs need protocol from base; everything else
    // (http://, https://, data:, mailto:, javascript:, #anchor) keep as-is.
    if (href.startsWith('//')) {
      try {
        const base = new URL(baseUrl);
        return base.protocol + href;
      } catch {
        return null;
      }
    }
    return href;
  }
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

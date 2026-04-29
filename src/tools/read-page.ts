// `read_page` tool — fetch a URL and return its content as cleaned
// HTML for the agent to read directly.
//
// Why a custom tool rather than navigating with the computer tool:
//   - Faster: no browser cold-start, no screenshot, no OCR
//   - Cheaper: no screenshot tokens (a full screenshot is ~1500
//     tokens; a typical cleaned-HTML page is 5-30KB ≈ 1-7K tokens)
//   - More reliable: the agent reads structured HTML instead of
//     trying to interpret a flattened image of it
//   - No JS execution needed: cleaning + linkifying is enough for
//     the read-only research case (~80% of agent web tasks)
//
// Limits worth knowing:
//   - Pure SPAs (empty body, content fetched by JS) — we return the
//     metadata we extracted from <head> instead of raw HTML, plus a
//     marker telling the agent the body was JS-only.
//   - Bot-blocked pages (Cloudflare challenges, 403 / 429) — the
//     fetch itself fails; we return that as a tool error.
//   - Pages > 80KB cleaned — truncated, marker appended.

import { cleanHtml, type StructuredData } from '../util/page-cleanup.js';

export interface ReadPageResult {
  /** What the tool returns as a string for the agent. */
  text: string;
  /** Stats for the audit log (not for the agent). */
  meta: {
    url: string;
    finalUrl: string;
    status: number;
    contentType: string;
    originalBytes: number;
    cleanedBytes: number;
    truncated: boolean;
    durationMs: number;
    bodyEffectivelyEmpty: boolean;
  };
}

export interface ReadPageOptions {
  /** Hard size cap on cleaned HTML. Default 80KB. */
  maxBytes?: number;
  /** Override the User-Agent header. Default is a Chrome 124 UA so
   *  sites don't bounce us with a "use a real browser" page. */
  userAgent?: string;
  /** Network timeout in ms. Default 15s — most pages are < 5s; we
   *  set a soft ceiling so a hung connection doesn't stall the
   *  agent's whole turn. */
  timeoutMs?: number;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Fetch + clean a URL. Returns the agent-ready text and audit meta.
 * Throws on fetch failure (caller should surface the error to the
 * agent as a tool_result with an error string).
 */
export async function readPage(url: string, opts: ReadPageOptions = {}): Promise<ReadPageResult> {
  const start = Date.now();

  // Validate URL early — give the agent a clean error rather than
  // a fetch-internal one when it passes garbage.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}. Only http: and https: are allowed.`);
  }

  const res = await fetch(url, {
    headers: {
      'user-agent': opts.userAgent ?? DEFAULT_USER_AGENT,
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });

  const finalUrl = res.url || url;
  const contentType = res.headers.get('content-type') || '';

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }

  // Non-HTML content: just return the body as text up to maxBytes.
  // Useful for the agent fetching JSON APIs, RSS feeds, plain-text
  // resources. We don't run cleanHtml on these.
  if (!contentType.includes('html') && !contentType.includes('xml')) {
    const raw = await res.text();
    const max = opts.maxBytes ?? 80_000;
    const truncated = raw.length > max;
    const text = truncated ? raw.slice(0, max) + '\n[...truncated]' : raw;
    return {
      text: `URL: ${finalUrl}\nContent-Type: ${contentType}\nBody (${raw.length} bytes${truncated ? ', truncated to ' + max : ''}):\n\n${text}`,
      meta: {
        url, finalUrl, status: res.status, contentType,
        originalBytes: raw.length, cleanedBytes: text.length, truncated,
        durationMs: Date.now() - start, bodyEffectivelyEmpty: false,
      },
    };
  }

  const rawHtml = await res.text();
  const { html, structured, stats } = cleanHtml(rawHtml, finalUrl, opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {});

  // Body-emptiness heuristic: if the cleaned HTML's <body> contains
  // less than ~200 chars of text, this is likely a pure SPA shell.
  // Surface the metadata + an explicit marker rather than just
  // shipping a near-empty HTML blob the agent has to puzzle over.
  const bodyEffectivelyEmpty = isBodyEmpty(html);

  let agentText: string;
  if (bodyEffectivelyEmpty) {
    agentText = renderSpaShellSummary(finalUrl, structured);
  } else {
    agentText = renderHtmlForAgent(finalUrl, structured, html, stats.truncated);
  }

  return {
    text: agentText,
    meta: {
      url, finalUrl, status: res.status, contentType,
      originalBytes: stats.originalBytes,
      cleanedBytes: stats.cleanedBytes,
      truncated: stats.truncated,
      durationMs: Date.now() - start,
      bodyEffectivelyEmpty,
    },
  };
}

/**
 * Heuristic — strip tags, count visible text in the body. < 200
 * non-whitespace chars likely means the body is a JS-rendered shell.
 */
function isBodyEmpty(cleanedHtml: string): boolean {
  // Pull just the body
  const bodyMatch = cleanedHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return false;
  const text = bodyMatch[1]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length < 200;
}

/**
 * Format the cleaned HTML + metadata as a single text blob for the
 * agent's tool_result. We use a small framing header so the agent
 * sees URL/metadata/body sections clearly instead of an undifferentiated
 * dump.
 */
function renderHtmlForAgent(
  url: string,
  structured: StructuredData,
  html: string,
  truncated: boolean,
): string {
  const metaParts: string[] = [];
  if (structured.meta['title']) metaParts.push(`Title: ${structured.meta['title']}`);
  if (structured.meta['description'] || structured.meta['og:description']) {
    metaParts.push(`Description: ${structured.meta['description'] || structured.meta['og:description']}`);
  }
  if (structured.meta['og:type']) metaParts.push(`Type: ${structured.meta['og:type']}`);
  if (structured.meta['article:published_time']) metaParts.push(`Published: ${structured.meta['article:published_time']}`);
  if (structured.meta['article:author']) metaParts.push(`Author: ${structured.meta['article:author']}`);

  const head: string[] = [
    `URL: ${url}`,
    ...metaParts,
  ];
  if (truncated) {
    head.push('Note: HTML body was truncated at the configured size limit.');
  }

  const jsonLdSection = structured.jsonLd.length > 0
    ? `\n\nStructured data (JSON-LD):\n\`\`\`json\n${JSON.stringify(structured.jsonLd, null, 2).slice(0, 4000)}\n\`\`\``
    : '';

  return `${head.join('\n')}${jsonLdSection}\n\nHTML body:\n\`\`\`html\n${html}\n\`\`\``;
}

/**
 * Format for SPA-shell case — no body content to render, but the
 * agent shouldn't have to figure that out from a near-empty HTML
 * blob. Return a structured summary plus a clear marker.
 */
function renderSpaShellSummary(url: string, structured: StructuredData): string {
  const lines: string[] = [
    `URL: ${url}`,
    'NOTE: This page is a single-page application shell. The HTML body has no meaningful content; the visible page is rendered by JavaScript on load. read_page does not execute JavaScript, so the body is not available.',
    '',
    'What we can see from <head> metadata:',
  ];
  for (const [k, v] of Object.entries(structured.meta)) {
    lines.push(`  ${k}: ${v}`);
  }
  if (structured.jsonLd.length > 0) {
    lines.push('');
    lines.push('Structured data (JSON-LD):');
    lines.push('```json');
    lines.push(JSON.stringify(structured.jsonLd, null, 2).slice(0, 2000));
    lines.push('```');
  }
  lines.push('');
  lines.push('To interact with this page, you would need to use the computer tool to launch a browser. For static content extraction, this URL is not reachable via read_page.');
  return lines.join('\n');
}

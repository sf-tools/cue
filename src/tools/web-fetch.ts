import { tool } from 'ai';
import { z } from 'zod';

import { truncate } from './utils';

const DEFAULT_MAX_CHARS = 20000;
const REQUEST_TIMEOUT_MS = 15000;

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'br',
  'div',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'footer',
  'form',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
]);

const STRIP_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'template', 'head']);

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™'
};

function decodeEntities(text: string) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    if (body.startsWith('#')) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }

    const replacement = ENTITY_MAP[body.toLowerCase()];
    return replacement ?? match;
  });
}

function htmlToMarkdown(html: string) {
  let source = html.replace(/<!--[\s\S]*?-->/g, '');

  for (const tag of STRIP_TAGS) {
    const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
    source = source.replace(re, '');
  }

  const out: string[] = [];
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  const linkStack: Array<string | null> = [];
  let cursor = 0;
  let inPre = false;

  const pushText = (text: string) => {
    const decoded = decodeEntities(text);
    if (inPre) {
      out.push(decoded);
      return;
    }
    out.push(decoded.replace(/\s+/g, ' '));
  };

  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(source)) !== null) {
    if (match.index > cursor) pushText(source.slice(cursor, match.index));
    cursor = tagRe.lastIndex;

    const tagName = match[1].toLowerCase();
    const isClose = match[0][1] === '/';
    const attrs = match[2] ?? '';

    if (tagName === 'pre') {
      inPre = !isClose;
      out.push(isClose ? '\n```\n' : '\n```\n');
      continue;
    }

    if (tagName === 'code' && !inPre) {
      out.push('`');
      continue;
    }

    if (tagName === 'br' && !isClose) {
      out.push('\n');
      continue;
    }

    if (!isClose && /^h[1-6]$/.test(tagName)) {
      const level = Number(tagName[1]);
      out.push(`\n\n${'#'.repeat(level)} `);
      continue;
    }

    if (!isClose && tagName === 'li') {
      out.push('\n- ');
      continue;
    }

    if (!isClose && tagName === 'a') {
      const href = attrs.match(/\bhref\s*=\s*"([^"]+)"|\bhref\s*=\s*'([^']+)'/i);
      const url = href?.[1] ?? href?.[2] ?? null;
      linkStack.push(url);
      out.push('[');
      continue;
    }

    if (isClose && tagName === 'a') {
      const url = linkStack.pop();
      out.push(url ? `](${url})` : '](#)');
      continue;
    }

    if (!isClose && tagName === 'img') {
      const alt = attrs.match(/\balt\s*=\s*"([^"]*)"/i)?.[1] ?? '';
      const src = attrs.match(/\bsrc\s*=\s*"([^"]+)"/i)?.[1] ?? '';
      if (src) out.push(`![${alt}](${src})`);
      continue;
    }

    if (BLOCK_TAGS.has(tagName)) {
      out.push('\n\n');
      continue;
    }
  }

  if (cursor < source.length) pushText(source.slice(cursor));

  return out
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function looksLikeHtml(contentType: string | null, body: string) {
  if (contentType && /\b(html|xml)\b/i.test(contentType)) return true;
  return /<html[\s>]|<!doctype html/i.test(body.slice(0, 256));
}

export function createWebFetchTool() {
  return tool({
    description: 'Fetch a URL over HTTP and return its content as markdown (HTML stripped). Use for docs pages, RFCs, blog posts, raw text/json.',
    inputSchema: z.object({
      url: z.string().url(),
      max_chars: z.number().int().positive().max(200000).optional()
    }),
    execute: async ({ url, max_chars }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url, {
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            'user-agent': 'cue-coding-agent/1.0',
            accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5'
          }
        });

        const contentType = response.headers.get('content-type');
        const body = await response.text();
        const limit = max_chars ?? DEFAULT_MAX_CHARS;

        const rendered = looksLikeHtml(contentType, body) ? htmlToMarkdown(body) : body.trim();
        const header = `# ${url}\n\nstatus: ${response.status}${contentType ? ` · type: ${contentType}` : ''}\n\n`;
        return truncate(`${header}${rendered}`, limit + header.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return `error fetching ${url}: ${message}`;
      } finally {
        clearTimeout(timer);
      }
    }
  });
}

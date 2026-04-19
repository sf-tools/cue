import { tool } from 'ai';
import { z } from 'zod';

import type { ToolFactoryOptions } from './types';
import { truncate } from './utils';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DEFAULT_BODY_PREVIEW_CHARS = 8000;

const REDACT_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization', 'x-api-key']);

function describeHeaders(headers: Headers, redact: boolean) {
  const lines: string[] = [];
  headers.forEach((value, name) => {
    const display = redact && REDACT_HEADERS.has(name.toLowerCase()) ? `<redacted ${value.length} chars>` : value;
    lines.push(`  ${name}: ${display}`);
  });
  return lines.join('\n');
}

function isProbablyText(contentType: string | null) {
  if (!contentType) return true;
  const lower = contentType.toLowerCase();
  return /text\/|json|xml|javascript|x-www-form-urlencoded|html|css|graphql|yaml|csv/.test(lower);
}

function tryPrettyJson(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function createHttpTool({ requestApproval }: ToolFactoryOptions) {
  return tool({
    description:
      'Make a single HTTP request and return status, headers, body (truncated), and timing. Use after `bash_bg` to hit a freshly-started dev server, or against any external API. Mutating methods (POST/PUT/PATCH/DELETE) require approval.',
    inputSchema: z.object({
      url: z.string().url(),
      method: z.enum(['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional().describe('Request body (string). For JSON, stringify yourself.'),
      json: z.unknown().optional().describe('Convenience: send this value as JSON (sets content-type if absent).'),
      timeout_ms: z.number().int().positive().max(120000).optional(),
      max_body_chars: z.number().int().positive().max(50000).optional(),
      redact_secrets: z.boolean().optional().describe('Mask Authorization/Cookie/etc headers in output (default true).'),
      follow_redirects: z.boolean().optional()
    }),
    execute: async ({ url, method, headers, body, json, timeout_ms, max_body_chars, redact_secrets, follow_redirects }) => {
      const httpMethod = method ?? (json !== undefined || body !== undefined ? 'POST' : 'GET');
      const finalHeaders = new Headers(headers);

      let finalBody: BodyInit | undefined;
      if (json !== undefined) {
        if (!finalHeaders.has('content-type')) finalHeaders.set('content-type', 'application/json');
        finalBody = JSON.stringify(json);
      } else if (body !== undefined) {
        finalBody = body;
      }

      if (!SAFE_METHODS.has(httpMethod)) {
        const detail = `${httpMethod} ${url}`;
        if (
          !(await requestApproval({
            scope: 'command',
            title: `HTTP ${httpMethod}`,
            detail
          }))
        ) {
          throw new Error('http denied by user');
        }
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout_ms ?? DEFAULT_TIMEOUT_MS);

      const startedAt = performance.now();
      let response: Response;
      try {
        response = await fetch(url, {
          method: httpMethod,
          headers: finalHeaders,
          body: finalBody,
          redirect: follow_redirects === false ? 'manual' : 'follow',
          signal: controller.signal
        });
      } catch (error) {
        clearTimeout(timer);
        const message = error instanceof Error ? error.message : String(error);
        return `error: ${httpMethod} ${url} failed: ${message}`;
      }
      clearTimeout(timer);

      const elapsed = performance.now() - startedAt;
      const contentType = response.headers.get('content-type');
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let truncated = false;

      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            total += value.byteLength;
            if (total > MAX_BODY_BYTES) {
              truncated = true;
              try { await reader.cancel(); } catch { /* ignore */ }
              break;
            }
            chunks.push(value);
          }
        }
      }

      const merged = chunks.length > 0 ? new Uint8Array(total) : new Uint8Array();
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const limit = max_body_chars ?? DEFAULT_BODY_PREVIEW_CHARS;
      let bodyDisplay: string;
      if (isProbablyText(contentType)) {
        const text = new TextDecoder('utf-8').decode(merged);
        const pretty = contentType?.toLowerCase().includes('json') ? tryPrettyJson(text) : text;
        bodyDisplay = truncate(pretty, limit);
      } else {
        bodyDisplay = `<binary ${total} bytes${truncated ? ', truncated' : ''}> (content-type: ${contentType ?? 'unknown'})`;
      }

      const redact = redact_secrets !== false;
      const lines = [
        `${httpMethod} ${url}`,
        `${response.status} ${response.statusText} · ${elapsed.toFixed(0)}ms · ${total} bytes${truncated ? ' (truncated)' : ''}`,
        '',
        '--- response headers ---',
        describeHeaders(response.headers, redact),
        '',
        '--- body ---',
        bodyDisplay
      ];

      return lines.join('\n');
    }
  });
}

import { existsSync, statSync } from 'node:fs';
import { extname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

function unescapeShellPath(value: string) {
  return value.replace(/\\(.)/g, '$1');
}

function decodeFileUrl(value: string) {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

function trimQuotes(value: string) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1);
  }
  return value;
}

function trimPathPunctuation(value: string) {
  let out = value;
  while (/[.,;:!?)]$/.test(out)) out = out.slice(0, -1);
  return out;
}

function expandHomePath(value: string) {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return value;
}

function resolveUserDirectoryPath(value: string) {
  const slashIndex = value.indexOf('/');
  if (slashIndex === -1) return null;

  const first = value.slice(0, slashIndex).toLowerCase();
  const rest = value.slice(slashIndex + 1);
  if (!rest) return null;

  const userDirectories: Record<string, string> = {
    desktop: 'Desktop',
    documents: 'Documents',
    downloads: 'Downloads',
    pictures: 'Pictures',
    movies: 'Movies',
    music: 'Music',
  };
  const directory = userDirectories[first];
  return directory ? resolve(homedir(), directory, rest) : null;
}

function normalizePathCandidate(value: string) {
  return expandHomePath(unescapeShellPath(decodeFileUrl(trimQuotes(trimPathPunctuation(value)))));
}

/**
 * Tokenize a string the way a shell would for path arguments. Honors single
 * quotes, double quotes, and backslash-escaped spaces. Used to split
 * drag-and-drop payloads — terminals send paths in any of these forms
 * depending on platform.
 */
export function shellSplitPaths(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

export type DroppedPath = { rawToken: string; absolutePath: string; mediaType: string; ext: string };
export type ImagePathMention = DroppedPath & { start: number; end: number };

/**
 * Try to interpret a piece of pasted text as one or more dropped image file
 * paths. Returns null when the text isn't shaped like a list of existing
 * image paths — caller should treat it as plain text in that case.
 */
export function parseDroppedImagePaths(input: string, cwd = process.cwd()): DroppedPath[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.includes('\n')) return null;

  const tokens = shellSplitPaths(trimmed);
  if (tokens.length === 0) return null;

  const results: DroppedPath[] = [];
  for (const token of tokens) {
    const candidate = normalizePathCandidate(token);
    if (!candidate) return null;
    const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
    const ext = extname(absolute).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) return null;
    if (!existsSync(absolute)) return null;
    try {
      if (!statSync(absolute).isFile()) return null;
    } catch {
      return null;
    }
    results.push({ rawToken: token, absolutePath: absolute, mediaType, ext });
  }
  return results.length > 0 ? results : null;
}

export function resolveExistingImagePath(
  value: string,
  cwd = process.cwd(),
): Omit<DroppedPath, 'rawToken'> | null {
  const candidate = normalizePathCandidate(value);
  if (!candidate) return null;
  const absolute = isAbsolute(candidate) ? candidate : resolve(cwd, candidate);
  const userDirectoryPath = !isAbsolute(candidate) ? resolveUserDirectoryPath(candidate) : null;
  const existingPath = existsSync(absolute) ? absolute : userDirectoryPath;
  if (!existingPath) return null;
  const ext = extname(existingPath).toLowerCase();
  const mediaType = IMAGE_MEDIA_TYPES[ext];
  if (!mediaType) return null;
  if (!existsSync(existingPath)) return null;
  try {
    if (!statSync(existingPath).isFile()) return null;
  } catch {
    return null;
  }
  return { absolutePath: existingPath, mediaType, ext };
}

export function findImagePathMentions(input: string, cwd = process.cwd()): ImagePathMention[] {
  const mentions: ImagePathMention[] = [];
  const seenStarts = new Set<number>();
  const pattern = /(?:"[^"\n]+"|'[^'\n]+'|file:\/\/(?:\\\s|[^\s])+|~\/(?:\\\s|[^\s])+|(?:\.{1,2}\/|\/)(?:\\\s|[^\s])+|(?:\\\s|[^\s])+\.(?:png|jpe?g|gif|webp|bmp|svg)\b(?:\\\s|[^\s])*)/gi;

  for (const match of input.matchAll(pattern)) {
    const rawToken = match[0];
    const start = match.index ?? 0;
    if (seenStarts.has(start)) continue;
    if (start > 0 && input[start - 1] === '@') continue;
    const resolved = resolveExistingImagePath(rawToken, cwd);
    if (!resolved) continue;

    seenStarts.add(start);
    mentions.push({
      rawToken,
      ...resolved,
      start,
      end: start + rawToken.length,
    });
  }

  return mentions;
}

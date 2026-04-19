import { readFile, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';

import { tool } from 'ai';
import { z } from 'zod';

import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

const MAX_TEXT_LENGTH = 400_000;
const DEFAULT_MAX_CITATIONS = 10;
const MAX_CITATIONS_CAP = 25;
const SNIPPET_CONTEXT_LINES = 4;
const MAX_SEARCH_HITS_PER_TERM = 8;
const DEFAULT_ROOT_CAUSE_LIMIT = 3;
const MAX_ROOT_CAUSE_LIMIT = 10;
const MAX_QUERY_RESULTS = 3;
const MAX_MESSAGE_CANDIDATES = 3;
const MAX_FUNCTION_CANDIDATES = 4;
const MAX_FILE_CANDIDATES = 4;
const MAX_SNIPPET_LINES = 9;
const LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%ad%x1f%s';

type SearchMatch = { path: string; line: number; column: number; text: string };
type CiClassification = 'your_change' | 'flaky_test' | 'infra' | 'dependency' | 'unknown';

type StackFrame = {
  raw: string;
  functionName: string | null;
  file: string | null;
  line: number | null;
  column: number | null;
};

type SearchEvidence = {
  path: string;
  line: number;
  kind: 'message' | 'function' | 'file' | 'context_hint';
  query: string;
  text: string;
};

type SnippetEvidence = {
  path: string;
  line: number;
  snippet: string;
};

function shellEscape(value: string) {
  return `'${value.replace(/'/g, `"'"'`)}'`;
}

function parseSearchLine(line: string): SearchMatch | null {
  const c1 = line.lastIndexOf(':');
  if (c1 === -1) return null;
  const c2 = line.lastIndexOf(':', c1 - 1);
  if (c2 === -1) return null;
  const c3 = line.lastIndexOf(':', c2 - 1);
  if (c3 === -1) return null;

  const path = line.slice(0, c3);
  const lineNo = Number.parseInt(line.slice(c3 + 1, c2), 10);
  const column = Number.parseInt(line.slice(c2 + 1, c1), 10);
  const text = line.slice(c1 + 1);
  if (!Number.isFinite(lineNo) || !Number.isFinite(column)) return null;
  return { path, line: lineNo, column, text };
}

async function searchWorkspace(
  runUserShell: ToolFactoryOptions['runUserShell'],
  options: {
    query: string;
    root?: string;
    glob?: string | null;
    caseSensitive?: boolean;
    fixedString?: boolean;
  },
) {
  const query = options.query;
  const root = options.root ?? '.';
  const flags = [
    '--line-number',
    '--column',
    '--no-heading',
    '--color=never',
    options.caseSensitive ? '' : '-i',
    options.fixedString ? '--fixed-strings' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const globArg = options.glob ? `-g ${shellEscape(options.glob)}` : '';
  const command = `if command -v rg >/dev/null 2>&1; then command rg ${flags} ${globArg} -- ${shellEscape(query)} ${shellEscape(root)}; else command grep -RIn -- ${shellEscape(query)} ${shellEscape(root)}; fi`;
  const { output, exitCode } = await runUserShell(command);
  const normalized = plain(output).trimEnd();
  if (exitCode !== 0 && exitCode !== 1) {
    throw new Error(normalized || `search exited with code ${exitCode}`);
  }

  const matches = normalized
    .split('\n')
    .filter(Boolean)
    .map(parseSearchLine)
    .filter((match): match is SearchMatch => match !== null);

  return { matches, matchCount: matches.length };
}

async function readSnippet(filePath: string, lineNumber: number) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return '';
  } catch {
    return '';
  }

  const text = await readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, lineNumber - 1 - SNIPPET_CONTEXT_LINES);
  const end = Math.min(lines.length, lineNumber + SNIPPET_CONTEXT_LINES);
  return lines
    .slice(start, end)
    .map((line, index) => {
      const ln = start + index + 1;
      const marker = ln === lineNumber ? '>' : ' ';
      return `${marker} ${String(ln).padStart(5)}  ${line}`;
    })
    .join('\n');
}

function extractSearchTerms(question: string) {
  const stopWords = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'shall',
    'can',
    'need',
    'dare',
    'ought',
    'used',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'as',
    'into',
    'through',
    'during',
    'before',
    'after',
    'above',
    'below',
    'between',
    'out',
    'off',
    'over',
    'under',
    'again',
    'further',
    'then',
    'once',
    'here',
    'there',
    'when',
    'where',
    'why',
    'how',
    'all',
    'each',
    'every',
    'both',
    'few',
    'more',
    'most',
    'other',
    'some',
    'such',
    'no',
    'nor',
    'not',
    'only',
    'own',
    'same',
    'so',
    'than',
    'too',
    'very',
    'just',
    'because',
    'but',
    'and',
    'or',
    'if',
    'while',
    'about',
    'up',
    'what',
    'which',
    'who',
    'whom',
    'this',
    'that',
    'these',
    'those',
    'am',
    'it',
    'its',
    'i',
    'me',
    'my',
    'we',
    'our',
    'you',
    'your',
    'he',
    'him',
    'his',
    'she',
    'her',
    'they',
    'them',
    'their',
    'work',
    'works',
    'working',
    'happen',
    'happens',
    'happening',
    'get',
    'gets',
    'getting',
    'got',
    'done',
    'doing',
    'make',
    'makes',
    'making',
    'made',
    'use',
    'uses',
    'using',
    'go',
    'goes',
    'going',
    'went',
    'come',
    'comes',
    'coming',
    'tell',
    'know',
    'think',
    'look',
    'want',
    'give',
    'take',
  ]);

  const terms: string[] = [];
  const seen = new Set<string>();
  const quotedRe = /["'`]([^"'`]+)["'`]/g;
  let match: RegExpExecArray | null;

  while ((match = quotedRe.exec(question)) !== null) {
    const term = match[1]!.trim();
    if (term && !seen.has(term.toLowerCase())) {
      seen.add(term.toLowerCase());
      terms.push(term);
    }
  }

  const identRe = /\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b/g;
  while ((match = identRe.exec(question)) !== null) {
    const word = match[0]!;
    const lower = word.toLowerCase();
    if (stopWords.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    terms.push(word);
  }

  const extraTerms: string[] = [];
  for (const term of terms) {
    const parts = term
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/_/g, ' ')
      .split(/\s+/)
      .map(part => part.toLowerCase())
      .filter(part => part.length > 2 && !stopWords.has(part));

    for (const part of parts) {
      if (!seen.has(part)) {
        seen.add(part);
        extraTerms.push(part);
      }
    }
  }

  return [...terms, ...extraTerms];
}

function uniqueNonEmpty(values: Array<string | null | undefined>, maxCount: number) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= maxCount) break;
  }
  return out;
}

function buildSummary(
  question: string,
  citations: Array<{ file: string; line: number; text: string }>,
) {
  if (citations.length === 0) return `No relevant code locations found for: "${question}".`;
  const grouped = new Map<string, Array<{ line: number; text: string }>>();
  for (const citation of citations) {
    const items = grouped.get(citation.file) ?? [];
    items.push({ line: citation.line, text: citation.text });
    grouped.set(citation.file, items);
  }

  const parts = [
    `Found ${citations.length} relevant location(s) across ${grouped.size} file(s):\n`,
  ];
  for (const [file, fileCitations] of grouped.entries()) {
    const refs = fileCitations
      .map(
        citation =>
          `  - L${citation.line}: ${citation.text.slice(0, 120)}${citation.text.length > 120 ? '…' : ''}`,
      )
      .join('\n');
    parts.push(`• ${file}\n${refs}`);
  }
  return parts.join('\n');
}

const CI_PATTERNS: Array<{
  re: RegExp;
  classification: CiClassification;
  weight: number;
  description: string;
}> = [
  {
    re: /\b(AssertionError|assertion failed|expected\b.*\bto (equal|be|contain)|toEqual|toBe\(|assert\.\w+)/i,
    classification: 'your_change',
    weight: 8,
    description: 'test assertion failure',
  },
  {
    re: /\b(TypeError|ReferenceError|NullPointerException|AttributeError|NameError|UndefinedFieldError)\b/,
    classification: 'your_change',
    weight: 7,
    description: 'runtime exception thrown by the code under test',
  },
  {
    re: /Cannot find module ['"][^'"]+['"]|ModuleNotFoundError: No module named/,
    classification: 'dependency',
    weight: 8,
    description: 'missing module at import time',
  },
  {
    re: /\b(npm ERR!|yarn error|pnpm ERR_|pip install\b.*\b(failed|ERROR)|cargo (build|fetch).*error)\b/i,
    classification: 'dependency',
    weight: 8,
    description: 'package manager install/build failure',
  },
  {
    re: /(EINTEGRITY|integrity check failed|signature mismatch|checksum mismatch)/i,
    classification: 'dependency',
    weight: 9,
    description: 'package integrity / checksum failure',
  },
  {
    re: /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|read ECONNRESET|getaddrinfo ENOTFOUND)\b/,
    classification: 'infra',
    weight: 8,
    description: 'network error reaching a remote host',
  },
  {
    re: /(JavaScript heap out of memory|OutOfMemoryError|MemoryError|killed: 9|Killed\b.*signal 9|oom-killer)/i,
    classification: 'infra',
    weight: 8,
    description: 'process killed by the runner (out of memory)',
  },
  {
    re: /(no space left on device|disk quota exceeded|ENOSPC)/i,
    classification: 'infra',
    weight: 9,
    description: 'CI runner out of disk space',
  },
  {
    re: /(rate ?limit(ed)?|429 Too Many Requests|GH008|abuse detection)/i,
    classification: 'infra',
    weight: 6,
    description: 'upstream rate limit or abuse detection',
  },
  {
    re: /\b(Timeout|Timed out|exceeded\s+\d+\s*(ms|s|seconds)|Test timeout of)\b/i,
    classification: 'flaky_test',
    weight: 5,
    description: 'test or step timed out',
  },
  {
    re: /\b(retry|retried|attempt \d+ of \d+|flaky|intermittent)\b/i,
    classification: 'flaky_test',
    weight: 4,
    description: 'log mentions retries or flakiness',
  },
  {
    re: /Element (not|is not) (visible|attached|interactable)|StaleElementReferenceException/i,
    classification: 'flaky_test',
    weight: 5,
    description: 'browser/UI race condition',
  },
  {
    re: /\b(snapshot does not match|snapshot file does not match|toMatchSnapshot)\b/i,
    classification: 'your_change',
    weight: 6,
    description: 'snapshot test diff -- usually intentional and needs updating',
  },
  {
    re: /(Permission denied|EACCES|sudo: required)/i,
    classification: 'infra',
    weight: 6,
    description: 'permission/access error on the CI runner',
  },
  {
    re: /\bdocker (pull|push|build).*\b(error|failed|denied)\b/i,
    classification: 'infra',
    weight: 7,
    description: 'docker registry or build failure',
  },
  {
    re: /\bSegmentation fault|SIGSEGV|fatal error: runtime: \w+\b/,
    classification: 'your_change',
    weight: 7,
    description: 'native crash or runtime fatal error',
  },
];

function lineMentioning(text: string, re: RegExp) {
  for (const line of text.split(/\r?\n/)) {
    if (re.test(line)) return line.trim().slice(0, 240);
  }
  return null;
}

function triageCi(text: string, recentChanges: string | null) {
  const tally = new Map<CiClassification, number>();
  const signals: string[] = [];
  const highlighted: string[] = [];

  for (const { re, classification, weight, description } of CI_PATTERNS) {
    const line = lineMentioning(text, re);
    if (!line) continue;
    tally.set(classification, (tally.get(classification) ?? 0) + weight);
    signals.push(`${description} (${classification})`);
    highlighted.push(line);
  }

  let bestClass: CiClassification = 'unknown';
  let bestScore = 0;
  for (const [cls, score] of tally.entries()) {
    if (score > bestScore) {
      bestScore = score;
      bestClass = cls;
    }
  }

  const totalScore = Array.from(tally.values()).reduce((a, b) => a + b, 0);
  const confidence = totalScore === 0 ? 0 : Math.min(0.99, bestScore / totalScore);
  if (bestClass === 'unknown' && recentChanges)
    signals.push(`no diagnostic patterns matched; recent change context: ${recentChanges}`);

  const nextSteps: string[] = [];
  switch (bestClass) {
    case 'your_change':
      nextSteps.push('Reproduce the failing test locally and confirm it fails on the head commit.');
      nextSteps.push(
        'Bisect within the PR if multiple commits are present, then fix or update the assertion.',
      );
      break;
    case 'flaky_test':
      nextSteps.push(
        'Re-run the failing job once. If it passes, file or update a flaky-test ticket and quarantine if it has flaked recently.',
      );
      nextSteps.push(
        'If it fails again, treat as a real failure and inspect for race conditions or timing assumptions.',
      );
      break;
    case 'infra':
      nextSteps.push(
        'Check CI runner status / provider status page; the failure is likely outside the code.',
      );
      nextSteps.push(
        'Re-run after confirming the runner has recovered; do not patch the code blindly.',
      );
      break;
    case 'dependency':
      nextSteps.push(
        'Verify the lockfile and registry availability; reproduce the install locally.',
      );
      nextSteps.push('If a dependency moved, pin the prior version or update affected call sites.');
      break;
    case 'unknown':
      nextSteps.push(
        'Open the full job log and search for the first ERROR / FAIL line; the patterns here did not match.',
      );
      nextSteps.push(
        'If you can share more of the log, re-run this triage with the surrounding context.',
      );
      break;
  }

  return {
    classification: bestClass,
    confidence: Number(confidence.toFixed(2)),
    signals: uniqueNonEmpty(signals, 12),
    highlighted_lines: uniqueNonEmpty(highlighted, 8),
    next_steps: nextSteps,
  };
}

function parseConflictMarkers(text: string, defaultOurs: string, defaultTheirs: string) {
  const lines = text.split(/\r?\n/);
  const out: Array<{ oursLabel: string; theirsLabel: string; ours: string[]; theirs: string[] }> =
    [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const startMatch = /^<{7}\s*(.*)$/.exec(line);
    if (!startMatch) {
      index++;
      continue;
    }

    const oursLabel = startMatch[1]!.trim() || defaultOurs;
    const ours: string[] = [];
    const theirs: string[] = [];
    let theirsLabel = defaultTheirs;
    let phase: 'ours' | 'theirs' = 'ours';
    index++;

    while (index < lines.length) {
      const current = lines[index]!;
      if (/^={7}\s*$/.test(current)) {
        phase = 'theirs';
        index++;
        continue;
      }
      const endMatch = /^>{7}\s*(.*)$/.exec(current);
      if (endMatch) {
        const label = endMatch[1]!.trim();
        if (label) theirsLabel = label;
        index++;
        break;
      }
      if (phase === 'ours') ours.push(current);
      else theirs.push(current);
      index++;
    }

    out.push({ oursLabel, theirsLabel, ours, theirs });
  }
  return out;
}

function summarizeIntent(lines: string[]) {
  if (lines.length === 0) return 'removes this region entirely';
  const trimmed = lines.map(line => line.trim()).filter(Boolean);
  if (trimmed.length === 0) return 'leaves only whitespace in this region';
  const head = trimmed[0]!;
  if (/^(import|from|require|use\s)/.test(head)) return 'adjusts imports / declarations';
  if (/^(export\s|public\s|def\s|fn\s|function\s|class\s|interface\s|type\s)/.test(head))
    return 'changes a top-level declaration';
  if (/^(if|else|switch|case|for|while|return|throw|raise|try|catch|except)\b/.test(head))
    return 'rewrites control flow';
  if (/[=:]/.test(head)) return 'updates an assignment / configuration value';
  if (lines.length > 8) return `replaces this block with ~${lines.length} lines`;
  return `applies a small edit (${lines.length} line(s))`;
}

function classifyOverlap(ours: string[], theirs: string[]) {
  const normalize = (values: string[]) =>
    values
      .map(value => value.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
  const a = normalize(ours);
  const b = normalize(theirs);
  if (a === b) return 'whitespace';
  if (a === '' || b === '') return 'logical';
  if (a.toLowerCase() === b.toLowerCase()) return 'cosmetic';
  return 'logical';
}

function recommendStrategy(
  ours: string[],
  theirs: string[],
  overlap: 'logical' | 'whitespace' | 'cosmetic' | 'unknown',
) {
  if (overlap === 'whitespace')
    return { strategy: 'pick_ours', rationale: 'Both sides are equivalent ignoring whitespace.' };
  if (overlap === 'cosmetic')
    return {
      strategy: 'pick_ours',
      rationale:
        'Sides differ only in case/punctuation -- pick either, prefer the side with newer style guide.',
    };
  if (ours.length === 0)
    return {
      strategy: 'pick_theirs',
      rationale:
        'Our side removed the region; theirs added content. Keep theirs unless the removal was deliberate.',
    };
  if (theirs.length === 0)
    return {
      strategy: 'pick_ours',
      rationale:
        'Their side removed the region; ours added content. Keep ours unless the removal was deliberate.',
    };
  const looksAdditive = (values: string[]) =>
    values.length > 0 &&
    values.every(value =>
      /^(import|from|require|use\s|export\s|"\w[^"]*"\s*:|\s*\w[\w-]*\s*:)/.test(value.trim()),
    );
  if (looksAdditive(ours) && looksAdditive(theirs)) {
    return {
      strategy: 'merge_both',
      rationale: 'Both sides look additive (imports / config entries). Combine and dedupe.',
    };
  }
  return {
    strategy: 'manual',
    rationale:
      'Sides express different logical intents -- read both summaries and craft a deliberate merge.',
  };
}

function parseJsFrame(line: string): StackFrame | null {
  const match =
    /^\s*at\s+(?:(.*?)\s+\()?(.*?):(\d+):(\d+)\)?\s*$/.exec(line) ??
    /^\s*at\s+(.*?):(\d+):(\d+)\s*$/.exec(line);
  if (!match) return null;

  if (match.length === 5) {
    return {
      raw: line,
      functionName: match[1] ? match[1].trim() || null : null,
      file: match[2] ? match[2].trim() : null,
      line: Number.parseInt(match[3]!, 10),
      column: Number.parseInt(match[4]!, 10),
    };
  }

  return {
    raw: line,
    functionName: null,
    file: match[1] ? match[1].trim() : null,
    line: Number.parseInt(match[2]!, 10),
    column: Number.parseInt(match[3]!, 10),
  };
}

function parsePythonFrame(line: string): StackFrame | null {
  const match = /^\s*File "(.+?)", line (\d+)(?:, in (.+))?\s*$/.exec(line);
  if (!match) return null;
  return {
    raw: line,
    functionName: match[3]?.trim() || null,
    file: match[1]!.trim(),
    line: Number.parseInt(match[2]!, 10),
    column: null,
  };
}

function parseFrames(stacktrace: string) {
  const frames: StackFrame[] = [];
  for (const rawLine of stacktrace.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const frame = parseJsFrame(line) ?? parsePythonFrame(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

function extractMessageCandidates(stacktrace: string) {
  const lines = stacktrace
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !/^\s*at\s+/.test(line))
    .filter(line => !/^\s*File ".+?", line \d+/.test(line));

  const weighted = lines.filter(line =>
    /(error|exception|panic|failed|failure|cannot|undefined|null)/i.test(line),
  );
  return uniqueNonEmpty(
    weighted.length > 0 ? weighted : lines.slice(-MAX_MESSAGE_CANDIDATES),
    MAX_MESSAGE_CANDIDATES,
  );
}

function buildSignals(
  messages: string[],
  functions: string[],
  files: string[],
  contextHint: string | null,
) {
  const signals: Array<{ kind: SearchEvidence['kind']; query: string; weight: number }> = [];
  for (const message of messages) signals.push({ kind: 'message', query: message, weight: 1.0 });
  for (const fn of functions) signals.push({ kind: 'function', query: fn, weight: 0.75 });
  for (const file of files) signals.push({ kind: 'file', query: file, weight: 0.5 });
  if (contextHint && contextHint.trim() !== '')
    signals.push({ kind: 'context_hint', query: contextHint.trim(), weight: 0.35 });
  return signals;
}

async function safeReadSnippet(path: string, lineNumber: number): Promise<SnippetEvidence | null> {
  if (lineNumber < 1) return null;
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }

  const text = await readFile(path, 'utf8');
  const lines = text.split(/\r?\n/);
  const start = Math.max(0, lineNumber - 1 - Math.floor(MAX_SNIPPET_LINES / 2));
  const end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
  return { path, line: lineNumber, snippet: lines.slice(start, end).join('\n') };
}

function summarizeCandidate(path: string, evidence: Array<SearchEvidence | SnippetEvidence>) {
  const messageEvidence = evidence.find(
    (item): item is SearchEvidence => 'kind' in item && item.kind === 'message',
  );
  if (messageEvidence)
    return `Code near ${path} directly references the traced error text "${messageEvidence.query}".`;
  const functionEvidence = evidence.find(
    (item): item is SearchEvidence => 'kind' in item && item.kind === 'function',
  );
  if (functionEvidence)
    return `Code in ${path} matches traced function or symbol "${functionEvidence.query}".`;
  return `Code in ${path} aligns with files referenced by the stacktrace.`;
}

function normalizeConfidence(score: number, topScore: number) {
  if (score <= 0 || topScore <= 0) return 0;
  const ratio = score / topScore;
  const adjusted = 0.35 + ratio * 0.64;
  return Math.round(Math.min(0.99, adjusted) * 100) / 100;
}

export function createGitLogTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Show recent commit history for the repository, or for a specific file or directory.',
    inputSchema: z.object({
      path: z.string().nullable().optional(),
      limit: z.number().int().positive().max(100).nullable().optional(),
    }),
    execute: async ({ path, limit }) => {
      const cwd = process.cwd();
      const target = path ? resolve(cwd, path) : cwd;
      const rootResult = await runUserShell(
        `git -C ${shellEscape(target)} rev-parse --show-toplevel`,
      );
      if (rootResult.exitCode !== 0)
        throw new Error(plain(rootResult.output).trim() || 'not inside a git repository');
      const root = plain(rootResult.output).trim();

      const args = [
        `git -C ${shellEscape(root)} log --date=iso --pretty=format:${shellEscape(LOG_FORMAT)}`,
      ];
      if (limit) args.push(`-${limit}`);
      if (path) args.push('--', shellEscape(path));
      const result = await runUserShell(args.join(' '));
      if (result.exitCode !== 0) throw new Error(plain(result.output).trim() || 'git log failed');

      const commits = plain(result.output)
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => {
          const [commit, author_name, author_email, date, subject] = line.split('\u001f');
          return { commit, author_name, author_email, date, subject };
        });

      return {
        repo: root,
        path: path ?? null,
        limit: limit ?? null,
        count: commits.length,
        commits,
      };
    },
  });
}

export function createCodebaseQATool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Answer a natural-language question about the codebase with exact file:line citations.',
    inputSchema: z.object({
      question: z.string().min(1),
      root: z.string().optional().default('.'),
      glob: z.string().nullable().optional(),
      max_citations: z.number().int().positive().max(MAX_CITATIONS_CAP).optional(),
    }),
    execute: async ({ question, root = '.', glob, max_citations }) => {
      const searchTerms = extractSearchTerms(question);
      const maxCitations = Math.min(max_citations ?? DEFAULT_MAX_CITATIONS, MAX_CITATIONS_CAP);
      if (searchTerms.length === 0) {
        return {
          question,
          search_terms: [],
          citations: [],
          summary: `Could not extract meaningful search terms from: "${question}". Try rephrasing with specific symbol or feature names.`,
        };
      }

      const hitMap = new Map<
        string,
        {
          file: string;
          line: number;
          ref: string;
          text: string;
          snippet: string;
          matched_term: string;
          relevance: number;
        }
      >();
      const rootPath = resolve(root);

      for (const term of searchTerms) {
        const result = await searchWorkspace(runUserShell, {
          query: term,
          root,
          glob: glob ?? null,
          caseSensitive: false,
          fixedString: true,
        });
        for (const match of result.matches.slice(0, MAX_SEARCH_HITS_PER_TERM)) {
          const key = `${match.path}:${match.line}`;
          const existing = hitMap.get(key);
          const termIndex = searchTerms.indexOf(term);
          const positionWeight = 1.0 - termIndex * (0.6 / Math.max(searchTerms.length, 1));
          const addedRelevance = Math.max(0.1, positionWeight);
          if (existing) {
            existing.relevance += addedRelevance;
            if (!existing.matched_term.includes(term)) existing.matched_term += `, ${term}`;
            continue;
          }

          const relPath = relative(rootPath, resolve(match.path)) || match.path;
          hitMap.set(key, {
            file: relPath,
            line: match.line,
            ref: `file://${relPath}#L${match.line}`,
            text: match.text.trim(),
            snippet: '',
            matched_term: term,
            relevance: addedRelevance,
          });
        }
      }

      const ranked = [...hitMap.values()]
        .sort(
          (a, b) => b.relevance - a.relevance || a.file.localeCompare(b.file) || a.line - b.line,
        )
        .slice(0, maxCitations);

      await Promise.all(
        ranked.map(async citation => {
          citation.snippet = await readSnippet(resolve(root, citation.file), citation.line);
          citation.relevance = Math.round(citation.relevance * 100) / 100;
        }),
      );

      return {
        question,
        search_terms: searchTerms,
        citations: ranked,
        summary: buildSummary(question, ranked),
      };
    },
  });
}

export function createStacktraceRootCauseTool({ runUserShell }: ToolFactoryOptions) {
  return tool({
    description:
      'Analyze a pasted stacktrace, search the repository for supporting evidence, and rank likely root causes.',
    inputSchema: z.object({
      stacktrace: z.string().min(1),
      limit: z.number().int().positive().max(MAX_ROOT_CAUSE_LIMIT).optional(),
      context_hint: z.string().optional(),
    }),
    execute: async ({ stacktrace, limit, context_hint }) => {
      const frames = parseFrames(stacktrace);
      const messageCandidates = extractMessageCandidates(stacktrace);
      const functionCandidates = uniqueNonEmpty(
        frames.map(frame => frame.functionName),
        MAX_FUNCTION_CANDIDATES,
      );
      const fileCandidates = uniqueNonEmpty(
        frames.map(frame => (frame.file ? basename(frame.file) : null)),
        MAX_FILE_CANDIDATES,
      );
      const signals = buildSignals(
        messageCandidates,
        functionCandidates,
        fileCandidates,
        context_hint ?? null,
      );
      const candidates = new Map<
        string,
        { path: string; score: number; evidence: Array<SearchEvidence | SnippetEvidence> }
      >();

      for (const signal of signals) {
        const result = await searchWorkspace(runUserShell, {
          query: signal.query,
          root: '.',
          caseSensitive: false,
          fixedString: true,
        });
        for (const match of result.matches.slice(0, MAX_QUERY_RESULTS)) {
          const existing = candidates.get(match.path) ?? {
            path: match.path,
            score: 0,
            evidence: [],
          };
          existing.score += signal.weight;
          existing.evidence.push({
            path: match.path,
            line: match.line,
            kind: signal.kind,
            query: signal.query,
            text: match.text,
          });
          candidates.set(match.path, existing);
        }
      }

      for (const frame of frames) {
        if (!frame.file || frame.line === null) continue;
        const resolved = resolve(frame.file);
        const snippet = await safeReadSnippet(resolved, frame.line);
        if (!snippet) continue;
        const existing = candidates.get(resolved) ?? { path: resolved, score: 0, evidence: [] };
        existing.score += 1.25;
        existing.evidence.push(snippet);
        candidates.set(resolved, existing);
      }

      const ranked = [...candidates.values()]
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, limit ?? DEFAULT_ROOT_CAUSE_LIMIT);
      const topScore = ranked[0]?.score ?? 0;

      return {
        extracted_signals: {
          message_candidates: messageCandidates,
          frame_count: frames.length,
          file_candidates: fileCandidates,
          function_candidates: functionCandidates,
        },
        likely_causes: ranked.map(candidate => {
          const evidence = candidate.evidence.slice(0, 4);
          return {
            summary: summarizeCandidate(candidate.path, evidence),
            confidence: normalizeConfidence(candidate.score, topScore),
            evidence,
          };
        }),
      };
    },
  });
}

export function createFailureTriagerTool(_: ToolFactoryOptions) {
  return tool({
    description: 'Triage a CI failure log or a merge-conflict file and suggest next steps.',
    inputSchema: z.object({
      kind: z.enum(['ci', 'merge_conflict']),
      text: z.string().min(1),
      file_path: z.string().optional(),
      ours_label: z.string().optional(),
      theirs_label: z.string().optional(),
      recent_changes_summary: z.string().optional(),
    }),
    execute: async ({
      kind,
      text,
      file_path,
      ours_label,
      theirs_label,
      recent_changes_summary,
    }) => {
      if (text.length > MAX_TEXT_LENGTH) {
        throw new Error(
          `text is too long (${text.length} chars); max supported is ${MAX_TEXT_LENGTH}`,
        );
      }

      if (kind === 'ci') {
        return { kind, ci: triageCi(text, recent_changes_summary ?? null), merge_conflict: null };
      }

      const raw = parseConflictMarkers(text, ours_label ?? 'ours', theirs_label ?? 'theirs');
      if (raw.length === 0) throw new Error('No merge conflict markers found in supplied text.');
      const conflicts = raw.map((conflict, index) => {
        const overlap = classifyOverlap(conflict.ours, conflict.theirs);
        const { strategy, rationale } = recommendStrategy(conflict.ours, conflict.theirs, overlap);
        return {
          index: index + 1,
          file_path: file_path ?? null,
          ours_label: ours_label ?? conflict.oursLabel,
          theirs_label: theirs_label ?? conflict.theirsLabel,
          ours: { intent: summarizeIntent(conflict.ours), key_lines: conflict.ours.slice(0, 6) },
          theirs: {
            intent: summarizeIntent(conflict.theirs),
            key_lines: conflict.theirs.slice(0, 6),
          },
          overlap,
          recommended_strategy: strategy,
          rationale,
        };
      });

      return {
        kind,
        ci: null,
        merge_conflict: {
          file_path: file_path ?? null,
          total_conflicts: conflicts.length,
          conflicts,
        },
      };
    },
  });
}

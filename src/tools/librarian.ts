import { generateText, stepCountIs, tool, type ModelMessage } from 'ai';
import { z } from 'zod';

import { createOpenAIProviderOptions, SYSTEM_PROMPT } from '@/config';
import { loadCueCloudModel } from '@/cloud/openai';
import { plain } from '@/text';
import type { ToolFactoryOptions } from './types';

const GITHUB_API_BASE_URL = 'https://api.github.com';
const MAX_PAGE_SIZE = 100;
const MAX_PATCH_CHARS = 4_096;
const DEFAULT_LIBRARIAN_STEPS = 6;
const MAX_LIBRARIAN_STEPS = 10;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

type SubagentContext = {
  subagentDepth?: number;
};

function normalizeRepository(input: string) {
  const trimmed = input.trim();
  const cleaned = trimmed
    .replace(/^git@github\.com:/, '')
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/^github\.com\//, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');

  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(cleaned)) {
    throw new Error(`invalid GitHub repository: ${input}`);
  }

  return {
    repo: cleaned,
    url: `https://github.com/${cleaned}`
  };
}

function githubHeaders(extra: HeadersInit = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'cue',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra
  } satisfies HeadersInit;
}

async function fetchGitHubJson<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${GITHUB_API_BASE_URL}/${path.replace(/^\//, '')}`, {
    ...init,
    headers: githubHeaders(init.headers)
  });

  let data: T | null = null;
  try {
    data = (await response.json()) as T;
  } catch {
    data = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    data
  };
}

function getPage(limit: number, offset: number) {
  if (offset % limit !== 0) {
    throw new Error(`offset (${offset}) must be divisible by limit (${limit}) for pagination`);
  }

  return Math.floor(offset / limit) + 1;
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... (truncated)`;
}

function decodeGitHubContent(content: string, encoding: string) {
  if (encoding === 'base64') return Buffer.from(content.replace(/\n/g, ''), 'base64').toString('utf8');
  return content;
}

function splitLinesWithNumbers(content: string, readRange?: { start: number; end: number }) {
  const lines = content.split('\n');
  const start = readRange ? Math.max(1, readRange.start) : 1;
  const end = readRange ? Math.max(start, readRange.end) : lines.length;
  const selected = lines.slice(start - 1, end);

  return selected.map((line, index) => `${start + index}: ${line}`).join('\n');
}

function latestUserMessage(messages: ModelMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'user') continue;

    if (typeof message.content === 'string' && message.content.trim()) return message.content.trim();
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part: unknown) => {
          const record = asRecord(part);
          return record?.type === 'text' && typeof record.text === 'string' ? record.text : '';
        })
        .join('\n')
        .trim();
      if (text) return text;
    }
  }

  return null;
}

export function createReadGitHubTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Read a file from a GitHub repository using the GitHub API. Best for inspecting public repository files outside the current workspace. Supports optional line ranges.',
    inputSchema: z.object({
      path: z.string().min(1),
      repository: z.string().min(1),
      read_range: z
        .object({
          start: z.number().int().positive(),
          end: z.number().int().positive()
        })
        .optional()
    }),
    execute: async ({ path, repository, read_range }) => {
      const { repo, url } = normalizeRepository(repository);
      const cleanPath = path.replace(/^\/+/, '');
      const response = await fetchGitHubJson<{ content: string; encoding: string; type: string }>(`repos/${repo}/contents/${cleanPath}`);

      if (!response.ok || !response.data) {
        throw new Error(`failed to read ${cleanPath} from ${url}: ${response.status} ${response.statusText}`);
      }

      if (response.data.type !== 'file') {
        throw new Error(`${cleanPath} is not a file in ${url}`);
      }

      const content = decodeGitHubContent(response.data.content, response.data.encoding);
      const numbered = splitLinesWithNumbers(content, read_range);
      const size = Buffer.byteLength(numbered, 'utf8');

      if (size > 128 * 1024) {
        throw new Error('file output is too large; retry with a smaller read_range');
      }

      return {
        repository: url,
        path: cleanPath,
        content: numbered
      };
    }
  });
}

export function createSearchGitHubTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Search code in a GitHub repository using the GitHub code search API. Best for public-repo code exploration by pattern, symbol, or text.',
    inputSchema: z.object({
      pattern: z.string().min(1),
      repository: z.string().min(1),
      path: z.string().optional(),
      limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(30),
      offset: z.number().int().min(0).default(0)
    }),
    execute: async ({ pattern, repository, path, limit = 30, offset = 0 }) => {
      const { repo, url } = normalizeRepository(repository);
      const perPage = Math.min(limit, MAX_PAGE_SIZE);
      const page = getPage(perPage, offset);
      const query = [pattern, `repo:${repo}`, path && path !== '.' ? `path:${path}` : null].filter(Boolean).join(' ');
      const response = await fetchGitHubJson<{
        total_count: number;
        items: Array<{
          path: string;
          text_matches?: Array<{ fragment: string; property: string }>;
        }>;
      }>(`search/code?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}`, {
        headers: {
          Accept: 'application/vnd.github.text-match+json'
        }
      });

      if (!response.ok || !response.data) {
        throw new Error(`failed to search ${url}: ${response.status} ${response.statusText}`);
      }

      const grouped = new Map<string, string[]>();
      for (const item of response.data.items ?? []) {
        const file = item.path;
        if (!grouped.has(file)) grouped.set(file, []);

        const fragments = (item.text_matches ?? [])
          .filter(match => match.property === 'content' && typeof match.fragment === 'string' && match.fragment.trim())
          .map(match => truncate(match.fragment.trim(), 2_048));

        if (fragments.length === 0) grouped.get(file)!.push('(match found, excerpt unavailable)');
        else grouped.get(file)!.push(...fragments);
      }

      return {
        repository: url,
        results: Array.from(grouped.entries()).map(([file, chunks]) => ({ file, chunks })),
        totalCount: response.data.total_count ?? 0
      };
    }
  });
}

export function createListDirectoryGitHubTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'List the contents of a directory in a GitHub repository using the GitHub contents API. Useful for exploring repository structure before reading or searching files.',
    inputSchema: z.object({
      path: z.string().default('.'),
      repository: z.string().min(1),
      limit: z.number().int().positive().max(1_000).default(100)
    }),
    execute: async ({ path = '.', repository, limit = 100 }) => {
      const { repo, url } = normalizeRepository(repository);
      const cleanPath = path === '.' ? '' : path.replace(/^\/+/, '');
      const response = await fetchGitHubJson<Array<{ name: string; type: 'file' | 'dir' }>>(`repos/${repo}/contents/${cleanPath}`);

      if (!response.ok || !response.data) {
        throw new Error(`failed to list ${cleanPath || '.'} in ${url}: ${response.status} ${response.statusText}`);
      }

      const entries = response.data
        .map(item => (item.type === 'dir' ? `${item.name}/` : item.name))
        .sort((left, right) => {
          const leftDir = left.endsWith('/');
          const rightDir = right.endsWith('/');
          if (leftDir !== rightDir) return leftDir ? -1 : 1;
          return left.localeCompare(right);
        })
        .slice(0, limit);

      return {
        repository: url,
        path: cleanPath || '.',
        entries
      };
    }
  });
}

export function createListRepositoriesTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Search public GitHub repositories by name, organization, and language. Useful for discovering candidate repositories before deeper inspection.',
    inputSchema: z.object({
      pattern: z.string().optional(),
      organization: z.string().optional(),
      language: z.string().optional(),
      limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(30),
      offset: z.number().int().min(0).default(0)
    }),
    execute: async ({ pattern, organization, language, limit = 30, offset = 0 }) => {
      const perPage = Math.min(limit, MAX_PAGE_SIZE);
      const page = getPage(perPage, offset);
      const query = [
        pattern ? `${pattern} in:name` : 'stars:>1',
        organization ? `org:${organization}` : null,
        language ? `language:${language}` : null,
        'is:public'
      ]
        .filter(Boolean)
        .join(' ');

      const response = await fetchGitHubJson<{
        total_count: number;
        items: Array<{
          full_name: string;
          description: string | null;
          language: string | null;
          stargazers_count: number;
          forks_count: number;
          html_url: string;
        }>;
      }>(`search/repositories?q=${encodeURIComponent(query)}&per_page=${perPage}&page=${page}&sort=stars&order=desc`);

      if (!response.ok || !response.data) {
        throw new Error(`failed to search repositories: ${response.status} ${response.statusText}`);
      }

      return {
        repositories: (response.data.items ?? []).map(item => ({
          name: item.full_name,
          url: item.html_url,
          description: item.description,
          language: item.language,
          stargazersCount: item.stargazers_count,
          forksCount: item.forks_count
        })),
        totalCount: response.data.total_count ?? 0
      };
    }
  });
}

export function createCommitSearchTool(_: ToolFactoryOptions) {
  return tool({
    description:
      'Search commits in a GitHub repository by query, author, date, or path. Useful for understanding when changes happened and who made them.',
    inputSchema: z.object({
      repository: z.string().min(1),
      query: z.string().optional(),
      author: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      path: z.string().optional(),
      limit: z.number().int().positive().max(MAX_PAGE_SIZE).default(30),
      offset: z.number().int().min(0).default(0)
    }),
    execute: async ({ repository, query, author, since, until, path, limit = 30, offset = 0 }) => {
      const { repo, url } = normalizeRepository(repository);
      const perPage = Math.min(limit, MAX_PAGE_SIZE);
      const page = getPage(perPage, offset);

      if (path || !query) {
        const params = new URLSearchParams({ per_page: String(perPage), page: String(page) });
        if (author) params.set('author', author);
        if (since) params.set('since', since);
        if (until) params.set('until', until);
        if (path) params.set('path', path);

        const response = await fetchGitHubJson<
          Array<{
            sha: string;
            commit: {
              message: string;
              author: { name: string; email: string; date: string };
            };
          }>
        >(`repos/${repo}/commits?${params.toString()}`);

        if (!response.ok || !response.data) {
          throw new Error(`failed to list commits for ${url}: ${response.status} ${response.statusText}`);
        }

        const filtered = (response.data ?? []).filter(item => {
          if (!query) return true;
          const haystack = `${item.commit.message}\n${item.commit.author.name}\n${item.commit.author.email}`.toLowerCase();
          return haystack.includes(query.toLowerCase());
        });

        return {
          repository: url,
          commits: filtered.map(item => ({
            sha: item.sha,
            message: truncate(item.commit.message.trim(), 1_024),
            author: item.commit.author
          })),
          totalCount: filtered.length
        };
      }

      const searchTerms = [
        query,
        `repo:${repo}`,
        author ? `author:${author}` : null,
        since ? `author-date:>=${since}` : null,
        until ? `author-date:<=${until}` : null
      ]
        .filter(Boolean)
        .join(' ');
      const response = await fetchGitHubJson<{
        total_count: number;
        items: Array<{
          sha: string;
          commit: {
            message: string;
            author: { name: string; email: string; date: string };
          };
        }>;
      }>(`search/commits?q=${encodeURIComponent(searchTerms)}&per_page=${perPage}&page=${page}&sort=author-date&order=desc`, {
        headers: {
          Accept: 'application/vnd.github+json'
        }
      });

      if (!response.ok || !response.data) {
        throw new Error(`failed to search commits for ${url}: ${response.status} ${response.statusText}`);
      }

      return {
        repository: url,
        commits: (response.data.items ?? []).map(item => ({
          sha: item.sha,
          message: truncate(item.commit.message.trim(), 1_024),
          author: item.commit.author
        })),
        totalCount: response.data.total_count ?? 0
      };
    }
  });
}

export function createDiffTool(_: ToolFactoryOptions) {
  return tool({
    description: 'Compare two commits, branches, or tags in a GitHub repository. Returns file-level change metadata and optional truncated patches.',
    inputSchema: z.object({
      base: z.string().min(1),
      head: z.string().min(1),
      repository: z.string().min(1),
      includePatches: z.boolean().default(false)
    }),
    execute: async ({ base, head, repository, includePatches = false }) => {
      const { repo, url } = normalizeRepository(repository);
      const response = await fetchGitHubJson<{
        base_commit: { sha: string; commit: { message: string } };
        commits: Array<{ sha: string; commit: { message: string } }>;
        ahead_by: number;
        behind_by: number;
        total_commits: number;
        files?: Array<{
          sha: string;
          filename: string;
          status: string;
          additions: number;
          deletions: number;
          changes: number;
          patch?: string;
          previous_filename?: string;
          blob_url: string;
          raw_url: string;
          contents_url: string;
        }>;
      }>(`repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);

      if (!response.ok || !response.data) {
        throw new Error(`failed to diff ${base}...${head} in ${url}: ${response.status} ${response.statusText}`);
      }

      const headCommit = response.data.commits?.[response.data.commits.length - 1];

      return {
        repository: url,
        files: (response.data.files ?? []).map(file => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          previous_filename: file.previous_filename,
          sha: file.sha,
          blob_url: file.blob_url,
          raw_url: file.raw_url,
          contents_url: file.contents_url,
          patch: includePatches && file.patch ? truncate(file.patch, MAX_PATCH_CHARS) : undefined
        })),
        base_commit: {
          sha: response.data.base_commit?.sha ?? base,
          message: response.data.base_commit?.commit?.message?.trim() ?? ''
        },
        head_commit: {
          sha: headCommit?.sha ?? head,
          message: headCommit?.commit?.message?.trim() ?? ''
        },
        ahead_by: response.data.ahead_by,
        behind_by: response.data.behind_by,
        total_commits: response.data.total_commits
      };
    }
  });
}

export function createLibrarianTool(options: ToolFactoryOptions) {
  const tools = {
    read_github: createReadGitHubTool(options),
    search_github: createSearchGitHubTool(options),
    list_directory_github: createListDirectoryGitHubTool(options),
    list_repositories: createListRepositoriesTool(options),
    commit_search: createCommitSearchTool(options),
    diff: createDiffTool(options)
  };

  return tool({
    description:
      'Delegate GitHub repository research to a focused librarian subagent. Best for exploring public GitHub repos, finding files, reading code, inspecting diffs, and searching commit history.',
    inputSchema: z.object({
      task: z.string().min(1),
      repository: z.string().optional(),
      context: z.string().optional(),
      files: z.array(z.string().min(1)).max(20).optional(),
      maxSteps: z.number().int().positive().max(MAX_LIBRARIAN_STEPS).optional()
    }),
    execute: async ({ task, repository, context, files = [], maxSteps }, execOptions) => {
      const currentContext = (asRecord(execOptions.experimental_context) ?? {}) as SubagentContext;
      const currentDepth = typeof currentContext.subagentDepth === 'number' ? currentContext.subagentDepth : 0;

      if (currentDepth >= 1) {
        throw new Error('nested librarian subagents are currently disabled');
      }

      const model = options.getCurrentModel();
      const thinkingMode = options.getThinkingMode();
      const normalizedRepository = repository ? normalizeRepository(repository).url : undefined;
      const latestUser = latestUserMessage(execOptions.messages) ?? undefined;

      const prompt = [
        `Task:\n${task.trim()}`,
        normalizedRepository ? `Repository:\n${normalizedRepository}` : null,
        context?.trim() ? `Extra context:\n${context.trim()}` : null,
        files.length > 0 ? `Inspect these paths first if relevant:\n- ${files.join('\n- ')}` : null,
        latestUser ? `Latest user request:\n${latestUser}` : null,
        'Work within public GitHub API access unless a token is configured. Return concise findings with concrete evidence.'
      ]
        .filter(Boolean)
        .join('\n\n');

      try {
        const result = await generateText({
          model: await loadCueCloudModel(model),
          system: `${SYSTEM_PROMPT}\n\n<librarian>\n- You are Cue's GitHub librarian subagent.\n- Explore repositories using only the provided GitHub tools.\n- Prefer list_directory_github before broad reads.\n- Use search_github to find likely files, then read_github to inspect them.\n- Use diff and commit_search for history questions.\n- If no repository is provided, use list_repositories first to identify candidates.\n- Final answer format: Verdict, Findings, Evidence, Recommended next step.\n</librarian>`,
          prompt,
          tools,
          stopWhen: stepCountIs(Math.max(1, Math.min(MAX_LIBRARIAN_STEPS, maxSteps ?? DEFAULT_LIBRARIAN_STEPS))),
          providerOptions: createOpenAIProviderOptions(model, thinkingMode),
          experimental_context: { subagentDepth: currentDepth + 1 }
        });

        const summary = plain(result.text).trim();
        if (!summary) throw new Error('librarian returned no summary');

        return {
          repository: normalizedRepository,
          summary,
          steps: result.steps.length,
          toolCalls: result.steps.flatMap(step => step.toolCalls.map(call => call.toolName))
        };
      } catch (error: unknown) {
        throw new Error(`librarian failed: ${plain(error instanceof Error ? error.message : String(error))}`);
      }
    }
  });
}

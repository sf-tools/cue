import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { tool } from 'ai';
import { z } from 'zod';

import { createFileChange, describeFileChange } from '@/file-changes';
import { readOptionalFile, type UndoEntry } from '@/undo';
import type { ToolFactoryOptions } from './types';
import { truncate } from './utils';

type LspLang = 'typescript' | 'python' | 'go' | 'rust';

type LspServerSpec = {
  lang: LspLang;
  langIds: string[];
  command: string;
  args: string[];
  installHint: string;
};

type LspDiagnostic = {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity?: number;
  code?: string | number;
  source?: string;
  message: string;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Session = {
  spec: LspServerSpec;
  proc: ChildProcessWithoutNullStreams;
  rootPath: string;
  rootUri: string;
  initPromise: Promise<void>;
  ready: boolean;
  nextId: number;
  pending: Map<number, Pending>;
  buffer: Buffer;
  openFiles: Map<string, number>;
  diagnostics: Map<string, LspDiagnostic[]>;
  onDiagnostics: Set<(uri: string) => void>;
  exited: boolean;
};

const REQUEST_TIMEOUT_MS = 30000;
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const SERVERS: Record<LspLang, LspServerSpec> = {
  typescript: {
    lang: 'typescript',
    langIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'],
    command: 'typescript-language-server',
    args: ['--stdio'],
    installHint: 'install with `npm i -g typescript-language-server typescript`'
  },
  python: {
    lang: 'python',
    langIds: ['python'],
    command: 'pyright-langserver',
    args: ['--stdio'],
    installHint: 'install with `npm i -g pyright` (or `pip install pyright`)'
  },
  go: {
    lang: 'go',
    langIds: ['go'],
    command: 'gopls',
    args: [],
    installHint: 'install with `go install golang.org/x/tools/gopls@latest`'
  },
  rust: {
    lang: 'rust',
    langIds: ['rust'],
    command: 'rust-analyzer',
    args: [],
    installHint: 'install with `rustup component add rust-analyzer`'
  }
};

const EXT_TO_LANG: Record<string, { lang: LspLang; langId: string }> = {
  '.ts': { lang: 'typescript', langId: 'typescript' },
  '.tsx': { lang: 'typescript', langId: 'typescriptreact' },
  '.mts': { lang: 'typescript', langId: 'typescript' },
  '.cts': { lang: 'typescript', langId: 'typescript' },
  '.js': { lang: 'typescript', langId: 'javascript' },
  '.jsx': { lang: 'typescript', langId: 'javascriptreact' },
  '.mjs': { lang: 'typescript', langId: 'javascript' },
  '.cjs': { lang: 'typescript', langId: 'javascript' },
  '.py': { lang: 'python', langId: 'python' },
  '.pyi': { lang: 'python', langId: 'python' },
  '.go': { lang: 'go', langId: 'go' },
  '.rs': { lang: 'rust', langId: 'rust' }
};

const sessions = new Map<LspLang, Session>();

function pathToUri(filePath: string): string {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  return pathToFileURL(abs).href;
}

function uriToRelative(uri: string, root: string): string {
  try {
    const abs = fileURLToPath(uri);
    if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
    return abs;
  } catch {
    return uri;
  }
}

function langForPath(filePath: string): { lang: LspLang; langId: string } | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? null;
}

function frame(message: object): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8');
  return Buffer.concat([header, body]);
}

function processBuffer(session: Session) {
  while (true) {
    const headerEnd = session.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    const header = session.buffer.slice(0, headerEnd).toString('utf8');
    const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
    if (!lengthMatch) {
      session.buffer = session.buffer.slice(headerEnd + 4);
      continue;
    }

    const bodyLength = Number(lengthMatch[1]);
    const totalLength = headerEnd + 4 + bodyLength;
    if (session.buffer.length < totalLength) return;

    const body = session.buffer.slice(headerEnd + 4, totalLength).toString('utf8');
    session.buffer = session.buffer.slice(totalLength);

    let message: Record<string, unknown>;
    try {
      message = JSON.parse(body) as Record<string, unknown>;
    } catch {
      continue;
    }

    handleMessage(session, message);
  }
}

function handleMessage(session: Session, message: Record<string, unknown>) {
  if (typeof message.id === 'number' && (message.result !== undefined || message.error !== undefined)) {
    const pending = session.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    session.pending.delete(message.id);

    if (message.error) {
      const err = message.error as { message?: string; code?: number };
      pending.reject(new Error(err.message ?? `lsp error ${err.code ?? '?'}`));
    } else {
      pending.resolve(message.result);
    }
    return;
  }

  if (typeof message.method === 'string') {
    if (message.method === 'textDocument/publishDiagnostics' && typeof message.params === 'object' && message.params !== null) {
      const params = message.params as { uri?: string; diagnostics?: LspDiagnostic[] };
      if (typeof params.uri === 'string' && Array.isArray(params.diagnostics)) {
        session.diagnostics.set(params.uri, params.diagnostics);
        for (const listener of session.onDiagnostics) listener(params.uri);
      }
    }

    if (typeof message.id === 'number') {
      const reply = { jsonrpc: '2.0', id: message.id, result: null };
      try {
        session.proc.stdin.write(frame(reply));
      } catch {
        // server gone
      }
    }
  }
}

async function startSession(spec: LspServerSpec, rootPath: string): Promise<Session> {
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(spec.command, spec.args, {
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${spec.command} not available: ${msg}. ${spec.installHint}`);
  }

  const session: Session = {
    spec,
    proc,
    rootPath,
    rootUri: pathToFileURL(rootPath).href,
    initPromise: Promise.resolve(),
    ready: false,
    nextId: 1,
    pending: new Map(),
    buffer: Buffer.alloc(0),
    openFiles: new Map(),
    diagnostics: new Map(),
    onDiagnostics: new Set(),
    exited: false
  };

  proc.stdout.on('data', chunk => {
    session.buffer = Buffer.concat([session.buffer, chunk]);
    if (session.buffer.length > MAX_BUFFER_BYTES) session.buffer = session.buffer.slice(session.buffer.length - MAX_BUFFER_BYTES);
    processBuffer(session);
  });

  proc.on('exit', () => {
    session.exited = true;
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`${spec.command} exited`));
    }
    session.pending.clear();
    sessions.delete(spec.lang);
  });

  proc.on('error', error => {
    session.exited = true;
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
    sessions.delete(spec.lang);
  });

  proc.stderr.on('data', () => {
    // discard — many servers are noisy
  });

  session.initPromise = (async () => {
    await sendRequest(session, 'initialize', {
      processId: process.pid,
      clientInfo: { name: 'cue', version: '1' },
      rootUri: session.rootUri,
      workspaceFolders: [{ uri: session.rootUri, name: 'workspace' }],
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true, didClose: true, didSave: true },
          definition: { linkSupport: false },
          references: {},
          hover: { contentFormat: ['markdown', 'plaintext'] },
          rename: { prepareSupport: false },
          publishDiagnostics: { relatedInformation: true }
        },
        workspace: { workspaceFolders: true, configuration: true }
      }
    });
    sendNotification(session, 'initialized', {});
    session.ready = true;
  })();

  return session;
}

function sendNotification(session: Session, method: string, params: unknown) {
  if (session.exited) return;
  try {
    session.proc.stdin.write(frame({ jsonrpc: '2.0', method, params }));
  } catch {
    // server gone
  }
}

function sendRequest<T = unknown>(session: Session, method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    if (session.exited) {
      rejectPromise(new Error(`${session.spec.command} not running`));
      return;
    }

    const id = session.nextId++;
    const timer = setTimeout(() => {
      session.pending.delete(id);
      rejectPromise(new Error(`lsp request ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    session.pending.set(id, {
      resolve: value => resolvePromise(value as T),
      reject: rejectPromise,
      timer
    });

    try {
      session.proc.stdin.write(frame({ jsonrpc: '2.0', id, method, params }));
    } catch (error) {
      session.pending.delete(id);
      clearTimeout(timer);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function getOrStartSession(lang: LspLang, rootPath: string): Promise<Session> {
  let session = sessions.get(lang);
  if (session && !session.exited) {
    await session.initPromise;
    return session;
  }

  const spec = SERVERS[lang];
  session = await startSession(spec, rootPath);
  sessions.set(lang, session);

  try {
    await session.initPromise;
  } catch (error) {
    sessions.delete(lang);
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`${spec.command} failed to start: ${msg}. ${spec.installHint}`);
  }

  return session;
}

async function ensureOpen(session: Session, filePath: string, langId: string) {
  const abs = isAbsolute(filePath) ? filePath : resolve(filePath);
  const uri = pathToUri(abs);
  const text = await readFile(abs, 'utf8');
  const existing = session.openFiles.get(uri);

  if (existing === undefined) {
    sendNotification(session, 'textDocument/didOpen', {
      textDocument: { uri, languageId: langId, version: 1, text }
    });
    session.openFiles.set(uri, 1);
  } else {
    const nextVersion = existing + 1;
    sendNotification(session, 'textDocument/didChange', {
      textDocument: { uri, version: nextVersion },
      contentChanges: [{ text }]
    });
    session.openFiles.set(uri, nextVersion);
  }

  return { uri, abs, text };
}

function waitForDiagnostics(session: Session, uri: string, timeoutMs: number): Promise<LspDiagnostic[]> {
  return new Promise(resolvePromise => {
    if (session.diagnostics.has(uri)) {
      resolvePromise(session.diagnostics.get(uri) ?? []);
      return;
    }

    const timer = setTimeout(() => {
      session.onDiagnostics.delete(listener);
      resolvePromise(session.diagnostics.get(uri) ?? []);
    }, timeoutMs);

    const listener = (publishedUri: string) => {
      if (publishedUri !== uri) return;
      clearTimeout(timer);
      session.onDiagnostics.delete(listener);
      resolvePromise(session.diagnostics.get(uri) ?? []);
    };

    session.onDiagnostics.add(listener);
  });
}

type LocationLike = { uri: string; range: { start: { line: number; character: number } } };

function asLocations(result: unknown): LocationLike[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result
      .map(entry => {
        if (typeof entry !== 'object' || entry === null) return null;
        const r = entry as Record<string, unknown>;
        if (typeof r.uri === 'string' && typeof r.range === 'object') return r as LocationLike;
        if (typeof r.targetUri === 'string' && typeof r.targetRange === 'object') {
          return { uri: r.targetUri, range: r.targetRange as LocationLike['range'] };
        }
        return null;
      })
      .filter((entry): entry is LocationLike => entry !== null);
  }
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if (typeof r.uri === 'string') return [r as LocationLike];
  }
  return [];
}

function severityName(value: number | undefined): 'error' | 'warning' | 'info' | 'hint' {
  switch (value) {
    case 1:
      return 'error';
    case 2:
      return 'warning';
    case 3:
      return 'info';
    default:
      return 'hint';
  }
}

function renderHoverContents(contents: unknown): string {
  if (!contents) return '(no hover info)';
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) return contents.map(renderHoverContents).filter(Boolean).join('\n\n');
  if (typeof contents === 'object') {
    const r = contents as Record<string, unknown>;
    if (typeof r.value === 'string') return r.value;
    if (typeof r.contents === 'string') return r.contents;
  }
  return '(no hover info)';
}

type WorkspaceEdit = {
  changes?: Record<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>;
  documentChanges?: Array<{
    textDocument?: { uri: string };
    edits?: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>;
  }>;
};

async function applyWorkspaceEdit(
  edit: WorkspaceEdit,
  rootPath: string,
  requestApproval: ToolFactoryOptions['requestApproval'],
  pushUndoEntry: ToolFactoryOptions['pushUndoEntry']
): Promise<string> {
  const editsByUri = new Map<string, Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>>();

  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      const uri = change.textDocument?.uri;
      const list = change.edits;
      if (!uri || !Array.isArray(list)) continue;
      const bucket = editsByUri.get(uri) ?? [];
      bucket.push(...list);
      editsByUri.set(uri, bucket);
    }
  }

  if (edit.changes) {
    for (const [uri, list] of Object.entries(edit.changes)) {
      const bucket = editsByUri.get(uri) ?? [];
      bucket.push(...list);
      editsByUri.set(uri, bucket);
    }
  }

  if (editsByUri.size === 0) return 'no edits to apply';

  const pending: Array<{ path: string; previousContent: string | null; nextContent: string; fileChange: ReturnType<typeof createFileChange> }> = [];

  for (const [uri, edits] of editsByUri.entries()) {
    const filePath = fileURLToPath(uri);
    const previous = await readOptionalFile(filePath);
    if (previous === null) continue;
    const next = applyTextEdits(previous, edits);
    const change = createFileChange(filePath, previous, next);
    pending.push({ path: filePath, previousContent: previous, nextContent: next, fileChange: change });
  }

  if (
    !(await requestApproval({
      scope: 'edit',
      title: 'Apply LSP rename',
      detail: `${pending.length} file${pending.length === 1 ? '' : 's'}`,
      fileChanges: pending.map(item => item.fileChange)
    }))
  ) {
    throw new Error('rename denied by user');
  }

  const undoFiles: UndoEntry['files'] = [];
  for (const item of pending) {
    await writeFile(item.path, item.nextContent);
    undoFiles.push({ path: item.path, previousContent: item.previousContent, nextContent: item.nextContent });
  }

  pushUndoEntry({
    toolName: 'lsp',
    summary: `lsp rename · ${pending.length} file${pending.length === 1 ? '' : 's'}`,
    files: undoFiles
  });

  return pending.map(item => `${uriToRelative(pathToFileURL(item.path).href, rootPath)} · ${describeFileChange(item.fileChange)}`).join('\n');
}

function applyTextEdits(
  source: string,
  edits: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; newText: string }>
): string {
  const lines = source.split('\n');
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sorted) {
    const startLine = edit.range.start.line;
    const startCh = edit.range.start.character;
    const endLine = edit.range.end.line;
    const endCh = edit.range.end.character;

    if (startLine === endLine) {
      const line = lines[startLine] ?? '';
      lines[startLine] = `${line.slice(0, startCh)}${edit.newText}${line.slice(endCh)}`;
      continue;
    }

    const startText = lines[startLine] ?? '';
    const endText = lines[endLine] ?? '';
    const merged = `${startText.slice(0, startCh)}${edit.newText}${endText.slice(endCh)}`;
    lines.splice(startLine, endLine - startLine + 1, merged);
  }

  return lines.join('\n');
}

export function createLspTool({ requestApproval, pushUndoEntry }: ToolFactoryOptions) {
  return tool({
    description:
      'Run language-server requests for semantic understanding: definition, references, hover, rename, diagnostics. Lines and columns are 1-indexed. Spawns the right server (typescript-language-server, pyright, gopls, rust-analyzer) lazily and keeps it alive across calls. Rename requires approval.',
    inputSchema: z.discriminatedUnion('action', [
      z.object({
        action: z.literal('definition'),
        path: z.string().min(1),
        line: z.number().int().positive(),
        column: z.number().int().positive()
      }),
      z.object({
        action: z.literal('references'),
        path: z.string().min(1),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        include_declaration: z.boolean().optional()
      }),
      z.object({
        action: z.literal('hover'),
        path: z.string().min(1),
        line: z.number().int().positive(),
        column: z.number().int().positive()
      }),
      z.object({
        action: z.literal('rename'),
        path: z.string().min(1),
        line: z.number().int().positive(),
        column: z.number().int().positive(),
        new_name: z.string().min(1)
      }),
      z.object({
        action: z.literal('diagnostics'),
        path: z.string().min(1),
        wait_ms: z.number().int().nonnegative().max(15000).optional().describe('How long to wait for the server to publish diagnostics (default 2000).')
      })
    ]),
    execute: async input => {
      const langInfo = langForPath(input.path);
      if (!langInfo) return `error: no LSP server known for ${extname(input.path) || 'this file'}`;

      const cwd = process.cwd();
      const session = await getOrStartSession(langInfo.lang, cwd);
      const { uri } = await ensureOpen(session, input.path, langInfo.langId);

      if (input.action === 'definition' || input.action === 'references' || input.action === 'hover' || input.action === 'rename') {
        const position = { line: input.line - 1, character: input.column - 1 };

        if (input.action === 'definition') {
          const result = await sendRequest(session, 'textDocument/definition', { textDocument: { uri }, position });
          const locations = asLocations(result);
          if (locations.length === 0) return 'no definition found';
          return locations
            .map(loc => `${uriToRelative(loc.uri, cwd)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`)
            .join('\n');
        }

        if (input.action === 'references') {
          const result = await sendRequest(session, 'textDocument/references', {
            textDocument: { uri },
            position,
            context: { includeDeclaration: input.include_declaration ?? true }
          });
          const locations = asLocations(result);
          if (locations.length === 0) return 'no references found';
          return `${locations.length} reference${locations.length === 1 ? '' : 's'}:\n${locations
            .map(loc => `${uriToRelative(loc.uri, cwd)}:${loc.range.start.line + 1}:${loc.range.start.character + 1}`)
            .join('\n')}`;
        }

        if (input.action === 'hover') {
          const result = (await sendRequest(session, 'textDocument/hover', { textDocument: { uri }, position })) as { contents?: unknown } | null;
          if (!result) return '(no hover info)';
          return truncate(renderHoverContents(result.contents), 4000);
        }

        const renameResult = (await sendRequest(session, 'textDocument/rename', {
          textDocument: { uri },
          position,
          newName: input.new_name
        })) as WorkspaceEdit | null;
        if (!renameResult) return 'rename returned no edits';
        return await applyWorkspaceEdit(renameResult, cwd, requestApproval, pushUndoEntry);
      }

      const diagnostics = await waitForDiagnostics(session, uri, input.wait_ms ?? 2000);
      if (diagnostics.length === 0) return `${uriToRelative(uri, cwd)}: no diagnostics`;
      const lines = [`${uriToRelative(uri, cwd)}: ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'}`];
      for (const diag of diagnostics) {
        const code = diag.code !== undefined ? ` [${diag.code}]` : '';
        const source = diag.source ? ` (${diag.source})` : '';
        lines.push(
          `  ${severityName(diag.severity)} ${diag.range.start.line + 1}:${diag.range.start.character + 1}${code}${source} — ${diag.message.replace(/\n/g, ' ')}`
        );
      }
      return truncate(lines.join('\n'), 8000);
    }
  });
}

export function shutdownLspSessions() {
  for (const session of sessions.values()) {
    try {
      sendNotification(session, 'exit', null);
      session.proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  sessions.clear();
}

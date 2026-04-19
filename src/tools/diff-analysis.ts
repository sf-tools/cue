export interface DiffHunk {
  header: string;
  addedLines: string[];
  removedLines: string[];
  contextLines: string[];
}

export interface DiffFile {
  path: string;
  oldPath: string | null;
  isNew: boolean;
  isDeleted: boolean;
  isRename: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export type FileKind =
  | 'src'
  | 'test'
  | 'docs'
  | 'config'
  | 'lockfile'
  | 'deps'
  | 'ci'
  | 'infra'
  | 'migration'
  | 'security'
  | 'asset'
  | 'unknown';

const HEADER_DIFF_GIT = /^diff --git a\/(.+?) b\/(.+?)$/;
const HEADER_OLD = /^---\s+(.+?)$/;
const HEADER_NEW = /^\+\+\+\s+(.+?)$/;
const HEADER_HUNK = /^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@.*$/;

function stripDiffPathPrefix(path: string) {
  if (path === '/dev/null') return path;
  if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
  return path;
}

export function parseUnifiedDiff(text: string): DiffFile[] {
  const lines = text.split(/\r?\n/);
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;

  const flushHunk = () => {
    if (current && hunk) current.hunks.push(hunk);
    hunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of lines) {
    let match = HEADER_DIFF_GIT.exec(line);
    if (match) {
      flushFile();
      current = {
        path: match[2]!,
        oldPath: match[1]!,
        isNew: false,
        isDeleted: false,
        isRename: match[1] !== match[2],
        additions: 0,
        deletions: 0,
        hunks: []
      };
      continue;
    }

    if (!current) {
      match = HEADER_OLD.exec(line);
      if (match) {
        const oldPath = stripDiffPathPrefix(match[1]!);
        current = {
          path: oldPath,
          oldPath,
          isNew: oldPath === '/dev/null',
          isDeleted: false,
          isRename: false,
          additions: 0,
          deletions: 0,
          hunks: []
        };
        continue;
      }
    }

    if (current && HEADER_OLD.test(line)) {
      const path = stripDiffPathPrefix(HEADER_OLD.exec(line)![1]!);
      if (path === '/dev/null') current.isNew = true;
      else current.oldPath = path;
      continue;
    }

    if (current && HEADER_NEW.test(line)) {
      const path = stripDiffPathPrefix(HEADER_NEW.exec(line)![1]!);
      if (path === '/dev/null') current.isDeleted = true;
      else current.path = path;
      continue;
    }

    if (current && /^new file mode\s+\d+$/.test(line)) {
      current.isNew = true;
      continue;
    }

    if (current && /^deleted file mode\s+\d+$/.test(line)) {
      current.isDeleted = true;
      continue;
    }

    if (current && HEADER_HUNK.test(line)) {
      flushHunk();
      hunk = { header: line, addedLines: [], removedLines: [], contextLines: [] };
      continue;
    }

    if (current && hunk) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        hunk.addedLines.push(line.slice(1));
        current.additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        hunk.removedLines.push(line.slice(1));
        current.deletions++;
      } else if (line.startsWith(' ')) {
        hunk.contextLines.push(line.slice(1));
      }
    }
  }

  flushFile();
  return files;
}

export function classifyPath(path: string): FileKind {
  const p = path.toLowerCase();
  if (p === '/dev/null') return 'unknown';

  if (
    /(^|\/)package-lock\.json$|(^|\/)yarn\.lock$|(^|\/)pnpm-lock\.yaml$|(^|\/)cargo\.lock$|(^|\/)gemfile\.lock$|(^|\/)poetry\.lock$|(^|\/)go\.sum$/.test(
      p
    )
  ) {
    return 'lockfile';
  }

  if (
    /(^|\/)package\.json$|(^|\/)requirements[^/]*\.txt$|(^|\/)pipfile$|(^|\/)pyproject\.toml$|(^|\/)go\.mod$|(^|\/)cargo\.toml$|(^|\/)gemfile$/.test(
      p
    )
  ) {
    return 'deps';
  }

  if (/(^|\/)migrations?\//.test(p) || p.endsWith('.sql') || /alembic|prisma\/migrations/.test(p)) {
    return 'migration';
  }

  if (/\.test\.[a-z0-9]+$|\.spec\.[a-z0-9]+$|(^|\/)tests?\/|(^|\/)__tests__\/|_test\.go$|_test\.py$/.test(p)) {
    return 'test';
  }

  if (/(^|\/)docs?\/|\.md$|\.mdx$|\.rst$|\.adoc$/.test(p)) return 'docs';
  if (/(^|\/)\.github\/|(^|\/)\.gitlab-ci|(^|\/)\.circleci\/|jenkinsfile/.test(p)) return 'ci';

  if (/dockerfile|\.dockerignore|\.tf$|(^|\/)terraform\/|(^|\/)k8s\/|(^|\/)kubernetes\/|(^|\/)helm\//.test(p)) {
    return 'infra';
  }

  if (/auth|oauth|jwt|session|password|crypto|secret|permission|policy/.test(p)) return 'security';
  if (/\.(png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|otf|eot)$/.test(p)) return 'asset';

  if (/\.(ya?ml|toml|ini|cfg|env|conf|json5?)$|\.config\./.test(p) && !/(^|\/)package\.json$/.test(p)) {
    return 'config';
  }

  return 'src';
}

export function totalLineChanges(files: DiffFile[]) {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}

export function joinAddedLines(files: DiffFile[]) {
  const parts: string[] = [];
  for (const file of files) for (const hunk of file.hunks) parts.push(...hunk.addedLines);
  return parts.join('\n');
}

export function joinRemovedLines(files: DiffFile[]) {
  const parts: string[] = [];
  for (const file of files) for (const hunk of file.hunks) parts.push(...hunk.removedLines);
  return parts.join('\n');
}

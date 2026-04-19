import { stderr, stdout } from 'node:process';
import chalk from 'chalk';

import { APP_RELEASE_DATE_ISO, APP_RELEASE_UNIX_TIME, APP_VERSION, DEFAULT_MODEL, type ThinkingMode } from '@/config';

export type JsonCliResult = {
  kind: 'headless-json';
  prompt?: string;
  allowAll: boolean;
  includeThinking: boolean;
  model?: string;
  reasoning?: ThinkingMode;
};

export type StartCliResult = { kind: 'start'; resumeId?: string };

type CliResult = StartCliResult | JsonCliResult | { kind: 'exit'; code: number };

const COMMAND_NAME = 'cue';

function formatRows(rows: Array<[string, string]>, indent = '  ') {
  const width = rows.reduce((max, [left]) => Math.max(max, left.length), 0);
  return rows.map(([left, right]) => `${indent}${chalk.white(left.padEnd(width))}  ${right}`).join('\n');
}

function formatRelativeAge(unixTime: number) {
  const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixTime);

  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  if (ageSeconds < 60 * 60) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 60 * 60 * 24) return `${Math.floor(ageSeconds / (60 * 60))}h ago`;
  if (ageSeconds < 60 * 60 * 24 * 30) return `${Math.floor(ageSeconds / (60 * 60 * 24))}d ago`;
  if (ageSeconds < 60 * 60 * 24 * 365) return `${Math.floor(ageSeconds / (60 * 60 * 24 * 30))}mo ago`;
  return `${Math.floor(ageSeconds / (60 * 60 * 24 * 365))}y ago`;
}

function printVersion() {
  stdout.write(`${APP_VERSION} (released ${APP_RELEASE_DATE_ISO}, ${formatRelativeAge(APP_RELEASE_UNIX_TIME)})\n`);
}

function printHelp() {
  const sections = [
    `${chalk.bold('Cue')} ${chalk.dim(APP_VERSION)}`,
    '',
    'Your next move, on cue.',
    '',
    `${chalk.bold('Usage:')} ${chalk.white(`${COMMAND_NAME} [options] [prompt]`)}`,
    '',
    `${chalk.bold('Default model:')} ${chalk.white(DEFAULT_MODEL)}`,
    '',
    chalk.bold('Options:'),
    '',
    formatRows([
      ['-h, --help', 'Show help'],
      ['-v, --version', 'Show version'],
      ['--json, --stream-json', 'Run one headless turn and emit newline-delimited JSON'],
      ['--resume <id>', 'Resume a saved interactive session'],
      ['--prompt <text>', 'Prompt text for headless JSON mode'],
      ['--allow-all', 'Auto-approve command/edit tools in headless JSON mode'],
      ['--thinking', 'Include reasoning deltas in headless JSON mode'],
      ['--model <id>', 'Override the model for headless JSON mode'],
      ['--reasoning <mode>', 'Override reasoning mode: auto, low, medium, high']
    ]),
    '',
    chalk.bold('Quick in-session shortcuts:'),
    '',
    formatRows([
      ['!<command>', 'Run a shell command'],
      ['@path/to/file', 'Attach a file to your prompt'],
      ['Ctrl+O', 'Expand/collapse truncated previews'],
      ['/logout', 'Log out of Cue'],
      ['/model', 'Switch models'],
      ['/reasoning', 'Adjust reasoning level'],
      ['/planning', 'Toggle read-only planning mode'],
      ['/share', 'Share the current thread'],
      ['/private', 'Make the current thread private'],
      ['/review', 'Run a read-only codebase review'],
      ['/tools', 'List the currently available agent tools'],
      ['/compact', 'Summarize the conversation to save context'],
      ['/exit', 'Quit Cue']
    ]),
    '',
    chalk.bold('Examples:'),
    '',
    formatRows([
      ['cue', 'Start the interactive TUI'],
      ['cue --help', 'Show CLI help'],
      ['cue --version', 'Print the build version'],
      ['cue --json --prompt "summarize this repo"', 'Run one headless JSON turn'],
      ['printf "fix the failing tests" | cue --json --allow-all', 'Drive Cue from a script'],
      ['!git status', 'Run a shell command once Cue is open'],
      ['@src/cue.ts', 'Attach a file once Cue is open']
    ]),
    '',
    chalk.bold('Environment:'),
    '',
    formatRows([
      ['SHELL', 'Shell used for ! commands (default: /bin/sh)'],
      ['rg', 'Optional, used when available for faster file indexing/search']
    ]),
    '',
    chalk.dim(`Tip: run '${COMMAND_NAME}' and then type / for commands.`),
    ''
  ];

  stdout.write(`${sections.join('\n')}\n`);
}

function printError(message: string, suggestion = `Run '${COMMAND_NAME} --help' for usage.`) {
  stderr.write(`${chalk.bold('Error:')} ${message}\n`);
  if (suggestion) stderr.write(`${chalk.dim(suggestion)}\n`);
}

function isThinkingMode(value: string): value is ThinkingMode {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high';
}

export function handleCliArgs(argv = process.argv.slice(2)): CliResult {
  if (argv.length === 0) return { kind: 'start' };

  if (argv.length === 1) {
    const [arg] = argv;

    if (arg === '-h' || arg === '--help' || arg === 'help') {
      printHelp();
      return { kind: 'exit', code: 0 };
    }

    if (arg === '-v' || arg === '-V' || arg === '--version' || arg === 'version') {
      printVersion();
      return { kind: 'exit', code: 0 };
    }
  }

  let jsonMode = false;
  let allowAll = false;
  let includeThinking = false;
  let prompt: string | undefined;
  let model: string | undefined;
  let reasoning: ThinkingMode | undefined;
  let resumeId: string | undefined;
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--json' || arg === '--stream-json') {
      jsonMode = true;
      continue;
    }

    if (arg === '--allow-all') {
      allowAll = true;
      continue;
    }

    if (arg === '--thinking') {
      includeThinking = true;
      continue;
    }

    if (arg === '--resume') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        printError(`Missing value for '${arg}'.`);
        return { kind: 'exit', code: 1 };
      }

      resumeId = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('--resume=')) {
      const value = arg.slice('--resume='.length);
      if (!value) {
        printError(`Missing value for '--resume'.`);
        return { kind: 'exit', code: 1 };
      }

      resumeId = value;
      continue;
    }

    if (arg === '--prompt') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        printError(`Missing value for '${arg}'.`);
        return { kind: 'exit', code: 1 };
      }

      prompt = value;
      index += 1;
      continue;
    }

    if (arg === '--model') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        printError(`Missing value for '${arg}'.`);
        return { kind: 'exit', code: 1 };
      }

      model = value;
      index += 1;
      continue;
    }

    if (arg === '--reasoning') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        printError(`Missing value for '${arg}'.`);
        return { kind: 'exit', code: 1 };
      }

      if (!isThinkingMode(value)) {
        printError(`Invalid reasoning mode '${value}'. Expected auto, low, medium, or high.`);
        return { kind: 'exit', code: 1 };
      }

      reasoning = value;
      index += 1;
      continue;
    }

    if (arg.startsWith('-')) {
      printError(`Invalid flag '${arg}'.`);
      return { kind: 'exit', code: 1 };
    }

    positionals.push(arg);
  }

  if (!jsonMode) {
    if (allowAll || includeThinking || prompt !== undefined || model !== undefined || reasoning !== undefined) {
      printError('Headless flags require --json.');
      return { kind: 'exit', code: 1 };
    }

    if (positionals.length > 0) {
      const [unexpected] = positionals;
      printError(`Unexpected argument '${unexpected}'.`);
      return { kind: 'exit', code: 1 };
    }

    return { kind: 'start', resumeId };
  }

  if (resumeId) {
    printError('--resume cannot be used with --json.');
    return { kind: 'exit', code: 1 };
  }

  if (prompt !== undefined && positionals.length > 0) {
    printError('Provide the headless prompt with either --prompt or positional text, not both.');
    return { kind: 'exit', code: 1 };
  }

  return {
    kind: 'headless-json',
    prompt: prompt ?? (positionals.length > 0 ? positionals.join(' ') : undefined),
    allowAll,
    includeThinking,
    model,
    reasoning
  };
}

import { stderr, stdout } from 'node:process';
import chalk from 'chalk';

import { APP_RELEASE_DATE_ISO, APP_RELEASE_UNIX_TIME, APP_VERSION, DEFAULT_MODEL } from '@/config';

type CliResult = { kind: 'start' } | { kind: 'exit'; code: number };

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
    'Coding with taste',
    '',
    `${chalk.bold('Usage:')} ${chalk.white(`${COMMAND_NAME} [options]`)}`,
    '',
    `${chalk.bold('Default model:')} ${chalk.white(DEFAULT_MODEL)}`,
    '',
    chalk.bold('Options:'),
    '',
    formatRows([
      ['-h, --help', 'Show help'],
      ['-v, --version', 'Show version']
    ]),
    '',
    chalk.bold('Quick in-session shortcuts:'),
    '',
    formatRows([
      ['!<command>', 'Run a shell command'],
      ['@path/to/file', 'Attach a file to your prompt'],
      ['/model', 'Switch models'],
      ['/reasoning', 'Adjust reasoning level'],
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

  const invalidFlag = argv.find(arg => arg.startsWith('-'));
  if (invalidFlag) {
    printError(`Invalid flag '${invalidFlag}'.`);
    return { kind: 'exit', code: 1 };
  }

  const [unexpected] = argv;
  printError(`Unexpected argument '${unexpected}'.`);
  return { kind: 'exit', code: 1 };
}

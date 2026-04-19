#!/usr/bin/env bun

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const prompt =
  process.argv.slice(2).join(' ').trim() ||
  'Read README.md and package.json, then summarize what this project does, how to run it, and which file owns the CLI argument parsing.';

const child = spawn('bun', ['src/cue.ts', '--json', '--prompt', prompt], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'inherit']
});

let assistantText = '';
let sawInit = false;

const rl = createInterface({ input: child.stdout });

for await (const line of rl) {
  if (!line.trim()) continue;

  let event;
  try {
    event = JSON.parse(line);
  } catch (error) {
    console.error('Non-JSON line from cue:', line);
    continue;
  }

  if (event.type === 'system' && event.subtype === 'init') {
    sawInit = true;
    console.log(`session ${event.session_id}`);
    console.log(`model   ${event.model}`);
    console.log(`reason  ${event.reasoning}`);
    console.log(`tools   ${event.tools.join(', ')}`);
    console.log('---');
    continue;
  }

  if (event.type === 'assistant' && event.subtype === 'tool_call') {
    console.log(`tool → ${event.tool_name}`);
    continue;
  }

  if (event.type === 'assistant' && event.subtype === 'tool_result') {
    console.log(`tool ✓ ${event.tool_name}`);
    continue;
  }

  if (event.type === 'assistant' && event.subtype === 'tool_error') {
    console.log(`tool ✗ ${event.tool_name}: ${event.error}`);
    continue;
  }

  if (event.type === 'assistant' && event.subtype === 'text_delta') {
    assistantText += event.delta;
    process.stdout.write(event.delta);
    continue;
  }

  if (event.type === 'result' && event.subtype === 'success') {
    if (assistantText && !assistantText.endsWith('\n')) process.stdout.write('\n');
    console.log('---');
    console.log(`done in ${event.duration_ms}ms`);
    if (event.usage) {
      console.log(`tokens input=${event.usage.input_tokens} output=${event.usage.output_tokens} reasoning=${event.usage.reasoning_tokens}`);
    }
    if (typeof event.cost_usd === 'number') console.log(`cost    $${event.cost_usd.toFixed(6)}`);
    process.exit(0);
  }

  if (event.type === 'result' && event.subtype === 'error') {
    console.error(`cue failed: ${event.error}`);
    process.exit(1);
  }
}

child.on('exit', code => {
  if (!sawInit && code !== 0) process.exit(code ?? 1);
});

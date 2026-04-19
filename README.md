# Cue

A terse terminal-based AI coding agent. Cue runs in your shell, streams responses from OpenAI models, and uses tools (read, write, edit, ripgrep, bash, web search) to inspect and modify your workspace.

The app is a fully interactive TUI written in TypeScript and run on [Bun](https://bun.sh). It supports streaming text + reasoning, slash commands, tool approval flows, conversation compaction, model switching, and configurable reasoning effort.

## Requirements

- [Bun](https://bun.sh) `>= 1.3`
- A POSIX shell (`$SHELL` is honored, falls back to `/bin/sh`)
- [`ripgrep`](https://github.com/BurntSushi/ripgrep) on `PATH` (used by the `ripgrep`/`rg` tool)
- Git (used for branch detection and the build's commit hash)
- A TTY-capable terminal (true color recommended)

## API Keys

Cue talks to the OpenAI API via [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai), which reads its credentials from environment variables.

| Variable | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Yes | Authenticates all model calls and the built-in web search tool. |
| `OPENAI_BASE_URL` | No | Override to point at an OpenAI-compatible endpoint. |
| `OPENAI_ORGANIZATION` / `OPENAI_PROJECT` | No | Standard OpenAI org/project scoping. |

Export it in your shell before launching:

```bash
export OPENAI_API_KEY="sk-..."
```

## Other environment variables

These are all optional and only affect runtime behavior or the build script.

| Variable | Used by | Effect |
| --- | --- | --- |
| `SHELL` | `src/config/constants.ts` | Shell used to execute commands (default `/bin/sh`). |
| `TERM_THEME`, `VSCODE_THEME`, `ANSI_LIGHT` | `src/theme.ts` | Force light/dark theme detection. |
| `COLORTERM`, `FORCE_COLOR`, `CLICOLOR`, `CLICOLOR_FORCE` | `src/agent/shell.ts` | Forwarded to child processes to preserve colored output. |
| `HOME` | `src/text.ts` | Used for `~` path normalization. |
| `APP_BUILD_UNIX_TIME`, `APP_GIT_HASH` | `scripts/generate-version.mjs` | Override the generated build version stamp. |

## Install

```bash
bun install
```

## Run

Development (watch mode):

```bash
bun dev
```

One-shot run:

```bash
bun start
```

Both commands first regenerate `src/config/version.ts` (a gitignored file) via `bun gen:version`.

## Build

```bash
bun run build
```

Produces a Node-targeted bundle under `dist/`. `bun clean` removes it.

## Project structure

```
src/
  cue.ts                  Entry point, wires up the AgentApp lifecycle
  agent/                  Core agent loop, slash commands, abort/compact logic, shell exec
  config/                 Model catalog, prompts, constants, version stamp
  render/                 TUI renderer, components, layout, diffing
  store/                  In-memory app state (messages, history, UI state)
  tools/                  AI SDK tools: read, write, edit, ripgrep, bash, web_search
  xml/                    Tiny XML formatter used to build prompts
  git.ts                  Cached current-branch lookup via isomorphic-git
  keypress.ts             Raw stdin keypress decoder
  kitty.ts                Kitty keyboard protocol helpers
  text.ts                 ANSI / path / segmentation utilities
  theme.ts                Light/dark theme detection and palette
  types.ts                Shared types (entry kinds, approvals, etc.)
scripts/
  generate-version.mjs    Writes src/config/version.ts from package.json + git
```

## Built-in slash commands

Defined in `src/agent/slash-commands/builtins/`:

- `/auto-run` – toggle auto-approval for tool calls in the current session
- `/compact` – manually compact older conversation history
- `/model` – switch between OpenAI models from `OPENAI_MODEL_OPTIONS`
- `/reasoning` – cycle thinking effort (`auto` / `low` / `medium` / `high`)
- `/toggle-auto-compact` – enable/disable automatic context compaction
- `/exit` – quit the session (also `Ctrl+C` twice when there's history)

You can also prefix any input with `!` to run it as a one-off shell command, and reference files with `@path/to/file` to inline their contents.

## Default model

`gpt-5.4` (see `DEFAULT_MODEL` in `src/config/models.ts`). The full list of selectable models lives in `OPENAI_MODEL_OPTIONS` in the same file. Pricing/context window metadata comes from [`@pydantic/genai-prices`](https://www.npmjs.com/package/@pydantic/genai-prices).

## Dependencies

Runtime (`package.json` → `dependencies`):

- [`@ai-sdk/openai`](https://www.npmjs.com/package/@ai-sdk/openai) – OpenAI provider for the Vercel AI SDK
- [`ai`](https://www.npmjs.com/package/ai) – Vercel AI SDK (`streamText`, tool plumbing)
- [`@pydantic/genai-prices`](https://www.npmjs.com/package/@pydantic/genai-prices) – per-model pricing & context-window metadata
- [`@zenbase/llml`](https://www.npmjs.com/package/@zenbase/llml) – LLM markup helpers
- [`approximate-number`](https://www.npmjs.com/package/approximate-number) – human-friendly number formatting (e.g. token counts)
- [`chalk`](https://www.npmjs.com/package/chalk) – terminal colors
- [`dedent`](https://www.npmjs.com/package/dedent) – multi-line string dedenting
- [`fuse.js`](https://www.npmjs.com/package/fuse.js) – fuzzy matching for composer suggestions
- [`isomorphic-git`](https://www.npmjs.com/package/isomorphic-git) – read current git branch without a git binary
- [`log-update`](https://www.npmjs.com/package/log-update) – in-place terminal updates
- [`ora`](https://www.npmjs.com/package/ora) – spinner frames
- [`react`](https://www.npmjs.com/package/react) – pulled in for JSX-style component types in the renderer
- [`zod`](https://www.npmjs.com/package/zod) – tool input schemas

Dev (`package.json` → `devDependencies`):

- `@types/approximate-number`, `@types/bun`, `@types/node`, `@types/react`

## License

Not specified.

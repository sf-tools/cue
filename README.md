# Cue

Your next move, on cue.

## Requirements

- [Bun](https://bun.sh)
- `OPENAI_API_KEY`
- [`rg`](https://github.com/BurntSushi/ripgrep) on your `PATH` for faster indexing/search (optional)

## Install

```bash
bun install
```

## Run

```bash
export OPENAI_API_KEY=your_key_here
bun start
```

## CLI

```bash
cue --help
cue --version
```

## Dev

```bash
bun dev
```

## Build

```bash
bun run build
```

The build output is written to `dist/`.

## Notes

- Use `!` to run a shell command.
- Use `@path/to/file` to include a file in your prompt.
- Built-in slash commands include `/model`, `/reasoning`, `/compact`, and `/exit`.
- `cue --help` shows CLI help, and `cue --version` prints the build version.

# Cue

Your next move, on cue.

```bash
# install
npm i -g @sf-tools/cue

# usage
cue --help
cue --version
cue --resume
cue --json --prompt "summarize this repo"
```

## Build

```bash
bun run build
```

The build output is written to `dist/`.

## Headless JSON mode

Cue can also run a single headless turn and emit newline-delimited JSON for scripts, CI, or other tools.

```bash
cue --json --prompt "read README.md and summarize the project"
printf "inspect src/cli.ts and explain the flags" | cue --json
```

Useful flags:

- `--resume` opens a picker for saved threads in the current workspace.
- `--resume <id>` resumes a specific saved thread.
- `--allow-all` auto-approves command/edit tools in headless mode.
- `--thinking` includes reasoning deltas in the JSON stream.
- `--model <id>` and `--reasoning <mode>` override the saved defaults.

There is also a demo consumer script at `scripts/demo-headless-json.mjs`:

## Notes

- Use `!` to run a shell command.
- Use `@path/to/file` to include a file in your prompt.
- Some built-in slash commands include `/model`, `/reasoning`, `/review`, `/tools`, `/compact`, `/switch`, and more.
- Typing `review my codebase` runs the same read-only review flow as `/review`.
- `cue --help` shows CLI help, and `cue --version` prints the build version.

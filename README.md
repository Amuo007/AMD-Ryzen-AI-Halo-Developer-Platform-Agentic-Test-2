# wen3.8-next-flash-q3 — forge

**forge** is a coding agent with a web interface, in the spirit of the Claude Code desktop app.
Run one command, a local server starts, your browser opens, and an LLM reads, edits and runs
code in your chosen project folder until your task is done — while you watch every step live.

Built with **zero npm dependencies**: Node.js 22 built-ins only, plain HTML/CSS/JS frontend.

## Requirements

- Node.js **22+** (uses `node --test`, native `fetch`, `AbortSignal`)
- No `npm install` needed — there are no dependencies.

## Install & start

```bash
git clone https://github.com/Amuo007/AMD-Ryzen-AI-Halo-Developer-Platform-Agentic-Test-2.git
cd AMD-Ryzen-AI-Halo-Developer-Platform-Agentic-Test-2
npm start                      # http://127.0.0.1:4848
npm start -- --port 5000       # custom port
npm start -- --no-open         # do not auto-open the browser
```

The server binds to **127.0.0.1 only** — it never exposes anything on your LAN.

## Usage

1. Pick a **workspace folder** in the sidebar (type a path or use the 📁 browser).
2. Choose a **permission mode** in the status bar (see below).
3. Type a task in the chat box and hit **Enter**. forge streams the model's answer live,
   shows each tool call as a collapsible card (with red/green diffs for edits), and asks
   for approval when the current mode requires it. **Stop** (or `Esc`) cancels a running
   turn, including a running shell command.

## Settings

Open **⚙ Settings** in the sidebar:

| Setting | Meaning | Default |
| --- | --- | --- |
| Base URL | OpenAI-compatible API root | `http://192.168.1.252:13305/v1` |
| API key | sent as `Authorization: Bearer …`, stored at `~/.config/forge/config.json` (mode 0600), never returned to the browser in full | `local` |
| Model | model id | `Qwen3.8-Flash-Next-GGUF-IQ3_M` |
| Max steps | tool-loop budget per turn | 50 |
| Context limit | tokens (chars/4) before trimming | 100000 |

Environment variables **`FORGE_BASE_URL`**, **`FORGE_API_KEY`**, **`FORGE_MODEL`** override
the file. The status bar shows live LLM-server reachability (green/red dot).

## Permission modes

| Mode | File reads | File writes/edits | Shell commands |
| --- | --- | --- | --- |
| **Ask** (default) | allowed | dialog: Allow / Deny / Always allow | dialog |
| **Auto-edit** | allowed | allowed | dialog |
| **Full access** | allowed | allowed | allowed |

In **every** mode a deny-list blocks the dangerous shapes: `rm -rf /`, `sudo`, `mkfs`,
`dd of=/dev/…`, fork bombs, power commands, recursive `chmod`/`chown` of `/`, `curl … | sh`.

## Tools

| Tool | What it does |
| --- | --- |
| `read_file` | read a file, numbered lines, optional `start_line`/`end_line` |
| `write_file` | create/overwrite a file (parents auto-created) |
| `edit_file` | exact string replace; fails clearly when the string is missing or not unique (`all=true` replaces all) |
| `list_dir` | list a directory (dirs marked with `/`) |
| `search` | regex search across files; skips `node_modules`/`.git` |
| `run_shell` | bash in the workspace; timeout (30 s default, 300 s max); exit code + stdout + stderr, output truncated |

All file tools resolve `..` **and symlinks** and refuse anything outside the workspace.

## Sessions & memory

- Conversations are saved as JSONL under `<workspace>/.forge/sessions/`; the sidebar lists
  them, click to continue, **＋ New chat** for a fresh one.
- If the workspace contains **`AGENTS.md`**, it is injected into the system prompt as
  project instructions.
- Context is managed automatically: old tool outputs shrink first, then whole turns drop,
  never the system prompt or your latest message.

## Tests

```bash
npm test   # node --test: unit, API and end-to-end (mock OpenAI server) tests
```

## Architecture

```
bin/forge.js        entry point: parse args, start server, open browser
src/server.js       HTTP + SSE endpoints, static hosting
src/agent.js        turn loop: LLM -> tools -> results -> repeat
src/llm.js          streaming OpenAI-compatible client (retry + backoff)
src/sse.js          SSE parser + tool-call delta assembler
src/tools/*         read/write/edit/list/search/shell (+ diff.js, sandbox.js)
src/permissions.js  modes + deny-list
src/context.js      token estimate + context trimming
src/memory.js       AGENTS.md loading, system prompt
src/sessions.js     JSONL session storage
public/             vanilla HTML/CSS/JS UI
```

See `DECISIONS.md` for design choices.

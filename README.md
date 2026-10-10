# Halo AI Harness

**Halo AI Harness** is an agentic coding assistant with a web interface, in the spirit of
the Claude Code desktop app. Run one command, a local server starts, your browser opens,
and an LLM reads, edits and runs code in your chosen project folder until your task is
done — while you watch every step live.

Built with **zero npm dependencies**: Node.js 22 built-ins only, plain HTML/CSS/JS frontend.

## Requirements

- Node.js **22+** (uses `node:sqlite`, `node --test`, native `fetch`, `AbortSignal`)
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

1. Pick a **mode** in the sidebar: **Chat** (plain conversation) or **Code** (agent works
   in a workspace). Light theme by default, dark one click away (◐).
2. Pick a **workspace folder** (type a path or use the 📁 browser).
3. Choose a **permission mode** and a **reasoning level** in the composer (see below).
4. Type a task and hit **Enter**. Halo streams the model's answer live with **markdown
   rendering**, shows each tool call as a collapsible card (red/green diffs for edits),
   aggregates the turn's edits into an "Edited N files" summary card, streams **thinking**
   as a collapsible "Thought for Ns" block (with a spinning halo loader), and asks for
   approval when the current mode requires it. **Stop** (or `Esc`) cancels a running turn.
   Rate answers 👍/👎 under each reply.
5. The **mascot** next to the input reacts to what's happening (idle breathe/blink,
   typing trot, waiting halo glow, thinking tilt, talking).
6. A fresh **Code** session shows the **usage dashboard** (tokens, sessions, peak hour,
   13-week activity heatmap, All / 30d / 7d).
7. The **context meter** (ring + %) next to the permission selector shows how full the
   model's context window is — click it for the breakdown (system prompt, skills, tool
   definitions, messages, tool results). Real API token counts are used as ground truth
   where available. In Code mode the harness **hands off automatically** before the window
   fills: the model writes a goal / done / state / branches+files / next-steps summary,
   a handoff card appears in the chat, and work continues in a fresh context — no action
   needed from you, and the earlier conversation stays readable.

## Settings

Open **⚙ Settings**:

| Setting | Meaning | Default |
| --- | --- | --- |
| Base URL | OpenAI-compatible API root | `http://192.168.1.252:13305/v1` |
| API key | sent as `Authorization: Bearer …`, stored in the local SQLite config, never returned to the browser in full | `local` |
| Model | model id | `Qwen3.8-Flash-Next-GGUF-IQ3_M` |
| Max steps | tool-loop budget per turn | 50 |
| Context limit | token window treated for every model | 140000 |
| Handoff limit | Code-mode context level at which the automatic handoff summary is written | 128000 |

Environment variables **`FORGE_BASE_URL`**, **`FORGE_API_KEY`**, **`FORGE_MODEL`** override
the stored config. The status bar shows live LLM-server reachability (green/red dot).

## Reasoning

Per-conversation control in the composer: **Auto / High / Low / Off**. Non-auto values are
translated into real API parameters (`chat_template_kwargs.thinking`, `reasoning_effort`),
so thinking models actually think less or not at all. The choice persists per conversation
and is remembered as the default.

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
| `edit_file` | exact string replace, or **multi-edit** `edits: [{old_string, new_string, all}]` applied in order — one write, one diff; fails clearly when a string is missing or not unique |
| `list_dir` | list a directory (dirs marked with `/`) |
| `glob_files` | find files by glob (`*`, `**`, `?`, `{a,b}`), newest first |
| `search` | regex search with `glob` path filter, `ignore_case`, `context_lines`; skips `node_modules`/`.git` |
| `run_shell` | bash in the workspace; timeout (30 s default, 300 s max); `background: true` starts a long-running job |
| `shell_jobs` | status + new output of background jobs |
| `kill_shell` | stop a background job |
| `todo` | maintain the live todo list (rendered as a panel above the composer) |
| `use_skill` | load the full instructions of an installed skill |

Tools can be **enabled/disabled** in Settings → Tools; the disabled set is filtered out of
the model's tool list and calls to disabled tools get a clear error. All file tools resolve
`..` **and symlinks** and refuse anything outside the workspace.

## MCP (external tools)

Drop an `mcp.json` in `~/.forge/` (global) or `<workspace>/.forge/` (workspace):

```json
{
  "servers": {
    "myserver": { "command": "node", "args": ["/path/to/server.js"], "env": {} }
  }
}
```

Halo speaks **MCP over stdio** (initialize → tools/list → tools/call). MCP tools appear
namespaced as `mcp__<server>__<tool>`, follow the same permission rules as write tools
(`readOnlyHint` tools are auto-approved like reads), and their servers' status is shown in
Settings → Tools.

## Prompt files & skills

- **System prompts** resolve per workspace: `<workspace>/.forge/system.md` →
  `~/.forge/system.md` → the built-in `prompt/system.md` (`chat.md` for Chat mode).
  `AGENTS.md` in the workspace root is appended as project instructions. The **Prompt**
  settings tab shows the effective prompt and which file wins (`GET /api/prompt`).
- **Skills** live in `<workspace>/.forge/skills/<id>/SKILL.md` or
  `~/.forge/skills/<id>/SKILL.md` (workspace overrides global) with `name` +
  `description` frontmatter. Only names + descriptions enter the system prompt; the model
  pulls full instructions (or extra files in the skill folder) on demand with `use_skill`.
  Toggle skills in Settings → Skills.

## Sessions & memory

- Conversations are saved in **SQLite** (Node 22 built-in), listed in the sidebar grouped
  by date, click-to-continue, hover-delete.
- Per-message **👍/👎 feedback** is stored and re-applied on reopen; `/api/stats` powers
  the dashboard.
- Context is managed automatically: real API usage is the ground truth where available;
  old tool outputs shrink first, then whole turns drop — never the system prompt or your
  latest message. In Code mode the automatic **handoff** replaces the working context with
  the model's own summary once the handoff limit is reached; everything remains in the
  session history.

## Tests

```bash
npm test                        # 173 unit / API / end-to-end tests (mock OpenAI + MCP servers)
node scripts/smoke-v3.mjs       # scripted end-to-end smoke: real bin, all v3 capabilities
```

## Architecture

```
bin/forge.js        entry point: parse args, start server, open browser
src/server.js       HTTP + SSE endpoints, static hosting, /api/* routes
src/agent.js        turn loop: history -> trim -> LLM -> tools -> results -> repeat (+ handoff)
src/llm.js          streaming OpenAI-compatible client (retry + backoff)
src/sse.js          SSE parser + tool-call delta assembler
src/tools/*         read/write/edit/list/glob/search/shell/jobs/todo (+ diff.js, sandbox.js)
src/permissions.js  modes + deny-list
src/context.js      token estimate, trimming, context breakdown
src/prompt.js       system-prompt file resolution (workspace/global/default)
src/skills.js       skill discovery, frontmatter, use_skill
src/mcp.js          MCP stdio client (servers from mcp.json)
src/memory.js       AGENTS.md loading, system prompt assembly
src/db.js           SQLite: settings, conversations, messages, todos
public/             vanilla HTML/CSS/JS UI
scripts/            test runner bootstrap + v3 smoke
```

See `DECISIONS.md` for design choices.

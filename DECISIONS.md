# DECISIONS.md — forge design choices

## Stack
- **Zero dependencies.** Everything uses Node 22 built-ins (`node:http`, `fetch`,
  `child_process`, `fs`, `node:test`). The frontend is vanilla HTML/CSS/JS served from
  `public/`. This was a hard constraint; it also keeps the attack surface and startup
  cost at zero.
- **Node 22 required** (the repo machine had 20 as default; nvm's 22.19.0 is used for all
  runs). The agent relies on native `fetch`, `AbortSignal` and `node --test`.

## Server
- **127.0.0.1 only, default port 4848**, `--port` flag, browser opened with `open`/
  `xdg-open`. The test suite uses port 0 (ephemeral) and `--no-open`.
- **SSE, not websockets.** One direction is all we need. Events are numbered per turn
  (`id: N`); a reconnecting browser sends `Last-Event-ID` and the server replays the
  in-memory event buffer, so a mid-task reload shows the current state. The buffer lives
  until the next turn; persisted state lives in session JSONL.
- **One turn at a time per session**: a second `POST /api/chat` while a turn runs gets
  409.

## LLM connection
- **OpenAI Chat Completions with `stream: true` + `tools`** (function calling), and
  `stream_options.include_usage` so token usage arrives.
- `reasoning_content` deltas (thinking models like the live Qwen) are surfaced to the UI
  as faded italic text but never sent back to the model.
- **Retries:** network errors and 5xx get 3 retries with exponential backoff
  (0.5 s, 1 s, 2 s). 4xx errors fail immediately — retrying those never helps. A retry
  re-sends the same messages; partial output from the failed attempt is discarded and the
  UI gets a `retry` event.
- **Invalid tool-call JSON is never fatal**: the model receives an error tool result
  telling it to retry with valid JSON, and the loop continues.

## Tools & sandbox
- Six tools exactly as specified. `edit_file` counts occurrences up front: 0 → clear
  "not found" error, >1 → "not unique" error unless `all=true`.
- **Sandbox**: `..` is resolved logically first, then the path is re-resolved
  component-by-component following every symlink (including dangling links and not-yet-
  existing files); the final real path must stay inside the real workspace.
- `run_shell` runs `bash -c` with the workspace as cwd, in its own process group
  (`detached: true`), so timeout/stop `SIGKILL`s the whole tree (verified: children of
  the command die too). Output capped at 64 KB/stream.
- `search` skips `node_modules`/`.git`, binary files and files > 2 MB.

## Permissions
- Three modes as specified. **In `ask` mode read-only tools (read_file, list_dir,
  search) are auto-approved** — asking for every read would make the agent unusable in
  practice; the spec's dialog targets actions that change something. "Always allow this
  tool" is per session (memory).
- **Deny-list** is regex-based against the raw command string and is enforced in every
  mode, including "always allow". It's deliberately conservative (e.g. `rm -rf` of `/` or
  `~`, not `rm -rf build/`). It's a guard rail, not a security boundary — Full access
  mode can still do damage, which is why it isn't the default.

## Agent loop & context
- Loop: build `[system, ...history]` → trim → stream → run tool calls → append results →
  repeat until no tool calls or `maxSteps`.
- **Token estimate = chars/4.** Trimming shrinks tool outputs first (to ~800 chars, with
  a marker), then drops whole oldest turns (an assistant turn with tool_calls drops its
  tool results with it, keeping the message list API-valid). The system prompt and the
  latest user message are never dropped.
- **AGENTS.md** from the workspace root is appended to the system prompt (capped at 32 KB).

## Frontend
- Vanilla everything. **Light theme is the default** from v2 — the UI follows the
  Claude Desktop / Claude Code screenshots in `reference/` (kept in the repo as the
  design source); dark theme remains via the ◐ toggle (persisted).
- **Greeting screens**: Chat mode shows "Good morning/afternoon/evening, `<user>`";
  Code mode shows "What's up next, `<user>?`" above the usage dashboard (tiles +
  13-week heatmap from `/api/stats`, All/30d/7d ranges). Username comes from
  `os.userInfo()` server-side — fine because the server is 127.0.0.1-only.
- **Markdown rendered in-app** (`renderMarkdown`/`renderText`, ~80 lines, no deps):
  headings, lists, bold/italic, inline code, links, fenced blocks with language tag;
  everything HTML-escaped before formatting.
- **Message actions**: copy (clipboard) and 👍/👎 per assistant message; feedback goes to
  `POST /api/feedback`, is stored on the message row and re-applied on session open.
  Toggling the same rating clears it.
- **Edits summary card**: a turn's write/edit diffs are aggregated into one
  "Edited N files +A −D" card; more than 4 files collapse behind "Show N more"; each row
  opens the full diff. Language badge derived from the file extension.
- Sidebar sessions are **grouped by date** (Today / Yesterday / `Mon D` [ / year]) with
  hover-delete.
- **Mascot**: a small robot (recreated as inline SVG from the provided avatar image —
  halo, headphone ears, cream screen face, chest ring) sits in the composer next to the
  input. Pure SVG + CSS keyframes, zero JS animation loops: `setMascotState()` just sets
  `data-state` on the svg and CSS swaps animations — idle = breathe + blink, typing =
  attentive trot, waiting = glowing halo pulse, thinking = head tilt + eye dart, talking =
  mouth flap; `transition` on the parts makes switches smooth; everything is disabled
  under `prefers-reduced-motion`. Art uses fixed warm oranges that read on both themes;
  the waiting glow is the accent orange. States are driven by real events (input, send,
  `reasoning_delta`/`text_delta`/`turn_end`/permission SSE). The headless test harness
  boots `app.js` in a `node:vm` DOM stub and asserts the state machine — static regex
  tests had previously missed a runtime crash in `renderWelcome`.
- **Tool cards** are `<details>`: name, live-streaming args, status pill, result, and a
  real LCS line-diff (red/green) for write/edit. Cards auto-expand on error/denied.
- **Permission dialogs** live inline in the chat (not a modal) so they survive reload via
  the SSE replay buffer.
- The workspace picker is a server-backed directory browser (`/api/browse`) — a plain
  text input plus a folder list; the native file picker can't return directory paths
  reliably from a browser.

## Sessions
- JSONL (one JSON object per line, `meta` first, corrupt lines skipped on read) in
  `<workspace>/.forge/sessions/<id>.jsonl`. Title = first user message (60 chars).

## Testing
- Unit tests for tools, sandbox, permissions, config, SSE parser, tool-call assembly,
  diff, context trimming, sessions, memory, UI contracts.
- API tests run the real server (ephemeral port) with a mock LLM: chat, permission
  allow/deny, stop, invalid tool JSON, 409, reconnect replay.
- E2E: scripted mock OpenAI server drives the full agent loop and asserts real files.
- Tests that stream use POST-before-SSE-connect; the turn buffers events so nothing is
  missed.

## Process notes
- `feat/project-memory` shipped inside the context-management/sessions commits (the
  memory module arrived together with its test file), so its branch was merged as a
  no-op and deleted.
- One early branch juggling mishap orphaned an `agent.js` commit; it was restored from
  the object store (`git show <sha>`) and re-committed. Everything on main is intact.
- v2: the reference-design UI overhaul was recovered from an interrupted session as
  uncommitted work (`feat/reference-design`, split backend/UI commits), plus a 24-check
  end-to-end smoke (real `bin/forge.js` + mock LLM) covering chat, permission allow/deny,
  stop, stats, feedback, sessions, search, browse and delete — all green.

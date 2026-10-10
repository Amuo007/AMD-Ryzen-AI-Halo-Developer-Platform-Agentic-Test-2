# DECISIONS.md — Halo AI Harness design choices

## Name
- **v3 rebrand: "Halo AI Harness".** All user-facing strings, prompts, favicon and brand
  mark use the name (halo ring converted to SVG; it doubles as the thinking loader).
  Internal identifiers — `~/.forge` config/skills directories, `FORGE_*` env vars,
  `forge-*` localStorage keys, the `forge:handoff` message marker, `bin/forge.js` — were
  deliberately **not** renamed so existing installs, sessions and settings keep working.

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
  repeat until no tool calls or `maxSteps`. History is now loaded from SQLite every turn
  (it was previously only the current user message — the loop never actually saw prior
  turns; without this the 140K window and handoff are meaningless).
- **Token estimate = chars/4**, but the API's real `usage.prompt_tokens` for the last
  request is used as **ground truth** (actual + estimate of anything appended after it)
  for the meter and for the handoff trigger. Trimming shrinks tool outputs first (to
  ~800 chars, with a marker), then drops whole oldest turns (an assistant turn with
  tool_calls drops its tool results with it, keeping the message list API-valid). The
  system prompt and the latest user message are never dropped.
- **Context window default 140K**, handoff default 128K (both Settings-configurable;
  handoff is clamped to `[2000, contextLimit - 2000]`).
- **Automatic handoff (Code mode only):** when the next request would reach the handoff
  limit, the model is asked (via a fixed directive) to write a `## Goal / ## Done /
  ## Current state / ## Branches & files / ## Next steps` summary; it is persisted as an
  assistant message named `forge:handoff`, the working context resets to that summary, and
  work continues without user action. Everything before the marker stays in the session
  (readable in the UI, rendered as a collapsible handoff card with the halo icon) but is
  excluded from future model contexts. Chat mode never hands off. If the model returns an
  empty summary the handoff is skipped for that turn (trimming still protects the window).
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
- **Context meter (v3)**: a circular SVG ring + % sits in the composer bar (Code mode
  sessions only; hidden with Chat or no session). Color escalates green → amber (70%) →
  red (90%). Click opens a popup with the per-category breakdown (system prompt, skills,
  tool defs, your messages, model replies, tool results) from `GET /api/context`, with a
  note saying whether real API usage backs the numbers. Refreshed after every usage /
  turn end / session open / mode switch; closes on outside click.
- **Handoff card (v3)**: handoff summaries render as a collapsible card with the halo icon
  ("Context handoff — continuing from this summary"); while the summary is being written
  it streams live into an open card. `handoff` / `handoff_delta` SSE events drive it;
  reopening a session recognizes the `forge:handoff` row.
- **Thinking loader (v3)**: the "Thought for Ns" block icon is the halo SVG — spinning
  while reasoning, static once finalized (respects `prefers-reduced-motion`).
- The workspace picker is a server-backed directory browser (`/api/browse`) — a plain
  text input plus a folder list; the native file picker can't return directory paths
  reliably from a browser.

## Sessions
- JSONL (one JSON object per line, `meta` first, corrupt lines skipped on read) in
  `<workspace>/.forge/sessions/<id>.jsonl`. Title = first user message (60 chars).

## Testing
- Unit tests for tools, sandbox, permissions, config, SSE parser, tool-call assembly,
  diff, context trimming + breakdown, sessions, memory, UI contracts (173 total).
- API tests run the real server (ephemeral port) with a mock LLM: chat, permission
  allow/deny, stop, invalid tool JSON, 409, reconnect replay, context meter, automatic
  handoff (tiny limits on the mock).
- E2E: scripted mock OpenAI server drives the full agent loop and asserts real files;
  MCP is tested against a mock stdio MCP server.
- `scripts/smoke-v3.mjs`: boots the **real `bin/forge.js`** with the mock LLM and runs 25
  end-to-end checks across every v3 capability (multi-edit + permission, glob, search,
  background jobs, todos, skills, tool policy, MCP call, reasoning params, prompt file
  override, context meter, automatic handoff, feedback/stats).
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

## Phase 4 — images, invisible local browser, handoff v2 (v4)

### Images
- Images are **stored, never inlined as base64 in message rows**: `POST /api/images`
  decodes a data URL, keeps the bytes in `<dataDir>/images/` and registers an id row
  (conversation, source, mime, size). Messages reference ids; `/api/images/<id>` serves
  them immutably. Keeps the DB small and makes reload cheap.
- Client downscales attachments to max 1568 px on a canvas before upload (vision-token
  sanity), max 5 per message, 10 MB decoded cap.
- **`modelSupportsImages` toggle**: when off, image parts are never sent, the attach UI is
  disabled, and browser screenshots degrade to text captions.

### Invisible local browser
- One shared headless browser process, **one isolated browser context per conversation**,
  lazy start, 10-minute idle shutdown, kill the whole process group on server exit — plus
  process/profile-cleanup assertions so no orphan Chrome can survive the test suite.
- The tool surface is a **single `browser` tool with an `action` param** (not 14 tools):
  fewer defs in the prompt, one policy switch, cache-stable prefix.
- Screenshots can't ride inside tool messages on OpenAI-compatible servers, so a taken
  screenshot is attached as a **follow-up `forge:screenshot` user message** with the image
  part, after all tool results of the step (tool-call order stays valid). Only the latest
  2 screenshots stay in model context (`materializeForModel` marks older ones);
  user-attached images are never pruned.
- **Cards are UI-only messages** (`forge:browser-card`, `forge:handoff`): persisted with
  the conversation, stripped from everything the model sees. The card is one per browser
  session per turn, updated in place (live via CDP screencast at ~2 fps over SSE), and
  re-renders "Closed" from the stored last frame on reopen.
- **Local-only rule** enforced at every layer: `open` refuses non-localhost/non-workspace
  URLs up front, and the page session watches *every* navigation event that carries a url
  (`frameScheduledNavigation`, `frameRequestedNavigation`, `frameStartedNavigating`,
  `navigatedWithinDocument`, plus legacy `frameStartedLoading`) — recent Chrome stopped
  sending the url on `frameStartedLoading`, which silently punched a hole in the first
  implementation. `file://` is allowed only inside the workspace (realpath-compared).
- Dialogs (alert/confirm) are auto-accepted and mirrored into the console so the agent
  can never hang on them.

### Handoff v2
- Handoff requests send **the same tools list as normal steps** — identical serialized
  prefix keeps provider prompt-caches warm; any tool calls in the summary reply are
  ignored (the summary is text-only by contract, but models sometimes call anyway).
- **Rolling memory**: the directive requires `## Original task` (verbatim copy from the
  previous handoff or the first user message), `## Earlier work (condensed)` and
  `## Plan / remaining todos` next to the older sections. The server additionally
  **re-injects** the `## Original task` section verbatim when a model drops it, so the
  task provably survives N handoffs.
- **Session budget**: total input tokens per conversation = sum of real prompt tokens on
  its messages (Settings `sessionTokenBudget`, default 1M). Over budget → banner above the
  composer; its button opens a fresh Code chat in the same workspace pre-filled with the
  latest handoff summary (the handoff text doubles as the seed for the new context).

### Mascot frisbee
- The throw is pure CSS on the existing `data-state` state machine (`m-halo-throw` +
  `m-throw-arm` on waiting/thinking/talking, calm on idle/typing), so it starts with the
  first token request and ends by itself when the turn ends or is stopped;
  `prefers-reduced-motion` kills it. No JS timers, no extra state.

### Testing
- `test/helpers/fake-cdp.mjs`: a real WebSocket server hand-rolled on `node:http`
  upgrade (no deps) that speaks just enough CDP to unit-test the client: id matching,
  event fan-out, error replies, per-request timeouts, close semantics.
- Real-Chrome integration test (broken button + console error page): open, screenshot,
  snapshot refs, click, exception capture, resize, navigation blocking, cleanup — and it
  **auto-skips** when no Chrome/Chromium/Edge is installed.
- `scripts/smoke-v4.mjs` boots the real bin with the mock LLM and checks all v4 surfaces
  end-to-end (20 checks).

## Phase 5 — UI polish (feat/ui-polish)

### Responsive strategy
- One breakpoint (860px) turned the fixed 300px sidebar into an **off-canvas drawer**
  (hamburger in the topbar, scrim behind it) instead of reflowing three columns into a
  phone. The drawer closes on scrim tap, Esc, new chat and session open, so the chat
  always owns the small viewport. Above the breakpoint nothing moves — desktop layout is
  byte-for-byte the same as before.
- Mobile-specific adaptations are deliberately few: 2-col stats grid, horizontally
  scrollable 91-day heatmap strip (wrapping made a ragged block), wrapped composer bar
  with the "Permission"/"Think" text labels dropped (the selects keep their titles),
  16px form fonts (iOS zooms the page when focusing a <16px input), and the browser
  side panel becomes a right-edge overlay (its drag-resize handle is hidden there —
  there is nothing to drag against).
- **Why JS state instead of a checkbox/`:has()` hack**: the open/closed state must also
  drive Esc handling and auto-close on navigation, so it lives in `state.navOpen`
  (`setNavOpen()`); CSS only renders it. That keeps it testable in the headless DOM
  stub, where classList is inert.

### Theming
- A **first visit follows the OS** (`prefers-color-scheme`) instead of always landing in
  light; an explicit toggle click still overrules forever (localStorage unchanged).
  `matchMedia` is `typeof`-guarded because app.js also boots inside the vm sandbox.
- `color-scheme: light|dark` per theme fixes the one dark-mode eyesore CSS couldn't
  reach: native `<select>` popups and scrollbars stayed light on a dark UI.
- Added a global `:focus-visible` ring — keyboard users finally get a focus indicator.

### Small stuff
- `#top-model` ellipsizes (it wrapped to two lines and stretched the topbar whenever the
  side panel was open) and carries the full model name as `title`; the browser header
  button gets an `active` state so it is clear which toggle opened the panel.
- Dialogs get `max-height: 92dvh + overflow-y: auto` and the settings `.row` pairs wrap —
  on short screens the Save button was previously unreachable.

# PROGRESS.md — Phase 4: images + invisible local browser

## Current status
- Branch: `feat/mascot-frisbee` — done; next: §7 better automatic handoff
- Doing: frisbee-throw mascot while a response generates (throw → catch → repeat until done/stopped)
- Half-done: nothing
- Baseline: v3.0.0 — 174 tests green (now 204)

## Legend: [ ] todo · [x] done · [~] in progress

## Phase 3 — COMPLETE (v3.0.0)

## 0. Setup
- [x] Orient: read README/DECISIONS, git log, run tests (126 pass)
- [x] Write PROGRESS.md plan

## 1. Tools good enough for real agentic work (`feat/tools-v2`)
- [x] `glob_files` tool: glob patterns (`*`, `**`, `?`), mtime sort, skip node_modules/.git, cap+errors
- [x] `edit_file` multi-edit: `edits: [{old_string,new_string,all}]` applied in order, one write, one diff
- [x] `search` upgrades: `glob` path filter, `ignore_case`, `context_lines`
- [x] Background shells: `run_shell` `background:true` → job id; `shell_jobs` (status + new output); `kill_shell`
- [x] `todo` tool: full-list replace, persisted per conversation, `todo_update` SSE event
- [x] Permissions: auto-allow safe new tools, ask rules for the rest; better tool descriptions
- [x] UI: live todo panel above composer; render on session open
- [x] Tests for all of the above; npm test green (135); merge to main + push

## 2. System prompt as a markdown file (`feat/system-prompt`)
- [x] `prompt/system.md` (Code) + `prompt/chat.md` (Chat) written as proper agent prompts
- [x] `src/prompt.js`: resolution: workspace `.forge/system.md` → global `~/.forge/system.md` → repo default; AGENTS.md appended (extend)
- [x] `GET /api/prompt?workspace=` returns source + effective text
- [x] Settings: "Prompt" tab showing the effective prompt + which file wins
- [x] Tests; merge + push

## 3. Skills (`feat/skills`)
- [x] `src/skills.js`: discover `<ws>/.forge/skills/<id>/SKILL.md` + `~/.forge/skills/`, frontmatter parse, workspace overrides global
- [x] Only name+description go into the system prompt (available-skills section)
- [x] `use_skill` tool: load a skill's full instructions (+ extra files in its folder)
- [x] Enable/disable persisted (settings); `GET /api/skills`, `POST /api/skills/enabled`, `GET /api/skill`
- [x] Settings: "Skills" tab — list, view, toggle
- [x] Tests; merge + push

## 4. Tool access & extensibility (`feat/tool-policy`, `feat/mcp`)
- [x] Tool enable/disable in Settings (persisted); defs filtered per turn; disabled-tool calls get a clear error
- [x] `GET /api/tools`, `POST /api/tools/enabled`
- [x] `src/mcp.js`: stdio JSON-RPC MCP client (initialize, tools/list, tools/call) + `~/.forge/mcp.json` + `.forge/mcp.json`
- [x] MCP tools namespaced `mcp__<server>__<tool>`, permissioned like write tools (readOnlyHint honored)
- [x] Settings: Tools tab shows core + MCP tools with toggles and server status
- [x] Tests incl. mock MCP server; merge + push

## 5. Reasoning control (`feat/reasoning`)
- [x] `reasoning`: auto/high/low/off per conversation from composer; real params to the API (`chat_template_kwargs.thinking`, `reasoning_effort`)
- [x] Persist per conversation; default persisted in settings
- [x] Thinking rendered as collapsible "Thought for Ns" block (live timer while running)
- [x] Tests (mock asserts body); merge + push

## 6. Context window, meter & automatic handoff (`feat/context-meter`, `feat/handoff`)
- [x] Defaults: context limit 140K, handoff at 128K (both Settings-configurable)
- [x] Real token counts from API usage used as ground truth where available
- [x] `GET /api/context?sessionId=` breakdown: system prompt / tool defs / skills / messages / tool results
- [x] Circular context meter near composer + popup breakdown; color escalation
- [x] Automatic handoff (Code mode only): model writes goal/done/state/branches+files/next-steps summary, work continues in fresh context without user action
- [x] Handoff marker visible in chat; earlier part still readable; Chat mode untouched
- [x] Tests with tiny limits on mock; merge + push

## 7. Rebrand: Halo AI Harness (`feat/rebrand`)
- [x] Rename user-facing "forge" → "Halo AI Harness" (title, brand, texts; internal `~/.forge` paths & keys unchanged)
- [x] Halo image converted to SVG; used as thinking loader (Thought block + while model thinks); existing mascot avatar stays

## 8. Polish + docs + release
- [x] End-to-end manual smoke of every new capability (real bin + mock LLM, scripted) — `scripts/smoke-v3.mjs`, 25/25
- [x] README: tools, skills, prompt file, reasoning, context meter/handoff, MCP config
- [x] DECISIONS.md updated; PROGRESS.md fully ticked
- [x] One short live test vs http://192.168.1.252:13305/v1 (reasoning on + off, several tools)
- [x] Tag v3.0.0, push main + tag

---

# Phase 4 — Images + invisible local browser

Extra rules: zero deps (Node 22 built-ins, global `WebSocket` + `child_process`); no
Playwright/Puppeteer — Chrome is driven over CDP. LOCAL ONLY: the browser may open only
localhost / 127.0.0.1 / [::1] / *.localhost (any port) or file:// paths inside the
workspace; off-localhost navigation is stopped and reported. Tests use the mock LLM +
local test pages; the live model server is never called during development.

## 0. Small fixes first (`feat/identity-reasoning`)
- [x] a) Identity: "Identity" section near the top of `prompt/system.md` + `prompt/chat.md`
      (name Halo, never impersonate other assistants, model id filled at build time,
      "You are **Halo AI Harness**" → "You are **Halo**"); built prompt contains the
      identity section + real configured model id (tests)
- [x] b) Reasoning: "Medium" in the Think selector (Auto/High/Medium/Low/Off);
      medium → `chat_template_kwargs {enable_thinking:true, thinking:true}` +
      `reasoning_effort:"medium"`; existing auto/high/low/off unchanged; tests

## 1. Image input — Chat AND Code (`feat/image-input`)
- [x] Attach 3 ways: paperclip/+ button, paste (Cmd/Ctrl+V), drag-and-drop on the chat
- [x] Thumbnails above the input with × to remove before sending; max 5 images/message,
      PNG/JPEG/WebP/GIF only; browser (canvas) downscale to max 1568px long edge
- [x] `POST /api/images` + `GET /api/images/:id`: files stored in Halo's data dir,
      referenced by id in SQLite (no base64 blobs in the DB)
- [x] Model sees OpenAI-style content parts: `[{type:"text"}, {type:"image_url",…}]`
- [x] User bubbles show images; click to enlarge (lightbox); old conversations reload
      with their images
- [x] Setting "Model supports images" (default on); off → attach disabled + tooltip,
      browser screenshots fall back to text snapshots
- [x] Tests: upload paths (button/paste/drop via DOM harness), size/type limits,
      storage + route, message format, reload, vision-off fallback

## 2. Headless browser engine (`src/browser/`) (`feat/browser-engine`)
- [x] Chrome/Chromium/Edge auto-detect (macOS/Linux/Windows); Settings override + env var
- [x] Launch: `--headless=new`, `--remote-debugging-port=0`, temp `--user-data-dir`,
      no first-run — a window must never appear
- [x] Lazy start; one isolated browser context per conversation; close after 10 min idle
      and on server exit (no orphan Chrome processes)
- [x] Small CDP client over global WebSocket: id-matched request/response, event
      subscriptions, timeouts, clear "Chrome not found — set the path in Settings" error
- [x] Tests against a fake CDP WebSocket server (node:http upgrade, no deps)

## 3. `browser` tool — Code mode only (`feat/browser-tool`)
- [x] ONE tool, `action` param: open/back/reload; screenshot (viewport|full, JPEG);
      snapshot (compact text outline, numbered refs for links/buttons/inputs);
      click(ref|selector|x,y), type, key, scroll, hover; resize(desktop|tablet|mobile);
      console; wait_for(text|selector, timeout)
- [x] Screenshots reach the model as an image_url part in a follow-up user message
      (tool result stays text); only the latest 2 screenshots kept in model context
      (older → "[earlier screenshot removed]"); user-attached images never pruned
- [x] Every screenshot stored with the conversation (section-1 image storage)
- [x] Per-tool enable/disable policy honored; tool absent in Chat mode

## 4. Browser card + inline screenshots in chat (`feat/browser-card`)
- [x] Browser card on first page open of a turn: live preview image on top; below it
      page title, subtitle "host:port · Live"/"· Closed", "Open" button, ⋮ menu
      (Copy URL, Open in my browser)
- [x] One card per browser session per turn, updated in place (no card per action)
- [x] "Open" opens the side panel (section 6) for real-time watching
- [x] Screenshots inline in the chat where taken (real image, caption URL + viewport,
      click to enlarge)
- [x] Agent narrates 1–2 lines after each screenshot (prompt + rendering)
- [x] Reopening an old conversation: card shown (last frame, "Closed") + screenshots in
      place; look matches reference/claude-browser-card.png if present, else adapted to
      Halo's theme incl. dark mode

## 5. Visual check loop (`feat/visual-loop`)
- [x] System prompt: build UI → start app (background shell) → open → screenshot +
      console → compare vs request/reference image → fix → reload → repeat until right
- [x] Polish pass checklist (overlap, cut-off text, spacing, contrast, broken images,
      dead buttons, console errors, mobile) + list remaining ideas instead of guessing
- [x] "open localhost:3000 and tell me what can be improved" review flow works

## 6. Browser side panel (`feat/browser-panel`)
- [x] Right-side panel, hidden by default; opens from card "Open" or header browser
      button; close button; draggable width remembered
- [x] Read-only URL bar; live view via CDP `Page.startScreencast` throttled ~2 fps over
      the existing SSE; status Live/Closed; viewport size switch; console-error badge
- [x] Browser tool honors per-tool enable/disable policy

## 6.5 Mascot frisbee throw (`feat/mascot-frisbee`)
- [x] While a response is generating (waiting/thinking/talking) the composer mascot throws
      his halo like a frisbee: wind-up → fly out spinning + edge-on flip → caught back,
      looping until the turn ends or is stopped (idle/typing keep the calm halo)
- [x] Right arm swings the throw (shoulder pivot); reduced-motion still disables everything
- [x] Tests for the loop, the flight path and the idle/typing exclusion (204 green)

## 7. Better automatic handoff (`feat/handoff-v2`)
- [x] performHandoff sends the same tools list (activeToolList) — cache prefix match;
      tool calls in the summary reply are ignored, never executed
- [x] Rolling memory: carry the previous handoff summary forward condensed; new sections
      "## Original task" (verbatim), "## Earlier work (condensed)",
      "## Plan / remaining todos" next to Goal/Done/Current state/Branches & files/Next steps
- [x] Session budget: total input tokens per conversation tracked; > 1,000,000
      (Settings-configurable) → banner suggesting a fresh chat + button opening a new
      Code chat in the same workspace pre-filled with the latest handoff summary
- [x] Tests with tiny limits: tools in handoff request; 2nd handoff carries 1st's
      points; original task survives 3 handoffs; banner appears after the limit

## 8. Tests — mock only (`feat/browser-tests`)
- [x] CDP client vs fake CDP WebSocket server (test/helpers/fake-cdp.mjs — node:http
      upgrade, no deps): id matching, events/sub+unsub, error replies, timeouts, close
- [x] Real-Chrome integration test, auto-skip when Chrome missing: local page with broken
      button + console error → open, screenshot, snapshot, click, read console, resize
- [x] Local-only guard: external URLs refused (unit + engine); off-localhost navigation
      stopped — fixed: new Chrome sends no url on Page.frameStartedLoading, the guard now
      hooks frameScheduled/frameRequested/startedNavigating/navigatedWithinDocument too
- [x] Screenshot pruning, inline screenshots, one card per turn updating in place,
      "Open" opens panel, card "Closed" after shutdown + on reload, no browser tool in
      Chat mode, process cleanup (no Chrome left after tests)
- [x] 210 tests green

## 9. Finish
- [ ] Scripted end-to-end smoke with the real bin + mock LLM (smoke-v4)
- [ ] README (identity, reasoning levels, images, browser, card, inline screenshots, side
      panel, local-only rule, handoff + session budget, settings); DECISIONS.md updated;
      PROGRESS.md fully ticked
- [ ] ONE short live test vs http://192.168.1.252:13305/v1: Code mode — attach a mockup
      image, build matching page, card appears, "Open" shows live view, screenshots in
      chat, differences noticed + fixed + re-checked; Chat mode — image question +
      "who are you?" (must answer Halo)
- [ ] Tag v4.0.0, push main + tag

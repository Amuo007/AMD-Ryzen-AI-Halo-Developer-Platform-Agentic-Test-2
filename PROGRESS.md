# PROGRESS.md — Phase 3: forge as a strong agent

## Current status
- Branch: `feat/tools-v2` (starting)
- Doing: task 1 — tool-suite upgrade (glob, multi-edit, search filters, background shells, todo tool)
- Half-done: nothing yet
- Baseline: main = fa4f2bb, 126 tests green

## Legend: [ ] todo · [x] done · [~] in progress

## 0. Setup
- [x] Orient: read README/DECISIONS, git log, run tests (126 pass)
- [x] Write PROGRESS.md plan

## 1. Tools good enough for real agentic work (`feat/tools-v2`)
- [ ] `glob_files` tool: glob patterns (`*`, `**`, `?`), mtime sort, skip node_modules/.git, cap+errors
- [ ] `edit_file` multi-edit: `edits: [{old_string,new_string,all}]` applied in order, one write, one diff
- [ ] `search` upgrades: `glob` path filter, `ignore_case`, `context_lines`
- [ ] Background shells: `run_shell` `background:true` → job id; `shell_jobs` (status + new output); `kill_shell`
- [ ] `todo` tool: full-list replace, persisted per conversation, `todo_update` SSE event
- [ ] Permissions: auto-allow safe new tools, ask rules for the rest; better tool descriptions
- [ ] UI: live todo panel above composer; render on session open
- [ ] Tests for all of the above; npm test green; merge to main + push

## 2. System prompt as a markdown file (`feat/system-prompt`)
- [ ] `prompt/system.md` (Code) + `prompt/chat.md` (Chat) written as proper agent prompts
- [ ] `src/prompt.js`: resolution: workspace `.forge/system.md` → global `~/.forge/system.md` → repo default; AGENTS.md appended (extend)
- [ ] `GET /api/prompt?workspace=` returns source + effective text
- [ ] Settings: "Prompt" tab showing the effective prompt + which file wins
- [ ] Tests; merge + push

## 3. Skills (`feat/skills`)
- [ ] `src/skills.js`: discover `<ws>/.forge/skills/<id>/SKILL.md` + `~/.forge/skills/`, frontmatter parse, workspace overrides global
- [ ] Only name+description go into the system prompt (available-skills section)
- [ ] `use_skill` tool: load a skill's full instructions (+ extra files in its folder)
- [ ] Enable/disable persisted (settings); `GET /api/skills`, `POST /api/skills/enabled`, `GET /api/skill`
- [ ] Settings: "Skills" tab — list, view, toggle
- [ ] Tests; merge + push

## 4. Tool access & extensibility (`feat/tool-policy`, `feat/mcp`)
- [ ] Tool enable/disable in Settings (persisted); defs filtered per turn; disabled-tool calls get a clear error
- [ ] `GET /api/tools`, `POST /api/tools/enabled`
- [ ] `src/mcp.js`: stdio JSON-RPC MCP client (initialize, tools/list, tools/call) + `~/.forge/mcp.json` + `.forge/mcp.json`
- [ ] MCP tools namespaced `mcp__<server>__<tool>`, permissioned like write tools (readOnlyHint honored)
- [ ] Settings: Tools tab shows core + MCP tools with toggles and server status
- [ ] Tests incl. mock MCP server; merge + push

## 5. Reasoning control (`feat/reasoning`)
- [ ] `reasoning`: auto/high/low/off per conversation from composer; real params to the API (`chat_template_kwargs.thinking`, `reasoning_effort`)
- [ ] Persist per conversation; default persisted in settings
- [ ] Thinking rendered as collapsible "Thought for Ns" block (live timer while running)
- [ ] Tests (mock asserts body); merge + push

## 6. Context window, meter & automatic handoff (`feat/context-meter`, `feat/handoff`)
- [ ] Defaults: context limit 140K, handoff at 128K (both Settings-configurable)
- [ ] Real token counts from API usage used as ground truth where available
- [ ] `GET /api/context?sessionId=` breakdown: system prompt / tool defs / skills / messages / tool results
- [ ] Circular context meter near composer + popup breakdown; color escalation
- [ ] Automatic handoff (Code mode only): model writes goal/done/state/branches+files/next-steps summary, work continues in fresh context without user action
- [ ] Handoff marker visible in chat; earlier part still readable; Chat mode untouched
- [ ] Tests with tiny limits on mock; merge + push

## 7. Polish + docs + release
- [ ] End-to-end manual smoke of every new capability (real bin + mock LLM, scripted)
- [ ] README: tools, skills, prompt file, reasoning, context meter/handoff, MCP config
- [ ] DECISIONS.md updated; PROGRESS.md fully ticked
- [ ] One short live test vs http://192.168.1.252:13305/v1 (reasoning on + off, several tools)
- [ ] Tag v3.0.0, push main + tag

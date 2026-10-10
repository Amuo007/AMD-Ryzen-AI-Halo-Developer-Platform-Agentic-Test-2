import { readFile, writeFile, editFile, listDir } from './files.js';
import { runShell } from './shell.js';
import { search } from './search.js';
import { globFiles } from './glob.js';
import { shellJobs, killShell } from './jobs.js';
import { todo } from './todo.js';
import { useSkill } from '../skills.js';
import { browserTool } from './browser.js';
import { mcpToolDefs, runMcpTool } from '../mcp.js';
import { getSetting, setSetting } from '../db.js';

const string = { type: 'string' };

export const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the workspace. Returns text with "N: " line-number prefixes. For big files use start_line/end_line to read a range. If the output is truncated the result says so — read the next range instead of giving up.',
      parameters: {
        type: 'object',
        properties: {
          path: { ...string, description: 'File path, relative to the workspace (or absolute inside it).' },
          start_line: { type: 'integer', description: 'Optional first line to read (1-based).' },
          end_line: { type: 'integer', description: 'Optional last line to read (1-based, inclusive).' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Create or overwrite a file with the given content. Parent directories are created automatically. Prefer edit_file for changing existing files — only use write_file for new files or complete rewrites.',
      parameters: {
        type: 'object',
        properties: {
          path: { ...string, description: 'File path relative to the workspace.' },
          content: { ...string, description: 'Full file content to write.' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace exact strings in a file. Either one edit (old_string/new_string) or an `edits` array of several replacements applied to the same file in order (single write, single diff) — use the array to make multiple changes to one file without rewriting it. Fails clearly if an old_string is not found or matches more than once (set all=true to replace every occurrence). Copy old_string verbatim from read_file output, including whitespace.',
      parameters: {
        type: 'object',
        properties: {
          path: { ...string, description: 'File path relative to the workspace.' },
          old_string: { ...string, description: 'Exact text to replace (for a single edit).' },
          new_string: { ...string, description: 'Replacement text (for a single edit).' },
          all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
          edits: {
            type: 'array',
            description: 'Array of {old_string, new_string, all?} edits applied in order (alternative to top-level old_string/new_string).',
            items: {
              type: 'object',
              properties: {
                old_string: string,
                new_string: string,
                all: { type: 'boolean' },
              },
              required: ['old_string', 'new_string'],
            },
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries of a directory in the workspace. Directories are shown with a trailing slash, files with their size.',
      parameters: {
        type: 'object',
        properties: {
          path: { ...string, description: 'Directory path relative to the workspace. Defaults to the workspace root.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'glob_files',
      description:
        'Find files by name pattern (fast codebase exploration). Supports * (inside a segment), ** (any directories), ? and {a,b} alternatives, e.g. "src/**/*.ts" or "*.{json,md}". Returns matching paths newest-modified first. Skips node_modules and .git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { ...string, description: 'Glob pattern to match against workspace-relative paths.' },
          path: { ...string, description: 'Directory to search under. Defaults to the workspace root.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search',
      description:
        'Search file contents with a regular expression. Returns "path:line: text" matches. Skips node_modules and .git. Optional glob filters which files are searched (e.g. "*.py"), ignore_case for case-insensitive matching, and context_lines (1-3) to include the following lines after each match (marked with "-").',
      parameters: {
        type: 'object',
        properties: {
          pattern: { ...string, description: 'JavaScript regular expression.' },
          path: { ...string, description: 'File or directory to search in. Defaults to the workspace root.' },
          flags: { ...string, description: 'Optional regex flags, e.g. "i" for case-insensitive.' },
          glob: { ...string, description: 'Optional file-name glob filter, e.g. "*.ts" or "src/**/*.tsx".' },
          ignore_case: { type: 'boolean', description: 'Case-insensitive matching.' },
          context_lines: { type: 'integer', description: 'Include this many following lines (0-3) after each match.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description:
        'Run a bash command in the workspace directory. Returns exit code, stdout and stderr; long output is truncated; timeout default 30s, max 300s. Set background=true for long-running processes (dev servers, watchers): returns a job id immediately, the process keeps running; read it later with shell_jobs and stop it with kill_shell.',
      parameters: {
        type: 'object',
        properties: {
          command: { ...string, description: 'The bash command to execute.' },
          timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds (1000-300000).' },
          background: { type: 'boolean', description: 'Start the command as a background job instead of waiting for it.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'shell_jobs',
      description:
        'Inspect background shell jobs started with run_shell { background: true }. Without job_id: list all jobs with status; with job_id: status + all output appended since the last read. Output older than 100k chars per job is trimmed.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { ...string, description: 'Job id (e.g. "bg1") to read; omit to list all jobs.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'kill_shell',
      description: 'Stop a background shell job (SIGTERM to the whole process group, SIGKILL after 3s). Use it when a dev server you started is no longer needed or must be restarted.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { ...string, description: 'Job id to stop (e.g. "bg1").' },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo',
      description:
        'Maintain your task checklist for multi-step work. Pass the COMPLETE list every time (full replace): [{id, content, status: "pending"|"in_progress"|"completed"}]. Call it again whenever a task starts or finishes so the user can follow your progress. Keep it to the real work items (max 50).',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: 'The complete todo list.',
            items: {
              type: 'object',
              properties: {
                id: { ...string, description: 'Stable short id for the item.' },
                content: { ...string, description: 'Short description of the task.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Current status.' },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_skill',
      description:
        'Load the full instructions of an installed skill (see the Available skills list in your instructions). Call before starting work that matches a skill. Optional `file` loads one extra file from the skill folder instead of the main SKILL.md.',
      parameters: {
        type: 'object',
        properties: {
          skill: { ...string, description: 'Skill id (folder name), e.g. "commit-helper".' },
          file: { ...string, description: 'Optional extra file inside the skill folder.' },
        },
        required: ['skill'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'browser',
      description:
        'Control an invisible local headless Chrome (Code mode only) to view and test what you build. LOCAL ONLY: open() accepts localhost / 127.0.0.1 / [::1] / *.localhost (any port) or file:// paths inside the workspace; anything else is refused and off-localhost navigation is stopped. One action per call: open(url), back, reload, screenshot (optional full:true for full page — you will SEE the image), snapshot (compact text outline with numbered [ref]s for links/buttons/inputs — use the ref for click/type/hover/scroll), click(ref|selector|x,y), type(ref|selector,text), key(name e.g. Enter), scroll(x,y or to_ref), hover(ref|selector|x,y), resize(desktop|tablet|mobile), console (messages/errors/failed requests since the last check), wait_for(text|selector, timeout). After each screenshot, write 1-2 short lines saying what you see and what you will fix next.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['open', 'back', 'reload', 'screenshot', 'snapshot', 'click', 'type', 'key', 'scroll', 'hover', 'resize', 'console', 'wait_for'], description: 'The browser action to run.' },
          url: { ...string, description: 'For open: a localhost / file-in-workspace URL.' },
          full: { type: 'boolean', description: 'For screenshot: capture the full page instead of just the viewport.' },
          ref: { type: 'integer', description: 'Element ref number from the last snapshot.' },
          selector: { ...string, description: 'CSS selector (alternative to ref).' },
          x: { type: 'number', description: 'X coordinate (click/hover).' },
          y: { type: 'number', description: 'Y coordinate (click/hover).' },
          text: { ...string, description: 'Text to type, or text to wait_for.' },
          key: { ...string, description: 'Key name for key (Enter, Tab, Escape, …).' },
          to_ref: { type: 'integer', description: 'For scroll: scroll this ref into view.' },
          size: { type: 'string', enum: ['desktop', 'tablet', 'mobile'], description: 'For resize.' },
          timeout: { type: 'integer', description: 'For wait_for: max ms (default 10000).' },
        },
        required: ['action'],
      },
    },
  },
];

const impl = new Map([
  ['read_file', readFile],
  ['write_file', writeFile],
  ['edit_file', editFile],
  ['list_dir', listDir],
  ['glob_files', globFiles],
  ['search', search],
  ['run_shell', runShell],
  ['shell_jobs', shellJobs],
  ['kill_shell', killShell],
  ['todo', todo],
  ['use_skill', useSkill],
  ['browser', browserTool],
]);

export function getTool(name) {
  return impl.get(name);
}

export function isReadOnlyTool(name) {
  return name === 'read_file' || name === 'list_dir' || name === 'search' || name === 'glob_files' || name === 'shell_jobs' || name === 'use_skill';
}

/** Tools that never change anything in the workspace and never ask for approval. */
export function isAutoAllowed(name) {
  return isReadOnlyTool(name) || name === 'todo' || name === 'kill_shell' || name === 'browser';
}

export function toolNames() {
  return [...impl.keys()];
}

/* ---------------- enable / disable policy ---------------- */

export function getDisabledTools() {
  try {
    const list = JSON.parse(getSetting('disabledTools', '[]'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

export function setToolEnabled(name, enabled) {
  const disabled = new Set(getDisabledTools());
  if (enabled) disabled.delete(String(name));
  else disabled.add(String(name));
  setSetting('disabledTools', JSON.stringify([...disabled]));
  return [...disabled];
}

export function isToolEnabled(name) {
  return !getDisabledTools().includes(String(name));
}

/** Tool defs after the user's enable/disable policy. */
export function activeToolDefs(defs = toolDefs) {
  const disabled = new Set(getDisabledTools());
  return defs.filter((d) => !disabled.has(d.function.name));
}

/** Core + MCP tool defs the model should see right now. */
export async function activeToolList(workspace = null) {
  let mcpDefs = [];
  try {
    mcpDefs = await mcpToolDefs(workspace);
  } catch {
    mcpDefs = [];
  }
  return [...activeToolDefs(), ...mcpDefs];
}

export async function runTool(name, ctx, args) {
  if (!isToolEnabled(name)) {
    return { ok: false, content: `Error: the "${name}" tool is disabled by the user. Ask them to enable it in Settings → Tools, and do not try to work around it.` };
  }
  if (String(name).startsWith('mcp__')) {
    return runMcpTool(String(name), args ?? {});
  }
  const fn = impl.get(name);
  if (!fn) return { ok: false, content: `Error: unknown tool "${name}". Available tools: ${[...impl.keys()].join(', ')}.` };
  try {
    return await fn(ctx, args ?? {});
  } catch (err) {
    return { ok: false, content: `Error in ${name}: ${err.stack ?? err.message}` };
  }
}

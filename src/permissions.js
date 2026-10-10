export const MODES = ['ask', 'auto-edit', 'full'];

export const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'search', 'glob_files', 'shell_jobs', 'use_skill']);
export const FILE_EDIT_TOOLS = new Set(['write_file', 'edit_file']);
/**
 * Tools that never change anything in the workspace and are auto-approved in
 * every mode (use_skill only reads skill folders; browser is local-only).
 */
export const AUTO_ALLOW_TOOLS = new Set([...READ_ONLY_TOOLS, 'todo', 'kill_shell', 'browser']);

/**
 * Deny list: checked against the full shell command string in EVERY
 * permission mode. Deliberately conservative — matches destructive shapes
 * like `rm -rf /`, `rm -rf ~`, sudo, disk formatting, fork bombs, etc.
 */
export const DENY_PATTERNS = [
  { re: /(^|[\s;&|(])sudo(\s|$)/, why: 'sudo is not allowed' },
  { re: /(^|[\s;&|(])doas(\s|$)/, why: 'doas is not allowed' },
  { re: /\brm\b[^\n|;&]*\s(-[a-zA-Z]*[rR][a-zA-Z]*f?|--recursive)\b[^\n]*\s\/(\s|$|[*])/, why: 'refusing recursive delete of the filesystem root' },
  { re: /\brm\b[^\n|;&]*\s(-[a-zA-Z]*[rR][a-zA-Z]*f?|--recursive)\b[^\n]*\s~(\/|\s|$)/, why: 'refusing recursive delete of the home directory' },
  { re: /\bmkfs(\.|\s)/, why: 'disk formatting is not allowed' },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: 'raw writes to devices are not allowed' },
  { re: /(^|[\s;&|])\/dev\/rdisk/, why: 'raw device access is not allowed' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?\s*:?/, why: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'power control is not allowed' },
  { re: /\bchmod\b[^\n]*\s-R\b[^\n]*\s\/(\s|$)/, why: 'recursive chmod of / is not allowed' },
  { re: /\bchown\b[^\n]*\s-R\b[^\n]*\s\/(\s|$)/, why: 'recursive chown of / is not allowed' },
  { re: /\bcurl\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: 'piping curl into a shell is not allowed' },
];

export function checkDenyList(command) {
  const cmd = String(command ?? '');
  for (const { re, why } of DENY_PATTERNS) {
    if (re.test(cmd)) return { blocked: true, why };
  }
  return { blocked: false };
}

/**
 * Decide what to do about a tool invocation.
 * Returns { action: 'allow' | 'ask' | 'deny', reason? }.
 *
 * Modes:
 *  - ask       : file edits and shell commands require approval (read-only
 *                tools are auto-allowed — asking for every read would make
 *                the agent unusable; see DECISIONS.md).
 *  - auto-edit : file tools allowed, shell commands ask.
 *  - full      : everything allowed (deny list still applies).
 * alwaysAllow: Set of tool names the user approved with "always allow".
 */
export function decidePermission({ mode, toolName, args, alwaysAllow = new Set(), readOnly = false }) {
  if (toolName === 'run_shell') {
    const deny = checkDenyList(args?.command);
    if (deny.blocked) return { action: 'deny', reason: deny.why };
  }
  if (mode === 'full') return { action: 'allow' };
  if (alwaysAllow.has(toolName)) return { action: 'allow' };
  if (readOnly) return { action: 'allow' }; // e.g. MCP tools with readOnlyHint
  if (mode === 'auto-edit') {
    if (toolName === 'run_shell') return { action: 'ask' };
    return { action: 'allow' };
  }
  if (mode === 'ask') {
    if (AUTO_ALLOW_TOOLS.has(toolName)) return { action: 'allow' };
    return { action: 'ask' };
  }
  return { action: 'ask', reason: `Unknown permission mode "${mode}", defaulting to ask` };
}

export function describeToolCall(toolName, args = {}) {
  switch (toolName) {
    case 'run_shell':
      return `Run shell command${args.background === true ? ' in the background' : ''}: ${args.command ?? ''}`;
    case 'write_file':
      return `Write file: ${args.path ?? ''} (${String(args.content ?? '').length} chars)`;
    case 'edit_file': {
      const n = Array.isArray(args.edits) ? `${args.edits.length} edits to ` : '';
      return `Edit file: ${n}${args.path ?? ''}`;
    }
    case 'kill_shell':
      return `Stop background job: ${args.job_id ?? ''}`;
    default:
      return `${toolName}: ${JSON.stringify(args)}`;
  }
}

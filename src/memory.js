import fs from 'node:fs/promises';
import path from 'node:path';

export const AGENTS_MD_CAP = 32_000; // chars of AGENTS.md injected

/** Load AGENTS.md from the workspace root, if present. */
export async function loadAgentsMd(workspace) {
  try {
    const st = await fs.stat(path.join(workspace, 'AGENTS.md'));
    if (!st.isFile()) return null;
    let text = await fs.readFile(path.join(workspace, 'AGENTS.md'), 'utf8');
    if (text.length > AGENTS_MD_CAP) {
      text = `${text.slice(0, AGENTS_MD_CAP)}\n[AGENTS.md truncated]`;
    }
    return text;
  } catch {
    return null;
  }
}

export function buildSystemPrompt({ workspace, agentsMd }) {
  const parts = [
    'You are forge, an autonomous coding agent. You accomplish the user\'s task by calling tools: ' +
      'read_file, write_file, edit_file, list_dir, search, run_shell.',
    `Your workspace is the directory ${workspace}. All file paths are relative to it. Never touch files outside it.`,
    'Rules of engagement:',
    '- Prefer tools over guessing. Read files before editing them.',
    '- When you edit, copy old_string verbatim from read_file output.',
    '- Verify your work: run tests or the program when applicable.',
    '- When the task is complete, stop calling tools and write a short final summary of what you did.',
  ];
  if (agentsMd) {
    parts.push('', '## Project instructions (AGENTS.md)', agentsMd);
  }
  return parts.join('\n');
}

/**
 * System prompt for Chat mode: a pure conversation with the model — no workspace,
 * no tools, no file access. The model is told its limits so it does not pretend
 * to have performed actions.
 */
export function buildChatSystemPrompt() {
  return [
    'You are forge, a helpful conversational assistant.',
    'You are in Chat mode: you have no access to files, folders or a shell, and you cannot run any tools.',
    'Answer the user directly, clearly and concisely. Use GitHub-flavoured markdown when it helps readability.',
    'Never claim to have read a file or run a command. If the user needs coding work inside a project, suggest they switch to Code mode.',
  ].join('\n');
}

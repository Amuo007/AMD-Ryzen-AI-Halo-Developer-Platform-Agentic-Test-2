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

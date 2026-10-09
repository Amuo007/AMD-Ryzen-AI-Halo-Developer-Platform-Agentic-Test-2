import fs from 'node:fs/promises';
import path from 'node:path';
import { resolvePrompt, globalAppend } from './prompt.js';

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

/**
 * System prompt for Code mode. The base comes from prompt files (see
 * src/prompt.js — workspace > global > repo default), then the optional
 * global append, AGENTS.md project instructions, and an available-skills
 * section are added.
 */
export async function buildSystemPrompt({ workspace, agentsMd, skillsSection = null }) {
  const base = await resolvePrompt({ mode: 'code', workspace });
  const parts = [base.text, `Your workspace is the directory ${workspace}. All file paths are relative to it. Never touch files outside it.`];
  const append = await globalAppend();
  if (append) parts.push('', '## Global instructions (append.md)', append);
  if (skillsSection) parts.push('', skillsSection);
  if (agentsMd) parts.push('', '## Project instructions (AGENTS.md)', agentsMd);
  return parts.filter((p) => p !== null && p !== '').join('\n');
}

/**
 * System prompt for Chat mode: a pure conversation with the model — no
 * workspace, no tools, no file access.
 */
export async function buildChatSystemPrompt() {
  const base = await resolvePrompt({ mode: 'chat' });
  const append = await globalAppend();
  if (append) return `${base.text}\n\n## Global instructions (append.md)\n${append}`;
  return base.text;
}

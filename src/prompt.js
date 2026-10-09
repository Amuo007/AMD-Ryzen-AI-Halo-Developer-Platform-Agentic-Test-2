import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDir } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_PROMPT_DIR = path.join(__dirname, '..', 'prompt');

/**
 * Prompt resolution (first existing file wins; "override"):
 *   1. <workspace>/.forge/system.md   (project)
 *   2. <globalDir>/system.md          (global, globalDir = FORGE_CONFIG_DIR or ~/.forge)
 *   3. <repo>/prompt/system.md        (default)
 * `chat.md` works the same way for Chat mode.
 * AGENTS.md (workspace) is always *appended* as project instructions
 * (extend). A global `append.md` is appended before that.
 */
export function configDir() {
  return process.env.FORGE_CONFIG_DIR || defaultDataDir();
}

async function readIfExists(file) {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return null;
    const text = await fs.readFile(file, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** Resolve the base prompt for a mode. Returns { text, source, path }. */
export async function resolvePrompt({ mode = 'code', workspace = null, cap = 32_000 }) {
  const name = mode === 'chat' ? 'chat.md' : 'system.md';
  const candidates = [
    { source: 'workspace', file: workspace ? path.join(workspace, '.forge', name) : null },
    { source: 'global', file: path.join(configDir(), name) },
    { source: 'default', file: path.join(REPO_PROMPT_DIR, name) },
  ];
  for (const c of candidates) {
    if (!c.file) continue;
    const text = await readIfExists(c.file);
    if (text !== null) {
      const clipped = text.length > cap ? `${text.slice(0, cap)}\n[prompt truncated]` : text;
      return { text: clipped, source: c.source, path: c.file };
    }
  }
  return { text: '', source: 'none', path: null };
}

/** Global append text (extension), appended to every prompt when present. */
export async function globalAppend() {
  return (await readIfExists(path.join(configDir(), 'append.md'))) ?? '';
}

/** Prompt file locations shown in Settings (which file to create/edit). */
export function promptLocations(workspace = null) {
  return {
    workspace: workspace ? path.join(workspace, '.forge') : null,
    global: configDir(),
    default: REPO_PROMPT_DIR,
  };
}

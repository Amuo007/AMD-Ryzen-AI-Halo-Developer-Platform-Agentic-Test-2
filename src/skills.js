import fs from 'node:fs/promises';
import path from 'node:path';
import { configDir } from './prompt.js';
import { getSetting, setSetting } from './db.js';

export const SKILL_BODY_CAP = 40_000; // chars of SKILL.md returned to the model

/**
 * Skills: folders containing a SKILL.md with YAML-ish frontmatter
 * (name, description) and instructions in the body, plus optional extra
 * files. Discovered in <workspace>/.forge/skills/<id>/ and
 * <globalDir>/skills/<id>/ — workspace skills override global ones.
 * Only id/name/description go into the context; the body is loaded on
 * demand with the use_skill tool.
 */

/** Parse leading `--- key: value ---` frontmatter. Returns { meta, body }. */
export function parseFrontmatter(text) {
  const m = String(text).match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/);
  const meta = {};
  if (!m) return { meta, body: String(text) };
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1) || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    if (key) meta[key] = value;
  }
  return { meta, body: String(text).slice(m[0].length) };
}

export function getDisabledSkills() {
  try {
    const list = JSON.parse(getSetting('disabledSkills', '[]'));
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return [];
  }
}

export function setSkillEnabled(id, enabled) {
  const disabled = new Set(getDisabledSkills());
  if (enabled) disabled.delete(String(id));
  else disabled.add(String(id));
  setSetting('disabledSkills', JSON.stringify([...disabled]));
  return [...disabled];
}

async function scanDir(dir, source, out) {
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const skillDir = path.join(dir, name);
    const skillFile = path.join(skillDir, 'SKILL.md');
    let st;
    try {
      st = await fs.stat(skillFile);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let text = '';
    try {
      text = await fs.readFile(skillFile, 'utf8');
    } catch {
      continue;
    }
    const { meta } = parseFrontmatter(text);
    out.set(name, {
      id: name,
      name: meta.name || name,
      description: meta.description || '',
      source,
      dir: skillDir,
      file: skillFile,
    });
  }
}

/** Discover all skills. Workspace skills override global ones with the same id. */
export async function discoverSkills({ workspace = null } = {}) {
  const out = new Map();
  await scanDir(path.join(configDir(), 'skills'), 'global', out);
  if (workspace) await scanDir(path.join(workspace, '.forge', 'skills'), 'workspace', out);
  const disabled = new Set(getDisabledSkills());
  return [...out.values()].map((s) => ({ ...s, enabled: !disabled.has(s.id) }));
}

/** Markdown section injected into the system prompt (names + descriptions only). */
export function skillsSectionText(skills) {
  const enabled = skills.filter((s) => s.enabled);
  if (!enabled.length) return null;
  const lines = enabled.map((s) => `- \`${s.id}\`: ${s.description}`);
  return [
    '## Available skills',
    'Skills are proven instruction sets for specific task types. Only the short descriptions are listed here. When a skill matches the work you are about to do, call `use_skill` with its id first and follow the loaded instructions instead of improvising.',
    ...lines,
  ].join('\n');
}

/** Relative list of files inside a skill directory (SKILL.md first). */
async function listSkillFiles(skillDir) {
  const files = [];
  const walk = async (dir, rel) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) await walk(full, relPath);
      else files.push(relPath);
    }
  };
  await walk(skillDir, '');
  files.sort((a, b) => (a === 'SKILL.md' ? -1 : b === 'SKILL.md' ? 1 : a.localeCompare(b)));
  return files;
}

/**
 * use_skill implementation: load a skill's full SKILL.md body (or one of its
 * extra files). Disabled skills are refused. `file` must stay inside the
 * skill folder.
 */
export async function useSkill({ workspace = null }, args = {}) {
  const id = String(args.skill ?? args.id ?? '').trim();
  if (!id) return { ok: false, content: 'Error: pass the skill id, e.g. { skill: "commit-helper" }. See the Available skills list.' };
  const skills = await discoverSkills({ workspace });
  const skill = skills.find((s) => s.id === id);
  if (!skill) {
    const known = skills.map((s) => s.id).join(', ') || 'none installed';
    return { ok: false, content: `Error: no such skill "${id}". Installed skills: ${known}.` };
  }
  if (!skill.enabled) {
    return { ok: false, content: `Error: skill "${id}" is disabled. Ask the user to enable it in Settings → Skills.` };
  }
  const files = await listSkillFiles(skill.dir);
  if (args.file) {
    const rel = String(args.file);
    const full = path.resolve(skill.dir, rel);
    if (full !== skill.dir && !full.startsWith(skill.dir + path.sep)) {
      return { ok: false, content: `Error: file must stay inside the skill folder.` };
    }
    try {
      let text = await fs.readFile(full, 'utf8');
      if (text.length > SKILL_BODY_CAP) text = `${text.slice(0, SKILL_BODY_CAP)}\n[truncated]`;
      return { ok: true, content: `# ${skill.name} — ${rel}\n\n${text}`, files };
    } catch {
      return { ok: false, content: `Error: file "${rel}" not found in skill "${id}". Files: ${files.join(', ')}` };
    }
  }
  let text = await fs.readFile(skill.file, 'utf8');
  if (text.length > SKILL_BODY_CAP) text = `${text.slice(0, SKILL_BODY_CAP)}\n[truncated]`;
  const { body } = parseFrontmatter(text);
  const extras = files.filter((f) => f !== 'SKILL.md');
  return {
    ok: true,
    content: `# Skill: ${skill.name}\n\n${body.trim()}${extras.length ? `\n\n[skill folder also contains: ${extras.join(', ')} — load one with use_skill { skill: "${id}", file: "<name>" }]` : ''}`,
    files,
  };
}

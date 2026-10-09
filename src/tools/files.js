import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { assertInWorkspace } from '../sandbox.js';
import { diffLines } from '../diff.js';

export const READ_CAP = 100_000; // chars of file content returned to the model
export const LINE_PREVIEW = 240;

function fail(content) {
  return { ok: false, content };
}

export async function readFile({ workspace }, args = {}) {
  let abs;
  try {
    abs = assertInWorkspace(workspace, args.path);
  } catch (err) {
    return fail(`Error: ${err.message}`);
  }
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return fail(`Error: file not found: ${args.path}`);
  }
  if (stat.isDirectory()) return fail(`Error: ${args.path} is a directory. Use list_dir instead.`);
  const buf = await fs.readFile(abs);
  if (buf.includes(0)) return fail(`${args.path} looks like a binary file (${buf.length} bytes); not shown.`);
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop(); // drop phantom line after trailing newline
  const start = Math.max(1, args.start_line ?? 1);
  const end = Math.min(lines.length, args.end_line ?? lines.length);
  if (start > lines.length) return fail(`Error: start_line ${start} is past end of file (${lines.length} lines).`);
  const out = [];
  let size = 0;
  let truncated = false;
  for (let i = start - 1; i < end; i++) {
    const line = `${i + 1}: ${lines[i]}`;
    size += line.length + 1;
    if (size > READ_CAP) {
      out.push(`${i + 1}: ...[output truncated at ${READ_CAP} chars; use start_line/end_line for the rest]`);
      truncated = true;
      break;
    }
    out.push(line);
  }
  return { ok: true, content: out.join('\n'), truncated };
}

export async function writeFile({ workspace }, args = {}) {
  if (typeof args.content !== 'string') return fail('Error: content must be a string.');
  let abs;
  try {
    abs = assertInWorkspace(workspace, args.path);
  } catch (err) {
    return fail(`Error: ${err.message}`);
  }
  try {
    const st = fssync.existsSync(abs) ? await fs.stat(abs) : null;
    if (st?.isDirectory()) return fail(`Error: ${args.path} is a directory.`);
  } catch {
    /* fall through to write error */
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, 'utf8');
  return {
    ok: true,
    content: `Created ${args.path} (${Buffer.byteLength(args.content)} bytes).`,
    diff: diffLines('', args.content),
  };
}

export async function editFile({ workspace }, args = {}) {
  let abs;
  try {
    abs = assertInWorkspace(workspace, args.path);
  } catch (err) {
    return fail(`Error: ${err.message}`);
  }
  // Multiple edits in one call: edits: [{old_string, new_string, all?}, ...]
  // applied in order, written once. Single old_string/new_string still work.
  let editList;
  if (Array.isArray(args.edits)) {
    if (args.edits.length === 0) return fail('Error: edits array is empty.');
    if (args.edits.length > 50) return fail('Error: at most 50 edits per call.');
    editList = args.edits;
  } else {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') {
      return fail('Error: provide old_string + new_string, or an edits array of {old_string, new_string, all?} objects.');
    }
    editList = [{ old_string: args.old_string, new_string: args.new_string, all: args.all }];
  }
  if (fssync.existsSync(abs)) {
    const st = await fs.stat(abs);
    if (st.isDirectory()) return fail(`Error: ${args.path} is a directory, not a file.`);
  }
  let content;
  try {
    content = await fs.readFile(abs, 'utf8');
  } catch {
    return fail(`Error: file not found: ${args.path}. Read the file first; use write_file to create a new file.`);
  }
  let updated = content;
  let totalReplaced = 0;
  for (let i = 0; i < editList.length; i++) {
    const e = editList[i] ?? {};
    if (typeof e.old_string !== 'string' || typeof e.new_string !== 'string') {
      return fail(`Error: edit #${i + 1} must have string old_string and new_string.`);
    }
    if (e.old_string === e.new_string) return fail(`Error: edit #${i + 1}: old_string and new_string are identical; nothing to do.`);
    const matches = updated.split(e.old_string).length - 1;
    if (matches === 0) {
      return fail(
        `Error: edit #${i + 1} old_string not found in ${args.path}. Read the file first and copy the exact text (including indentation and newlines). Edits are applied in order against the file as it stands after earlier edits.`
      );
    }
    if (matches > 1 && e.all !== true) {
      return fail(
        `Error: edit #${i + 1} old_string matches ${matches} times in ${args.path}; not unique. Include more surrounding context, or set all=true to replace every occurrence.`
      );
    }
    updated = updated.split(e.old_string).join(e.new_string);
    totalReplaced += matches;
  }
  await fs.writeFile(abs, updated, 'utf8');
  return {
    ok: true,
    content: `Edited ${args.path} (${editList.length} edit${editList.length > 1 ? 's' : ''}, ${totalReplaced} occurrence${totalReplaced > 1 ? 's' : ''} replaced).`,
    diff: diffLines(content, updated),
    occurrences: totalReplaced,
  };
}

export async function listDir({ workspace }, args = {}) {
  let abs;
  try {
    abs = assertInWorkspace(workspace, args.path ?? '.');
  } catch (err) {
    return fail(`Error: ${err.message}`);
  }
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    return fail(`Error: cannot list ${args.path ?? '.'}: ${err.message}`);
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const lines = [];
  for (const ent of entries) {
    let size = '';
    if (!ent.isDirectory()) {
      try {
        size = ` (${(await fs.stat(path.join(abs, ent.name))).size} bytes)`;
      } catch {
        /* ignore */
      }
    }
    lines.push(`${ent.isDirectory() ? 'd' : '-'} ${ent.name}${ent.isDirectory() ? '/' : ''}${size}`);
  }
  if (lines.length === 0) return { ok: true, content: '(empty directory)' };
  return { ok: true, content: lines.join('\n') };
}

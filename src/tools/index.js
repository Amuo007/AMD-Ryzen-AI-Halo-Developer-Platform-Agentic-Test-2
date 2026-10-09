import { readFile, writeFile, editFile, listDir } from './files.js';
import { runShell } from './shell.js';
import { search } from './search.js';

const string = { type: 'string' };

export const toolDefs = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file from the workspace. Returns text with "N: " line-number prefixes. Optionally pass start_line/end_line (1-based, inclusive) for a range.',
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
      description: 'Create or overwrite a file with the given content. Parent directories are created automatically.',
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
      description: 'Replace an exact string in a file. Fails if old_string is not found or matches more than once (set all=true to replace every occurrence).',
      parameters: {
        type: 'object',
        properties: {
          path: { ...string, description: 'File path relative to the workspace.' },
          old_string: { ...string, description: 'Exact text to replace (copy it verbatim from read_file, including whitespace).' },
          new_string: { ...string, description: 'Replacement text.' },
          all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List the entries of a directory in the workspace. Directories are shown with a trailing slash.',
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
      name: 'search',
      description: 'Search files with a regular expression. Returns "path:line: text" matches. Skips node_modules and .git.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { ...string, description: 'JavaScript regular expression.' },
          path: { ...string, description: 'File or directory to search in. Defaults to the workspace root.' },
          flags: { ...string, description: 'Optional regex flags, e.g. "i" for case-insensitive.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description: 'Run a bash command in the workspace directory. Returns exit code, stdout and stderr. Long output is truncated. Has a timeout (default 30s, max 300s).',
      parameters: {
        type: 'object',
        properties: {
          command: { ...string, description: 'The bash command to execute.' },
          timeout_ms: { type: 'integer', description: 'Optional timeout in milliseconds (1000-300000).' },
        },
        required: ['command'],
      },
    },
  },
];

const impl = new Map([
  ['read_file', readFile],
  ['write_file', writeFile],
  ['edit_file', editFile],
  ['list_dir', listDir],
  ['search', search],
  ['run_shell', runShell],
]);

export function getTool(name) {
  return impl.get(name);
}

export function isReadOnlyTool(name) {
  return name === 'read_file' || name === 'list_dir' || name === 'search';
}

export async function runTool(name, ctx, args) {
  const fn = impl.get(name);
  if (!fn) return { ok: false, content: `Error: unknown tool "${name}". Available tools: ${[...impl.keys()].join(', ')}.` };
  try {
    return await fn(ctx, args ?? {});
  } catch (err) {
    return { ok: false, content: `Error in ${name}: ${err.stack ?? err.message}` };
  }
}

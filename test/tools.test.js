import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// keep the todo tool's persistence out of the real database
const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'forge-tools-'));
process.env.FORGE_DATA_DIR = tmpHome;

const { runTool, toolDefs, isReadOnlyTool } = await import('../src/tools/index.js');

function tmpws() {
  return fssync.mkdtempSync(path.join(os.tmpdir(), 'forge-tools-'));
}

test('tool definitions cover all tools', () => {
  const names = toolDefs.map((t) => t.function.name);
  assert.deepEqual(names.sort(), ['edit_file', 'glob_files', 'kill_shell', 'list_dir', 'read_file', 'run_shell', 'search', 'shell_jobs', 'todo', 'use_skill', 'write_file']);
  for (const def of toolDefs) assert.equal(def.type, 'function');
  assert.equal(isReadOnlyTool('read_file'), true);
  assert.equal(isReadOnlyTool('glob_files'), true);
  assert.equal(isReadOnlyTool('run_shell'), false);
});

test('write_file creates file and parents, returns diff', async () => {
  const ws = tmpws();
  const res = await runTool('write_file', { workspace: ws }, { path: 'a/b/hello.txt', content: 'hello\nworld\n' });
  assert.equal(res.ok, true);
  assert.equal(await fs.readFile(path.join(ws, 'a/b/hello.txt'), 'utf8'), 'hello\nworld\n');
  assert.ok(res.diff.some((l) => l.type === 'add' && l.text === 'hello'));
});

test('write_file refuses paths outside the workspace', async () => {
  const ws = tmpws();
  const res = await runTool('write_file', { workspace: ws }, { path: '../escape.txt', content: 'x' });
  assert.equal(res.ok, false);
  assert.match(res.content, /escapes workspace/);
});

test('read_file returns numbered lines and supports ranges', async () => {
  const ws = tmpws();
  await fs.writeFile(path.join(ws, 'f.txt'), 'one\ntwo\nthree\nfour\n');
  const all = await runTool('read_file', { workspace: ws }, { path: 'f.txt' });
  assert.equal(all.ok, true);
  assert.match(all.content, /^1: one/);
  assert.match(all.content, /^4: four/m);
  const range = await runTool('read_file', { workspace: ws }, { path: 'f.txt', start_line: 2, end_line: 3 });
  assert.equal(range.content, '2: two\n3: three');
});

test('read_file errors clearly', async () => {
  const ws = tmpws();
  assert.match((await runTool('read_file', { workspace: ws }, { path: 'nope.txt' })).content, /not found/);
  assert.equal((await runTool('read_file', { workspace: ws }, { path: '.' })).ok, false);
});

test('read_file truncates huge output', async () => {
  const ws = tmpws();
  await fs.writeFile(path.join(ws, 'big.txt'), 'x'.repeat(200000) + '\n');
  const res = await runTool('read_file', { workspace: ws }, { path: 'big.txt' });
  assert.equal(res.truncated, true);
  assert.ok(res.content.length < 110_000);
});

test('edit_file replaces a unique occurrence', async () => {
  const ws = tmpws();
  await fs.writeFile(path.join(ws, 'f.txt'), 'alpha\nbeta\ngamma\n');
  const res = await runTool('edit_file', { workspace: ws }, { path: 'f.txt', old_string: 'beta', new_string: 'BETA!' });
  assert.equal(res.ok, true);
  assert.equal(await fs.readFile(path.join(ws, 'f.txt'), 'utf8'), 'alpha\nBETA!\ngamma\n');
  assert.ok(res.diff.some((l) => l.type === 'del'));
});

test('edit_file fails when string is missing', async () => {
  const ws = tmpws();
  await fs.writeFile(path.join(ws, 'f.txt'), 'alpha\n');
  const res = await runTool('edit_file', { workspace: ws }, { path: 'f.txt', old_string: 'zzz', new_string: 'q' });
  assert.equal(res.ok, false);
  assert.match(res.content, /not found/);
});

test('edit_file fails when match is not unique, unless all=true', async () => {
  const ws = tmpws();
  await fs.writeFile(path.join(ws, 'f.txt'), 'x\nx\nx\n');
  const res = await runTool('edit_file', { workspace: ws }, { path: 'f.txt', old_string: 'x', new_string: 'y' });
  assert.equal(res.ok, false);
  assert.match(res.content, /3 times/);
  const all = await runTool('edit_file', { workspace: ws }, { path: 'f.txt', old_string: 'x', new_string: 'y', all: true });
  assert.equal(all.ok, true);
  assert.equal(await fs.readFile(path.join(ws, 'f.txt'), 'utf8'), 'y\ny\ny\n');
});

test('list_dir lists entries with dirs marked', async () => {
  const ws = tmpws();
  await fs.mkdir(path.join(ws, 'sub'));
  await fs.writeFile(path.join(ws, 'a.txt'), 'hi');
  const res = await runTool('list_dir', { workspace: ws }, {});
  assert.equal(res.ok, true);
  assert.match(res.content, /- a\.txt/);
  assert.match(res.content, /d sub\//);
});

test('search finds regex matches and skips node_modules/.git', async () => {
  const ws = tmpws();
  await fs.mkdir(path.join(ws, 'src'));
  await fs.mkdir(path.join(ws, 'node_modules', 'pkg'), { recursive: true });
  await fs.mkdir(path.join(ws, '.git'), { recursive: true });
  await fs.writeFile(path.join(ws, 'src', 'a.js'), 'const needle = 1;\nnothing here\nNEEDLE upper\n');
  await fs.writeFile(path.join(ws, 'node_modules', 'pkg', 'hidden.js'), 'needle in node_modules\n');
  await fs.writeFile(path.join(ws, '.git', 'HEAD.txt'), 'needle in git\n');
  const res = await runTool('search', { workspace: ws }, { pattern: 'needle' });
  assert.equal(res.ok, true);
  assert.equal(res.count, 1);
  assert.match(res.content, /^src\/a\.js:1: const needle = 1;/);
  const ci = await runTool('search', { workspace: ws }, { pattern: 'needle', flags: 'i' });
  assert.equal(ci.count, 2);
});

test('search reports invalid regex clearly', async () => {
  const ws = tmpws();
  const res = await runTool('search', { workspace: ws }, { pattern: '(unclosed' });
  assert.equal(res.ok, false);
  assert.match(res.content, /invalid regex/);
});

test('run_shell returns exit code, stdout and stderr', async () => {
  const ws = tmpws();
  const ok = await runTool('run_shell', { workspace: ws }, { command: 'echo out; echo err 1>&2; exit 3' });
  assert.equal(ok.ok, false);
  assert.match(ok.content, /exit code: 3/);
  assert.match(ok.content, /out/);
  assert.match(ok.content, /err/);
});

test('run_shell runs inside the workspace', async () => {
  const ws = tmpws();
  const res = await runTool('run_shell', { workspace: ws }, { command: 'touch marker.txt && pwd' });
  assert.equal(res.ok, true);
  assert.ok(fssync.existsSync(path.join(fssync.realpathSync(ws), 'marker.txt')));
});

test('run_shell times out and kills the command', async () => {
  const ws = tmpws();
  const start = Date.now();
  const res = await runTool('run_shell', { workspace: ws }, { command: 'sleep 30', timeout_ms: 1000 });
  const dur = Date.now() - start;
  assert.equal(res.ok, false);
  assert.equal(res.timedOut, true);
  assert.match(res.content, /TIMED OUT/);
  assert.ok(dur < 5000, `timed out took ${dur}ms`);
});

test('run_shell kills child processes on timeout', async () => {
  const ws = tmpws();
  const res = await runTool('run_shell', { workspace: ws }, {
    command: 'sleep 30 & CHILD=$!; wait $CHILD; echo should-not-reach',
    timeout_ms: 1000,
  });
  assert.equal(res.timedOut, true);
  assert.doesNotMatch(res.content, /should-not-reach/);
});

test('run_shell truncates huge output', async () => {
  const ws = tmpws();
  const res = await runTool('run_shell', { workspace: ws }, { command: 'seq 1 50000' });
  assert.equal(res.ok, true);
  assert.match(res.content, /truncated/);
  assert.ok(res.content.length < 200_000);
});

test('run_shell stops on abort signal', async () => {
  const ws = tmpws();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 200);
  const res = await runTool('run_shell', { workspace: ws, signal: ac.signal }, { command: 'sleep 30', timeout_ms: 20000 });
  assert.equal(res.aborted, true);
  assert.match(res.content, /STOPPED/);
});

test('unknown tool returns clear error', async () => {
  const res = await runTool('no_such_tool', { workspace: tmpws() }, {});
  assert.equal(res.ok, false);
  assert.match(res.content, /unknown tool/);
});

/* ---------------- glob_files ---------------- */

test('glob_files matches patterns, newest-first, skipping node_modules', async () => {
  const ws = tmpws();
  await fs.mkdir(path.join(ws, 'src/deep'), { recursive: true });
  await fs.mkdir(path.join(ws, 'node_modules/pkg'), { recursive: true });
  await fs.writeFile(path.join(ws, 'src/a.ts'), 'a');
  await fs.writeFile(path.join(ws, 'src/deep/b.ts'), 'b');
  await fs.writeFile(path.join(ws, 'src/c.js'), 'c');
  await fs.writeFile(path.join(ws, 'node_modules/pkg/d.ts'), 'd');
  const r = await runTool('glob_files', { workspace: ws }, { pattern: '**/*.ts' });
  assert.equal(r.ok, true);
  const lines = r.content.split('\n');
  assert.deepEqual(lines.length, 2);
  assert.ok(lines.includes('src/a.ts') && lines.includes('src/deep/b.ts'), r.content);
  const alt = await runTool('glob_files', { workspace: ws }, { pattern: '*.{js,ts}', path: 'src' });
  assert.equal(alt.count, 3);
  const none = await runTool('glob_files', { workspace: ws }, { pattern: '*.rs' });
  assert.equal(none.count, 0);
  assert.match(none.content, /No files match/);
  const noPat = await runTool('glob_files', { workspace: ws }, {});
  assert.equal(noPat.ok, false);
});

/* ---------------- edit_file multi-edit ---------------- */

test('edit_file applies an edits array in order with a single write', async () => {
  const ws = tmpws();
  await fs.writeFile(path.join(ws, 'f.txt'), 'one\ntwo\nthree\n');
  const res = await runTool(
    'edit_file',
    { workspace: ws },
    { path: 'f.txt', edits: [{ old_string: 'one', new_string: 'ONE' }, { old_string: 'three', new_string: 'THREE' }, { old_string: 'ONE', new_string: 'Uno' }] }
  );
  assert.equal(res.ok, true);
  assert.equal(await fs.readFile(path.join(ws, 'f.txt'), 'utf8'), 'Uno\ntwo\nTHREE\n');
  assert.match(res.content, /3 edits, 3 occurrences replaced/);
});

test('edit_file multi-edit fails with index when a step is missing or ambiguous', async () => {
  const ws = tmpws();
  await fs.writeFile(path.join(ws, 'f.txt'), 'aa\nbb\n');
  const missing = await runTool('edit_file', { workspace: ws }, { path: 'f.txt', edits: [{ old_string: 'aa', new_string: 'x' }, { old_string: 'zz', new_string: 'y' }] });
  assert.equal(missing.ok, false);
  assert.match(missing.content, /edit #2 old_string not found/);
  assert.equal(await fs.readFile(path.join(ws, 'f.txt'), 'utf8'), 'aa\nbb\n', 'nothing written on failed multi-edit');
  const ambig = await runTool('edit_file', { workspace: ws }, { path: 'f.txt', edits: [{ old_string: 'a', new_string: 'z' }] });
  assert.match(ambig.content, /edit #1 old_string matches 2 times/);
});

/* ---------------- search upgrades ---------------- */

test('search supports glob filter, ignore_case and context_lines', async () => {
  const ws = tmpws();
  await fs.mkdir(path.join(ws, 'src'));
  await fs.writeFile(path.join(ws, 'src/a.js'), 'first\nNEEDLE one\nthird\nfourth\n');
  await fs.writeFile(path.join(ws, 'src/b.py'), 'needle two\n');
  const byGlob = await runTool('search', { workspace: ws }, { pattern: 'needle', ignore_case: true, glob: '*.js' });
  assert.equal(byGlob.count, 1);
  assert.match(byGlob.content, /^src\/a\.js:2:/);
  const ctx = await runTool('search', { workspace: ws }, { pattern: 'NEEDLE', context_lines: 2 });
  assert.equal(ctx.ok, true);
  assert.match(ctx.content, /src\/a\.js:2: NEEDLE one/);
  assert.match(ctx.content, /src\/a\.js:3- third/);
  assert.match(ctx.content, /src\/a\.js:4- fourth/);
  const badGlob = await runTool('search', { workspace: ws }, { pattern: 'x', glob: '[z-a]' });
  assert.equal(badGlob.ok, false);
});

/* ---------------- background shells ---------------- */

test('run_shell background: starts a job, reads output, kills it', async () => {
  const ws = tmpws();
  const started = await runTool('run_shell', { workspace: ws }, { command: 'echo bg-hello; sleep 30', background: true });
  assert.equal(started.ok, true);
  assert.match(started.content, /background job bg\d+/);
  const jobId = started.jobId;
  await new Promise((r) => setTimeout(r, 300));
  const list = await runTool('shell_jobs', { workspace: ws }, {});
  assert.equal(list.ok, true);
  assert.match(list.content, new RegExp(jobId));
  assert.match(list.content, /running/);
  const detail = await runTool('shell_jobs', { workspace: ws }, { job_id: jobId });
  assert.match(detail.content, /bg-hello/);
  const again = await runTool('shell_jobs', { workspace: ws }, { job_id: jobId });
  assert.match(again.content, /no new output/);
  const killed = await runTool('kill_shell', { workspace: ws }, { job_id: jobId });
  assert.equal(killed.ok, true);
  assert.match(killed.content, /status: (killed|exited)/);
  const after = await runTool('shell_jobs', { workspace: ws }, { job_id: jobId });
  assert.match(after.content, /(killed|exited)/);
  const badKill = await runTool('kill_shell', { workspace: ws }, { job_id: 'bg999' });
  assert.equal(badKill.ok, false);
  assert.match(badKill.content, /no such job/);
});

test('kill_shell kills the whole process group', async () => {
  const ws = tmpws();
  const started = await runTool('run_shell', { workspace: ws }, { command: 'sleep 40 & echo CHILD=$!; wait', background: true });
  const jobId = started.jobId;
  await new Promise((r) => setTimeout(r, 300));
  const detail = await runTool('shell_jobs', { workspace: ws }, { job_id: jobId });
  const childPid = Number(detail.content.match(/CHILD=(\d+)/)?.[1]);
  assert.ok(childPid > 0, 'child pid printed');
  await runTool('kill_shell', { workspace: ws }, { job_id: jobId });
  await new Promise((r) => setTimeout(r, 200));
  let alive = true;
  try {
    process.kill(childPid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, 'grandchild process was killed with the group');
});

/* ---------------- todo tool ---------------- */

test('todo tool validates, persists and emits', async () => {
  const { getTodos } = await import('../src/db.js');
  const events = [];
  const ctx = { workspace: tmpws(), sessionId: 'todosess', emit: (e) => events.push(e) };
  const bad = await runTool('todo', ctx, { todos: 'nope' });
  assert.equal(bad.ok, false);
  const badItem = await runTool('todo', ctx, { todos: [{ content: '', status: 'pending' }] });
  assert.equal(badItem.ok, false);
  const ok = await runTool('todo', ctx, { todos: [
    { id: '1', content: 'Do the thing', status: 'in_progress' },
    { id: '2', content: 'Then the other thing', status: 'pending' },
  ] });
  assert.equal(ok.ok, true);
  assert.match(ok.content, /1\. \[~\] Do the thing/);
  assert.equal(events.at(-1).type, 'todo_update');
  assert.equal(events.at(-1).todos.length, 2);
  const stored = getTodos('todosess');
  assert.equal(stored.length, 2);
  assert.equal(stored[0].status, 'in_progress');
  const tooMany = await runTool('todo', ctx, { todos: Array.from({ length: 51 }, (_, i) => ({ content: `t${i}`, status: 'pending' })) });
  assert.equal(tooMany.ok, false);
});

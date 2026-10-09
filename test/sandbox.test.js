import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInWorkspace, assertInWorkspace } from '../src/sandbox.js';

function mktmp() {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'forge-sandbox-'));
}

test('relative path inside workspace is allowed', () => {
  const ws = mktmp();
  fs.mkdirSync(path.join(ws, 'src'));
  const r = resolveInWorkspace(ws, 'src/app.js');
  assert.equal(r.ok, true);
  assert.equal(r.resolved, path.join(fs.realpathSync(ws), 'src/app.js'));
});

test('absolute path inside workspace is allowed', () => {
  const ws = mktmp();
  const abs = path.join(ws, 'a.txt');
  const r = resolveInWorkspace(ws, abs);
  assert.equal(r.ok, true);
  assert.equal(r.resolved, path.join(fs.realpathSync(ws), 'a.txt'));
});

test('dot and dot-dot paths that stay inside are allowed', () => {
  const ws = mktmp();
  fs.mkdirSync(path.join(ws, 'a/b'), { recursive: true });
  const r = resolveInWorkspace(ws, 'a/b/../b/x.txt');
  assert.equal(r.ok, true);
});

test('traversal outside workspace is rejected', () => {
  const ws = mktmp();
  const r = resolveInWorkspace(ws, '../evil.txt');
  assert.equal(r.ok, false);
  assert.match(r.error, /escapes workspace/);
  assert.throws(() => assertInWorkspace(ws, '../evil.txt'), /escapes workspace/);
});

test('absolute path outside workspace is rejected', () => {
  const ws = mktmp();
  const r = resolveInWorkspace(ws, '/etc/passwd');
  assert.equal(r.ok, false);
  assert.match(r.error, /escapes workspace/);
});

test('symlink to a file outside the workspace is rejected', () => {
  const ws = mktmp();
  const outside = mktmp();
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'top secret');
  fs.symlinkSync(secret, path.join(ws, 'link'));
  const r = resolveInWorkspace(ws, 'link');
  assert.equal(r.ok, false);
  assert.match(r.error, /escapes workspace/);
});

test('symlink to a directory outside the workspace is rejected', () => {
  const ws = mktmp();
  const outside = mktmp();
  fs.mkdirSync(path.join(outside, 'dir'));
  fs.symlinkSync(outside, path.join(ws, 'out'));
  const r = resolveInWorkspace(ws, 'out/dir/file.txt');
  assert.equal(r.ok, false);
});

test('symlink pointing to a non-existent path outside is rejected', () => {
  const ws = mktmp();
  fs.symlinkSync('/tmp/definitely-not-here-xyz/file.txt', path.join(ws, 'dangling'));
  const r = resolveInWorkspace(ws, 'dangling');
  assert.equal(r.ok, false);
});

test('symlink inside the workspace is allowed', () => {
  const ws = mktmp();
  fs.mkdirSync(path.join(ws, 'real'));
  fs.symlinkSync(path.join(ws, 'real'), path.join(ws, 'alias'));
  const r = resolveInWorkspace(ws, 'alias/file.txt');
  assert.equal(r.ok, true);
  assert.equal(r.resolved, path.join(fs.realpathSync(ws), 'real/file.txt'));
});

test('workspace itself given through a symlink works', () => {
  const realWs = mktmp();
  const linkParent = mktmp();
  const wsLink = path.join(linkParent, 'ws');
  fs.symlinkSync(realWs, wsLink);
  const r = resolveInWorkspace(wsLink, 'file.txt');
  assert.equal(r.ok, true);
  assert.equal(r.resolved, path.join(realWs, 'file.txt'));
});

test('non-string target is rejected', () => {
  const ws = mktmp();
  assert.equal(resolveInWorkspace(ws, 123).ok, false);
  assert.equal(resolveInWorkspace(ws, null).ok, false);
});

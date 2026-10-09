import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines } from '../src/diff.js';

test('identical texts produce only context lines', () => {
  const d = diffLines('a\nb\nc', 'a\nb\nc');
  assert.deepEqual(d.map((l) => l.type), ['ctx', 'ctx', 'ctx']);
});

test('single line change', () => {
  const d = diffLines('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(d.map((l) => l.type), ['ctx', 'del', 'add', 'ctx']);
  assert.equal(d[1].text, 'b');
  assert.equal(d[2].text, 'B');
});

test('insertion in the middle', () => {
  const d = diffLines('a\nc', 'a\nb\nc');
  assert.deepEqual(d.map((l) => l.type), ['ctx', 'add', 'ctx']);
});

test('empty old text is all additions', () => {
  const d = diffLines('', 'x\ny');
  assert.deepEqual(d.map((l) => l.type), ['add', 'add']);
});

test('huge texts fall back to meta + full replacement', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
  const d = diffLines(big, big + '\nextra');
  assert.equal(d[0].type, 'meta');
});

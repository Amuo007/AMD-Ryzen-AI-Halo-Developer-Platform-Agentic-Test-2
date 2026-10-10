import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'forge-img-'));
process.env.FORGE_DATA_DIR = path.join(tmpHome, 'data');

const { startServer } = await import('../src/server.js');
const { useDatabase } = await import('../src/db.js');
const { saveImage, imageExists, imagesDir, parseDataUrl, materializeForModel, SCREENSHOT_NAME, MAX_IMAGE_BYTES } = await import('../src/images.js');
const { startMockLLM, deltaChunk, textChunks } = await import('./helpers/mock-llm.js');

// 1x1 red PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgZmQAAAMAAOZ9A5cAAAAASUVORK5CYII=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

useDatabase(path.join(tmpHome, 'data', 'forge.db'));

/* ---------------- unit: saveImage + materialize ---------------- */

test('saveImage stores a PNG on disk and in the db', () => {
  const img = saveImage({ dataUrl: PNG, source: 'user' });
  assert.match(img.id, /^img-/);
  assert.equal(img.mime, 'image/png');
  assert.ok(img.bytes > 0);
  assert.ok(fs.existsSync(img.path));
  assert.equal(fs.readFileSync(img.path).length, img.bytes);
  assert.ok(imageExists(img.id));
  assert.equal(fs.existsSync(imagesDir()), true);
});

test('parseDataUrl extracts mime + bytes', () => {
  const p = parseDataUrl(JPEG);
  assert.equal(p.mime, 'image/jpeg');
  assert.ok(p.buffer.length > 0);
  assert.equal(parseDataUrl('http://x/y'), null);
  assert.equal(parseDataUrl('data:text/plain,hi'), null);
});

test('saveImage rejects bad input (415 type / 400 empty)', () => {
  assert.throws(() => saveImage({ dataUrl: 'data:image/bmp;base64,AAAA' }), (e) => e.status === 415);
  assert.throws(() => saveImage({ dataUrl: 'data:image/png;base64,' }), (e) => e.status === 400);
  const big = 'data:image/png;base64,' + Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64');
  assert.throws(() => saveImage({ dataUrl: big }), (e) => e.status === 413);
});

test('materializeForModel turns images into OpenAI content parts', () => {
  const a = saveImage({ dataUrl: PNG });
  const msgs = [{ role: 'user', content: 'look', images: [a.id] }];
  const out = materializeForModel(msgs, { vision: true });
  const parts = out[0].content;
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: 'text', text: 'look' });
  assert.equal(parts[1].type, 'image_url');
  assert.match(parts[1].image_url.url, /^data:image\/png;base64,/);
});

test('materializeForModel: vision off replaces images with a text note', () => {
  const a = saveImage({ dataUrl: PNG });
  const out = materializeForModel([{ role: 'user', content: 'x', images: [a.id] }], { vision: false });
  assert.equal(typeof out[0].content, 'string');
  assert.match(out[0].content, /image attached but image support is off/);
});

test('materializeForModel: only the latest 2 screenshots stay, user images never pruned', () => {
  const ids = [saveImage({ dataUrl: PNG, source: 'screenshot' }), saveImage({ dataUrl: PNG, source: 'screenshot' }), saveImage({ dataUrl: PNG, source: 'screenshot' })];
  const userImg = saveImage({ dataUrl: PNG, source: 'user' });
  const msgs = [
    { role: 'user', content: 'ref', images: [userImg.id] }, // user image — never pruned
    { role: 'user', name: SCREENSHOT_NAME, content: 'shot1', images: [ids[0].id] },
    { role: 'user', name: SCREENSHOT_NAME, content: 'shot2', images: [ids[1].id] },
    { role: 'user', name: SCREENSHOT_NAME, content: 'shot3', images: [ids[2].id] },
  ];
  const out = materializeForModel(msgs, { vision: true });
  assert.ok(Array.isArray(out[0].content), 'user image kept');
  assert.equal(typeof out[1].content, 'string');
  assert.match(out[1].content, /earlier screenshot removed/);
  assert.ok(Array.isArray(out[2].content), 'shot2 kept');
  assert.ok(Array.isArray(out[3].content), 'shot3 kept');
});

/* ---------------- server routes ---------------- */

let forge;
let mock;
let mockHandler = () => ({ chunks: [...textChunks('ok'), deltaChunk({}, 'stop')] });

test('boot forge + mock', async () => {
  mock = await startMockLLM((body, n) => mockHandler(body, n));
  process.env.FORGE_BASE_URL = mock.url;
  process.env.FORGE_API_KEY = 'local';
  forge = await startServer({ port: 0, openBrowser: false });
});

const base = () => `http://127.0.0.1:${forge.port}`;

async function req(method, pathname, body) {
  const res = await fetch(base() + pathname, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

let uploadedId;
test('POST /api/images stores + GET /api/images/:id serves it', async () => {
  const up = await req('POST', '/api/images', { data: PNG, source: 'user', width: 1, height: 1 });
  assert.equal(up.status, 201);
  uploadedId = up.data.id;
  assert.equal(up.data.mime, 'image/png');
  assert.equal(up.data.url, `/api/images/${uploadedId}`);
  const got = await fetch(`${base()}/api/images/${uploadedId}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/png');
  const buf = Buffer.from(await got.arrayBuffer());
  assert.ok(buf.length > 0);
});

test('POST /api/images rejects unsupported types', async () => {
  const r = await req('POST', '/api/images', { data: 'data:application/pdf;base64,AAAA' });
  assert.equal(r.status, 415);
});

test('GET /api/images/:id 404s for unknown id', async () => {
  const r = await req('GET', '/api/images/nope');
  assert.equal(r.status, 404);
});

test('a chat turn with an image sends OpenAI image_url parts to the model', async () => {
  const ws = await fsp.mkdtemp(path.join(tmpHome, 'ws-'));
  const up = await req('POST', '/api/images', { data: JPEG, source: 'user' });
  const r = await req('POST', '/api/chat', { sessionId: 'imgchat', agentMode: 'chat', message: 'what is in this picture?', images: [up.data.id] });
  assert.equal(r.status, 202);
  await new Promise((r2) => setTimeout(r2, 300));
  const sent = mock.requests.at(-1);
  const lastUser = [...sent.messages].reverse().find((m) => m.role === 'user');
  assert.ok(Array.isArray(lastUser.content), 'content is an array of parts');
  assert.equal(lastUser.content[0].type, 'text');
  assert.equal(lastUser.content[1].type, 'image_url');
  assert.match(lastUser.content[1].image_url.url, /^data:image\/jpeg;base64,/);
});

test('more than 5 images per message is rejected', async () => {
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push((await req('POST', '/api/images', { data: PNG })).data.id);
  const r = await req('POST', '/api/chat', { sessionId: 'imgmany', agentMode: 'chat', message: 'x', images: ids });
  assert.equal(r.status, 400);
});

test('vision off: no image parts reach the model', async () => {
  await req('PUT', '/api/config', { modelSupportsImages: false });
  const up = await req('POST', '/api/images', { data: PNG });
  const r = await req('POST', '/api/chat', { sessionId: 'imgoff', agentMode: 'chat', message: 'see this?', images: [up.data.id] });
  assert.equal(r.status, 202);
  await new Promise((r2) => setTimeout(r2, 300));
  const sent = mock.requests.at(-1);
  const lastUser = [...sent.messages].reverse().find((m) => m.role === 'user');
  assert.equal(typeof lastUser.content, 'string');
  assert.match(lastUser.content, /image support is off/);
  await req('PUT', '/api/config', { modelSupportsImages: true });
});

test('images reload with old conversations', async () => {
  const { session } = (await req('GET', '/api/session?sessionId=imgchat')).data;
  const user = session.messages.find((m) => m.role === 'user' && Array.isArray(m.images) && m.images.length);
  assert.ok(user, 'user message with images found on reload');
  assert.match(user.images[0], /^img-/);
});

test('shutdown', async () => {
  await forge.close();
  await mock.close();
});

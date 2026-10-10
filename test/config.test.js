import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, maskKey, publicConfig, DEFAULTS } from '../src/config.js';
import { useDatabase, getSetting, dbFilePath } from '../src/db.js';

function freshDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cfgdb-'));
  const file = path.join(dir, 'forge.db');
  useDatabase(file);
  return file;
}

test('defaults without any stored settings', () => {
  freshDb();
  const cfg = loadConfig();
  assert.equal(cfg.baseURL, DEFAULTS.baseURL);
  assert.equal(cfg.model, 'Qwen3.8-Flash-Next-GGUF-IQ3_M');
  assert.equal(cfg.maxSteps, 50);
  assert.equal(cfg.contextLimit, 140000);
  assert.equal(cfg.handoffLimit, 128000);
  assert.equal(cfg.apiKey, 'local');
});

test('db values override defaults, env overrides db', async () => {
  freshDb();
  await saveConfig({ baseURL: 'http://file/v1', model: 'file-model', apiKey: 'filekey' });
  assert.equal(loadConfig().baseURL, 'http://file/v1');
  process.env.FORGE_BASE_URL = 'http://env/v1';
  process.env.FORGE_MODEL = 'env-model';
  assert.equal(loadConfig().baseURL, 'http://env/v1');
  assert.equal(loadConfig().model, 'env-model');
  delete process.env.FORGE_BASE_URL;
  delete process.env.FORGE_MODEL;
  assert.equal(loadConfig().baseURL, 'http://file/v1');
});

test('env FORGE_API_KEY overrides stored key', () => {
  freshDb();
  process.env.FORGE_API_KEY = 'envkey';
  assert.equal(loadConfig().apiKey, 'envkey');
  delete process.env.FORGE_API_KEY;
});

test('numeric values persist as numbers and clamp', async () => {
  freshDb();
  await saveConfig({ maxSteps: '7', contextLimit: 5000 });
  const cfg = loadConfig();
  assert.equal(cfg.maxSteps, 7);
  assert.equal(cfg.contextLimit, 5000);
  assert.equal(cfg.handoffLimit, 3000, 'handoff clamps below a small context window');
  await saveConfig({ maxSteps: 0 });
  assert.equal(loadConfig().maxSteps, 1); // clamped
  await saveConfig({ handoffLimit: 999999999 });
  assert.ok(loadConfig().handoffLimit < loadConfig().contextLimit, 'handoff always below the window');
});

test('saveConfig merges and only accepts known keys', async () => {
  const file = freshDb();
  await saveConfig({ baseURL: 'http://a/v1', evil: 'x' });
  assert.equal(getSetting('evil'), null);
  assert.equal(loadConfig().baseURL, 'http://a/v1');
  assert.ok(fs.existsSync(file));
});

test('saveConfig ignores re-submitted masked key', async () => {
  freshDb();
  await saveConfig({ apiKey: 'sk-secret123456' });
  const masked = maskKey('sk-secret123456');
  await saveConfig({ apiKey: masked });
  assert.equal(loadConfig().apiKey, 'sk-secret123456');
});

test('maskKey never leaks the middle', () => {
  assert.equal(maskKey('sk-1234567890abcdef'), '••••••••cdef');
  assert.equal(maskKey('short'), '••••••••');
  assert.equal(maskKey(''), '');
  const view = publicConfig({ baseURL: 'b', model: 'm', apiKey: 'supersecret', maxSteps: 5, contextLimit: 9, port: 1 });
  assert.equal(view.apiKey, undefined);
  assert.equal(view.apiKeyMasked, '••••••••cret');
  assert.equal(view.hasApiKey, true);
});

test('settings survive reopening the same db file', async () => {
  const file = freshDb();
  await saveConfig({ model: 'persist-model' });
  useDatabase(file); // reopen
  assert.equal(loadConfig().model, 'persist-model');
  assert.equal(dbFilePath(), file);
});

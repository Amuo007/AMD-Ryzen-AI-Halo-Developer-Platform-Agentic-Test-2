import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig, maskKey, publicConfig, configFilePath, DEFAULTS } from '../src/config.js';

function tmpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-cfg-'));
  process.env.FORGE_CONFIG = path.join(dir, 'config.json');
  return process.env.FORGE_CONFIG;
}

test('defaults without any config', () => {
  tmpConfig();
  const cfg = loadConfig();
  assert.equal(cfg.baseURL, DEFAULTS.baseURL);
  assert.equal(cfg.model, 'Qwen3.8-Flash-Next-GGUF-IQ3_M');
  assert.equal(cfg.maxSteps, 50);
  assert.equal(cfg.contextLimit, 100000);
  assert.equal(cfg.apiKey, 'local');
});

test('file values override defaults, env overrides file', async () => {
  const file = tmpConfig();
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

test('env FORGE_API_KEY overrides file key', () => {
  tmpConfig();
  process.env.FORGE_API_KEY = 'envkey';
  assert.equal(loadConfig().apiKey, 'envkey');
  delete process.env.FORGE_API_KEY;
});

test('corrupt config file falls back to defaults', () => {
  const file = tmpConfig();
  fs.writeFileSync(file, 'not json at all {{{');
  const cfg = loadConfig();
  assert.equal(cfg.baseURL, DEFAULTS.baseURL);
});

test('saveConfig merges and only accepts known keys', async () => {
  const file = tmpConfig();
  await saveConfig({ baseURL: 'http://a/v1', evil: 'x' });
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.baseURL, 'http://a/v1');
  assert.equal(raw.evil, undefined);
});

test('saveConfig ignores re-submitted masked key', async () => {
  const file = tmpConfig();
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

test('numeric clamping', () => {
  tmpConfig();
  process.env.FORGE_BASE_URL = 'http://x/v1';
  const cfg = loadConfig();
  assert.ok(cfg.maxSteps >= 1);
  delete process.env.FORGE_BASE_URL;
});

test('configFilePath respects FORGE_CONFIG', () => {
  tmpConfig();
  assert.equal(configFilePath(), process.env.FORGE_CONFIG);
});

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const DEFAULTS = {
  baseURL: 'http://192.168.1.252:13305/v1',
  apiKey: 'local',
  model: 'Qwen3.8-Flash-Next-GGUF-IQ3_M',
  maxSteps: 50,
  contextLimit: 100000,
  port: 4848,
};

/** Where the config file lives (override with FORGE_CONFIG, for tests). */
export function configFilePath() {
  return process.env.FORGE_CONFIG || path.join(os.homedir(), '.config', 'forge', 'config.json');
}

/**
 * Load config: file values, then env overrides
 * (FORGE_BASE_URL, FORGE_API_KEY, FORGE_MODEL).
 */
export function loadConfig() {
  const cfg = { ...DEFAULTS };
  const file = configFilePath();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(DEFAULTS)) {
        if (raw[key] !== undefined && raw[key] !== null) cfg[key] = raw[key];
      }
    }
  } catch {
    // no file / corrupt file → defaults
  }
  if (process.env.FORGE_BASE_URL) cfg.baseURL = process.env.FORGE_BASE_URL;
  if (process.env.FORGE_API_KEY) cfg.apiKey = process.env.FORGE_API_KEY;
  if (process.env.FORGE_MODEL) cfg.model = process.env.FORGE_MODEL;
  cfg.maxSteps = Math.max(1, Math.min(500, Number(cfg.maxSteps) || DEFAULTS.maxSteps));
  cfg.contextLimit = Math.max(4000, Number(cfg.contextLimit) || DEFAULTS.contextLimit);
  return cfg;
}

export function maskKey(key) {
  const k = String(key ?? '');
  if (!k) return '';
  if (k.length <= 8) return '••••••••';
  return `••••••••${k.slice(-4)}`;
}

/** Never expose the raw key; return a safe view for the browser. */
export function publicConfig(cfg) {
  return {
    baseURL: cfg.baseURL,
    model: cfg.model,
    maxSteps: cfg.maxSteps,
    contextLimit: cfg.contextLimit,
    port: cfg.port,
    apiKeyMasked: maskKey(cfg.apiKey),
    hasApiKey: Boolean(cfg.apiKey),
  };
}

/**
 * Merge a partial update into the config file. `apiKey` equal to the current
 * masked placeholder is ignored so the UI can resubmit without clobbering.
 */
export async function saveConfig(partial = {}) {
  const file = configFilePath();
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* start fresh */
  }
  const next = { ...current };
  for (const key of ['baseURL', 'model', 'maxSteps', 'contextLimit', 'port']) {
    if (partial[key] !== undefined) next[key] = partial[key];
  }
  if (partial.apiKey !== undefined) {
    const masked = maskKey(process.env.FORGE_API_KEY || current.apiKey || '');
    if (partial.apiKey !== masked) next.apiKey = partial.apiKey;
  }
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  return next;
}

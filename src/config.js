import { getAllSettings, setSetting } from './db.js';

export const DEFAULTS = {
  baseURL: 'http://192.168.1.252:13305/v1',
  apiKey: 'local',
  model: 'Qwen3.8-Flash-Next-GGUF-IQ3_M',
  maxSteps: 50,
  contextLimit: 140000, // every model is treated as a 140K-token window
  handoffLimit: 128000, // Code-mode automatic context handoff threshold
  sessionTokenBudget: 1000000, // total input tokens per conversation before the fresh-chat banner
  modelSupportsImages: true, // false → no image parts sent; attach disabled; screenshots → text
  browserPath: '', // empty → auto-detect Chrome / Chromium / Edge
  port: 4848,
};

const NUMERIC = new Set(['maxSteps', 'contextLimit', 'handoffLimit', 'sessionTokenBudget', 'port']);
const BOOLEAN = new Set(['modelSupportsImages']);

/**
 * Load config: defaults, then SQLite `settings` rows, then env overrides
 * (FORGE_BASE_URL, FORGE_API_KEY, FORGE_MODEL, FORGE_BROWSER_PATH).
 */
export function loadConfig() {
  const cfg = { ...DEFAULTS };
  const stored = getAllSettings();
  for (const key of Object.keys(DEFAULTS)) {
    if (stored[key] !== undefined && stored[key] !== null && stored[key] !== '') {
      if (NUMERIC.has(key)) cfg[key] = Number(stored[key]);
      else if (BOOLEAN.has(key)) cfg[key] = String(stored[key]) === 'true';
      else cfg[key] = stored[key];
    }
  }
  if (process.env.FORGE_BASE_URL) cfg.baseURL = process.env.FORGE_BASE_URL;
  if (process.env.FORGE_API_KEY) cfg.apiKey = process.env.FORGE_API_KEY;
  if (process.env.FORGE_MODEL) cfg.model = process.env.FORGE_MODEL;
  if (process.env.FORGE_BROWSER_PATH) cfg.browserPath = process.env.FORGE_BROWSER_PATH;
  cfg.maxSteps = clamp(Number(cfg.maxSteps), 1, 500, DEFAULTS.maxSteps);
  cfg.contextLimit = clamp(Number(cfg.contextLimit), 4000, 1_000_000_000, DEFAULTS.contextLimit);
  cfg.sessionTokenBudget = clamp(Number(cfg.sessionTokenBudget), 1000, 1_000_000_000, DEFAULTS.sessionTokenBudget);
  // handoff threshold must leave headroom under the window
  cfg.handoffLimit = clamp(Number(cfg.handoffLimit), 2000, cfg.contextLimit - 2000, Math.min(DEFAULTS.handoffLimit, cfg.contextLimit - 2000));
  return cfg;
}

function clamp(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
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
    handoffLimit: cfg.handoffLimit,
    sessionTokenBudget: cfg.sessionTokenBudget,
    modelSupportsImages: cfg.modelSupportsImages,
    browserPath: cfg.browserPath,
    port: cfg.port,
    apiKeyMasked: maskKey(cfg.apiKey),
    hasApiKey: Boolean(cfg.apiKey),
  };
}

/**
 * Merge a partial update into the settings table. `apiKey` equal to the current
 * masked placeholder is ignored so the UI can resubmit without clobbering.
 */
export async function saveConfig(partial = {}) {
  const current = {};
  const stored = getAllSettings();
  for (const key of Object.keys(DEFAULTS)) if (stored[key] !== undefined) current[key] = stored[key];
  for (const key of ['baseURL', 'model', 'maxSteps', 'contextLimit', 'handoffLimit', 'sessionTokenBudget', 'browserPath', 'port']) {
    if (partial[key] !== undefined) setSetting(key, partial[key]);
  }
  if (partial.modelSupportsImages !== undefined) setSetting('modelSupportsImages', partial.modelSupportsImages ? 'true' : 'false');
  if (partial.apiKey !== undefined) {
    const masked = maskKey(process.env.FORGE_API_KEY || current.apiKey || '');
    if (partial.apiKey !== masked) setSetting('apiKey', partial.apiKey);
  }
  return loadConfig();
}

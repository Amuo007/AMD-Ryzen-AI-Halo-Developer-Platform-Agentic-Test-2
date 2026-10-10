import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { loadConfig } from '../config.js';

/** Candidate absolute paths per platform (checked in order). */
function candidates() {
  const p = process.platform;
  if (p === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Chromium Canary.app/Contents/MacOS/Chromium Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      `${process.env.HOME}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
    ];
  }
  if (p === 'win32') {
    const pf = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean);
    const out = [];
    for (const base of pf) {
      out.push(`${base}\\Google\\Chrome\\Application\\chrome.exe`);
      out.push(`${base}\\Chromium\\Application\\chrome.exe`);
      out.push(`${base}\\Microsoft\\Edge\\Application\\msedge.exe`);
    }
    return out;
  }
  // linux + others: PATH lookups + common absolute paths
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/snap/bin/chromium',
    '/snap/bin/chromium.chrome',
  ];
}

function which(name) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('where', [name], { encoding: 'utf8' });
      if (r.status === 0) return r.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || null;
      return null;
    }
    const r = spawnSync('which', [name], { encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() || null : null;
  } catch {
    return null;
  }
}

function exists(p) {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve the browser binary to launch.
 * Priority: explicit override (config.browserPath or FORGE_BROWSER_PATH) →
 * detected candidates (paths + PATH lookup). Returns an absolute path or null.
 */
export function detectBrowser({ override = null } = {}) {
  const forced = override || loadConfig().browserPath || '';
  if (forced) return exists(forced) ? forced : null;
  for (const c of candidates()) {
    if (exists(c)) return c;
  }
  const names = process.platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'chromium.exe'] : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'chrome'];
  for (const n of names) {
    const w = which(n);
    if (w) return w;
  }
  return null;
}

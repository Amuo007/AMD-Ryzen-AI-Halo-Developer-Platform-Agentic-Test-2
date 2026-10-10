import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir, addImage, getImage } from './db.js';

export const MAX_IMAGES_PER_MESSAGE = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // decoded size cap per image
export const ALLOWED_IMAGE_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };
/** Screenshots taken by the browser tool carry this message name (user-role follow-ups). */
export const SCREENSHOT_NAME = 'forge:screenshot';
/** Persisted browser card (preview + url/title) appended at the end of a turn that used the browser. Never seen by the model. */
export const BROWSER_CARD_NAME = 'forge:browser-card';
/** Only the latest N screenshots stay visible to the model. */
export const MAX_SCREENSHOTS_IN_CONTEXT = 2;

export function imagesDir() {
  return path.join(defaultDataDir(), 'images');
}

/** Parse a data: URL into { mime, buffer } or null. */
export function parseDataUrl(dataUrl) {
  const m = /^data:([a-z0-9.+-]+\/[a-z0.+-]+)?[;,]base64,(.*)$/is.exec(String(dataUrl));
  if (!m) return null;
  const mime = (m[1] || 'application/octet-stream').toLowerCase();
  let buffer;
  try {
    buffer = Buffer.from(m[2], 'base64');
  } catch {
    return null;
  }
  return { mime, buffer };
}

/**
 * Save an image (from a data URL) into Halo's data dir and register it in SQLite.
 * Throws with .status on invalid input. Returns the stored image row.
 */
export function saveImage({ dataUrl, conversationId = null, source = 'user', width = 0, height = 0 }) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) throw Object.assign(new Error('data must be a base64 data: URL'), { status: 400 });
  const ext = ALLOWED_IMAGE_MIME[parsed.mime];
  if (!ext) throw Object.assign(new Error(`Unsupported image type ${parsed.mime} (allowed: PNG, JPEG, WebP, GIF)`), { status: 415 });
  if (!parsed.buffer.length) throw Object.assign(new Error('image is empty'), { status: 400 });
  if (parsed.buffer.length > MAX_IMAGE_BYTES) throw Object.assign(new Error(`image too large (${parsed.buffer.length} bytes, max ${MAX_IMAGE_BYTES})`), { status: 413 });
  const dir = imagesDir();
  fs.mkdirSync(dir, { recursive: true });
  const id = `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(dir, `${id}${ext}`);
  fs.writeFileSync(file, parsed.buffer);
  return addImage({ id, conversationId, source, mime: parsed.mime, path: file, width, height, bytes: parsed.buffer.length });
}

export function imageExists(id) {
  const img = getImage(id);
  return img && fs.existsSync(img.path) ? img : null;
}

/** OpenAI-style image_url content part for a stored image (or null if missing). */
export function imageToPart(id) {
  const img = imageExists(id);
  if (!img) return null;
  const b64 = fs.readFileSync(img.path).toString('base64');
  return { type: 'image_url', image_url: { url: `data:${img.mime};base64,${b64}` } };
}

/**
 * Turn stored messages into what the model actually receives:
 *  - internal message names (screenshots, browser cards) are always stripped
 *  - browser-card messages are dropped entirely (UI-only)
 *  - images on user messages become content parts (text first, then image_url parts)
 *  - with vision off, images are replaced by a text note
 *  - screenshots older than the latest N (name SCREENSHOT_NAME) lose their image
 * Returns new message objects; never prunes user-attached images.
 */
export function materializeForModel(messages, { vision = true } = {}) {
  const screenshotIdx = [];
  messages.forEach((m, i) => {
    if (m.name === SCREENSHOT_NAME && Array.isArray(m.images) && m.images.length) screenshotIdx.push(i);
  });
  const prunedScreenshots = new Set(screenshotIdx.slice(0, Math.max(0, screenshotIdx.length - MAX_SCREENSHOTS_IN_CONTEXT)));
  const out = messages.map((m, i) => {
    if (m.name === BROWSER_CARD_NAME) return null; // UI-only, never model content
    const { name, ...rest } = m; // internal names never travel to the API
    if (!Array.isArray(rest.images) || !rest.images.length) return rest;
    const text = typeof rest.content === 'string' ? rest.content : '';
    if (!vision) {
      return { ...rest, content: `${text}${text ? '\n' : ''}[image attached but image support is off in Settings]` };
    }
    if (prunedScreenshots.has(i)) {
      return { ...rest, content: `${text}${text ? '\n' : ''}[earlier screenshot removed — only the latest ${MAX_SCREENSHOTS_IN_CONTEXT} screenshots stay in context]` };
    }
    const parts = text ? [{ type: 'text', text }] : [];
    for (const id of rest.images) {
      const part = imageToPart(id);
      if (part) parts.push(part);
    }
    if (!parts.length) return { ...rest, content: '[image file is missing]' };
    return { ...rest, content: parts };
  });
  return out.filter((m) => m !== null);
}

import { ensurePage, getPage, VIEWPORTS } from '../browser/index.js';
import { saveImage } from '../images.js';
import { loadConfig } from '../config.js';

function fmtUrl(u) {
  if (!u) return '(none)';
  try {
    const p = new URL(u);
    const path = p.pathname === '/' ? '' : p.pathname;
    return `${p.host}${path}`;
  } catch {
    return u;
  }
}

function ok(content, extra = {}) {
  return { ok: true, content, ...extra };
}

/**
 * The single `browser` tool (Code mode). One action param keeps the tool
 * definition compact. Screenshots are stored as images and returned via
 * `screenshot` (the agent loop attaches them as a follow-up user message so the
 * model actually sees them; OpenAI servers reject images inside tool results).
 */
export async function browserTool(ctx, args = {}) {
  const action = String(args.action ?? '').trim();
  const conversationId = ctx.sessionId;
  const workspace = ctx.workspace || null;
  if (!action) return { ok: false, content: 'Error: browser needs an `action`. Actions: open, back, reload, screenshot, snapshot, click, type, key, scroll, hover, resize, console, wait_for.' };

  // screenshot with vision off → text snapshot fallback
  const vision = loadConfig().modelSupportsImages === true;
  if (action === 'screenshot' && !vision) {
    const page = await ensurePage(conversationId, { workspace });
    const snap = await page.snapshot();
    return ok(`(image support is off — text snapshot instead)\n${formatSnapshot(snap)}\n\nAsk the user to enable "Model supports images" in Settings to see real screenshots.`);
  }

  const page = await ensurePage(conversationId, { workspace });
  try {
    switch (action) {
      case 'open': {
        if (!args.url) return { ok: false, content: 'Error: open needs a `url` (localhost / 127.0.0.1 / *.localhost / file in the workspace).' };
        const nav = await page.goto(String(args.url));
        return ok(`Opened ${nav.url}${nav.title ? ` — "${nav.title}"` : ''}. ${page.errorCount() ? `${page.errorCount()} console error(s) so far.` : 'No console errors.'}`);
      }
      case 'back': {
        const r = await page.back();
        return ok(`Back → ${fmtUrl(r.url)}${r.note ? ` (${r.note})` : ''}`);
      }
      case 'reload': {
        const r = await page.reload();
        return ok(`Reloaded ${fmtUrl(r.url)}`);
      }
      case 'screenshot': {
        const full = args.full === true;
        const shot = await page.screenshot({ full });
        const saved = saveImage({ dataUrl: `data:image/jpeg;base64,${shot.data}`, conversationId, source: 'screenshot', width: page.viewport.width, height: full ? 0 : page.viewport.height });
        ctx.emit({ type: 'browser_screenshot', imageId: saved.id, url: page.url, title: page.title, viewport: `${page.viewport.width}x${page.viewport.height}`, full });
        return ok(`Screenshot taken (${full ? 'full page' : 'viewport'}, ${page.viewport.width}x${page.viewport.height}). The image is attached for you to look at.`, { screenshot: saved.id });
      }
      case 'snapshot': {
        const snap = await page.snapshot();
        return ok(formatSnapshot(snap));
      }
      case 'click': {
        if (args.ref == null && !args.selector && args.x == null) return { ok: false, content: 'Error: click needs `ref` (from a snapshot), `selector`, or `x`/`y`.' };
        const r = await page.click({ ref: args.ref != null ? Number(args.ref) : undefined, selector: args.selector, x: args.x, y: args.y });
        return ok(`Clicked at ${Math.round(r.x)},${Math.round(r.y)} → now at ${fmtUrl(r.url)}`);
      }
      case 'type': {
        if (args.ref == null && !args.selector) return { ok: false, content: 'Error: type needs `ref` or `selector`.' };
        const r = await page.typeText({ ref: args.ref != null ? Number(args.ref) : undefined, selector: args.selector, text: args.text ?? '' });
        return ok(`Typed ${r.typed} character(s) into ${args.ref != null ? `ref ${args.ref}` : args.selector}.`);
      }
      case 'key': {
        if (!args.key) return { ok: false, content: 'Error: key needs a `key` name (e.g. Enter, Tab, Escape).' };
        await page.pressKey(String(args.key));
        return ok(`Pressed ${args.key}.`);
      }
      case 'scroll': {
        const r = await page.scroll({ x: Number(args.x) || 0, y: Number(args.y) || 0, toRef: args.to_ref != null ? Number(args.to_ref) : args.toRef != null ? Number(args.toRef) : null });
        return ok(r.scrolledTo != null ? `Scrolled to ref ${r.scrolledTo}.` : `Scrolled by ${r.deltaX},${r.deltaY}.`);
      }
      case 'hover': {
        if (args.ref == null && !args.selector && args.x == null) return { ok: false, content: 'Error: hover needs `ref`, `selector`, or `x`/`y`.' };
        await page.hover({ ref: args.ref != null ? Number(args.ref) : undefined, selector: args.selector, x: args.x, y: args.y });
        return ok('Hovered.');
      }
      case 'resize': {
        const size = String(args.size || 'desktop');
        const vp = VIEWPORTS[size];
        if (!vp) return { ok: false, content: `Error: unknown viewport "${size}". Use desktop, tablet or mobile.` };
        await page.applyViewport(vp);
        return ok(`Resized viewport to ${size} (${vp.width}x${vp.height}).`);
      }
      case 'console': {
        const page2 = getPage(conversationId);
        if (!page2) return ok('Browser is not open.');
        const since = args.since != null ? Number(args.since) : 0;
        const entries = page2.console.slice(since);
        page2.consoleRead = page2.console.length;
        if (!entries.length) return ok('No console messages since the last check.');
        const lines = entries.map((e) => `[${e.kind}] ${e.text}`);
        return ok(`Console (${entries.length} since last check, ${page2.console.length} total):\n${lines.join('\n')}`);
      }
      case 'wait_for': {
        if (!args.text && !args.selector) return { ok: false, content: 'Error: wait_for needs `text` or `selector`.' };
        const r = await page.waitFor({ text: args.text || null, selector: args.selector || null, timeout: Number(args.timeout) || 10000 });
        return r.found ? ok(`Found ${args.text ? `text "${args.text}"` : `selector ${args.selector}`} after ${r.waitedMs}ms.`) : { ok: false, content: `Timed out after ${r.waitedMs}ms waiting for ${args.text ? `text "${args.text}"` : `selector ${args.selector}`}.` };
      }
      default:
        return { ok: false, content: `Error: unknown browser action "${action}". Actions: open, back, reload, screenshot, snapshot, click, type, key, scroll, hover, resize, console, wait_for.` };
    }
  } catch (err) {
    if (err.localOnly) return { ok: false, content: `Blocked (local-only rule): ${err.message}` };
    return { ok: false, content: `Error in browser.${action}: ${err.message ?? String(err)}` };
  }
}

function formatSnapshot(snap) {
  const lines = [];
  lines.push(`URL: ${snap.url || '(none)'}`);
  lines.push(`Title: ${snap.title || '(none)'}`);
  if (snap.headings?.length) lines.push(`Headings: ${snap.headings.join(' | ')}`);
  lines.push(`Interactive elements (${snap.count}):`);
  for (const e of snap.elements || []) {
    const dis = e.disabled ? ' [disabled]' : '';
    const href = e.href ? ` → ${e.href}` : '';
    lines.push(`  [${e.ref}] ${e.tag}${e.type ? ':' + e.type : ''} "${e.text}"${href}${dis} @${e.x},${e.y} ${e.w}x${e.h}`);
  }
  if (!snap.elements?.length) lines.push('  (none)');
  return lines.join('\n');
}

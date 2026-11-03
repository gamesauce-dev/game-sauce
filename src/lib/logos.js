// Platform logos: uploaded by an admin, never supplied by the system. JPEG, PNG, WebP or SVG, up to 512 KB.
// SVG can carry scripts, so one is accepted only when it is plain drawing: no scripts, no event handlers, nothing that loads another file.
import { sniffImage } from './coverzip.js';

export const MAX_LOGO_BYTES = 512 * 1024;

export function sniffLogo(buf) {
  const raster = sniffImage(buf);
  if (raster) return { type: raster };
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  const text = buf.toString('utf8');
  if (!/^\s*(?:\uFEFF)?(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(text)) return null;
  if (/<script|<foreignObject|<iframe|<object|<embed|<audio|<video|<link\b|<meta\b|javascript:|data:text\/html|\son[a-z]+\s*=|@import|url\(\s*["']?\s*(?:https?:|\/\/|data:text)/i.test(text)) return { error: 'That SVG contains scripts or links to other files, which are not allowed. Export it as a plain drawing.' };
  // Every href must point inside the drawing ("#id"). Anything else would load, or link to, another file.
  for (const m of text.matchAll(/\b(?:xlink:)?href\s*=\s*(["'])(.*?)\1/gi)) {
    if (!m[2].trim().startsWith('#')) return { error: 'That SVG loads another file (an href that is not inside the drawing). Use a plain drawing, or a PNG.' };
  }
  if (/\b(?:xlink:)?href\s*=\s*[^"'\s>]/i.test(text)) return { error: 'That SVG has an unquoted link, which is not allowed. Use a plain drawing, or a PNG.' };
  return { type: 'image/svg+xml' };
}

/** Headers that make a stored logo safe to hand out: shown as a picture only, and an SVG cannot run anything even if opened directly. */
export const LOGO_HEADERS = (type) => ({
  'Content-Type': type,
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  'Cache-Control': 'private, max-age=86400'
});

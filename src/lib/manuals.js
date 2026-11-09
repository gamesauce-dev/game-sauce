// Manuals for the games on a person's shelf (Physical). A game's manual is either a link to one on the web, or a file the person uploads (a PDF or pictures of the pages).
// Nothing is looked up or downloaded for them: the links and files are their own. Files are private to the person who added them and live in storage/manuals/<person>/.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { storageDir } from './storage.js';

export const MAX_MANUAL_BYTES = 50 * 1024 * 1024;

const root = () => storageDir('manuals');
export const manualDir = (userId) => path.join(root(), String(Number(userId)));

/** What kind of file this is, from its first bytes (the name and the type the browser sent are not trusted). null for anything but a PDF, PNG, JPEG or WebP. */
export function sniffManual(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return { ext: 'pdf', type: 'application/pdf' };
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return { ext: 'png', type: 'image/png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return null;
}

/** A web address for a manual: http or https only, tidied. '' / null means "none". Throws a 400 for anything else. */
export function cleanManualLink(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) throw Object.assign(new Error('That is not a web address: a manual link must start with http:// or https://'), { status: 400 });
  if (u.href.length > 600) throw Object.assign(new Error('That web address is too long (600 characters at most).'), { status: 400 });
  return u.href;
}

/** A file name that is safe to show and to offer for download. */
export const cleanFileName = (n) => String(n || 'manual').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120) || 'manual';

/** Keep an uploaded manual. Returns { path, name, type }. Throws a 400 for a file that is too big or is not a PDF or picture. */
export function saveManual(userId, gameId, buffer, originalName) {
  if (!buffer?.length) throw Object.assign(new Error('Choose a file first.'), { status: 400 });
  if (buffer.length > MAX_MANUAL_BYTES) throw Object.assign(new Error('That file is over 50 MB.'), { status: 400 });
  const kind = sniffManual(buffer);
  if (!kind) throw Object.assign(new Error('A manual must be a PDF or a picture (PNG, JPEG or WebP).'), { status: 400 });
  const dir = manualDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Number(gameId)}-${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 10)}.${kind.ext}`);
  fs.writeFileSync(file, buffer);
  const base = cleanFileName(originalName).replace(/\.(pdf|png|jpe?g|webp)$/i, '');
  return { path: file, name: `${base}.${kind.ext}`, type: kind.type };
}

/** Remove one stored manual file (only ever inside storage/manuals). */
export function deleteManualFile(file) {
  try { if (file && path.resolve(file).startsWith(path.resolve(root()) + path.sep)) fs.rmSync(file, { force: true }); } catch { /* already gone */ }
}

/** When a person's account is deleted, every manual they uploaded goes with it. */
export function purgeManualFiles(userId) {
  try { fs.rmSync(manualDir(userId), { recursive: true, force: true }); } catch { /* none */ }
}

export const manualType = (file) => ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[String(path.extname(file || '')).slice(1).toLowerCase()] || 'application/octet-stream');

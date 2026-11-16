// "Play locally": hand one ROM to the game-sauce launcher running on the PC you are browsing from.
//
// The launcher is a separate program (launcher/gamesauce-launcher.mjs) that is not signed in to game-sauce, so it cannot
// use your browser session. Instead the signed-in page asks for a LAUNCH TOKEN for one game; the page opens a
// gamesauce:// link carrying it, and the launcher swaps the token for the file. A token:
//   - is for ONE game, issued only to someone who is allowed to download (see canDownload in policy.js),
//   - works ONCE (a second use is refused), and
//   - expires after two minutes.
// Tokens live in memory only, so a server restart simply invalidates any that were outstanding.
//
// PROGRESS: every launch also gets a launch id (lid) so the page can show how far along it is. The page asks for the state of
// its own launch (signed in, and only the person who started it), and the server answers from two sources: how many bytes it has
// sent to the launcher itself, and what the launcher reports about its own steps (downloading, unpacking, starting, running).
// An older launcher reports nothing, so the server's own count is enough to show a download bar. A launch record is memory only.

import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { randomToken, hashToken } from './auth.js';

export const LAUNCH_TTL_MS = 2 * 60 * 1000;
const MAX_OUTSTANDING = 500;

const tokens = new Map(); // hashToken(token) -> { romId, userId, expires, lid }
const launches = new Map(); // lid -> progress record (see launchView)
const LAUNCH_KEEP_MS = 3 * 60 * 60 * 1000;   // a game can be played for hours; the record is only needed while it starts
const PHASES = new Set(['downloading', 'unpacking', 'starting', 'running', 'closed', 'error']);

function prune(now = Date.now()) {
  for (const [k, v] of tokens) if (v.expires <= now) tokens.delete(k);
  // A flood of mint requests cannot grow this without limit: drop the oldest first.
  while (tokens.size >= MAX_OUTSTANDING) tokens.delete(tokens.keys().next().value);
  for (const [k, v] of launches) if (now - v.updated > LAUNCH_KEEP_MS) launches.delete(k);
  while (launches.size >= MAX_OUTSTANDING) launches.delete(launches.keys().next().value);
}

export function mintLaunchToken(romId, userId, { title = '', size = 0 } = {}) {
  prune();
  const token = randomToken(32);
  const lid = randomToken(24);
  const now = Date.now();
  const uid = userId == null ? null : Number(userId);
  tokens.set(hashToken(token), { romId: Number(romId), userId: uid, expires: now + LAUNCH_TTL_MS, lid });
  launches.set(lid, { userId: uid, romId: Number(romId), title: String(title).slice(0, 200), size: Math.max(0, Number(size) || 0), created: now, updated: now, state: 'waiting', total: 0, sock: null, sockBase: 0, bytesSent: 0, reported: null });
  return { token, lid, expires_in: Math.round(LAUNCH_TTL_MS / 1000) };
}

/** Use a token up. Returns its entry, or null when it is unknown, expired or already used. */
export function takeLaunchToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const key = hashToken(token);
  const entry = tokens.get(key);
  if (!entry) return null;
  tokens.delete(key); // single use, even if the rest of the request fails
  return entry.expires > Date.now() ? entry : null;
}

/** GET /api/launch/:token — public (the token is the credential). Streams the ROM file to the launcher. */
export function launchFileHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const entry = takeLaunchToken(req.params.token);
  if (!entry) return res.status(404).json({ error: 'This launch link has expired or was already used. Click Play locally again.' });

  const rom = db.prepare('SELECT * FROM roms WHERE id = ?').get(entry.romId);
  if (!rom) return res.status(404).json({ error: 'ROM not found' });
  if (!fs.existsSync(rom.storage_path)) {
    if (rom.source_id) db.prepare('UPDATE roms SET missing = 1 WHERE id = ?').run(rom.id);
    return res.status(410).json({ error: 'File is not reachable — its drive may be offline' });
  }

  // Logged as its own kind: it is not a manual download (that feeds "most downloaded") and not a browser play.
  db.prepare("INSERT INTO downloads (rom_id, bytes, user_id, kind) VALUES (?, ?, ?, 'launch')").run(rom.id, rom.size_bytes, entry.userId);

  // Count what is sent so the page can show a progress bar (the launcher downloads, not the browser).
  const rec = entry.lid ? launches.get(entry.lid) : null;
  if (rec) {
    let total = Number(rom.size_bytes) || 0;
    try { total = fs.statSync(rom.storage_path).size; } catch { /* the size in the library will do */ }
    Object.assign(rec, { state: 'downloading', total, sock: res.socket, sockBase: res.socket ? res.socket.bytesWritten : 0, updated: Date.now() });
    res.on('finish', () => { rec.bytesSent = rec.total; rec.state = 'sent'; rec.sock = null; rec.updated = Date.now(); });
    res.on('close', () => { if (rec.state === 'downloading') { rec.bytesSent = sentBytes(rec); rec.state = 'interrupted'; rec.sock = null; rec.updated = Date.now(); } });
  }

  res.download(rom.storage_path, `${String(rom.title).replace(/[^\w .()\-\[\]]+/g, '_')}${path.extname(rom.filename)}`, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
}

/** Bytes of the file the server has put on the wire so far (the response headers are a few hundred bytes, left out). */
function sentBytes(rec) {
  if (rec.state === 'sent') return rec.total;
  if (!rec.sock) return rec.bytesSent || 0;
  return Math.max(0, Math.min(rec.total, (rec.sock.bytesWritten || 0) - rec.sockBase - 400));
}

/** What the page shows. phase: waiting (nobody has fetched the file yet), downloading, unpacking, starting, running, closed, error,
 *  or sent (an older launcher: the whole file has gone and nothing more is known). */
export function launchView(rec, now = Date.now()) {
  const rep = rec.reported;
  let phase, bytes = sentBytes(rec), total = rec.total || rec.size || 0, message = '';
  if (rep) {
    phase = rep.phase; message = rep.message;
    if (rep.phase === 'downloading') {   // the launcher's own count is what it has really received
      if (rep.bytes != null) bytes = rep.bytes;
      if (rep.total) total = rep.total;
    } else bytes = total;
  } else {
    phase = rec.state === 'interrupted' ? 'error' : rec.state;   // waiting | downloading | sent | error
    if (rec.state === 'interrupted') message = 'The download stopped before it finished.';
  }
  return { phase, bytes: total ? Math.min(bytes, total) : bytes, total, message, title: rec.title, age_s: Math.round((now - rec.created) / 1000) };
}

/** GET /api/launch-status/:lid — signed in: how far this person's own launch has got. */
export function launchStatusHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const rec = launches.get(String(req.params.lid || ''));
  if (!rec || (rec.userId != null && (!req.user || Number(req.user.id) !== rec.userId))) return res.status(404).json({ error: 'No such launch.' });
  res.json(launchView(rec));
}

/** POST /api/launch/:lid/progress — public (the launch id is the credential, and only a launch that exists can be updated):
 *  { phase, bytes?, total?, message? } from the launcher. Small, validated, and only ever shown as plain text. */
export function launchProgressHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const rec = launches.get(String(req.params.lid || ''));
  if (!rec) return res.status(404).json({ error: 'No such launch.' });
  const b = req.body || {};
  const phase = String(b.phase || '');
  if (!PHASES.has(phase)) return res.status(400).json({ error: 'Unknown phase.' });
  const num = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(Math.floor(Number(v)), 2 ** 50) : null);
  const now = Date.now();
  rec.reported = { phase, bytes: num(b.bytes), total: num(b.total), message: String(b.message || '').replace(/[\u0000-\u001f]+/g, ' ').slice(0, 300), at: now };
  rec.updated = now;
  res.json({ ok: true });
}

/* ───────── which platforms this PC can start ─────────
 * The launcher is the only program that can read ~/.gamesauce/launcher.json, so it reports to the server which platforms
 * have an emulator set up (the platform names only: never a path or a command). The person's page asks for a one-time SYNC
 * TOKEN, opens gamesauce://sync?... and the launcher swaps the token for the report. The list is kept per account. */
const syncTokens = new Map(); // hashToken(token) -> { userId, expires }
const SLUG = /^[a-z0-9_-]{1,40}$/;

export function mintSyncToken(userId) {
  const now = Date.now();
  for (const [k, v] of syncTokens) if (v.expires <= now) syncTokens.delete(k);
  while (syncTokens.size >= MAX_OUTSTANDING) syncTokens.delete(syncTokens.keys().next().value);
  const token = randomToken(32);
  syncTokens.set(hashToken(token), { userId: Number(userId), expires: now + LAUNCH_TTL_MS });
  return { token, expires_in: Math.round(LAUNCH_TTL_MS / 1000) };
}

/** Use a sync token up (once): the account it was made for, or null. */
export function takeSyncToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const key = hashToken(token), entry = syncTokens.get(key);
  if (!entry) return null;
  syncTokens.delete(key);
  return entry.expires > Date.now() ? entry : null;
}

/** Is this sync token still good? (It is not used up: the setup page asks for the platform list first and reports its choices with the same token afterwards.) */
export function peekSyncToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
  const entry = syncTokens.get(hashToken(token));
  return entry && entry.expires > Date.now() ? entry : null;
}

/** GET /api/launcher/platforms?token= — public (the sync token is the credential): every platform the server knows, so the launcher's setup page lists the ones added in Settings > Platforms too. */
export function launcherPlatformsHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!peekSyncToken(String(req.query?.token || ''))) return res.status(404).json({ error: 'This link has expired or was already used. Try again from game-sauce.' });
  res.json({ platforms: db.prepare('SELECT slug, name, family FROM platforms ORDER BY family, name').all().filter((p) => SLUG.test(p.slug)) });
}

/** Keep the platforms a PC reported (valid platform names only, no more than 200). Returns the stored list. */
export function saveLauncherPlatforms(userId, platforms) {
  const list = [...new Set((Array.isArray(platforms) ? platforms : []).map((s) => String(s || '').toLowerCase()).filter((s) => SLUG.test(s)))].slice(0, 200).sort();
  db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value')
    .run(Number(userId), 'launcher_platforms', JSON.stringify({ platforms: list, at: new Date().toISOString() }));
  return list;
}

/** POST /api/launcher/sync — public (the sync token is the credential): { token, platforms: ['snes', ...] }. */
export function launcherSyncHandler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const entry = takeSyncToken(req.body?.token);
  if (!entry) return res.status(404).json({ error: 'This link has expired or was already used. Try again from game-sauce.' });
  const list = saveLauncherPlatforms(entry.userId, req.body?.platforms);
  res.json({ ok: true, platforms: list });
}

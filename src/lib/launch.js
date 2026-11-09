// "Play locally": hand one ROM to the game-sauce launcher running on the PC you are browsing from.
//
// The launcher is a separate program (launcher/gamesauce-launcher.mjs) that is not signed in to game-sauce, so it cannot
// use your browser session. Instead the signed-in page asks for a LAUNCH TOKEN for one game; the page opens a
// gamesauce:// link carrying it, and the launcher swaps the token for the file. A token:
//   - is for ONE game, issued only to someone who is allowed to download (see canDownload in policy.js),
//   - works ONCE (a second use is refused), and
//   - expires after two minutes.
// Tokens live in memory only, so a server restart simply invalidates any that were outstanding.

import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { randomToken, hashToken } from './auth.js';

export const LAUNCH_TTL_MS = 2 * 60 * 1000;
const MAX_OUTSTANDING = 500;

const tokens = new Map(); // hashToken(token) -> { romId, userId, expires }

function prune(now = Date.now()) {
  for (const [k, v] of tokens) if (v.expires <= now) tokens.delete(k);
  // A flood of mint requests cannot grow this without limit: drop the oldest first.
  while (tokens.size >= MAX_OUTSTANDING) tokens.delete(tokens.keys().next().value);
}

export function mintLaunchToken(romId, userId) {
  prune();
  const token = randomToken(32);
  tokens.set(hashToken(token), { romId: Number(romId), userId: userId == null ? null : Number(userId), expires: Date.now() + LAUNCH_TTL_MS });
  return { token, expires_in: Math.round(LAUNCH_TTL_MS / 1000) };
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

  res.download(rom.storage_path, `${String(rom.title).replace(/[^\w .()\-\[\]]+/g, '_')}${path.extname(rom.filename)}`, (err) => {
    if (err && !res.headersSent) res.status(500).end();
  });
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

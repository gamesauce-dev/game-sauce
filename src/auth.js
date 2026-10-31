import db from './db.js';
import { purgeSaveFiles } from './lib/saves.js';
import { hashPassword, hashToken, randomToken, verifyPassword } from './lib/auth.js';

/* ───────────────────────────── users ───────────────────────────── */

export function initAuthTables() {
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- Every mutating request, so "who deleted that ROM" has an answer.
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  username   TEXT,
  action     TEXT NOT NULL,
  target     TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(username);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);

-- Login throttling: one row per (username, ip) attempt window.
CREATE TABLE IF NOT EXISTS login_attempts (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  last_failure TEXT NOT NULL DEFAULT (datetime('now')),
  locked_until TEXT
);
`);
// Per-person download permission: NULL = follow the server-wide default, 1 = always allowed, 0 = never.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'download_override')) {
  db.exec('ALTER TABLE users ADD COLUMN download_override INTEGER');
}
// First-run welcome tour: 0 = not seen yet. Accounts that already existed when this column was added are marked
// as seen (they have been using the app); only accounts created afterwards get the tour.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'welcomed')) {
  db.exec('ALTER TABLE users ADD COLUMN welcomed INTEGER NOT NULL DEFAULT 0');
  db.exec('UPDATE users SET welcomed = 1');
}
// Play-only accounts: 1 = a cut-down "play in browser" screen and nothing else. The admin sets it per person.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'play_only')) {
  db.exec('ALTER TABLE users ADD COLUMN play_only INTEGER NOT NULL DEFAULT 0');
}
// Profile picture (small JPEG/PNG/WebP, stored in the database so backups carry it).
for (const [col, ddl] of [['avatar', 'BLOB'], ['avatar_type', 'TEXT'], ['avatar_updated', 'INTEGER']]) {
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} ${ddl}`);
}
// Older databases: sessions without the flag were all persistent logins.
if (!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'persistent')) {
  db.exec('ALTER TABLE sessions ADD COLUMN persistent INTEGER NOT NULL DEFAULT 1');
}
}

// Created at import time as well, so any entry point that pulls in auth.js
// directly (scripts, tests) still gets the tables.
initAuthTables();

const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;

/** First run: create the owner account from the environment if there is none. */
export async function bootstrapAdmin() {
  if (userCount() > 0) return null;

  const username = (process.env.GAMESAUCE_ADMIN_USER || 'admin').trim();
  const password = process.env.GAMESAUCE_ADMIN_PASSWORD;

  if (!password) {
    // No password supplied: generate one and print it exactly once. Better than
    // shipping a default like "admin/admin".
    const generated = randomToken(12);
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, await hashPassword(generated), 'admin');
    console.log('─'.repeat(64));
    console.log('game-sauce: created the first account');
    console.log(`  username: ${username}`);
    console.log(`  password: ${generated}`);
    console.log('This password is shown once. Change it after signing in.');
    console.log('─'.repeat(64));
    return { username, password: generated, generated: true };
  }

  const problems = await import('./lib/auth.js').then((m) => m.passwordProblems(password));
  if (problems.length) {
    throw new Error(`GAMESAUCE_ADMIN_PASSWORD needs ${problems.join(', ')}`);
  }

  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, await hashPassword(password), 'admin');
  console.log(`game-sauce: created admin account "${username}" from GAMESAUCE_ADMIN_PASSWORD`);
  return { username, generated: false };
}

/* ──────────────────────────── sessions ──────────────────────────── */

/* Two kinds of session, chosen by the "Keep me signed in" box at login:
 *  - persistent (ticked):   14-day cookie (GAMESAUCE_SESSION_HOURS), no idle limit by default.
 *  - browser-only (unticked): cookie with no Max-Age, so it disappears when the browser closes;
 *    the server also expires it after GAMESAUCE_SHORT_SESSION_HOURS (default 12).
 * Idle timeout: GAMESAUCE_IDLE_MINUTES (default 120) signs out browser-only sessions after that
 * long without any API activity; GAMESAUCE_IDLE_MINUTES_PERSISTENT (default 0 = off) does the
 * same for persistent ones. Env is read per call so it can be changed without code edits. */
const numEnv = (name, dflt) => { const v = Number(process.env[name]); return Number.isFinite(v) && process.env[name] !== undefined && process.env[name] !== '' ? v : dflt; };
const sessionHours = (persistent) => (persistent ? numEnv('GAMESAUCE_SESSION_HOURS', 24 * 14) : numEnv('GAMESAUCE_SHORT_SESSION_HOURS', 12));
const idleMinutes = (persistent) => (persistent ? numEnv('GAMESAUCE_IDLE_MINUTES_PERSISTENT', 0) : numEnv('GAMESAUCE_IDLE_MINUTES', 120));

export async function createSession(userId, { userAgent, ip, persistent = true } = {}) {
  const token = randomToken(32);
  const hours = sessionHours(persistent);
  db.prepare(`
    INSERT INTO sessions (user_id, token_hash, user_agent, ip, expires_at, persistent)
    VALUES (?, ?, ?, ?, datetime('now', ?), ?)
  `).run(userId, hashToken(token), (userAgent || '').slice(0, 200), ip || null, `+${hours} hours`, persistent ? 1 : 0);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  // expires_in = null means "session cookie": the browser drops it when it closes.
  return { token, expires_in: persistent ? hours * 3600 : null, persistent };
}

export function findSession(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.persistent,
           u.id, u.username, u.display_name, u.role, u.disabled, u.download_override, u.play_only
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(hashToken(token));
  if (!row) return null;
  const idle = idleMinutes(row.persistent !== 0);
  if (idle > 0) {
    const last = Date.parse(String(row.last_seen_at).replace(' ', 'T') + 'Z');
    if (Number.isFinite(last) && Date.now() - last > idle * 60000) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(row.session_id); // idle too long: gone for good
      return null;
    }
  }
  return row;
}

export function touchSession(sessionId) {
  db.prepare("UPDATE sessions SET last_seen_at = datetime('now') WHERE id = ?").run(sessionId);
}

export function destroySession(token) {
  if (!token) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyAllSessions(userId, exceptSessionId = null) {
  if (exceptSessionId) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?').run(userId, exceptSessionId);
  } else {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }
}

export function purgeExpiredSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run().changes;
}

/* ───────────────────────────── users ───────────────────────────── */

export function listUsers() {
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.created_at, u.last_login_at, u.download_override, u.avatar_updated, u.play_only,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS active_sessions
    FROM users u ORDER BY u.username
  `).all().map(({ download_override, avatar_updated, play_only, ...u }) => ({
    ...u, avatar_v: avatar_updated || null, disabled: Boolean(u.disabled), mode: u.role !== 'admin' && play_only ? 'play' : 'full',
    download: download_override === 1 ? 'allow' : download_override === 0 ? 'deny' : 'default'
  }));
}

export async function createUser({ username, password, display_name = null, role = 'user' }) {
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(name)) {
    throw Object.assign(new Error('Username must be 3–32 characters: letters, digits, dot, dash, underscore'), { status: 400 });
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) {
    throw Object.assign(new Error('That username is taken'), { status: 409 });
  }
  const problems = (await import('./lib/auth.js')).passwordProblems(password);
  if (problems.length) {
    throw Object.assign(new Error(`Password needs ${problems.join(', ')}`), { status: 400 });
  }
  const info = db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, display_name, await hashPassword(password), role === 'admin' ? 'admin' : 'user');
  return { id: Number(info.lastInsertRowid), username: name, role };
}

export async function setPassword(userId, password) {
  const problems = (await import('./lib/auth.js')).passwordProblems(password);
  if (problems.length) {
    throw Object.assign(new Error(`Password needs ${problems.join(', ')}`), { status: 400 });
  }
  const info = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(await hashPassword(password), userId);
  if (!info.changes) throw Object.assign(new Error('User not found'), { status: 404 });
  destroyAllSessions(userId);
}

export function deleteUser(userId) {
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!user) throw Object.assign(new Error('User not found'), { status: 404 });
  if (user.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
    if (admins <= 1) throw Object.assign(new Error('Cannot delete the last admin'), { status: 409 });
  }
  purgeSaveFiles({ userId });
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

/* ───────────────────────── login throttling ───────────────────────── */

const MAX_FAILURES = Number(process.env.GAMESAUCE_LOGIN_MAX_FAILURES || 8);
const LOCK_MINUTES = Number(process.env.GAMESAUCE_LOGIN_LOCK_MINUTES || 15);

export function loginLockRemaining(key) {
  const row = db.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').get(key);
  if (!row?.locked_until) return 0;
  const until = new Date(`${row.locked_until.replace(' ', 'T')}Z`).getTime();
  return Math.max(0, until - Date.now());
}

export function recordLoginFailure(key) {
  const row = db.prepare('SELECT failures FROM login_attempts WHERE key = ?').get(key);
  const failures = (row?.failures || 0) + 1;
  const lock = failures >= MAX_FAILURES ? `+${LOCK_MINUTES} minutes` : null;

  db.prepare(`
    INSERT INTO login_attempts (key, failures, last_failure, locked_until)
    VALUES (?, ?, datetime('now'), ${lock ? "datetime('now', ?)" : 'NULL'})
    ON CONFLICT(key) DO UPDATE SET
      failures = excluded.failures,
      last_failure = datetime('now'),
      locked_until = ${lock ? 'excluded.locked_until' : 'NULL'}
  `).run(...(lock ? [key, failures, lock] : [key, failures]));

  return { failures, locked: Boolean(lock), remaining: MAX_FAILURES - failures };
}

export function clearLoginFailures(key) {
  db.prepare('DELETE FROM login_attempts WHERE key = ?').run(key);
}

/** Forget every failed-login record for a username (any address): used when an admin resets a password. */
export function clearLoginFailuresForUser(username) {
  db.prepare("DELETE FROM login_attempts WHERE key LIKE ? ESCAPE '\\'")
    .run(String(username).toLowerCase().replace(/[\\%_]/g, '\\$&') + '|%');
}

/* ──────────────────────────── audit log ──────────────────────────── */

export function audit(user, action, { target = null, detail = null, ip = null } = {}) {
  db.prepare('INSERT INTO audit_log (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user?.id || null, user?.username || null, action, target,
      detail ? JSON.stringify(detail).slice(0, 2000) : null, ip || null);
}

export function listAudit({ limit = 100, action = null, username = null, since = null, until = null } = {}) {
  const where = [];
  const params = [];
  // Substring matches, so "rom" catches every "POST /api/roms…" row and
  // "login" catches both login.success and login.failed.
  if (action) { where.push('action LIKE ?'); params.push(`%${action}%`); }
  if (username) { where.push('username LIKE ?'); params.push(`%${username}%`); }
  if (since) { where.push("created_at >= datetime(?)"); params.push(String(since).replace('T', ' ')); }
  // "until 2026-10-26" should include the whole day, not stop at midnight.
  if (until) {
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(until).trim())
      ? `${String(until).trim()} 23:59:59` : String(until).replace('T', ' ');
    where.push('created_at <= datetime(?)');
    params.push(day);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ?`).all(...params);
}

/**
 * One-line plain-English summary for an audit row, for the Activity panel.
 * The raw `action` stays in the row (title + filter use it); this is display.
 */
export function describeAudit(entry) {
  const who = entry.username || 'Someone';
  const t = entry.target ? String(entry.target) : '';
  let detail = null;
  try { detail = entry.detail ? JSON.parse(entry.detail) : null; } catch { detail = null; }
  const a = entry.action || '';
  if (a === 'login.success') return `${who} signed in`;
  if (a === 'login.failed') return `Failed sign-in as ${t || who}`;
  if (a === 'logout') return `${who} signed out`;
  if (a === 'password.changed') return `${who} changed their password`;
  if (a === 'sessions.revoked') return `${who} signed out ${detail?.all ? 'all devices' : 'other devices'}`;
  if (a === 'user.created') return `${who} created user ${t}${detail?.role ? ` (${detail.role})` : ''}`;
  if (a === 'user.deleted') return `${who} deleted user ${t || 'unknown'}`;
  if (a === 'policy.changed' && detail?.arcade_verified_only !== undefined) return `${who} ${detail.arcade_verified_only ? 'switched arcade browser play to verified games only' : 'went back to the standard arcade browser-play rules'}`;
  if (a === 'policy.changed') return `${who} ${detail?.members_can_download ? 'allowed' : 'turned off'} ROM downloads for members`;
  if (a === 'user.password_reset') return `${who} reset a password for user ${t || 'unknown'}`;
  if (a === 'user.updated') {
    const bits = [];
    if (detail && typeof detail === 'object' && detail.download !== undefined) {
      bits.push(detail.download === 'allow' ? 'downloads always allowed' : detail.download === 'deny' ? 'downloads never allowed' : 'downloads follow the default');
    }
    if (detail && typeof detail === 'object') {
      if (detail.disabled === true) bits.push('disabled');
      if (detail.disabled === false) bits.push('re-enabled');
      if (detail.role) bits.push(`role → ${detail.role}`);
      if (detail.display_name !== undefined) bits.push('renamed');
    }
    return `${who} updated user ${t}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }
  const m = a.match(/^(GET|POST|PUT|PATCH|DELETE) (\S+?)(?:\?[^ ]*)?$/);
  if (m) {
    const [, method, path] = m;
    const seg = path.replace(/^\/api\//, '').split('/');
    const res = seg[0] || '', id = seg[1] || t;
    if (res === 'roms' && method === 'DELETE' && String(id).toLowerCase() === 'bulk') {
      const titles = Array.isArray(detail?.titles) ? detail.titles : [];
      const n = detail?.count ?? (Array.isArray(detail?.ids) ? detail.ids.length : null);
      if (titles.length === 1) {
        const t = titles[0];
        return `${who} bulk-deleted “${t.title}” (${t.platform})`;
      }
      if (titles.length > 1) {
        const named = titles.slice(0, 3).map((t) => `“${t.title}” (${t.platform})`).join(', ');
        const rest = (n ?? titles.length) - titles.length;
        return `${who} bulk-deleted ${n ?? titles.length} ROMs: ${named}${rest > 0 ? ` + ${rest} more` : ''}`;
      }
      return `${who} bulk-deleted${n ? ` ${n}` : ''} ROM${n === 1 ? '' : 's'}`;
    }
    if (res === 'roms' && method === 'DELETE') {
      if (detail?.title) return `${who} deleted “${detail.title}” (${detail.platform || 'unknown platform'})`;
      return `${who} deleted ROM ${t || id}`;
    }
    if (res === 'roms' && method === 'POST' && ((seg[1] === 'bulk' && seg[2] === 'hide-all') || seg[2] === 'hide-all')) {
      const verb = detail?.hidden === false ? 'showed to everyone' : 'hid from everyone';
      if (detail?.title) return `${who} ${verb} “${detail.title}” (${detail.platform || 'unknown platform'})`;
      return `${who} ${verb} ${detail?.count ?? ''} ROM${detail?.count === 1 ? '' : 's'}`.replace('  ', ' ');
    }
    if (res === 'roms' && method === 'POST' && seg[1] === 'bulk' && seg[2] === 'hide') {
      const named = Array.isArray(detail?.titles) && detail.titles.length
        ? detail.titles.slice(0, 3).map((x) => `“${x.title}” (${x.platform || 'unknown platform'})`).join(', ')
        : null;
      const verb = detail?.hidden === false ? 'unhid' : 'hid';
      if (named && (detail?.count ?? 0) <= 3) return `${who} ${verb} ${named}`;
      if (named) return `${who} ${verb} ${detail.count} ROMs: ${named} + ${detail.count - Math.min(3, detail.titles.length)} more`;
      return `${who} ${verb} ROMs in bulk`;
    }
    if (res === 'roms' && method === 'POST' && seg[2] === 'hide') {
      const named = Array.isArray(detail?.titles) && detail.titles.length
        ? detail.titles.slice(0, 3).map((x) => `“${x.title}” (${x.platform || 'unknown platform'})`).join(', ')
        : (detail?.title ? `“${detail.title}” (${detail.platform || 'unknown platform'})` : null);
      const verb = detail?.hidden === false ? 'unhid' : 'hid';
      if (named) return `${who} ${verb} ${named}`;
      return `${who} ${verb} ROM ${t || id}`;
    }
    if (res === 'roms' && method === 'POST' && seg[1] === 'upload') return `${who} uploaded ROMs`;
    if (res === 'roms' && method === 'POST' && seg[1] === 'bulk' && seg[2] === 'enrich') return `${who} ran bulk metadata enrichment`;
    if (res === 'roms' && method === 'PATCH') {
      if (detail?.title) return `${who} edited “${detail.title}” (${detail.platform || 'unknown platform'})`;
      return `${who} edited ROM ${t || id}`;
    }
    if (res === 'sources' && method === 'POST') return `${who} added source ${t || detail?.path || ''}`.trim();
    if (res === 'sources' && method === 'DELETE') return `${who} removed source ${t || id}${detail && detail.remove_roms ? ' (+ its ROMs)' : ''}`;
    if (res === 'sources' && method === 'PATCH') return `${who} changed source ${t || id} settings`;
    if (res === 'sources' && seg[2] === 'scan') return `${who} scanned source ${t || id}`;
    if (res === 'roms' && method === 'POST' && seg[2] === 'cover') {
      if (detail?.title) return `${who} uploaded a cover for “${detail.title}” (${detail.platform || 'unknown platform'})`;
      return `${who} uploaded a cover for ROM ${t || id}`;
    }
    if (res === 'roms' && method === 'POST' && seg[2] === 'favorite') {
      if (detail?.title) return `${who} favourited “${detail.title}” (${detail.platform || 'unknown platform'})`;
      return `${who} favourited ROM ${t || id}`;
    }
    if (res === 'collections' && method === 'POST') return `${who} created collection ${t || detail?.name || ''}`.trim();
    if (res === 'collections' && method === 'PATCH') return `${who} edited collection ${t || id}`;
    if (res === 'collections' && method === 'DELETE') return `${who} deleted collection ${t || id}`;
    if (res === 'metadata' && seg[1] === 'providers') return `${who} updated metadata credentials`;
    if (res === 'metadata' && method === 'POST' && seg[1] === 'screenscraper') return `${who} re-checked ScreenScraper system ids`;
    if (res === 'metadata' && method === 'POST') return `${who} edited metadata`;
    if (res === 'dats' || res === 'datfiles') {
      if (method === 'POST') return `${who} imported a DAT file`;
      if (method === 'DELETE') return `${who} removed DAT ${t || id}`;
      return `${who} updated DATs`;
    }
    if (res === 'platforms' && method === 'POST') return `${who} added platform ${t || detail?.slug || ''}`.trim();
    if (res === 'platforms' && method === 'PATCH') return `${who} edited platform ${t || id}`;
    if (res === 'platforms' && method === 'DELETE') return `${who} deleted platform ${t || id}`;
    return `${who} ${method} ${path}${t && !path.includes(t) ? ` (${t})` : ''}`;
  }
  return `${who} ${a}${t ? ` (${t})` : ''}`;
}

export { verifyPassword, userCount };

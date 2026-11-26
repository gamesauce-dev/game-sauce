import db from './db.js';
import { purgeUser as purgeMessages } from './lib/messages.js';
import { userColour, nextUserColour } from './lib/colours.js';
import { purgeSaveFiles } from './lib/saves.js';
import { purgeManualFiles } from './lib/manuals.js';
import { purgeCustomCovers } from './lib/storage.js';
import { forgetSubject, setUserGroups } from './lib/restrictions.js';
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
// Age restrictions (src/lib/restrictions.js): a person's own age limit (NULL = none), and the groups people are put in.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'age_limit')) {
  db.exec('ALTER TABLE users ADD COLUMN age_limit INTEGER');
}
db.exec(`
CREATE TABLE IF NOT EXISTS account_groups (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  age_limit INTEGER,
  can_edit  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS account_group_members (
  user_id  INTEGER NOT NULL,
  group_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, group_id)
);
`);
// Play-only accounts: 1 = a cut-down "play in browser" screen and nothing else. The admin sets it per person.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'play_only')) {
  db.exec('ALTER TABLE users ADD COLUMN play_only INTEGER NOT NULL DEFAULT 0');
}
// A colour for each person (set by an admin; it tints them in the chat). Accounts that already exist are given one each, from the palette, in the order they were made.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'colour')) {
  db.exec('ALTER TABLE users ADD COLUMN colour TEXT');
  const taken = [];
  for (const u of db.prepare('SELECT id FROM users ORDER BY id').all()) { const c = nextUserColour(taken); taken.push(c); db.prepare('UPDATE users SET colour = ? WHERE id = ?').run(c, u.id); }
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
    db.prepare('INSERT INTO users (username, password_hash, role, colour) VALUES (?, ?, ?, ?)')
      .run(username, await hashPassword(generated), 'admin', nextUserColour(db.prepare('SELECT colour FROM users').all().map((u) => u.colour)));
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

  db.prepare('INSERT INTO users (username, password_hash, role, colour) VALUES (?, ?, ?, ?)')
    .run(username, await hashPassword(password), 'admin', nextUserColour(db.prepare('SELECT colour FROM users').all().map((u) => u.colour)));
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
  const inGroups = db.prepare('SELECT user_id, group_id FROM account_group_members ORDER BY group_id').all();
  return db.prepare(`
    SELECT u.id, u.username, u.display_name, u.role, u.disabled, u.created_at, u.last_login_at, u.download_override, u.avatar_updated, u.play_only, u.colour, u.age_limit,
           (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > datetime('now')) AS active_sessions
    FROM users u ORDER BY u.username
  `).all().map(({ download_override, avatar_updated, play_only, ...u }) => ({
    ...u, groups: inGroups.filter((m) => m.user_id === u.id).map((m) => m.group_id), avatar_v: avatar_updated || null, disabled: Boolean(u.disabled), mode: u.role !== 'admin' && play_only ? 'play' : 'full',
    download: download_override === 1 ? 'allow' : download_override === 0 ? 'deny' : 'default'
  }));
}

export async function createUser({ username, password, display_name = null, role = 'user', colour = null, groups = [], age_limit = null }) {
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
  // The admin may choose the person's colour here; without one they get the next palette colour nobody has.
  let chosen;
  if (colour !== null && colour !== undefined && String(colour).trim() !== '') {
    const c = userColour(colour);
    if (!c.ok) throw Object.assign(new Error(c.reason), { status: 400 });
    chosen = c.colour;
  } else chosen = nextUserColour(db.prepare('SELECT colour FROM users').all().map((u) => u.colour));
  const hash = await hashPassword(password);
  const info = db.transaction(() => {
    const made = db.prepare('INSERT INTO users (username, display_name, password_hash, role, colour, age_limit) VALUES (?, ?, ?, ?, ?, ?)')
      .run(name, display_name, hash, role === 'admin' ? 'admin' : 'user', chosen, age_limit);
    setUserGroups(Number(made.lastInsertRowid), groups);
    return made;
  })();
  // New people start in the Modern look (they can switch to Classic any time). People who already exist are left as they are.
  try { db.prepare("INSERT OR IGNORE INTO user_prefs (user_id, key, value) VALUES (?, 'ui_mode', 'modern')").run(Number(info.lastInsertRowid)); } catch { /* prefs table missing: they simply start in Classic */ }
  return { id: Number(info.lastInsertRowid), username: name, role, colour: chosen };
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
  // Their Steam key and owned-games list go with them (stored per person, nothing shared).
  db.prepare('DELETE FROM digital_marks WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM digital_games WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM digital_accounts WHERE user_id = ?').run(userId);
  purgeManualFiles(userId);   // the manuals they uploaded
  purgeCustomCovers(userId);  // and the covers
  db.prepare('DELETE FROM physical_games WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM digital_user_meta WHERE user_id = ?').run(userId);
  purgeMessages(userId);   // every message they sent or received goes, on both sides
  forgetSubject('user', userId);   // the games blocked for them, and their places in groups: a new account may be given this number
  db.prepare('DELETE FROM account_group_members WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
}

/* ───────────────────────── login throttling ───────────────────────── */

/* Failed sign-ins are counted three ways, and any one of them can lock:
 *  - one username from one address (GAMESAUCE_LOGIN_MAX_FAILURES, default 8),
 *  - one address whatever the username (GAMESAUCE_LOGIN_MAX_FAILURES_PER_ADDRESS, default 30), so changing the name does not help,
 *  - one username whatever the address (GAMESAUCE_LOGIN_MAX_FAILURES_PER_USER, default 50), so changing or faking the address does not help.
 *    Set high on purpose: reaching it locks that username for everyone for a while. An admin's password reset lifts it.
 * A lock lasts GAMESAUCE_LOGIN_LOCK_MINUTES (default 15). The two wider counts also start again after that long without a failure. */
const MAX_FAILURES = Number(process.env.GAMESAUCE_LOGIN_MAX_FAILURES || 8);
const MAX_PER_ADDRESS = Number(process.env.GAMESAUCE_LOGIN_MAX_FAILURES_PER_ADDRESS || 30);
const MAX_PER_USER = Number(process.env.GAMESAUCE_LOGIN_MAX_FAILURES_PER_USER || 50);
const LOCK_MINUTES = Number(process.env.GAMESAUCE_LOGIN_LOCK_MINUTES || 15);

// The wider counts' keys start with a control character, which a sign-in name may not contain, so no username can imitate them.
const addressKey = (ip) => `\u0001address:${ip}`;
const userKey = (username) => `\u0001user:${String(username).toLowerCase()}`;

/** The counters one sign-in attempt is held against. The narrow one counts until it is cleared or goes stale; the wide ones lapse. */
export function loginCounters(username, ip) {
  return [
    { key: `${String(username).toLowerCase()}|${ip}`, max: MAX_FAILURES, lapses: false, clearedBySuccess: true },
    { key: addressKey(ip), max: MAX_PER_ADDRESS, lapses: true, clearedBySuccess: false },   // not by success: or signing in to your own account would reset it
    { key: userKey(username), max: MAX_PER_USER, lapses: true, clearedBySuccess: true }
  ];
}

// Wrong guesses at the current password (on the change-password form) have a count of their own: someone holding a stolen session is stopped
// after a few, and cannot use them to lock the owner out of signing in.
const changeKey = (username) => `\u0001change:${String(username).toLowerCase()}`;
export const passwordChangeCounters = (username) => [{ key: changeKey(username), max: MAX_FAILURES, lapses: true, clearedBySuccess: true }];

function loginLockRemaining(key) {
  const row = db.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').get(key);
  if (!row?.locked_until) return 0;
  const until = new Date(`${row.locked_until.replace(' ', 'T')}Z`).getTime();
  return Math.max(0, until - Date.now());
}

function failureCount({ key, lapses }) {
  const row = db.prepare("SELECT failures, (last_failure <= datetime('now', ?)) AS old FROM login_attempts WHERE key = ?").get(`-${LOCK_MINUTES} minutes`, key);
  return !row || (lapses && row.old) ? 0 : row.failures;
}

// Checking a password takes a moment, so guesses sent together would all be let in before the first had been counted. Those being checked count too.
const checking = new Map();

/** Take a place for one password check. Returns { wait } (milliseconds) when it may not happen, else { done } to call when it has finished. */
export function startLoginAttempt(counters) {
  const wait = Math.max(...counters.map((c) => loginLockRemaining(c.key)));
  if (wait > 0) return { wait };
  if (counters.some((c) => (checking.get(c.key) || 0) >= Math.max(1, c.max - failureCount(c)))) return { wait: 1000 };
  for (const c of counters) checking.set(c.key, (checking.get(c.key) || 0) + 1);
  return {
    done() {
      for (const c of counters) { const n = checking.get(c.key) - 1; if (n > 0) checking.set(c.key, n); else checking.delete(c.key); }
    }
  };
}

function countFailure(counter) {
  const failures = failureCount(counter) + 1;
  const lock = failures >= counter.max ? `+${LOCK_MINUTES} minutes` : null;

  db.prepare(`
    INSERT INTO login_attempts (key, failures, last_failure, locked_until)
    VALUES (?, ?, datetime('now'), ${lock ? "datetime('now', ?)" : 'NULL'})
    ON CONFLICT(key) DO UPDATE SET
      failures = excluded.failures,
      last_failure = datetime('now'),
      locked_until = ${lock ? 'excluded.locked_until' : 'NULL'}
  `).run(...(lock ? [counter.key, failures, lock] : [counter.key, failures]));

  return counter.max - failures;
}

/** Count a failed sign-in on every counter. Returns how many tries are left before the first lock. */
export function recordLoginFailure(counters) {
  // Counters nobody has touched for a day, and which are not locking anything, are only taking up room.
  db.prepare("DELETE FROM login_attempts WHERE last_failure < datetime('now', '-1 day') AND (locked_until IS NULL OR locked_until < datetime('now'))").run();
  return { remaining: Math.min(...counters.map(countFailure)) };
}

export function clearLoginFailures(counters) {
  for (const c of counters) if (c.clearedBySuccess) db.prepare('DELETE FROM login_attempts WHERE key = ?').run(c.key);
}

/** Forget a username's failed-login records (any address): used when an admin resets a password. An address's own count stays. */
export function clearLoginFailuresForUser(username) {
  db.prepare("DELETE FROM login_attempts WHERE key = ? OR key = ? OR key LIKE ? ESCAPE '\\'")
    .run(userKey(username), changeKey(username), String(username).toLowerCase().replace(/[\\%_]/g, '\\$&') + '|%');
}

/* ──────────────────────────── audit log ──────────────────────────── */

/** The longest username a sign-in is even looked at with, and the longest kept in the log. New accounts are limited to 32; this leaves room for a longer first admin name. */
export const MAX_LOGIN_NAME = 64;
// Anyone who can reach the sign-in page can add failed sign-ins, so only the newest are kept. Everything else in the log is kept as before.
const KEEP_FAILED_LOGINS = 10_000;
const cut = (v, n) => (v === null || v === undefined || v === '' ? null : String(v).slice(0, n));

export function audit(user, action, { target = null, detail = null, ip = null } = {}) {
  db.prepare('INSERT INTO audit_log (user_id, username, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user?.id || null, cut(user?.username, MAX_LOGIN_NAME), cut(action, 300), cut(target, 200),
      detail ? JSON.stringify(detail).slice(0, 2000) : null, cut(ip, 64));
  if (action === 'login.failed') {
    db.prepare("DELETE FROM audit_log WHERE action = 'login.failed' AND id <= (SELECT id FROM audit_log WHERE action = 'login.failed' ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .run(KEEP_FAILED_LOGINS);
  }
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

import {
  createSession, createUser, deleteUser, describeAudit, destroyAllSessions, destroySession,
  findSession, listAudit, listUsers, setPassword, touchSession, verifyPassword,
  audit, loginLockRemaining, recordLoginFailure, clearLoginFailures, clearLoginFailuresForUser
} from '../auth.js';
import { canDownload, membersCanDownload, setMembersCanDownload } from '../lib/policy.js';
import db from '../db.js';
import express from 'express';

const router = express.Router();

const COOKIE = process.env.GAMESAUCE_COOKIE_NAME || 'gamesauce_session';

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export function sessionCookie(token, maxAgeSeconds) {
  const secure = process.env.GAMESAUCE_COOKIE_SECURE === '1' ? '; Secure' : '';
  // No Max-Age (null) = session cookie, dropped when the browser closes.
  const age = maxAgeSeconds ? `; Max-Age=${maxAgeSeconds}` : '';
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${age}${secure}`;
}

export function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function tokenFromRequest(req) {
  const cookie = readCookie(req, COOKIE);
  if (cookie) return cookie;
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return null;
}

/** Attach req.user when a valid session cookie/token is present. Never rejects. */
export function attachUser(req, res, next) {
  const token = tokenFromRequest(req);
  if (token) {
    const session = findSession(token);
    if (session && !session.disabled) {
      req.user = {
        id: session.id, username: session.username,
        display_name: session.display_name, role: session.role,
        session_id: session.session_id
      };
      req.sessionToken = token;
      // Cheap last-seen update; not on every asset request.
      if (req.path.startsWith('/api')) touchSession(session.session_id);
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
}

export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

const clientIp = (req) => (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');

/* ───────────────────────────── session ───────────────────────────── */

router.get('/me', (req, res) => {
  if (!req.user) return res.json({ authenticated: false });
  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      username: req.user.username,
      display_name: req.user.display_name,
      role: req.user.role,
      can_download: canDownload(req.user)
    }
  });
});

/** Server-wide switches. Anyone signed in can read them; only an admin can change them. */
router.get('/policy', requireAuth, (req, res) => {
  res.json({ members_can_download: membersCanDownload() });
});
router.put('/policy', requireAdmin, (req, res) => {
  if (typeof req.body?.members_can_download !== 'boolean') {
    return res.status(400).json({ error: 'members_can_download must be true or false' });
  }
  const now = setMembersCanDownload(req.body.members_can_download, req.user.id);
  audit(req.user, 'policy.changed', { detail: { members_can_download: now }, ip: clientIp(req) });
  res.json({ members_can_download: now });
});

router.post('/login', async (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const ip = clientIp(req);
  const key = `${username.toLowerCase()}|${ip}`;

  const lockMs = loginLockRemaining(key);
  if (lockMs > 0) {
    return res.status(429).json({
      error: `Too many failed attempts. Try again in ${Math.ceil(lockMs / 60000)} minute(s).`,
      retry_after: Math.ceil(lockMs / 1000)
    });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

  // Always run a hash comparison, even for an unknown user, so response timing
  // does not reveal which usernames exist.
  const ok = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAA');

  if (!user || !ok || user.disabled) {
    const state = recordLoginFailure(key);
    audit({ id: user?.id, username: user?.username || username }, 'login.failed', { ip });
    return res.status(401).json({
      error: user?.disabled ? 'That account is disabled' : 'Invalid username or password',
      attempts_remaining: state.remaining > 0 ? state.remaining : 0
    });
  }

  clearLoginFailures(key);
  // "Keep me signed in": omitted/true = persistent (as before); false = browser-only.
  const persistent = req.body?.remember !== false;
  const { token, expires_in } = await createSession(user.id, { userAgent: req.headers['user-agent'], ip, persistent });
  audit(user, 'login.success', { ip });

  res.setHeader('Set-Cookie', sessionCookie(token, expires_in));
  res.json({
    token,
    expires_in,
    user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, can_download: canDownload(user) }
  });
});

router.post('/logout', (req, res) => {
  if (req.sessionToken) destroySession(req.sessionToken);
  if (req.user) audit(req.user, 'logout', { ip: clientIp(req) });
  res.setHeader('Set-Cookie', clearCookie());
  res.json({ ok: true });
});

/** Change your own password. Invalidates every other session. */
router.post('/password', requireAuth, async (req, res, next) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const current = String(req.body?.current_password || '');
    const next_ = String(req.body?.new_password || '');

    if (!(await verifyPassword(current, user.password_hash))) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // setPassword drops all sessions; re-issue one of the same kind for this browser.
    const cur = db.prepare('SELECT persistent FROM sessions WHERE id = ?').get(req.user.session_id);
    await setPassword(user.id, next_);
    const { token, expires_in } = await createSession(user.id, {
      userAgent: req.headers['user-agent'], ip: clientIp(req), persistent: cur?.persistent !== 0
    });
    audit(req.user, 'password.changed', { ip: clientIp(req) });
    res.setHeader('Set-Cookie', sessionCookie(token, expires_in));
    res.json({ ok: true, token });
  } catch (err) { next(err); }
});

/* ────────────────────────────── users ────────────────────────────── */

router.get('/users', requireAdmin, (req, res) => {
  res.json({ items: listUsers() });
});

router.post('/users', requireAdmin, async (req, res, next) => {
  try {
    const created = await createUser({
      username: req.body?.username,
      password: req.body?.password,
      display_name: req.body?.display_name || null,
      role: req.body?.role === 'admin' ? 'admin' : 'user'
    });
    audit(req.user, 'user.created', { target: created.username, detail: { role: created.role }, ip: clientIp(req) });
    res.status(201).json(created);
  } catch (err) { next(err); }
});

router.patch('/users/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (req.body?.disabled !== undefined) {
    if (user.role === 'admin' && req.body.disabled) {
      const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get().n;
      if (admins <= 1) return res.status(409).json({ error: 'Cannot disable the last admin' });
    }
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(req.body.disabled ? 1 : 0, id);
    if (req.body.disabled) destroyAllSessions(id);
  }

  if (req.body?.role !== undefined) {
    const role = req.body.role === 'admin' ? 'admin' : 'user';
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
  }

  if (req.body?.display_name !== undefined) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(req.body.display_name || null, id);
  }

  audit(req.user, 'user.updated', { target: user.username, detail: req.body, ip: clientIp(req) });
  res.json(listUsers().find((u) => u.id === id));
});

/** Admin sets a new password for another user (they forgot it, or are locked out). Signs them out everywhere. */
router.post('/users/:id/password', requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(409).json({ error: 'Use Change password for your own account' });
    const target = listUsers().find((u) => u.id === id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await setPassword(id, String(req.body?.password || ''));
    clearLoginFailuresForUser(target.username); // a lockout from failed attempts should not outlive the reset
    audit(req.user, 'user.password_reset', { target: target.username, ip: clientIp(req) });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/users/:id', requireAdmin, (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (id === req.user.id) return res.status(409).json({ error: 'You cannot delete your own account' });
    deleteUser(id);
    audit(req.user, 'user.deleted', { target: String(id), ip: clientIp(req) });
    res.json({ deleted: id });
  } catch (err) { next(err); }
});

router.get('/sessions', requireAuth, (req, res) => {
  const items = db.prepare(`
    SELECT id, user_agent, ip, created_at, last_seen_at, expires_at
    FROM sessions WHERE user_id = ? AND expires_at > datetime('now')
    ORDER BY last_seen_at DESC
  `).all(req.user.id);
  res.json({ items, current: req.user.session_id });
});

router.delete('/sessions', requireAuth, (req, res) => {
  const keepCurrent = req.query.all !== '1';
  destroyAllSessions(req.user.id, keepCurrent ? req.user.session_id : null);
  audit(req.user, 'sessions.revoked', { detail: { all: !keepCurrent }, ip: clientIp(req) });
  res.json({ ok: true, kept_current: keepCurrent });
});

/* ───────────────────────────── audit ───────────────────────────── */

router.get('/audit', requireAdmin, (req, res) => {
  const rows = listAudit({
    limit: req.query.limit,
    action: req.query.action,
    username: req.query.username,
    since: req.query.since,
    until: req.query.until
  });
  res.json({
    items: rows.map((e) => {
      let detail = null;
      try { detail = e.detail ? JSON.parse(e.detail) : null; } catch { detail = null; }
      return { ...e, detail, summary: describeAudit(e) };
    }),
    // Distinct usernames for the filter dropdown — cheap, keeps the UI simple.
    users: db.prepare('SELECT DISTINCT username FROM audit_log WHERE username IS NOT NULL ORDER BY username COLLATE NOCASE').all().map((r) => r.username)
  });
});

export default router;

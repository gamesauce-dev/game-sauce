// Messages: a small, private, one-to-one chat between the people who use this server, plus notices from the admin to everyone (such as "maintenance tonight").
//
// It is for a household, so it is deliberately plain:
//   - Only the two people in a conversation can read it. There is no admin view, no admin route and no audit entry for what is said or who said it.
//   - Plain text of at most 200 characters. No links, no pictures, no files: nothing here can be used to send or point to a ROM.
//   - A game can be SHARED: only its title and platform go in the message (a note, not a file). Opening a shared ROM goes through the Library's own permissions.
//   - "Delete" removes a message for the person who deleted it only. The sender can RECALL a message for a few minutes: it is wiped for both.
//   - When someone's account is deleted, every message they sent or received goes with it, on both sides.
import db from '../db.js';
import { platformLabel } from './consoles.js';

export const MAX_LEN = 200;
export const RECALL_MINUTES = 5;
export const NOTICE_DEFAULT_HOURS = 168;
const RATE = { max: 10, windowMs: 60_000 };

const fail = (status, message) => Object.assign(new Error(message), { status });

/** Links are refused: this is a chat between people in one house, and a link is the one way it could point at a place that hosts ROMs. */
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|to|me|gg|xyz|info|ru|cc|ws|tv|ly|gd|co|app|dev|site|link|club|top)\b)/i;
export const hasLink = (text) => LINK.test(String(text || ''));
const NO_LINKS = 'Links can\'t be sent in messages. To point someone at a game, use the Share button.';

function cleanText(body, { required = true } = {}) {
  const t = String(body ?? '').replace(/\s+/g, ' ').trim();
  if (!t && required) throw fail(400, 'Type a message.');
  if ([...t].length > MAX_LEN) throw fail(400, `Messages are at most ${MAX_LEN} characters.`);
  if (hasLink(t)) throw fail(400, NO_LINKS);
  return t;
}

/* ───────── who can chat ───────── */

/** A play-only account (a cut-down screen for playing) reads the admin's notices but has no chat. The admin always can. */
export const canChat = (user) => Boolean(user) && (user.role === 'admin' || !user.play_only);

const person = (u) => ({ id: u.id, username: u.username, name: u.display_name || u.username, avatar_v: u.avatar_updated || null, colour: u.colour || null });

/** The other people one can write to: enabled accounts that have chat. Names and pictures only. */
export function listPeople(userId) {
  return db.prepare("SELECT id, username, display_name, avatar_updated, colour FROM users WHERE id != ? AND disabled = 0 AND (role = 'admin' OR play_only = 0) ORDER BY lower(COALESCE(NULLIF(display_name, ''), username))")
    .all(userId).map(person);
}
const findPerson = (id) => db.prepare("SELECT id, username, display_name, avatar_updated, colour, role, play_only, disabled FROM users WHERE id = ?").get(Number(id));

/* ───────── sending limits ───────── */

const sent = new Map();   // user id -> the times of their recent messages
/** At most 10 messages a minute per person: a household chat has no need for more, and it stops a runaway script. */
export function checkRate(userId, now = Date.now()) {
  const list = (sent.get(userId) || []).filter((t) => now - t < RATE.windowMs);
  if (list.length >= RATE.max) { sent.set(userId, list); throw fail(429, 'You are sending messages too fast. Wait a moment.'); }
  list.push(now); sent.set(userId, list);
}
export const _resetRate = () => sent.clear();

/* ───────── sharing a game ───────── */

const clip = (s, n = 120) => String(s ?? '').slice(0, n);

/** Check a game the sender picked and keep only a note about it: { type, title, platform } (and the ROM's id, so its details can be opened). */
function shareOf(userId, game) {
  if (!game) return null;
  const type = String(game.type || '');
  if (type === 'rom') {
    const r = db.prepare('SELECT r.id, r.title, p.name AS platform FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?').get(Number(game.id));
    if (!r) throw fail(400, 'That game is not in the ROM Library.');
    return { type, id: r.id, title: clip(r.title), platform: clip(r.platform) };
  }
  if (type === 'digital') {
    const g = db.prepare('SELECT store, platform, name FROM digital_games WHERE user_id = ? AND store = ? AND app_id = ?').get(userId, String(game.store || ''), String(game.app_id || ''));
    if (!g) throw fail(400, 'That game is not in your Digital Library.');
    return { type, title: clip(g.name), platform: clip(g.store === 'steam' ? 'Steam' : platformLabel(g.store, g.platform)) };
  }
  if (type === 'physical') {
    const g = db.prepare('SELECT g.title, p.name AS platform FROM physical_games g LEFT JOIN platforms p ON p.slug = g.platform WHERE g.user_id = ? AND g.id = ?').get(userId, Number(game.id));
    if (!g) throw fail(400, 'That game is not in your Physical Library.');
    return { type, title: clip(g.title), platform: clip(g.platform || '') };
  }
  throw fail(400, 'Unknown kind of game to share.');
}

/* ───────── messages ───────── */

const visibleTo = '((sender_id = @me AND del_sender = 0) OR (recipient_id = @me AND del_recipient = 0))';

/** Send one message to one person. body is plain text (may be empty when a game is shared), game is { type: 'rom' | 'digital' | 'physical', ... }, replyTo a message in this conversation. */
export function sendMessage(sender, toId, { body = '', game = null, replyTo = null } = {}) {
  if (!canChat(sender)) throw fail(403, 'Chat is not available for this account.');
  const to = findPerson(toId);
  if (!to || to.disabled || (to.role !== 'admin' && to.play_only)) throw fail(404, 'That person cannot receive messages.');
  if (to.id === sender.id) throw fail(400, 'Choose someone else to write to.');
  const text = cleanText(body, { required: !game });
  const share = shareOf(sender.id, game);
  let reply = null;
  if (replyTo != null && replyTo !== '') {
    reply = db.prepare(`SELECT id FROM messages WHERE id = @id AND ${visibleTo} AND ((sender_id = @me AND recipient_id = @other) OR (sender_id = @other AND recipient_id = @me))`).get({ id: Number(replyTo), me: sender.id, other: to.id });
    if (!reply) throw fail(400, 'The message you are replying to is gone.');
  }
  checkRate(sender.id);
  const info = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, game, reply_to) VALUES (?, ?, ?, ?, ?)').run(sender.id, to.id, text, share ? JSON.stringify(share) : null, reply?.id ?? null);
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(info.lastInsertRowid);
}

const withinRecall = (m) => !m.recalled_at && (Date.now() - new Date(String(m.created_at).replace(' ', 'T') + 'Z').getTime()) <= RECALL_MINUTES * 60_000;
const snippet = (m) => (m.recalled_at ? 'Message recalled' : clip(m.body || (m.game ? 'Shared a game' : ''), 70));

function shape(m, me) {
  const mine = m.sender_id === me;
  let game = null; if (m.game) { try { game = JSON.parse(m.game); } catch { game = null; } }
  let reply = null;
  if (m.reply_to) {
    const q = db.prepare('SELECT * FROM messages WHERE id = ?').get(m.reply_to);
    // The quoted message shows only if it is still visible to this person.
    if (q && ((q.sender_id === me && !q.del_sender) || (q.recipient_id === me && !q.del_recipient))) reply = { id: q.id, mine: q.sender_id === me, text: snippet(q) };
  }
  return { id: m.id, mine, body: m.recalled_at ? '' : m.body, recalled: Boolean(m.recalled_at), game, reply, at: m.created_at, seen: mine && Boolean(m.read_at), can_recall: mine && withinRecall(m) };
}

/** The conversation with one person, oldest first (the latest 200). */
export function thread(me, otherId) {
  const rows = db.prepare(`SELECT * FROM (SELECT * FROM messages WHERE ${visibleTo} AND ((sender_id = @me AND recipient_id = @other) OR (sender_id = @other AND recipient_id = @me)) ORDER BY id DESC LIMIT 200) ORDER BY id`).all({ me, other: Number(otherId) });
  return rows.map((m) => shape(m, me));
}

/** Everyone the person has a conversation with, the most recent first, with the last message and how many are unread. */
export function conversations(me) {
  const groups = db.prepare(`SELECT other, MAX(id) AS last_id, SUM(unread) AS unread FROM (
      SELECT CASE WHEN sender_id = @me THEN recipient_id ELSE sender_id END AS other, id,
        CASE WHEN recipient_id = @me AND read_at IS NULL AND recalled_at IS NULL THEN 1 ELSE 0 END AS unread
      FROM messages WHERE ${visibleTo}) GROUP BY other ORDER BY last_id DESC`).all({ me });
  return groups.map((g) => {
    const u = findPerson(g.other); const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(g.last_id);
    return { user: u ? person(u) : { id: g.other, username: '', name: 'Someone', avatar_v: null }, unread: g.unread || 0, last: { id: m.id, mine: m.sender_id === me, text: snippet(m), at: m.created_at } };
  });
}

/** Opening a conversation marks what the other person sent as read. */
export function markRead(me, otherId) {
  return db.prepare("UPDATE messages SET read_at = datetime('now') WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL").run(me, Number(otherId)).changes;
}

/** Delete for me only: the other person keeps their copy. When both have deleted it, it is gone for good. */
export function deleteForMe(me, id) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(id));
  if (!m || (m.sender_id !== me && m.recipient_id !== me)) throw fail(404, 'That message is not in your conversations.');
  const col = m.sender_id === me ? 'del_sender' : 'del_recipient';
  db.prepare(`UPDATE messages SET ${col} = 1 WHERE id = ?`).run(m.id);
  db.prepare('DELETE FROM messages WHERE id = ? AND del_sender = 1 AND del_recipient = 1').run(m.id);
  return { deleted: true };
}

/** Delete a whole conversation for me: every message in it, both those I sent and those I received. The other person keeps their copy; a message both of us have deleted is gone for good. */
export function deleteConversation(me, otherId) {
  const other = Number(otherId);
  const a = db.prepare('UPDATE messages SET del_sender = 1 WHERE sender_id = ? AND recipient_id = ? AND del_sender = 0').run(me, other).changes;
  const b = db.prepare('UPDATE messages SET del_recipient = 1 WHERE recipient_id = ? AND sender_id = ? AND del_recipient = 0').run(me, other).changes;
  db.prepare('DELETE FROM messages WHERE del_sender = 1 AND del_recipient = 1 AND ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))').run(me, other, other, me);
  return { deleted: a + b };
}

/** The sender can take a message back for a few minutes: its words and any shared game are wiped for both people, and "Message recalled" is left in its place. */
export function recall(me, id) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ? AND sender_id = ?').get(Number(id), me);
  if (!m) throw fail(404, 'That message is not yours to recall.');
  if (m.recalled_at) return { recalled: true };
  if (!withinRecall(m)) throw fail(409, `A message can only be recalled in the first ${RECALL_MINUTES} minutes.`);
  db.prepare("UPDATE messages SET body = '', game = NULL, recalled_at = datetime('now') WHERE id = ?").run(m.id);
  return { recalled: true };
}

/* ───────── notices from the admin ───────── */

/** A notice to everyone, such as scheduled maintenance. Admin only (the route checks). It lapses after `hours` (default a week). */
export function postNotice(admin, { body, hours } = {}) {
  const text = cleanText(body);
  const h = hours === undefined || hours === null || hours === '' ? NOTICE_DEFAULT_HOURS : Number(hours);
  if (!Number.isFinite(h) || h < 1 || h > 24 * 60) throw fail(400, 'A notice lasts between 1 hour and 60 days.');
  const info = db.prepare("INSERT INTO notices (author_id, body, expires_at) VALUES (?, ?, datetime('now', ?))").run(admin.id, text, `+${Math.round(h * 60)} minutes`);
  return { id: Number(info.lastInsertRowid) };
}

/** The notices still running that this person has not dismissed. */
export function listNotices(me) {
  db.prepare("DELETE FROM notices WHERE expires_at IS NOT NULL AND expires_at <= datetime('now')").run();
  return db.prepare(`SELECT n.id, n.body, n.created_at, n.expires_at, n.author_id, u.display_name, u.username, COALESCE(s.read_at, '') AS read_at
      FROM notices n LEFT JOIN users u ON u.id = n.author_id LEFT JOIN notice_state s ON s.notice_id = n.id AND s.user_id = ?
      WHERE COALESCE(s.dismissed, 0) = 0 ORDER BY n.id DESC`).all(me)
    .map((n) => ({ id: n.id, body: n.body, at: n.created_at, until: n.expires_at, from: n.display_name || n.username || 'Admin', unread: !n.read_at, mine: n.author_id === me }));
}
const noticeExists = (id) => db.prepare('SELECT id FROM notices WHERE id = ?').get(Number(id));
export function markNoticeRead(me, id) {
  if (!noticeExists(id)) throw fail(404, 'That notice has gone.');
  db.prepare("INSERT INTO notice_state (user_id, notice_id, read_at) VALUES (?, ?, datetime('now')) ON CONFLICT(user_id, notice_id) DO UPDATE SET read_at = COALESCE(read_at, excluded.read_at)").run(me, Number(id));
  return { read: true };
}
/** Dismiss for me. */
export function dismissNotice(me, id) {
  if (!noticeExists(id)) throw fail(404, 'That notice has gone.');
  db.prepare("INSERT INTO notice_state (user_id, notice_id, read_at, dismissed) VALUES (?, ?, datetime('now'), 1) ON CONFLICT(user_id, notice_id) DO UPDATE SET dismissed = 1, read_at = COALESCE(read_at, excluded.read_at)").run(me, Number(id));
  return { dismissed: true };
}
/** The admin takes a notice back for everyone. */
export function withdrawNotice(id) {
  const r = db.prepare('DELETE FROM notices WHERE id = ?').run(Number(id));
  db.prepare('DELETE FROM notice_state WHERE notice_id = ?').run(Number(id));
  if (!r.changes) throw fail(404, 'That notice has gone.');
  return { withdrawn: true };
}

/* ───────── the badge and the toast ───────── */

/** What the page polls: how many unread messages and notices, and the newest of each, so it can raise a toast for something new. */
export function summary(me, user) {
  const chat = canChat(user);
  const unread = chat ? db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND del_recipient = 0 AND read_at IS NULL AND recalled_at IS NULL').get(me).n : 0;
  const latest = chat ? db.prepare(`SELECT m.id, u.display_name, u.username, u.id AS uid FROM messages m JOIN users u ON u.id = m.sender_id
      WHERE m.recipient_id = ? AND m.del_recipient = 0 AND m.read_at IS NULL AND m.recalled_at IS NULL ORDER BY m.id DESC LIMIT 1`).get(me) : null;
  const notices = listNotices(me).filter((n) => n.unread);
  return {
    chat, unread, notices_unread: notices.length,
    latest: latest ? { id: latest.id, from_id: latest.uid, from: latest.display_name || latest.username } : null,
    notice: notices[0] ? { id: notices[0].id, body: notices[0].body, from: notices[0].from } : null
  };
}

/** When an account is deleted, every message it sent or received goes, on both sides, and so do its notice states. */
export function purgeUser(userId) {
  db.prepare('DELETE FROM messages WHERE sender_id = ? OR recipient_id = ?').run(userId, userId);
  db.prepare('DELETE FROM notice_state WHERE user_id = ?').run(userId);
  db.prepare('UPDATE notices SET author_id = NULL WHERE author_id = ?').run(userId);
}

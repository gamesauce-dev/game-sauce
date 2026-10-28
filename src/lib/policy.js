// Server-wide policy switches an admin can flip. Stored as plain rows in app_settings.
// Kept separate from provider credentials (settings.js), which are encrypted and read differently.
import db from '../db.js';

const KEYS = { members_can_download: 'policy.members_can_download' };

function readBool(key, fallback) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  if (!row) return fallback;
  return row.value === '1';
}

/** Members may download ROM files only when an admin has allowed it. Default: off (browser play still works). */
export function membersCanDownload() {
  return readBool(KEYS.members_can_download, false);
}

export function setMembersCanDownload(on, userId = null) {
  db.prepare(`
    INSERT INTO app_settings (key, value, encrypted, updated_by, updated_at)
    VALUES (?, ?, 0, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = datetime('now')
  `).run(KEYS.members_can_download, on ? '1' : '0', userId);
  return membersCanDownload();
}

/** Can this user download ROM files? Admins always can. */
export function canDownload(user) {
  if (!user) return false;
  return user.role === 'admin' || membersCanDownload();
}

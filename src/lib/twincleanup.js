// One-time cleanup for the first build of "disc to digital", which put every Xbox One / Series disc into Digital on its own.
// A counterpart the shelf created (digital_made = 1) and that nobody has touched since (no favourite, hide, play switch or
// own details) is removed again, and the disc is left unlinked and not switched off, so it can be turned on from its details.
// Counterparts someone did touch, and Digital games that were already there, are never removed.
export function dropUntouchedCounterparts(db) {
  const rows = db.prepare(`SELECT p.id, p.user_id, p.digital_app_id AS app_id FROM physical_games p
    WHERE p.digital_made = 1 AND p.digital_app_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM digital_marks m WHERE m.user_id = p.user_id AND m.store = 'xbox' AND m.app_id = p.digital_app_id AND (m.favourite = 1 OR m.hidden = 1 OR m.play = 1))
      AND NOT EXISTS (SELECT 1 FROM digital_user_meta u WHERE u.user_id = p.user_id AND u.store = 'xbox' AND u.app_id = p.digital_app_id)`).all();
  db.transaction(() => {
    for (const r of rows) {
      db.prepare("DELETE FROM digital_games WHERE user_id = ? AND store = 'xbox' AND app_id = ?").run(r.user_id, r.app_id);
      db.prepare("DELETE FROM digital_marks WHERE user_id = ? AND store = 'xbox' AND app_id = ?").run(r.user_id, r.app_id);
      db.prepare('UPDATE physical_games SET digital_app_id = NULL, digital_made = 0, digital_off = 0 WHERE id = ?').run(r.id);
    }
  })();
  return rows.length;
}

// Review of the Digital entries that "disc to digital" created. The first build added one for every Xbox One / Series disc on its own,
// so a person may now have Digital entries for games they have no digital copy of. Nothing here runs by itself: a person asks for the list
// (reviewCounterparts), unticks any they do own digitally, and confirms (dropCounterparts).
//
// An entry is only offered for removal when the shelf created it (the disc's digital_made flag, set when it was linked) and nobody has touched it
// since (no favourite, hide, play switch or own details). A Digital game that was already there before the disc was linked is never offered.
const LABEL = { xboxone: 'Xbox One', xboxseries: 'Xbox Series X|S' };

export function reviewCounterparts(db, userId) {
  const rows = db.prepare(`SELECT p.id, p.title, p.platform, p.digital_made AS made,
      COALESCE(m.favourite, 0) AS fav, COALESCE(m.hidden, 0) AS hid, COALESCE(m.play, 0) AS pl,
      EXISTS (SELECT 1 FROM digital_user_meta u WHERE u.user_id = p.user_id AND u.store = 'xbox' AND u.app_id = p.digital_app_id) AS edited
    FROM physical_games p
    LEFT JOIN digital_marks m ON m.user_id = p.user_id AND m.store = 'xbox' AND m.app_id = p.digital_app_id
    WHERE p.user_id = ? AND p.digital_app_id IS NOT NULL ORDER BY p.title COLLATE NOCASE`).all(userId);
  const remove = [], kept = []; let already = 0;
  for (const r of rows) {
    const item = { id: r.id, title: r.title, platform: LABEL[r.platform] || r.platform };
    if (!r.made) { already++; continue; }
    const why = r.fav ? 'you favourited it' : r.hid ? 'you hid it' : r.pl ? 'its play switch is on' : r.edited ? 'you edited its details' : null;
    if (why) kept.push({ ...item, why }); else remove.push(item);
  }
  return { remove, kept, already_there: already };
}

/** Removes the chosen entries (only ones the review offered). The discs stay on the shelf, unlinked and not switched off. Returns how many went. */
export function dropCounterparts(db, userId, ids) {
  const offered = new Map(reviewCounterparts(db, userId).remove.map((r) => [r.id, r]));
  const chosen = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter((id) => offered.has(id));
  db.transaction(() => {
    for (const id of chosen) {
      const r = db.prepare('SELECT digital_app_id AS app_id FROM physical_games WHERE id = ? AND user_id = ?').get(id, userId);
      db.prepare("DELETE FROM digital_games WHERE user_id = ? AND store = 'xbox' AND app_id = ?").run(userId, r.app_id);
      db.prepare("DELETE FROM digital_marks WHERE user_id = ? AND store = 'xbox' AND app_id = ?").run(userId, r.app_id);
      db.prepare('UPDATE physical_games SET digital_app_id = NULL, digital_made = 0, digital_off = 0 WHERE id = ?').run(id);
    }
  })();
  return chosen.length;
}

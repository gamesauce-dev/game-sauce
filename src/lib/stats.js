// Library figures for Settings > Stats. Read-only; every number is counted straight from the database.
import db from '../db.js';

const n = (sql, ...args) => Number(db.prepare(sql).get(...args)?.n || 0);

export function collectStats() {
  const roms = n('SELECT COUNT(*) AS n FROM roms');
  // "With provider metadata" = anything matched by a provider or a DAT; the rest is a name taken from the file.
  const matched = n("SELECT COUNT(*) AS n FROM roms WHERE meta_source IS NOT NULL AND meta_source NOT IN ('', 'none', 'filename', 'seed')");
  const bySource = db.prepare("SELECT COALESCE(NULLIF(meta_source, ''), 'none') AS source, COUNT(*) AS count FROM roms GROUP BY 1 ORDER BY count DESC").all();
  const topPlayer = db.prepare(`
    SELECT COALESCE(u.display_name, u.username) AS name, u.username, COUNT(*) AS plays
    FROM downloads d JOIN users u ON u.id = d.user_id
    WHERE d.kind = 'play' GROUP BY u.id ORDER BY plays DESC, u.id LIMIT 1`).get() || null;
  const topGame = db.prepare(`
    SELECT r.title, COUNT(*) AS plays FROM downloads d JOIN roms r ON r.id = d.rom_id
    WHERE d.kind = 'play' GROUP BY r.id ORDER BY plays DESC, r.id LIMIT 1`).get() || null;
  return {
    roms,
    platforms: n('SELECT COUNT(DISTINCT platform_id) AS n FROM roms'),
    sources: n('SELECT COUNT(*) AS n FROM sources'),
    users: n('SELECT COUNT(*) AS n FROM users'),
    with_metadata: matched,
    by_source: bySource,
    filename_only: roms - matched,
    with_covers: n('SELECT COUNT(*) AS n FROM roms WHERE cover_path IS NOT NULL'),
    no_covers: n('SELECT COUNT(*) AS n FROM roms WHERE cover_path IS NULL AND is_system = 0'),
    orphans: n('SELECT COUNT(*) AS n FROM roms WHERE source_id IS NULL OR source_id NOT IN (SELECT id FROM sources)'),
    missing_files: n('SELECT COUNT(*) AS n FROM roms WHERE missing = 1'),
    hidden: n('SELECT COUNT(*) AS n FROM roms WHERE hidden_all = 1 OR id IN (SELECT rom_id FROM hidden_roms)'),
    system_items: n('SELECT COUNT(*) AS n FROM roms WHERE is_system = 1'),
    favourites: n('SELECT COUNT(DISTINCT rom_id) AS n FROM favorites'),
    plays: n("SELECT COUNT(*) AS n FROM downloads WHERE kind = 'play'"),
    most_active_user: topPlayer,
    most_played_game: topGame
  };
}

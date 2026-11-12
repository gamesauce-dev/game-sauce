// ScreenScraper's media links can carry the credentials of whoever asked (developer id and password, account name and password). Earlier builds stored such links as they came
// (in the metadata cache and next to covers). This takes the credentials out of anything already stored. It runs once (src/migrations.js); new links are cleaned as they arrive
// (ssClean in src/lib/providers.js).
const PARAM = /([?&])(?:devid|devpassword|softname|ssid|sspassword)=[^&"'\s\\<>]*/gi;

/** The same text with those parameters removed from every link in it. */
export function scrubSsText(text) {
  return String(text ?? '').replace(PARAM, (m, sep) => (sep === '?' ? '?' : '')).replace(/\?&/g, '?').replace(/\?(?=["'\s\\<>]|$)/g, '');
}

const TARGETS = [
  ['metadata_cache', 'key', ['payload']],
  ['roms', 'id', ['cover_url', 'provider_media']],
  ['physical_games', 'id', ['cover_url', 'spine_url', 'disc_url', 'back_url']],
  ['digital_details', 'rowid', ['json']],
  ['digital_user_meta', 'rowid', ['json']]
];

/** Removes the credentials from every stored value that has them. Returns how many values were cleaned. */
export function scrubStoredSsLinks(db) {
  let cleaned = 0;
  for (const [table, idCol, cols] of TARGETS) {
    let have;
    try { have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)); } catch { continue; }
    if (!have.size) continue;
    for (const col of cols) {
      if (!have.has(col)) continue;
      const rows = db.prepare(`SELECT ${idCol} AS id, ${col} AS v FROM ${table} WHERE ${col} LIKE '%sspassword=%' OR ${col} LIKE '%devpassword=%'`).all();
      const set = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${idCol} = ?`);
      for (const r of rows) { const next = scrubSsText(r.v); if (next !== r.v) { set.run(next, r.id); cleaned++; } }
    }
  }
  return cleaned;
}

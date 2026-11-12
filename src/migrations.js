import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
import { decodeEntities } from './lib/metadata.js';
import { scrubStoredSsLinks } from './lib/ssscrub.js';

// Bump when the schema changes in a way that needs an explicit migration step.
const SCHEMA_VERSION = 7;

db.exec(`
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const version = Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0);

/* ── platforms: new columns for provider ids, family grouping and extensions ── */
const platformCols = new Set(db.prepare('PRAGMA table_info(platforms)').all().map((c) => c.name));
for (const [name, ddl] of [
  ['family', 'TEXT'],
  ['screenscraper_id', 'INTEGER'],
  ['tgdb_id', 'INTEGER'],
  ['extensions', 'TEXT']
]) {
  if (!platformCols.has(name)) db.exec(`ALTER TABLE platforms ADD COLUMN ${name} ${ddl}`);
}

/* ── roms: where the file actually lives ── */
const romCols = new Set(db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name));
const romAdditions = [
  // A ROM can be owned in place (a folder we scan) or imported into our own storage.
  ['source_id', 'INTEGER REFERENCES sources(id) ON DELETE SET NULL'],
  // Original absolute path, preserved verbatim for in-place libraries.
  ['source_path', 'TEXT'],
  ['in_place', 'INTEGER NOT NULL DEFAULT 0'],
  ['missing', 'INTEGER NOT NULL DEFAULT 0'],
  ['last_seen_at', 'TEXT'],
  ['scanned_size', 'INTEGER'],
  ['scanned_mtime', 'INTEGER'],
  ['provider_media', 'TEXT'] // JSON: extra media (screenshot, fanart, wheel…)
];
for (const [name, ddl] of romAdditions) {
  if (!romCols.has(name)) db.exec(`ALTER TABLE roms ADD COLUMN ${name} ${ddl}`);
}

/* ── sources: the folders the user points us at ──
   Also created in db.js (before the roms.source_id column is added, because
   SQLite resolves that REFERENCES clause immediately). This block keeps the
   definition here for databases created before that reordering. */
db.exec(`
CREATE TABLE IF NOT EXISTS sources (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  path          TEXT NOT NULL UNIQUE,
  platform_hint TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  watch         INTEGER NOT NULL DEFAULT 1,
  recursive     INTEGER NOT NULL DEFAULT 1,
  ignore_globs  TEXT,
  last_scan_at  TEXT,
  last_scan_ms  INTEGER,
  last_scan_found INTEGER NOT NULL DEFAULT 0,
  last_scan_added INTEGER NOT NULL DEFAULT 0,
  last_scan_error TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// roms.source_id references sources, which is created after roms — SQLite allows
// the forward reference in ALTER TABLE, but the index has to come after both.
db.exec('CREATE INDEX IF NOT EXISTS idx_roms_source ON roms(source_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_roms_source_path ON roms(source_path)');

db.exec(`
CREATE TABLE IF NOT EXISTS scan_log (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER REFERENCES sources(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  found      INTEGER NOT NULL DEFAULT 0,
  added      INTEGER NOT NULL DEFAULT 0,
  updated    INTEGER NOT NULL DEFAULT 0,
  missing    INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  error      TEXT
);
`);

/* ── provider cache, so a rescan does not burn API quota ── */
db.exec(`
CREATE TABLE IF NOT EXISTS metadata_cache (
  key         TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
  .run(String(SCHEMA_VERSION));

export { SCHEMA_VERSION };
export default db;

/* ── v3: hidden ROMs ── */
const romColsV3 = new Set(db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name));
for (const [name, ddl] of [
  // Separate from `favorite`: "show me this" and "keep this out of the way" are
  // different questions and a user may well want both.
  ['hidden', 'INTEGER NOT NULL DEFAULT 0'],
  ['hidden_at', 'TEXT']
]) {
  if (!romColsV3.has(name)) db.exec(`ALTER TABLE roms ADD COLUMN ${name} ${ddl}`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_roms_hidden ON roms(hidden)');

/* ── DAT tables: datfiles + dat_entries live here (not dats.js) so every fresh
   database — app boot, tests, scripts — gets them even when nothing imports
   the DAT helpers first. dats.js only adds rows/queries, never schema. */
db.exec(`
CREATE TABLE IF NOT EXISTS datfiles (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  source        TEXT,
  version       TEXT,
  system_name   TEXT,
  platform_slug TEXT REFERENCES platforms(slug) ON DELETE SET NULL,
  filename      TEXT,
  entries       INTEGER NOT NULL DEFAULT 0,
  imported_at   TEXT NOT NULL DEFAULT (datetime('now')),
  imported_by   INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS dat_entries (
  id            INTEGER PRIMARY KEY,
  datfile_id    INTEGER NOT NULL REFERENCES datfiles(id) ON DELETE CASCADE,
  platform_slug TEXT NOT NULL,
  title         TEXT NOT NULL,
  rom_name      TEXT,
  size          INTEGER,
  crc32         TEXT,
  md5           TEXT,
  sha1          TEXT,
  status        TEXT NOT NULL DEFAULT 'verified',
  cloneof       TEXT
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_dat_sha1 ON dat_entries(sha1)');
db.exec('CREATE INDEX IF NOT EXISTS idx_dat_crc_size ON dat_entries(crc32, size)');
db.exec('CREATE INDEX IF NOT EXISTS idx_dat_datfile ON dat_entries(datfile_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_dat_platform ON dat_entries(platform_slug)');

/* ── v4: harden dedupe — sha1 UNIQUE index (SQLite treats NULLs as distinct,
   so rows without hashes are unaffected) + a dat_entries sha1 index ── */
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_roms_sha1_unique ON roms(sha1)');
db.exec('CREATE INDEX IF NOT EXISTS idx_dat_entries_sha1 ON dat_entries(sha1)');

/* ── v5: emulator vault — your own emulator installers, catalogued like ROMs.
   Binaries enter only by YOUR hand (manual upload or "save official release"
   from the guide's GitHub). game-sauce never ships or fetches them itself. */
db.exec(`
CREATE TABLE IF NOT EXISTS emulators (
  id            INTEGER PRIMARY KEY,
  platform_slug TEXT,
  name          TEXT NOT NULL,
  version       TEXT,
  os            TEXT,
  arch          TEXT,
  source        TEXT NOT NULL DEFAULT 'upload',
  source_url    TEXT,
  filename      TEXT NOT NULL,
  storage_path  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL DEFAULT 0,
  sha1          TEXT,
  notes         TEXT,
  downloaded_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sha1)
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_emulators_platform ON emulators(platform_slug)');

/* ── v6: per-user favourites + download attribution.
   Favourites were a single global flag (roms.favorite). Keep that column as the
   legacy/system value, but track per-user stars in `favorites` so the "★ mine"
   stat is honest on a shared box. Downloads likewise gain user_id so "most
   downloaded" survives per-row, while existing rows stay attributed to nobody. */
db.exec(`
CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rom_id     INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, rom_id)
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_favorites_rom ON favorites(rom_id)');
const dlCols = new Set(db.prepare('PRAGMA table_info(downloads)').all().map((c) => c.name));
if (!dlCols.has('user_id')) db.exec('ALTER TABLE downloads ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE SET NULL');
// v7: kind column — separates manual downloads ('download') from browser-play
// streams ('play'). "Most downloaded" counts only kind='download'; old rows
// have NULL kind (counted as legacy/manual before the split).
if (!dlCols.has('kind')) db.exec("ALTER TABLE downloads ADD COLUMN kind TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_downloads_kind ON downloads(kind)");
db.exec('CREATE INDEX IF NOT EXISTS idx_downloads_user ON downloads(user_id)');
db.exec('CREATE INDEX IF NOT EXISTS idx_downloads_rom ON downloads(rom_id)');

db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '7') ON CONFLICT(key) DO UPDATE SET value = '7'").run();

/* ── v8: per-user save states + battery saves (browser play).
   Rows belong to (user, rom); bytes live on disk under storage/saves/<user>/<rom>/.
   Rows cascade with user/ROM deletion; lib/saves.js removes the files. One
   battery save per (user, rom); states are capped per game (oldest dropped). */
db.exec(`
CREATE TABLE IF NOT EXISTS save_states (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rom_id     INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('state','battery')),
  core       TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  file_path  TEXT NOT NULL,
  shot_path  TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_save_states_user_rom ON save_states(user_id, rom_id)');
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_save_battery_one ON save_states(user_id, rom_id) WHERE kind = 'battery'");

db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '8') ON CONFLICT(key) DO UPDATE SET value = '8'").run();

/* ── v9: MAME short-name list (mame -listxml): zip name -> real title. */
db.exec(`
CREATE TABLE IF NOT EXISTS mame_names (
  name         TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  year         INTEGER,
  manufacturer TEXT,
  cloneof      TEXT,
  isbios       INTEGER NOT NULL DEFAULT 0,
  isdevice     INTEGER NOT NULL DEFAULT 0
);
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '9') ON CONFLICT(key) DO UPDATE SET value = '9'").run();

/* ── v10: small per-user key/value preferences (e.g. favourite match provider). */
db.exec(`
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '10') ON CONFLICT(key) DO UPDATE SET value = '10'").run();

/* ── v11: per-game browser-play override. NULL = platform/year default,
   1 = force Play on (if the platform has a core), 0 = force Play off. */
const romColsV11 = new Set(db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name));
if (!romColsV11.has('play_override')) db.exec('ALTER TABLE roms ADD COLUMN play_override INTEGER');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '11') ON CONFLICT(key) DO UPDATE SET value = '11'").run();

/* ── v12: cover_locked — set when a person uploads their own cover; provider refreshes keep it. */
const romColsV12 = new Set(db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name));
if (!romColsV12.has('cover_locked')) db.exec('ALTER TABLE roms ADD COLUMN cover_locked INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '12') ON CONFLICT(key) DO UPDATE SET value = '12'").run();

/* ── v13: keep_override — a person's choice in the duplicate finder. NULL = automatic, 1 = keep this copy, 0 = do not keep. */
const romColsV13 = new Set(db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name));
if (!romColsV13.has('keep_override')) db.exec('ALTER TABLE roms ADD COLUMN keep_override INTEGER');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '13') ON CONFLICT(key) DO UPDATE SET value = '13'").run();

/* ── v14: is_system — BIOS / device / non-arcade entries. Kept (and downloadable) but out of the main library and out of metadata lookups. */
const romColsV14 = new Set(db.prepare('PRAGMA table_info(roms)').all().map((c) => c.name));
if (!romColsV14.has('is_system')) db.exec('ALTER TABLE roms ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '14') ON CONFLICT(key) DO UPDATE SET value = '14'").run();

/* ── v15: favourites are per person only. The old global roms.favorite flag is no longer read or written. */
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '15') ON CONFLICT(key) DO UPDATE SET value = '15'").run();

/* ── v16: hiding is per person. A person's hidden games are theirs alone; System (admin) is the system-wide way to tuck games away.
   Existing shared hides are handed to the oldest admin so nothing changes for them and nothing leaks to other people. */
db.exec(`
CREATE TABLE IF NOT EXISTS hidden_roms (
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rom_id     INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, rom_id)
);
CREATE INDEX IF NOT EXISTS idx_hidden_roms_user ON hidden_roms(user_id);
`);
if (!db.prepare("SELECT value FROM meta WHERE key = 'hide_migrated'").get()) {
  // A brand-new database has no users table yet (it is created later); there is nothing to hand over then.
  const haveUsers = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").get();
  const admin = haveUsers ? db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get() : null;
  if (admin) db.prepare('INSERT OR IGNORE INTO hidden_roms (user_id, rom_id) SELECT ?, id FROM roms WHERE hidden = 1').run(admin.id);
  // Only mark done when there really was something to decide: with no admin yet, shared hides (if any) stay for the next start.
  if (admin || !haveUsers) db.prepare("INSERT INTO meta (key, value) VALUES ('hide_migrated', '1') ON CONFLICT(key) DO NOTHING").run();
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '16') ON CONFLICT(key) DO UPDATE SET value = '16'").run();

/* ── v17: tidy web-page codes ("&amp;") that earlier provider matches and name lists left in titles and details. */
if (!db.prepare("SELECT value FROM meta WHERE key = 'entities_cleaned'").get()) {
  const rows = db.prepare("SELECT id, title, developer, publisher, genre, description FROM roms WHERE title LIKE '%&%;%' OR developer LIKE '%&%;%' OR publisher LIKE '%&%;%' OR genre LIKE '%&%;%' OR description LIKE '%&%;%'").all();
  const upd = db.prepare('UPDATE roms SET title = ?, developer = ?, publisher = ?, genre = ?, description = ? WHERE id = ?');
  db.transaction(() => { for (const r of rows) upd.run(decodeEntities(r.title), decodeEntities(r.developer), decodeEntities(r.publisher), decodeEntities(r.genre), decodeEntities(r.description), r.id); })();
  for (const r of db.prepare("SELECT name, title, manufacturer FROM mame_names WHERE title LIKE '%&%;%' OR manufacturer LIKE '%&%;%'").all()) {
    db.prepare('UPDATE mame_names SET title = ?, manufacturer = ? WHERE name = ?').run(decodeEntities(r.title), decodeEntities(r.manufacturer), r.name);
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('entities_cleaned', '1') ON CONFLICT(key) DO NOTHING").run();
}
// The DAT list counts, for every DAT file, the games that matched one of its entries. Without an index on the game's
// dat_entry_id that count scanned the whole library for every entry (tens of seconds on a real collection, and the server
// answers one request at a time, so everything else stalled behind it).
// (The column itself is added by dats.js, which on a brand-new database loads after this file: an existing database gets
// the index here, a new one gets it from dats.js right after the column is created.)
if (db.prepare('PRAGMA table_info(roms)').all().some((c) => c.name === 'dat_entry_id')) {
  db.exec('CREATE INDEX IF NOT EXISTS idx_roms_dat_entry ON roms(dat_entry_id)');
}
/* ── v19: hidden_all — an admin can hide a game from EVERYONE (members cannot see or open it; the admin finds it under Hidden). Personal hiding (hidden_roms) is unchanged. */
if (!db.prepare('PRAGMA table_info(roms)').all().some((c) => c.name === 'hidden_all')) db.exec('ALTER TABLE roms ADD COLUMN hidden_all INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '19') ON CONFLICT(key) DO UPDATE SET value = '19'").run();

/* ── v20: a source can have several folders. A collection is often split across drives; the source keeps its single name and
   platform, its own folder stays in sources.path, and any further folders live here. */
db.exec(`
CREATE TABLE IF NOT EXISTS source_paths (
  id         INTEGER PRIMARY KEY,
  source_id  INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_id, path)
);
CREATE INDEX IF NOT EXISTS idx_source_paths_source ON source_paths(source_id);
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '20') ON CONFLICT(key) DO UPDATE SET value = '20'").run();

/* ── v21: platforms.icon — which pictogram a platform shows (console, handheld, disc, arcade...). NULL = the built-in default for
   that platform (see public/platform-icons.js). */
if (!db.prepare('PRAGMA table_info(platforms)').all().some((c) => c.name === 'icon')) db.exec('ALTER TABLE platforms ADD COLUMN icon TEXT');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '21') ON CONFLICT(key) DO UPDATE SET value = '21'").run();

/* ── v22: an admin's Hide now hides the game from members too, so every game an admin had already hidden for themselves is
   hidden from everyone (admins still see them under Hidden). */
if (Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0) < 22) try {
  db.exec("UPDATE roms SET hidden_all = 1 WHERE hidden_all = 0 AND id IN (SELECT hr.rom_id FROM hidden_roms hr JOIN users u ON u.id = hr.user_id WHERE u.role = 'admin')");
} catch { /* a brand-new database has no users yet: nothing to carry over */ }
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '22') ON CONFLICT(key) DO UPDATE SET value = '22'").run();

/* ── v23: collections belong to the person who made them. Each one gets a user_id; the name is unique per person (two people can
   both have "Favourites"). Collections that already exist go to the oldest admin. The table is rebuilt with foreign keys off, so
   the game links (collection_roms) are not wiped by the drop. */
if (Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0) < 23
    && !db.prepare('PRAGMA table_info(collections)').all().some((c) => c.name === 'user_id')) {
  let owner = null;
  try {   // a brand-new database has no users table yet: nothing to hand over, collections start empty
    owner = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.id
      ?? db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get()?.id ?? null;
  } catch { /* no users yet */ }
  db.pragma('foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE collections_new (
        id          INTEGER PRIMARY KEY,
        user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        description TEXT,
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (user_id, name)
      );`);
    db.prepare('INSERT INTO collections_new (id, user_id, name, description, created_at) SELECT id, ?, name, description, created_at FROM collections').run(owner);
    db.exec('DROP TABLE collections; ALTER TABLE collections_new RENAME TO collections; CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id);');
    db.exec('COMMIT');
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* nothing open */ } throw e; }
  finally { db.pragma('foreign_keys = ON'); }
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '23') ON CONFLICT(key) DO UPDATE SET value = '23'").run();

/* ── v24: a source can hide its games. sources.hide_games is the switch; roms.source_hidden is its mark on each game, kept in step
   (set when the switch is flipped, when a scan adds a game to that source, and cleared if the source is removed). Every list, count and
   search leaves marked games out; flipping the switch back shows them again, nothing is lost. Separate from sources.enabled (scanning). */
if (!db.prepare('PRAGMA table_info(sources)').all().some((c) => c.name === 'hide_games')) db.exec('ALTER TABLE sources ADD COLUMN hide_games INTEGER NOT NULL DEFAULT 0');
if (!db.prepare('PRAGMA table_info(roms)').all().some((c) => c.name === 'source_hidden')) db.exec('ALTER TABLE roms ADD COLUMN source_hidden INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '24') ON CONFLICT(key) DO UPDATE SET value = '24'").run();

/* ── v25: a colour per platform family, used for the family chips (and as the fallback for a platform that has no colour of its own).
   A family is only a label (platforms.family), so its colour lives in its own small table keyed by the family name. */
db.exec(`CREATE TABLE IF NOT EXISTS family_colours (
  family TEXT PRIMARY KEY,
  colour TEXT NOT NULL
)`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '25') ON CONFLICT(key) DO UPDATE SET value = '25'").run();

/* ── v26: platform logos. An admin can upload a picture per platform (nothing is supplied by the system). Kept in the database, like
   profile pictures, so a backup carries them; a separate table so the big picture never rides along with the platform list. */
db.exec(`CREATE TABLE IF NOT EXISTS platform_logos (
  slug    TEXT PRIMARY KEY,
  data    BLOB NOT NULL,
  type    TEXT NOT NULL,
  updated INTEGER NOT NULL
)`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '26') ON CONFLICT(key) DO UPDATE SET value = '26'").run();

/* ── v27: a logo per platform FAMILY (shown in the Library when several platforms of one family are picked; a family such as Arcade can
   carry a generic logo). Same rules as platform logos; keyed by the family name. */
db.exec(`CREATE TABLE IF NOT EXISTS family_logos (
  family  TEXT PRIMARY KEY,
  data    BLOB NOT NULL,
  type    TEXT NOT NULL,
  updated INTEGER NOT NULL
)`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '27') ON CONFLICT(key) DO UPDATE SET value = '27'").run();

/* ── v28: "light backing in dark mode" per logo. A logo drawn in black (many official ones) vanishes on the dark theme; with this set, the
   Library shows it on a light plate when the theme is dark. Off by default; one flag per platform logo and per family logo. */
for (const t of ['platform_logos', 'family_logos']) {
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'plate')) db.exec(`ALTER TABLE ${t} ADD COLUMN plate INTEGER NOT NULL DEFAULT 0`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '28') ON CONFLICT(key) DO UPDATE SET value = '28'").run();

/* ── v29: Digital (owned games from online stores), per person. Steam first. The key is stored encrypted (same scheme as provider keys). ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS digital_accounts (
    user_id INTEGER NOT NULL, store TEXT NOT NULL, steam_id TEXT, key_enc TEXT, last_sync TEXT, last_error TEXT,
    PRIMARY KEY (user_id, store)
  );
  CREATE TABLE IF NOT EXISTS digital_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, store TEXT NOT NULL, app_id TEXT NOT NULL, name TEXT NOT NULL,
    minutes INTEGER NOT NULL DEFAULT 0, last_played INTEGER, img_icon TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_digital_user ON digital_games (user_id, store);
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '29') ON CONFLICT(key) DO UPDATE SET value = '29'").run();

/* ── v30: Digital marks (favourite / hidden / play button on), kept apart from the games list: a refresh replaces the list but keeps these. ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS digital_marks (
    user_id INTEGER NOT NULL, store TEXT NOT NULL, app_id TEXT NOT NULL,
    favourite INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, play INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, store, app_id)
  );
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '30') ON CONFLICT(key) DO UPDATE SET value = '30'").run();

/* ── v31: cached Steam store details (description, developer, genres, screenshots...). Public information, shared by everyone. ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS digital_details (
    store TEXT NOT NULL, app_id TEXT NOT NULL, json TEXT, fetched_at TEXT NOT NULL DEFAULT (datetime('now')), found INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (store, app_id)
  );
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '31') ON CONFLICT(key) DO UPDATE SET value = '31'").run();

/* ── v32: console games in Digital (PlayStation 4 / 5, Xbox), brought in from a CSV. Each game remembers the country of the store it was
   bought from, and the cached details keep the cover picture downloaded for it (Steam's covers come from Steam's own address instead). ── */
if (!db.prepare('PRAGMA table_info(digital_games)').all().some((c) => c.name === 'country')) db.exec('ALTER TABLE digital_games ADD COLUMN country TEXT');
if (!db.prepare('PRAGMA table_info(digital_details)').all().some((c) => c.name === 'cover_path')) db.exec('ALTER TABLE digital_details ADD COLUMN cover_path TEXT');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '32') ON CONFLICT(key) DO UPDATE SET value = '32'").run();


/* ── v33: Xbox games are told apart by console (Xbox, Xbox 360, Xbox One, Xbox Series X|S). Games imported before this have no console until
   the CSV is imported again, which fills it in. ── */
if (!db.prepare('PRAGMA table_info(digital_games)').all().some((c) => c.name === 'platform')) db.exec('ALTER TABLE digital_games ADD COLUMN platform TEXT');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '33') ON CONFLICT(key) DO UPDATE SET value = '33'").run();

/* ── v34: one PlayStation chip. PlayStation 4 and 5 games (stores 'ps4' and 'ps5') move to the one 'playstation' store, each keeping its console as its
   platform; their ids gain the console ("astro-bot" → "astro-bot-ps5") like Xbox's, so a title on both consoles is two games. Marks and the cached
   details move with them. Nintendo needs nothing here: it is new. ── */
mergePlaystationStores();
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '34') ON CONFLICT(key) DO UPDATE SET value = '34'").run();

/* ── v35: console games can be marked as owned on a physical disc or cartridge (a switch on the tile, private to the person like the other marks). ── */
if (!db.prepare('PRAGMA table_info(digital_marks)').all().some((c) => c.name === 'physical')) db.exec('ALTER TABLE digital_marks ADD COLUMN physical INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '35') ON CONFLICT(key) DO UPDATE SET value = '35'").run();

/* ── v36: Physical: games on the shelf (boxed discs, cartridges) with no ROM behind them. Each person's own list, filed under a Library
   platform slug; details and covers come from the same providers as the Library (matched automatically, or picked by hand). ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS physical_games (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, platform TEXT NOT NULL,
    title TEXT NOT NULL, sort_title TEXT NOT NULL, dedupe_key TEXT NOT NULL,
    region TEXT, notes TEXT, release_year INTEGER, developer TEXT, publisher TEXT, genre TEXT, players INTEGER, rating REAL, description TEXT,
    cover_url TEXT, cover_path TEXT, meta_source TEXT, meta_synced_at TEXT, meta_tried_at TEXT,
    favourite INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, platform, dedupe_key)
  );
  CREATE INDEX IF NOT EXISTS idx_physical_user ON physical_games (user_id, platform);
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '36') ON CONFLICT(key) DO UPDATE SET value = '36'").run();

/* ── v37: Physical games can carry a spine picture (from the LaunchBox database) for the shelf view. ── */
for (const [col, type] of [['spine_url', 'TEXT'], ['spine_path', 'TEXT'], ['spine_tried_at', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE physical_games ADD COLUMN ${col} ${type}`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '37') ON CONFLICT(key) DO UPDATE SET value = '37'").run();

/* ── v38: the shape (width / height) of a Physical game's cover and spine pictures, so the shelf can size a spine and a pulled-out cover exactly. ── */
for (const col of ['cover_ar', 'spine_ar']) {
  if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE physical_games ADD COLUMN ${col} REAL`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '38') ON CONFLICT(key) DO UPDATE SET value = '38'").run();

/* ── v39: a person's own corrections to a console game's details (a hand match from the identify search, or edits), kept apart from the
   cached details everyone shares, so one person's change never alters another's list. ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS digital_user_meta (
    user_id INTEGER NOT NULL, store TEXT NOT NULL, app_id TEXT NOT NULL, json TEXT, cover_path TEXT, source TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, store, app_id)
  );
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '39') ON CONFLICT(key) DO UPDATE SET value = '39'").run();

/* ── v40: Messages: a private one-to-one chat (each message can be deleted by either person for themselves, and recalled by its sender for a few minutes), and notices from
   the admin to everyone. See src/lib/messages.js for the rules. ── */
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, sender_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
    body TEXT NOT NULL DEFAULT '', game TEXT, reply_to INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), read_at TEXT, recalled_at TEXT,
    del_sender INTEGER NOT NULL DEFAULT 0, del_recipient INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages (recipient_id, read_at);
  CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages (sender_id, recipient_id);
  CREATE TABLE IF NOT EXISTS notices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, author_id INTEGER, body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT
  );
  CREATE TABLE IF NOT EXISTS notice_state (
    user_id INTEGER NOT NULL, notice_id INTEGER NOT NULL, read_at TEXT, dismissed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, notice_id)
  );
`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '40') ON CONFLICT(key) DO UPDATE SET value = '40'").run();

/* ── v41: a notice can be meant for the admins only ('admins'), such as "a new game-sauce is available". The default, 'all', is what an admin's own notices are. ── */
if (!db.prepare('PRAGMA table_info(notices)').all().some((c) => c.name === 'audience')) db.exec("ALTER TABLE notices ADD COLUMN audience TEXT NOT NULL DEFAULT 'all'");
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '41') ON CONFLICT(key) DO UPDATE SET value = '41'").run();

/** Move any 'ps4' / 'ps5' Digital rows to the one 'playstation' store (safe to run again: it does nothing when none are left). */
export function mergePlaystationStores() {
  db.transaction(() => {
    for (const old of ['ps4', 'ps5']) {
      db.prepare(`UPDATE digital_games SET platform = ?, app_id = app_id || '-' || ?, store = 'playstation' WHERE store = ?`).run(old, old, old);
      db.prepare(`UPDATE OR IGNORE digital_marks SET app_id = app_id || '-' || ?, store = 'playstation' WHERE store = ?`).run(old, old);
      db.prepare(`DELETE FROM digital_marks WHERE store = ?`).run(old);
      db.prepare(`UPDATE OR IGNORE digital_details SET app_id = app_id || '-' || ?, store = 'playstation' WHERE store = ?`).run(old, old);
      db.prepare(`DELETE FROM digital_details WHERE store = ?`).run(old);
    }
  })();
}

/* ── v42: platforms.badge — the text on that platform's cover badges and chips, when an admin wants something other than the default (Settings > Platforms). NULL = the default. ── */
if (!db.prepare('PRAGMA table_info(platforms)').all().some((c) => c.name === 'badge')) db.exec('ALTER TABLE platforms ADD COLUMN badge TEXT');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '42') ON CONFLICT(key) DO UPDATE SET value = '42'").run();

/* ── v43: Physical games can carry a disc picture (from the LaunchBox database) for the open case on the shelf. ── */
for (const [col, type] of [['disc_url', 'TEXT'], ['disc_path', 'TEXT'], ['disc_tried_at', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE physical_games ADD COLUMN ${col} ${type}`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '43') ON CONFLICT(key) DO UPDATE SET value = '43'").run();

/* ── v44: a Physical game can have a manual: a web link, or a file the person uploaded (src/lib/manuals.js). ── */
for (const [col, type] of [['manual_link', 'TEXT'], ['manual_path', 'TEXT'], ['manual_name', 'TEXT']]) {
  if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE physical_games ADD COLUMN ${col} ${type}`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '44') ON CONFLICT(key) DO UPDATE SET value = '44'").run();

/* ── v45: a cover a person uploaded for a Physical game is kept (cover_locked): a later automatic match does not replace it. Picking a match by hand does. ── */
if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === 'cover_locked')) db.exec('ALTER TABLE physical_games ADD COLUMN cover_locked INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '45') ON CONFLICT(key) DO UPDATE SET value = '45'").run();

/* ── v46: a spine or disc picture a person uploaded is kept too (spine_locked, disc_locked): the background lookups never replace it. ── */
for (const col of ['spine_locked', 'disc_locked']) {
  if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE physical_games ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '46') ON CONFLICT(key) DO UPDATE SET value = '46'").run();

/* ── v47: a Physical game can carry the back of its case (an upload, a folder import, or cut from a full wrap): shown when the case on the shelf is turned over. ── */
for (const [col, type] of [['back_url', 'TEXT'], ['back_path', 'TEXT'], ['back_tried_at', 'TEXT'], ['back_locked', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE physical_games ADD COLUMN ${col} ${type}`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '47') ON CONFLICT(key) DO UPDATE SET value = '47'").run();

/* ── v48: a Physical Xbox One / Series disc can have a counterpart in Digital. digital_app_id is that Digital game; digital_made says the shelf
   created it (so taking the disc off the shelf takes it out of Digital too; a Digital game that was already there is only marked, never removed). ── */
for (const [col, type] of [['digital_app_id', 'TEXT'], ['digital_made', 'INTEGER NOT NULL DEFAULT 0']]) {
  if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE physical_games ADD COLUMN ${col} ${type}`);
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '48') ON CONFLICT(key) DO UPDATE SET value = '48'").run();

/* ── v49: digital_off: a person untoggled this disc's Digital counterpart, so adding or importing discs never switches it back on by itself. ── */
if (!db.prepare('PRAGMA table_info(physical_games)').all().some((c) => c.name === 'digital_off')) db.exec('ALTER TABLE physical_games ADD COLUMN digital_off INTEGER NOT NULL DEFAULT 0');
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '49') ON CONFLICT(key) DO UPDATE SET value = '49'").run();

/* ── v50: videos kept for games (src/lib/emumovies.js): one per platform and title, shared by everyone who has that game. path NULL = looked for and not found (asked again after a week). ── */
db.exec(`CREATE TABLE IF NOT EXISTS game_videos (
  platform TEXT NOT NULL, title_key TEXT NOT NULL, path TEXT, bytes INTEGER, source TEXT, fetched_at TEXT, tried_at TEXT,
  PRIMARY KEY (platform, title_key)
)`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '50') ON CONFLICT(key) DO UPDATE SET value = '50'").run();

/* ── v52: extra files for a Library game beyond its cover: a spine, a disc, a back and a manual (src/lib/romfiles.js), brought in by the picture importer. ── */
db.exec(`CREATE TABLE IF NOT EXISTS rom_files (
  rom_id INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE, kind TEXT NOT NULL, path TEXT NOT NULL, name TEXT, type TEXT, bytes INTEGER,
  PRIMARY KEY (rom_id, kind)
)`);
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '52') ON CONFLICT(key) DO UPDATE SET value = '52'").run();

/* ── v53: ScreenScraper media links stored by earlier builds may carry the credentials of whoever asked: they are taken out, once (src/lib/ssscrub.js). ── */
if (!db.prepare("SELECT 1 FROM meta WHERE key = 'ss_links_scrubbed'").get()) {
  scrubStoredSsLinks(db);
  db.prepare("INSERT INTO meta (key, value) VALUES ('ss_links_scrubbed', '1')").run();
}
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '53') ON CONFLICT(key) DO UPDATE SET value = '53'").run();

/* ── v54: ScreenScraper's number for the Xbox 360 is 33 (the stored 56 searched another system, so no Xbox 360 game matched). Only a value still at the old built-in 56 is changed; one an admin set is left. ── */
db.prepare("UPDATE platforms SET screenscraper_id = 33 WHERE slug = 'xbox360' AND screenscraper_id = 56").run();
db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '54') ON CONFLICT(key) DO UPDATE SET value = '54'").run();

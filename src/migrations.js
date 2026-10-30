import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';

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

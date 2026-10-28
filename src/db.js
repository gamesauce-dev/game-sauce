import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.GAMESAUCE_DATA_DIR || path.resolve('data');
const DB_FILE = process.env.GAMESAUCE_DB_FILE || path.join(DATA_DIR, 'gamesauce.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_FILE);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS platforms (
  id           INTEGER PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  short_name   TEXT NOT NULL,
  manufacturer TEXT,
  generation   INTEGER,
  accent       TEXT NOT NULL DEFAULT '#6b7280',
  family       TEXT,
  screenscraper_id INTEGER,
  tgdb_id      INTEGER,
  extensions   TEXT
);

CREATE TABLE IF NOT EXISTS roms (
  id             INTEGER PRIMARY KEY,
  platform_id    INTEGER NOT NULL REFERENCES platforms(id) ON DELETE RESTRICT,
  title          TEXT NOT NULL,
  sort_title     TEXT NOT NULL,
  filename       TEXT NOT NULL,
  storage_path   TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  region         TEXT,
  revision       TEXT,
  release_year   INTEGER,
  developer      TEXT,
  publisher      TEXT,
  genre          TEXT,
  players        INTEGER,
  rating         REAL,
  description    TEXT,
  cover_url      TEXT,
  cover_path     TEXT,
  crc32          TEXT,
  md5            TEXT,
  sha1           TEXT,
  meta_source    TEXT,
  meta_synced_at TEXT,
  favorite       INTEGER NOT NULL DEFAULT 0,
  play_count     INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (sha1)
);

-- Sources must exist before roms.source_id is added by migrations, because
-- SQLite resolves the REFERENCES clause when the ALTER TABLE runs.
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

CREATE INDEX IF NOT EXISTS idx_roms_platform ON roms(platform_id);
CREATE INDEX IF NOT EXISTS idx_roms_sort ON roms(sort_title);
CREATE INDEX IF NOT EXISTS idx_roms_title ON roms(title);

CREATE TABLE IF NOT EXISTS collections (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS collection_roms (
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  rom_id        INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE,
  added_at      TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (collection_id, rom_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS rom_tags (
  rom_id INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (rom_id, tag_id)
);

CREATE TABLE IF NOT EXISTS downloads (
  id         INTEGER PRIMARY KEY,
  rom_id     INTEGER NOT NULL REFERENCES roms(id) ON DELETE CASCADE,
  bytes      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS roms_fts USING fts5(
  title, developer, publisher, genre, description,
  content='roms', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS roms_ai AFTER INSERT ON roms BEGIN
  INSERT INTO roms_fts(rowid, title, developer, publisher, genre, description)
  VALUES (new.id, new.title, new.developer, new.publisher, new.genre, new.description);
END;

CREATE TRIGGER IF NOT EXISTS roms_ad AFTER DELETE ON roms BEGIN
  INSERT INTO roms_fts(roms_fts, rowid, title, developer, publisher, genre, description)
  VALUES ('delete', old.id, old.title, old.developer, old.publisher, old.genre, old.description);
END;

CREATE TRIGGER IF NOT EXISTS roms_au AFTER UPDATE ON roms BEGIN
  INSERT INTO roms_fts(roms_fts, rowid, title, developer, publisher, genre, description)
  VALUES ('delete', old.id, old.title, old.developer, old.publisher, old.genre, old.description);
  INSERT INTO roms_fts(rowid, title, developer, publisher, genre, description)
  VALUES (new.id, new.title, new.developer, new.publisher, new.genre, new.description);
END;
`);

export default db;

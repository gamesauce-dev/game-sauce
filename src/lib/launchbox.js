// LaunchBox Games Database: a local, key-free metadata source.
//
// LaunchBox publishes its whole database as one public download (Metadata.zip, ~110 MB, a ~500 MB XML inside).
// The admin presses "Download / update" in Settings; the server downloads it once, streams the XML through a
// parser (never loading it into memory) and keeps a compact SQLite index of only the platforms this app knows.
// A lookup is then a local query: no network, no quota, no key. Cover images are links on LaunchBox's image
// server; the app caches each cover it actually uses, like it does for every other provider.
//
// Matching is by NAME only and only exact: the game's name or one of its alternate names, ignoring case,
// punctuation and "the", with roman numerals read as digits. A loose match would hand a sequel's data to the
// original game, so anything that is not the same title is left for the next provider or manual matching.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { Parser } from 'saxen';

const dataDir = () => process.env.GAMESAUCE_DATA_DIR || path.resolve('data');
const lbDir = () => path.join(dataDir(), 'launchbox');
const dbFile = () => path.join(lbDir(), 'launchbox.db');
const DEFAULT_URL = 'https://gamesdb.launchbox-app.com/Metadata.zip';
const IMAGE_BASE = 'https://images.launchbox-app.com/';

/** App platform slug -> the platform name(s) LaunchBox uses for it. */
export const LB_PLATFORMS = {
  nes: ['Nintendo Entertainment System'], snes: ['Super Nintendo Entertainment System'], n64: ['Nintendo 64'],
  gamecube: ['Nintendo GameCube'], wii: ['Nintendo Wii'], wiiu: ['Nintendo Wii U'], switch: ['Nintendo Switch'],
  switch2: ['Nintendo Switch 2'], gb: ['Nintendo Game Boy'], gbc: ['Nintendo Game Boy Color'],
  gba: ['Nintendo Game Boy Advance'], nds: ['Nintendo DS'], '3ds': ['Nintendo 3DS'], virtualboy: ['Nintendo Virtual Boy'],
  pokemonmini: ['Nintendo Pokemon Mini'],
  ps1: ['Sony Playstation'], ps2: ['Sony Playstation 2'], ps3: ['Sony Playstation 3'], ps4: ['Sony Playstation 4'],
  ps5: ['Sony Playstation 5'], psp: ['Sony PSP'], psvita: ['Sony Playstation Vita'],
  xbox: ['Microsoft Xbox'], xbox360: ['Microsoft Xbox 360'], xboxone: ['Microsoft Xbox One'],
  xboxseries: ['Microsoft Xbox Series X/S'],
  genesis: ['Sega Genesis'], mastersystem: ['Sega Master System'], gamegear: ['Sega Game Gear'], segacd: ['Sega CD'],
  sega32x: ['Sega 32X'], saturn: ['Sega Saturn'], dreamcast: ['Sega Dreamcast'], segamodel2: ['Sega Model 2'],
  segamodel3: ['Sega Model 3'], naomi: ['Sega Naomi'], atomiswave: ['Sammy Atomiswave'],
  atari2600: ['Atari 2600'], atari5200: ['Atari 5200'], atari7800: ['Atari 7800'], lynx: ['Atari Lynx'], jaguar: ['Atari Jaguar'],
  turbografx16: ['NEC TurboGrafx-16'], pcenginecd: ['NEC TurboGrafx-CD'],
  neogeo: ['SNK Neo Geo AES', 'SNK Neo Geo MVS', 'SNK Neo Geo CD'], neogeopocket: ['SNK Neo Geo Pocket Color', 'SNK Neo Geo Pocket'],
  wonderswan: ['WonderSwan Color', 'WonderSwan'], '3do': ['3DO Interactive Multiplayer'], cdi: ['Philips CD-i'],
  arcade: ['Arcade'], mame: ['Arcade'], fba: ['Arcade'], cps1: ['Arcade'], cps2: ['Arcade'], cps3: ['Arcade'], coinop: ['Arcade'],
  scummvm: ['ScummVM'], dos: ['MS-DOS']
};
const KNOWN_PLATFORMS = new Set(Object.values(LB_PLATFORMS).flat());

/* Name keys. Stored at import and used at lookup from this one file, so they always agree. */
const ROMAN = { ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, v: 5 };
const romanToDigits = (t) => String(t || '').toLowerCase().replace(/\b(viii|vii|iii|ii|iv|vi|ix|v)\b/g, (m) => String(ROMAN[m]));
const keyOf = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
const keysOf = (t) => ({ norm: keyOf(t), rnorm: keyOf(romanToDigits(t)) });

/* ───────────────────────── the local index ───────────────────────── */

let conn = null;
function open() {
  if (conn) return conn;
  if (!fs.existsSync(dbFile())) return null;
  try { conn = new Database(dbFile(), { readonly: true, fileMustExist: true }); } catch { conn = null; }
  return conn;
}
function closeIndex() { try { conn?.close(); } catch { /* already closed */ } conn = null; }

export function launchboxReady() {
  const c = open();
  if (!c) return false;
  try { return c.prepare('SELECT COUNT(*) AS n FROM games').get().n > 0; } catch { return false; }
}

const metaGet = (c, k) => { try { return c.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null; } catch { return null; } };

const toRecord = (g) => ({
  title: g.name,
  developer: g.developer || null,
  publisher: g.publisher || null,
  genre: g.genres || null,
  release_year: g.year || null,
  players: g.players || null,
  rating: g.rating || null,
  description: g.overview || null,
  cover_url: g.cover ? IMAGE_BASE + g.cover : null,
  has_cover: Boolean(g.cover),
  media: { ...(g.cover ? { box2d: IMAGE_BASE + g.cover } : {}), ...(g.shot ? { screenshot: IMAGE_BASE + g.shot } : {}) },
  game_id: String(g.id),
  source: 'launchbox'
});

/**
 * Find the game whose name (or alternate name) is exactly one of `titles` (tried in order, most specific first).
 * Several entries with the same name (regional releases): the nearest year when one is known, then the one with a cover.
 */
export function launchboxFind(titles, slug, year = null) {
  const c = open();
  const plats = LB_PLATFORMS[slug];
  if (!c || !plats) return null;
  const marks = plats.map(() => '?').join(',');
  const direct = c.prepare(`SELECT * FROM games WHERE platform IN (${marks}) AND (norm = ? OR rnorm = ?)`);
  const alt = c.prepare(`SELECT g.* FROM alt a JOIN games g ON g.id = a.game_id WHERE g.platform IN (${marks}) AND (a.norm = ? OR a.rnorm = ?)`);
  const y = Number(year) || null;
  for (const t of titles) {
    const { norm, rnorm } = keysOf(t);
    if (norm.length < 2) continue;
    const rows = [
      ...direct.all(...plats, norm, rnorm).map((g) => ({ g, tier: g.norm === norm ? 0 : 1 })),
      ...alt.all(...plats, norm, rnorm).map((g) => ({ g, tier: 2 }))
    ];
    if (!rows.length) continue;
    // Same name, several releases: the one from the year we already know first (a wrong game's cover is worse than
    // none), then the one with a cover.
    rows.sort((a, b) => a.tier - b.tier
      || (y ? Math.abs((a.g.year || 9999) - y) - Math.abs((b.g.year || 9999) - y) : 0)
      || (b.g.cover ? 1 : 0) - (a.g.cover ? 1 : 0)
      || a.g.id - b.g.id);
    return { ...toRecord(rows[0].g), matched_query: t };
  }
  return null;
}

/** Name search for manual matching: games whose name contains the text, exact and prefix matches first. */
export function launchboxSearch(query, slug = null) {
  const c = open();
  if (!c) return { error: 'The LaunchBox database has not been downloaded yet (Settings → Metadata providers).', items: [] };
  const { norm } = keysOf(query);
  if (norm.length < 2) return { items: [] };
  const plats = slug && LB_PLATFORMS[slug] ? LB_PLATFORMS[slug] : null;
  const where = plats ? `platform IN (${plats.map(() => '?').join(',')}) AND ` : '';
  const rows = c.prepare(`SELECT * FROM games WHERE ${where}norm LIKE ? ESCAPE '\\' LIMIT 200`)
    .all(...(plats || []), `%${norm.replace(/[%_\\]/g, '\\$&')}%`);
  rows.sort((a, b) => (a.norm === norm ? 0 : a.norm.startsWith(norm) ? 1 : 2) - (b.norm === norm ? 0 : b.norm.startsWith(norm) ? 1 : 2)
    || (b.cover ? 1 : 0) - (a.cover ? 1 : 0) || a.norm.length - b.norm.length);
  return { items: rows.slice(0, 10).map((g) => ({ ...toRecord(g), platform_id: slug, matched_query: query })) };
}

/* ───────────────────────── reading the zip ───────────────────────── */

/** Open one file inside a .zip as a stream, without unpacking the rest. Handles stored and deflated entries. */
export async function openZipEntry(zipPath, wanted) {
  const fh = await fs.promises.open(zipPath, 'r');
  try {
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('This does not look like a zip file');
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff) throw new Error('Zip64 archives are not supported');
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOffset);
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      const method = cd.readUInt16LE(p + 10);
      const csize = cd.readUInt32LE(p + 20);
      const usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
      p += 46 + nameLen + extraLen + commentLen;
      if (path.posix.basename(name).toLowerCase() !== wanted.toLowerCase()) continue;
      const local = Buffer.alloc(30);
      await fh.read(local, 0, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('The zip file is damaged');
      const start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      const raw = fs.createReadStream(zipPath, { start, end: start + Math.max(csize, 1) - 1 });
      if (method === 0) return { stream: raw, size: usize };
      if (method !== 8) throw new Error(`Unsupported zip compression (${method})`);
      const inflate = zlib.createInflateRaw();
      raw.on('error', (e) => inflate.destroy(e));
      return { stream: raw.pipe(inflate), size: usize };
    }
    throw new Error(`${wanted} is not inside the zip`);
  } finally {
    await fh.close();
  }
}

/* ───────────────────────── importing ───────────────────────── */

const REGION_RANK = { 'North America': 0, 'United States': 1, World: 2, Europe: 3, 'United Kingdom': 4, Australia: 5 };
const regionRank = (r) => (r in REGION_RANK ? REGION_RANK[r] : 9);
const COVER_TYPES = { 'Box - Front': 0, 'Box - Front - Reconstructed': 1 };

/**
 * Stream LaunchBox's Metadata.xml into a fresh index file, then swap it in. `xml` is a readable stream of the XML text.
 * Progress is reported as a 0-100 number from how much of `totalBytes` has been read.
 */
export async function importLaunchBox(xml, { totalBytes = 0, onProgress = () => {}, sourceModified = null } = {}) {
  fs.mkdirSync(lbDir(), { recursive: true });
  const tmp = `${dbFile()}.new`;
  for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) { try { fs.rmSync(f, { force: true }); } catch { /* none */ } }
  const out = new Database(tmp);
  out.pragma('journal_mode = OFF');
  out.pragma('synchronous = OFF');
  out.exec(`
    CREATE TABLE games (id INTEGER PRIMARY KEY, platform TEXT NOT NULL, name TEXT NOT NULL, norm TEXT, rnorm TEXT, year INTEGER,
      overview TEXT, genres TEXT, developer TEXT, publisher TEXT, players TEXT, rating REAL, cover TEXT, shot TEXT);
    CREATE TABLE alt (game_id INTEGER NOT NULL, norm TEXT, rnorm TEXT);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `);
  const insGame = out.prepare('INSERT OR IGNORE INTO games (id, platform, name, norm, rnorm, year, overview, genres, developer, publisher, players, rating) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
  const insAlt = out.prepare('INSERT INTO alt (game_id, norm, rnorm) VALUES (?,?,?)');
  out.exec('BEGIN');

  const ids = new Set();
  const covers = new Map(); // id -> { rank, file }
  const shots = new Map();  // id -> file
  let games = 0, alts = 0, ctx = null, rec = null, field = null, buf = '';
  const parser = new Parser();

  parser.on('openTag', (name) => {
    if (name === 'Game' || name === 'GameAlternateName' || name === 'GameImage') { ctx = name; rec = {}; field = null; }
    else if (ctx) { field = name; buf = ''; }
  });
  parser.on('text', (value, decode) => { if (ctx && field) buf += decode(value); });
  parser.on('closeTag', (name) => {
    if (!ctx) return;
    if (name !== ctx) { if (field === name) { rec[name] = buf.trim(); field = null; } return; }
    const id = Number(rec.DatabaseID);
    if (ctx === 'Game') {
      if (rec.Name && id && KNOWN_PLATFORMS.has(rec.Platform)) {
        const { norm, rnorm } = keysOf(rec.Name);
        const year = Number(rec.ReleaseYear || String(rec.ReleaseDate || '').slice(0, 4)) || null;
        const rating = Number(rec.CommunityRating) || null;
        const players = Number(rec.MaxPlayers) > 0 ? String(Number(rec.MaxPlayers)) : null;
        insGame.run(id, rec.Platform, rec.Name, norm, rnorm, year, rec.Overview || null,
          (rec.Genres || '').split(';').map((s) => s.trim()).filter(Boolean).join(', ') || null,
          rec.Developer || null, rec.Publisher || null, players, rating ? Math.round(rating * 10) / 10 : null);
        ids.add(id);
        games++;
      }
    } else if (ctx === 'GameAlternateName') {
      if (ids.has(id) && rec.AlternateName) { const k = keysOf(rec.AlternateName); insAlt.run(id, k.norm, k.rnorm); alts++; }
    } else if (ctx === 'GameImage') {
      if (ids.has(id) && rec.FileName) {
        if (rec.Type in COVER_TYPES) {
          const rank = COVER_TYPES[rec.Type] * 10 + regionRank(rec.Region);
          const cur = covers.get(id);
          if (!cur || rank < cur.rank) covers.set(id, { rank, file: rec.FileName });
        } else if (rec.Type === 'Screenshot - Gameplay' && !shots.has(id)) shots.set(id, rec.FileName);
      }
    }
    ctx = null; rec = null; field = null;
  });

  let read = 0, lastPct = -1;
  try {
    await new Promise((resolve, reject) => {
      xml.setEncoding('utf8');
      xml.on('data', (chunk) => {
        try {
          parser.write(chunk);
          read += Buffer.byteLength(chunk);
          if (totalBytes) {
            const pct = Math.min(99, Math.floor((read / totalBytes) * 100));
            if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
          }
        } catch (err) { xml.destroy(err); }
      });
      xml.on('error', reject);
      xml.on('end', () => { try { parser.end(); resolve(); } catch (err) { reject(err); } });
    });

    const setCover = out.prepare('UPDATE games SET cover = ? WHERE id = ?');
    const setShot = out.prepare('UPDATE games SET shot = ? WHERE id = ?');
    for (const [id, c] of covers) setCover.run(c.file, id);
    for (const [id, f] of shots) setShot.run(f, id);
    out.exec('COMMIT');
    if (!games) throw new Error('No games were found in the download. Is it the LaunchBox Metadata file?');
    out.exec(`
      CREATE INDEX games_norm ON games (platform, norm);
      CREATE INDEX games_rnorm ON games (platform, rnorm);
      CREATE INDEX alt_norm ON alt (norm);
      CREATE INDEX alt_rnorm ON alt (rnorm);
    `);
    const put = out.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
    put.run('imported_at', new Date().toISOString());
    put.run('games', String(games));
    put.run('alts', String(alts));
    put.run('covers', String(covers.size));
    if (sourceModified) put.run('source_modified', sourceModified);
    out.close();
  } catch (err) {
    try { out.close(); } catch { /* already closed */ }
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) { try { fs.rmSync(f, { force: true }); } catch { /* none */ } }
    throw err;
  }
  closeIndex(); // release the old file before it is replaced
  fs.renameSync(tmp, dbFile());
  return { games, alts, covers: covers.size };
}

/* ───────────────────────── the update job ───────────────────────── */

const job = { state: 'idle', message: '', pct: 0, started_at: null, finished_at: null, error: null };
const setJob = (patch) => Object.assign(job, patch);

export function launchboxStatus() {
  const c = open();
  const base = { url: process.env.GAMESAUCE_LAUNCHBOX_URL || DEFAULT_URL, job: { ...job } };
  if (!c) return { ...base, available: false };
  let size = 0; try { size = fs.statSync(dbFile()).size; } catch { /* gone */ }
  return {
    ...base,
    available: launchboxReady(),
    games: Number(metaGet(c, 'games') || 0),
    alts: Number(metaGet(c, 'alts') || 0),
    covers: Number(metaGet(c, 'covers') || 0),
    imported_at: metaGet(c, 'imported_at'),
    source_modified: metaGet(c, 'source_modified'),
    bytes: size
  };
}

/** Download the database and index it, in the background. Returns { started: false } when one is already running. */
export function startLaunchBoxUpdate() {
  if (job.state === 'downloading' || job.state === 'importing') return { started: false };
  setJob({ state: 'downloading', message: 'Downloading the LaunchBox database…', pct: 0, started_at: new Date().toISOString(), finished_at: null, error: null });
  const zipPath = path.join(lbDir(), 'Metadata.zip.part');
  (async () => {
    try {
      fs.mkdirSync(lbDir(), { recursive: true });
      const res = await fetch(process.env.GAMESAUCE_LAUNCHBOX_URL || DEFAULT_URL, { headers: { 'User-Agent': 'game-sauce' } });
      if (!res.ok || !res.body) throw new Error(`LaunchBox answered HTTP ${res.status}`);
      const total = Number(res.headers.get('content-length')) || 0;
      let got = 0;
      const src = Readable.fromWeb(res.body);
      src.on('data', (b) => { got += b.length; if (total) setJob({ pct: Math.min(99, Math.floor((got / total) * 100)), message: `Downloading… ${(got / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB` }); });
      await pipeline(src, fs.createWriteStream(zipPath));
      setJob({ state: 'importing', pct: 0, message: 'Reading the database (a few minutes)…' });
      const { stream, size } = await openZipEntry(zipPath, 'Metadata.xml');
      const result = await importLaunchBox(stream, {
        totalBytes: size,
        sourceModified: res.headers.get('last-modified'),
        onProgress: (pct) => setJob({ pct, message: `Reading the database… ${pct}%` })
      });
      setJob({ state: 'done', pct: 100, finished_at: new Date().toISOString(), message: `Ready: ${result.games.toLocaleString()} games indexed.` });
    } catch (err) {
      setJob({ state: 'error', finished_at: new Date().toISOString(), error: String(err.message || err), message: `Failed: ${err.message || err}` });
    } finally {
      try { fs.rmSync(zipPath, { force: true }); } catch { /* none */ }
    }
  })();
  return { started: true };
}

/** Test helper: forget the open index and the job state. */
export function _resetLaunchBox() { closeIndex(); Object.assign(job, { state: 'idle', message: '', pct: 0, started_at: null, finished_at: null, error: null }); }

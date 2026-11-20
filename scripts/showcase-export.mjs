// Read-only: picks a spread of games that have a cover (a few from every platform, plus some of the Physical shelf and Digital) and copies their
// details and cover pictures into one folder, so they can be used to take screenshots and videos for the website.
// Nothing about people is copied: no accounts, passwords, keys, file paths on the server, or ROM files. The database is opened read-only.
//   node showcase-export.mjs [out-folder] [games-per-platform]
//   On the Proxmox host:  pct exec 100 -- runuser -u gamesauce -- env GAMESAUCE_DATA_DIR=/var/lib/game-sauce/data node /opt/game-sauce/showcase-export.mjs /tmp/showcase 14
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(process.argv[2] || 'showcase');
const PER = Math.max(1, Number(process.argv[3]) || 14);
const DATA_DIR = process.env.GAMESAUCE_DATA_DIR || path.resolve('data');
const FILE = process.env.GAMESAUCE_DB_FILE || path.join(DATA_DIR, 'gamesauce.db');
if (!fs.existsSync(FILE)) { console.log('No database at', FILE, '(set GAMESAUCE_DATA_DIR to the data folder)'); process.exit(1); }
const db = new Database(FILE, { readonly: true, fileMustExist: true });
const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);

fs.mkdirSync(path.join(OUT, 'media'), { recursive: true });
let copied = 0, bytes = 0;
const taken = new Map();
/** Copy a picture into media/ (once) and return its name there, or null if it is not a file. */
function take(file) {
  if (!file || typeof file !== 'string') return null;
  if (taken.has(file)) return taken.get(file);
  let name = null;
  try {
    if (fs.statSync(file).isFile()) {
      name = 'media/' + String(taken.size + 1).padStart(4, '0') + path.extname(file).toLowerCase();
      fs.copyFileSync(file, path.join(OUT, name));
      copied++; bytes += fs.statSync(file).size;
    }
  } catch { /* a picture that is gone is skipped */ }
  taken.set(file, name);
  return name;
}

const out = { made: new Date().toISOString().slice(0, 10), roms: [], physical: [], digital: [] };

// Games: for each platform, the best-described ones that have a cover (a description and a year first, then the better rated).
for (const p of db.prepare('SELECT id, slug, name, family FROM platforms').all()) {
  const rows = db.prepare(`SELECT title, region, release_year, developer, publisher, genre, players, rating, description, cover_path, favorite
    FROM roms WHERE platform_id = ? AND cover_path IS NOT NULL AND cover_path <> '' AND hidden = 0 AND missing = 0 AND is_system = 0
    ORDER BY (description IS NOT NULL AND description <> '') DESC, (release_year IS NOT NULL) DESC, rating DESC, title LIMIT ?`).all(p.id, PER * 3);
  let n = 0;
  for (const r of rows) {
    if (n >= PER) break;
    const cover = take(r.cover_path); if (!cover) continue;
    out.roms.push({ platform: p.slug, platform_name: p.name, family: p.family, title: r.title, region: r.region, year: r.release_year, developer: r.developer, publisher: r.publisher, genre: r.genre, players: r.players, rating: r.rating, description: r.description, favorite: r.favorite ? 1 : 0, cover });
    n++;
  }
}

// The Physical shelf: games with a cover, and the spine picture where there is one (from every person's shelf, without saying whose).
if (has('physical_games')) {
  for (const r of db.prepare(`SELECT platform, title, region, release_year, cover_path, spine_path FROM physical_games WHERE cover_path IS NOT NULL AND cover_path <> '' ORDER BY (spine_path IS NOT NULL AND spine_path <> '') DESC, title LIMIT ?`).all(PER * 5)) {
    const cover = take(r.cover_path); if (!cover) continue;
    out.physical.push({ platform: r.platform, title: r.title, region: r.region, year: r.release_year, cover, spine: take(r.spine_path) });
  }
}

// Digital: Steam and console games with a cover picture.
if (has('digital_games') && has('digital_details')) {
  for (const r of db.prepare(`SELECT g.store, g.platform, g.name, g.minutes, d.cover_path FROM digital_games g JOIN digital_details d ON d.store = g.store AND d.app_id = g.app_id
    WHERE d.cover_path IS NOT NULL AND d.cover_path <> '' ORDER BY g.minutes DESC LIMIT ?`).all(PER * 3)) {
    const cover = take(r.cover_path); if (!cover) continue;
    out.digital.push({ store: r.store, platform: r.platform, name: r.name, minutes: r.minutes, cover });
  }
}

fs.writeFileSync(path.join(OUT, 'showcase.json'), JSON.stringify(out, null, 1));
const perPlat = {}; for (const r of out.roms) perPlat[r.platform] = (perPlat[r.platform] || 0) + 1;
console.log(`wrote ${OUT}: ${out.roms.length} games on ${Object.keys(perPlat).length} platforms, ${out.physical.length} on the shelf, ${out.digital.length} digital; ${copied} pictures, ${(bytes / 1048576).toFixed(1)} MB`);
console.log('platforms:', Object.entries(perPlat).map(([k, v]) => `${k} ${v}`).join(', '));

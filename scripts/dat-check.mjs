// Read-only: why does a DAT not match my arcade games? Prints what the matcher sees.
//   node scripts/dat-check.mjs                      (the data folder is GAMESAUCE_DATA_DIR, as the app uses; or GAMESAUCE_DB_FILE)
//   On the Proxmox host:  pct exec 100 -- runuser -u gamesauce -- env GAMESAUCE_DATA_DIR=/var/lib/game-sauce/data node /opt/game-sauce/scripts/dat-check.mjs
// Nothing is written. It opens the database read-only.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.GAMESAUCE_DATA_DIR || path.resolve('data');
const FILE = process.env.GAMESAUCE_DB_FILE || path.join(DATA_DIR, 'gamesauce.db');
if (!fs.existsSync(FILE)) { console.log('No database at', FILE, '(set GAMESAUCE_DATA_DIR to the data folder)'); process.exit(1); }
const db = new Database(FILE, { readonly: true, fileMustExist: true });
const one = (sql, ...a) => db.prepare(sql).get(...a);
const all = (sql, ...a) => db.prepare(sql).all(...a);
const has = (t) => !!one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t);
const ARCADE = ['mame', 'neogeo', 'cps1', 'cps2', 'cps3', 'naomi', 'atomiswave', 'fba', 'arcade', 'coinop'];

console.log('database:', FILE);
console.log('schema version:', one("SELECT value FROM meta WHERE key = 'schema_version'")?.value);
if (!has('dat_sets')) { console.log('\nNo dat_sets table: this copy of game-sauce is not the version that matches arcade games by name yet. Update it first.'); process.exit(0); }

console.log('\nDAT files:');
for (const d of all('SELECT d.id, d.name, d.platform_slug, d.entries, (SELECT COUNT(*) FROM dat_sets s WHERE s.datfile_id = d.id) AS sets FROM datfiles d ORDER BY d.id')) {
  console.log(`  #${d.id} "${d.name}" platform=${d.platform_slug} chip entries=${d.entries} sets=${d.sets}`);
}
const total = one('SELECT COUNT(*) AS n FROM dat_sets').n;
console.log('\nsets stored by name:', total, total ? '' : '  <-- none: delete the DAT on the DAT page and import it again');
for (const s of all('SELECT platform_slug, COUNT(*) AS n FROM dat_sets GROUP BY platform_slug')) console.log(`  under platform "${s.platform_slug}": ${s.n}`);

console.log('\nyour arcade platforms:');
for (const slug of ARCADE) {
  const n = one('SELECT COUNT(*) AS n FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE p.slug = ?', slug).n;
  if (!n) continue;
  const st = all("SELECT COALESCE(r.dat_status, 'unchecked') AS s, COUNT(*) AS n FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE p.slug = ? GROUP BY 1", slug).map((x) => `${x.s}=${x.n}`).join(', ');
  const inSets = one(`SELECT COUNT(*) AS n FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE p.slug = ? AND EXISTS (SELECT 1 FROM dat_sets s WHERE s.set_name = lower(replace(replace(replace(r.filename, '.zip', ''), '.7z', ''), '.rar', '')))`, slug).n;
  console.log(`  ${slug}: ${n} games (${st}); ${inSets} have a file name that is a set name in a DAT`);
  const sample = all('SELECT r.filename, r.title, r.dat_status FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE p.slug = ? ORDER BY r.id LIMIT 6', slug);
  for (const r of sample) console.log(`     file "${r.filename}"  title "${r.title}"  dat=${r.dat_status || 'unchecked'}`);
}
const names = all('SELECT set_name FROM dat_sets ORDER BY id LIMIT 6').map((x) => x.set_name);
if (names.length) console.log('\nthe first sets in the DAT:', names.join(', '));

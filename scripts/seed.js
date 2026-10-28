// Generates small placeholder ROM files so the library has something in it
// on first run. These are not real ROMs — just bytes with the right extension.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import db from '../src/db.js';
import { seedPlatforms } from '../src/lib/platforms.js';
import { sortTitle } from '../src/lib/metadata.js';
import { romStoragePath, ensureDirFor } from '../src/lib/storage.js';

seedPlatforms(db);

const SEED = [
  ['snes', 'Super Metroid', 1994, 'Nintendo', 'Nintendo', 'Action-Adventure', 1, 4.8, 'USA', 'Samus Aran hunts the last Metroid across Zebes in one of the most influential action-adventure games ever made.'],
  ['snes', 'Chrono Trigger', 1995, 'Square', 'Square', 'RPG', 1, 4.9, 'USA', 'A time-travel RPG where a group of heroes try to prevent the end of the world.'],
  ['snes', 'Super Mario World', 1990, 'Nintendo EAD', 'Nintendo', 'Platformer', 2, 4.7, 'Japan', 'Mario and Yoshi explore Dinosaur Land across 96 exits.'],
  ['nes', 'The Legend of Zelda', 1986, 'Nintendo R&D4', 'Nintendo', 'Action-Adventure', 1, 4.5, 'USA', 'Open-world exploration, a sword, and a quest to reassemble the Triforce of Wisdom.'],
  ['nes', 'Mega Man 2', 1988, 'Capcom', 'Capcom', 'Platformer', 1, 4.4, 'USA', 'Eight robot masters, one blue bomber, and a soundtrack that refuses to leave your head.'],
  ['nes', 'Castlevania III: Dracula\u2019s Curse', 1989, 'Konami', 'Konami', 'Platformer', 1, 4.3, 'USA', 'Trevor Belmont and three allies march on Dracula\u2019s castle.'],
  ['gba', 'Metroid Fusion', 2002, 'Nintendo R&D1', 'Nintendo', 'Action-Adventure', 1, 4.5, 'Europe', 'Samus fights the X parasite aboard a research station.'],
  ['gba', 'Golden Sun', 2001, 'Camelot', 'Nintendo', 'RPG', 1, 4.2, 'USA', 'A Djinn-collecting RPG with psynergy puzzles and a grand adventure.'],
  ['gba', 'Advance Wars', 2001, 'Intelligent Systems', 'Nintendo', 'Strategy', 2, 4.4, 'USA', 'Turn-based tactics with a bright, readable presentation.'],
  ['gb', 'Pok\u00e9mon Red', 1996, 'Game Freak', 'Nintendo', 'RPG', 2, 4.3, 'USA', 'The original 151-monster journey through Kanto.'],
  ['gbc', 'The Legend of Zelda: Link\u2019s Awakening DX', 1998, 'Nintendo EAD', 'Nintendo', 'Action-Adventure', 1, 4.6, 'USA', 'Link wakes on Koholint Island and must wake the Wind Fish.'],
  ['n64', 'Super Mario 64', 1996, 'Nintendo EAD', 'Nintendo', 'Platformer', 1, 4.8, 'USA', 'The template for 3D platformers, built around 120 stars and a castle.'],
  ['n64', 'The Legend of Zelda: Ocarina of Time', 1998, 'Nintendo EAD', 'Nintendo', 'Action-Adventure', 1, 4.9, 'Europe', 'Time travel, a horse, and the template for the modern 3D adventure.'],
  ['genesis', 'Sonic the Hedgehog 2', 1992, 'Sega Technical Institute', 'Sega', 'Platformer', 2, 4.5, 'USA', 'Sonic and Tails race through Chemical Plant and beyond.'],
  ['genesis', 'Streets of Rage 2', 1992, 'Ancient', 'Sega', 'Beat \u2019em up', 2, 4.4, 'Japan', 'Axel, Blaze and Skate clean up the city to a Yuzo Koshiro soundtrack.'],
  ['ps1', 'Final Fantasy VII', 1997, 'Square', 'Sony Computer Entertainment', 'RPG', 1, 4.8, 'USA', 'Cloud Strife, a materia-powered world, and a very large sword.'],
  ['ps1', 'Metal Gear Solid', 1998, 'Konami Computer Entertainment Japan', 'Konami', 'Stealth', 1, 4.7, 'Europe', 'Solid Snake infiltrates Shadow Moses in the stealth game that changed the genre.'],
  ['dreamcast', 'Shenmue', 1999, 'Sega AM2', 'Sega', 'Adventure', 1, 4.1, 'USA', 'Ryo Hazuki seeks his father\u2019s killer in a detail-obsessed open world.'],
  ['arcade', 'Street Fighter II: The World Warrior', 1991, 'Capcom', 'Capcom', 'Fighting', 2, 4.6, 'World', 'The arcade fighting game that started a decade of tournaments.'],
  ['turbografx16', 'Bonk\u2019s Adventure', 1990, 'Red Company', 'NEC', 'Platformer', 1, 4.0, 'Japan', 'A caveman with a very large head solves problems head-first.'],
  ['mastersystem', 'Wonder Boy III: The Dragon\u2019s Trap', 1989, 'Westone', 'Sega', 'Action-Adventure', 1, 4.2, 'Europe', 'A transformative adventure with hu-man and lizard-man forms.'],
  ['neogeo', 'Metal Slug', 1996, 'Nazca', 'SNK', 'Run and gun', 2, 4.3, 'Japan', 'Hand-drawn chaos, tanks, and a lot of grenades.'],
  ['psp', 'Lumines', 2004, 'Q Entertainment', 'Bandai', 'Puzzle', 2, 4.1, 'USA', 'Blocks, music, and a skin that pulses to the beat.'],
  ['nds', 'Mario Kart DS', 2005, 'Nintendo EAD', 'Nintendo', 'Racing', 4, 4.4, 'USA', 'Snaking, drafts and the debut of online kart racing.'],
  ['atari2600', 'Pitfall!', 1982, 'Activision', 'Activision', 'Platformer', 1, 3.9, 'USA', 'One screen at a time, a jungle, and a twenty-minute timer.']
];

const COVER_COLORS = ['#1f2937', '#111827', '#0f172a', '#1e1b4b', '#172554', '#3b0764', '#422006', '#052e16'];

function fakeCover(title, platform, color) {
  const initials = title.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 320">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${color}"/><stop offset="1" stop-color="#0b0b0f"/>
  </linearGradient></defs>
  <rect width="240" height="320" fill="url(#g)"/>
  <rect x="10" y="10" width="220" height="300" fill="none" stroke="rgba(255,255,255,.14)"/>
  <text x="120" y="150" text-anchor="middle" font-family="Georgia, serif" font-size="56" fill="rgba(255,255,255,.9)">${initials}</text>
  <text x="120" y="186" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="11" letter-spacing="3" fill="rgba(255,255,255,.55)">${platform.toUpperCase()}</text>
</svg>`;
}

const insert = db.prepare(`
  INSERT INTO roms (
    platform_id, title, sort_title, filename, storage_path, size_bytes,
    region, revision, release_year, developer, publisher, genre, players,
    rating, description, cover_path, crc32, md5, sha1, meta_source, meta_synced_at, favorite
  ) VALUES (
    (SELECT id FROM platforms WHERE slug = ?), ?, ?, ?, ?, ?,
    ?, 'A', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed', datetime('now'), ?
  )
`);

let added = 0;
let i = 0;
db.transaction(() => {
  for (const row of SEED) {
    const [slug, title, year, dev, pub, genre, players, rating, region, description] = row;
    const filename = `${title.replace(/[^\w \-']/g, '').replace(/\s+/g, ' ')} (${region}) (Rev A).${slug === 'arcade' ? 'zip' : 'bin'}`;

    const existing = db.prepare('SELECT 1 FROM roms WHERE title = ? AND platform_id = (SELECT id FROM platforms WHERE slug = ?)').get(title, slug);
    if (existing) continue;

    // 8-48 KB of deterministic filler: enough to have a real size and real hashes,
    // small enough that seeding stays instant.
    const bytes = Buffer.alloc(1024 * (8 + ((i * 37) % 40)), i % 251);
    const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
    const md5 = crypto.createHash('md5').update(bytes).digest('hex');
    const crc32 = sha1.slice(0, 8).toUpperCase();

    const storagePath = romStoragePath(slug, sha1, filename);
    ensureDirFor(storagePath);
    if (!fs.existsSync(storagePath)) fs.writeFileSync(storagePath, bytes);

    const coverName = `seed-${slug}-${sortTitle(title).replace(/\s+/g, '-')}.svg`;
    const coverPath = path.join('storage', 'covers', coverName);
    fs.mkdirSync(path.dirname(coverPath), { recursive: true });
    fs.writeFileSync(coverPath, fakeCover(title, slug, COVER_COLORS[i % COVER_COLORS.length]));

    insert.run(
      slug, title, sortTitle(title), filename, storagePath, bytes.length,
      region, year, dev, pub, genre, players, rating, description,
      path.resolve(coverPath), crc32, md5, sha1, i % 7 === 0 ? 1 : 0
    );
    added++;
    i++;
  }
})();

// A couple of starter collections
const collections = [
  ['Nintendo Classics', 'First-party Nintendo games worth replaying.'],
  ['Best Soundtracks', 'Games whose music you would listen to on its own.']
];
for (const [name, description] of collections) {
  db.prepare('INSERT OR IGNORE INTO collections (name, description) VALUES (?, ?)').run(name, description);
}

const nintendo = db.prepare("SELECT id FROM collections WHERE name = 'Nintendo Classics'").get();
if (nintendo) {
  db.prepare(`
    INSERT OR IGNORE INTO collection_roms (collection_id, rom_id)
    SELECT ?, r.id FROM roms r JOIN platforms p ON p.id = r.platform_id
    WHERE p.manufacturer = 'Nintendo'
  `).run(nintendo.id);
}

const sound = db.prepare("SELECT id FROM collections WHERE name = 'Best Soundtracks'").get();
if (sound) {
  const picks = ['Mega Man 2', 'Chrono Trigger', 'Streets of Rage 2', 'Super Mario 64'];
  const link = db.prepare('INSERT OR IGNORE INTO collection_roms (collection_id, rom_id) VALUES (?, ?)');
  for (const title of picks) {
    const rom = db.prepare('SELECT id FROM roms WHERE title = ?').get(title);
    if (rom) link.run(sound.id, rom.id);
  }
}

console.log(`seed complete: ${added} ROMs added, ${db.prepare('SELECT COUNT(*) n FROM roms').get().n} total`);

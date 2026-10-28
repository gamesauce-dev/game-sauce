// Generates two small, real-format DAT files (No-Intro style, logiqx XML) that
// match ROMs in the demo library, so the DAT feature can be exercised end to end
// without downloading a 40 MB set.
//
// Usage: node scripts/make-sample-dats.mjs <rom-folder> <out-dir>
import fs from 'node:fs';
import path from 'node:path';
import { hashFile } from '../src/lib/hash.js';

const [, , romRoot = 'demo-roms', outDir = 'sample-dats'] = process.argv;
fs.mkdirSync(outDir, { recursive: true });

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = path.join(dir, e.name);
  if (e.isDirectory()) return walk(full);
  return /\.(sfc|smc|nsp|xci|pkg|iso|vpk|xvc)$/i.test(e.name) ? [full] : [];
});

// The demo library's own files, described as if they were in a curated set.
const CANONICAL = {
  'Chrono Trigger (USA).sfc': { title: 'Chrono Trigger (USA)', platform: 'Nintendo - Super Nintendo Entertainment System' },
  'Super Mario Bros. Wonder (Europe).nsp': { title: 'Super Mario Bros. Wonder (Europe)', platform: 'Nintendo - Nintendo Switch' },
  "Demon's Souls (USA).pkg": { title: "Demon's Souls (USA)", platform: 'Sony - PlayStation 5' },
  'Halo 3 (USA).iso': { title: 'Halo 3 (USA)', platform: 'Microsoft - Xbox 360' },
  'Mario Kart 8 Deluxe (USA).nsp': { title: 'Mario Kart 8 Deluxe (USA) (En,Fr,De,Es,It,Nl,Pt,Ru,Ja,Zh)', platform: 'Nintendo - Nintendo Switch' }
};

const byPlatform = new Map();

for (const file of walk(romRoot)) {
  const base = path.basename(file);
  const meta = CANONICAL[base];
  if (!meta) continue;
  const hashes = await hashFile(file);
  if (!byPlatform.has(meta.platform)) byPlatform.set(meta.platform, []);
  byPlatform.get(meta.platform).push({ ...meta, base, hashes });
}

let written = 0;
for (const [platform, games] of byPlatform) {
  const xml = `<?xml version="1.0"?>
<!DOCTYPE datafile PUBLIC "-//Logiqx//DTD ROM Management Datafile//EN" "http://www.logiqx.com/Dats/datafile.dtd">
<datafile>
  <header>
    <name>${platform}</name>
    <description>${platform}</description>
    <version>20240101-000000</version>
    <date>20240101</date>
  </header>
${games.map((g) => `  <game name="${g.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
    <description>${g.title.replace(/&/g, '&amp;')}</description>
    <rom name="${g.title.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" size="${g.hashes.size}" crc="${g.hashes.crc32.toLowerCase()}" md5="${g.hashes.md5}" sha1="${g.hashes.sha1}"/>
  </game>`).join('\n')}
</datafile>
`;
  const out = path.join(outDir, `${platform.replace(/[^\w]+/g, '_')}.dat`);
  fs.writeFileSync(out, xml);
  written++;
  console.log(`${out}  (${games.length} entries)`);
}

console.log(`${written} DAT file(s) written to ${outDir}`);

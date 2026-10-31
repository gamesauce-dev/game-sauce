// Platform catalogue.
//
// Each entry carries:
//   slug            stable id used in URLs and on disk
//   family          used to group the sidebar / pickers
//   extensions      canonical extensions for this platform
//   aliases         extra extensions shared with other platforms; only used when
//                   a folder-level hint disambiguates them (see scanner.js)
//   screenscraper   ScreenScraper numeric system id (systemeid)
//   tgdb            TheGamesDB platform id
//
// The ScreenScraper ids below are the documented `systemeid` values. They are
// best-effort: `npm run check:platforms` verifies every one against the live API
// and prints anything that does not resolve, so a stale id never fails silently.

/** The pictograms a platform can show (drawn in public/platform-icons.js). Kept in step with it by a test. */
export const ICON_TYPES = ['console', 'handheld', 'cartridge', 'disc', 'arcade', 'computer', 'pad', 'chip'];

export const PLATFORMS = [
  /* ───────────────────────── Nintendo ───────────────────────── */
  { slug: 'nes', name: 'Nintendo Entertainment System', short_name: 'NES', family: 'Nintendo', manufacturer: 'Nintendo', generation: 3, accent: '#e60012', extensions: ['nes', 'unf', 'unif', 'fds'], screenscraper: 3, tgdb: 7 },
  { slug: 'snes', name: 'Super Nintendo', short_name: 'SNES', family: 'Nintendo', manufacturer: 'Nintendo', generation: 4, accent: '#7b5ea7', extensions: ['sfc', 'smc', 'swc', 'fig', 'bs'], screenscraper: 4, tgdb: 6 },
  { slug: 'n64', name: 'Nintendo 64', short_name: 'N64', family: 'Nintendo', manufacturer: 'Nintendo', generation: 5, accent: '#0f9d58', extensions: ['z64', 'n64', 'v64'], screenscraper: 14, tgdb: 3 },
  { slug: 'gamecube', name: 'Nintendo GameCube', short_name: 'GCN', family: 'Nintendo', manufacturer: 'Nintendo', generation: 6, accent: '#4e2a84', extensions: ['gcm', 'rvz', 'wia', 'dol'], aliases: ['iso'], screenscraper: 13, tgdb: 2 },
  { slug: 'wii', name: 'Nintendo Wii', short_name: 'Wii', family: 'Nintendo', manufacturer: 'Nintendo', generation: 7, accent: '#00a0e9', extensions: ['wbfs', 'wad', 'rvz', 'iso'], screenscraper: 16, tgdb: 9 },
  { slug: 'wiiu', name: 'Nintendo Wii U', short_name: 'WiiU', family: 'Nintendo', manufacturer: 'Nintendo', generation: 8, accent: '#0288d1', extensions: ['wud', 'wux', 'rpx', 'wua'], screenscraper: 18, tgdb: 24 },
  { slug: 'switch', name: 'Nintendo Switch', short_name: 'NSW', family: 'Nintendo', manufacturer: 'Nintendo', generation: 9, accent: '#e60012', extensions: ['nsp', 'xci', 'nsz', 'xcz'], screenscraper: 225, tgdb: 4971 },
  { slug: 'switch2', name: 'Nintendo Switch 2', short_name: 'NSW2', family: 'Nintendo', manufacturer: 'Nintendo', generation: 9, accent: '#b3000f', extensions: ['nsp', 'xci', 'nsz', 'xcz'], screenscraper: 393, tgdb: null },
  { slug: 'gb', name: 'Game Boy', short_name: 'GB', family: 'Nintendo', manufacturer: 'Nintendo', generation: 4, accent: '#8b8b00', extensions: ['gb'], screenscraper: 9, tgdb: 4 },
  { slug: 'gbc', name: 'Game Boy Color', short_name: 'GBC', family: 'Nintendo', manufacturer: 'Nintendo', generation: 5, accent: '#c2185b', extensions: ['gbc'], screenscraper: 10, tgdb: 41 },
  { slug: 'gba', name: 'Game Boy Advance', short_name: 'GBA', family: 'Nintendo', manufacturer: 'Nintendo', generation: 6, accent: '#5c2d91', extensions: ['gba'], screenscraper: 12, tgdb: 5 },
  { slug: 'nds', name: 'Nintendo DS', short_name: 'NDS', family: 'Nintendo', manufacturer: 'Nintendo', generation: 7, accent: '#455a64', extensions: ['nds', 'dsi'], screenscraper: 15, tgdb: 8 },
  { slug: '3ds', name: 'Nintendo 3DS', short_name: '3DS', family: 'Nintendo', manufacturer: 'Nintendo', generation: 8, accent: '#d32f2f', extensions: ['3ds', 'cia', 'cci', 'cxi'], screenscraper: 17, tgdb: 4912 },
  { slug: 'virtualboy', name: 'Virtual Boy', short_name: 'VB', family: 'Nintendo', manufacturer: 'Nintendo', generation: 5, accent: '#b71c1c', extensions: ['vb', 'vboy'], screenscraper: 11, tgdb: 4918 },
  { slug: 'pokemonmini', name: 'Pokémon Mini', short_name: 'PM', family: 'Nintendo', manufacturer: 'Nintendo', generation: 6, accent: '#fbc02d', extensions: ['min'], screenscraper: 211, tgdb: 4938 },

  /* ───────────────────────── Sony ───────────────────────── */
  { slug: 'ps1', name: 'Sony PlayStation', short_name: 'PS1', family: 'Sony', manufacturer: 'Sony', generation: 5, accent: '#9e9e9e', extensions: ['pbp', 'cue', 'm3u', 'chd', 'bin', 'img', 'ecm'], screenscraper: 57, tgdb: 10 },
  { slug: 'ps2', name: 'Sony PlayStation 2', short_name: 'PS2', family: 'Sony', manufacturer: 'Sony', generation: 6, accent: '#1a1a8c', extensions: ['chd', 'iso', 'gz', 'cso', 'bin'], screenscraper: 58, tgdb: 11 },
  { slug: 'ps3', name: 'Sony PlayStation 3', short_name: 'PS3', family: 'Sony', manufacturer: 'Sony', generation: 7, accent: '#283593', extensions: ['pkg', 'iso', 'ps3', 'sfo'], screenscraper: 59, tgdb: 12 },
  { slug: 'ps4', name: 'Sony PlayStation 4', short_name: 'PS4', family: 'Sony', manufacturer: 'Sony', generation: 8, accent: '#1565c0', extensions: ['pkg', 'iso', 'fpkg', 'pkgsrc'], screenscraper: 60, tgdb: 4919 },
  { slug: 'ps5', name: 'Sony PlayStation 5', short_name: 'PS5', family: 'Sony', manufacturer: 'Sony', generation: 9, accent: '#0d47a1', extensions: ['pkg', 'iso', 'exfat'], screenscraper: 388, tgdb: null },
  { slug: 'psp', name: 'Sony PSP', short_name: 'PSP', family: 'Sony', manufacturer: 'Sony', generation: 7, accent: '#212121', extensions: ['cso', 'iso', 'pbp', 'chd'], screenscraper: 61, tgdb: 13 },
  { slug: 'psvita', name: 'Sony PS Vita', short_name: 'Vita', family: 'Sony', manufacturer: 'Sony', generation: 8, accent: '#263238', extensions: ['vpk', 'psvita', 'mai'], screenscraper: 62, tgdb: 4939 },

  /* ───────────────────────── Microsoft ───────────────────────── */
  { slug: 'xbox', name: 'Microsoft Xbox', short_name: 'XBX', family: 'Microsoft', manufacturer: 'Microsoft', generation: 6, accent: '#107c10', extensions: ['xiso', 'iso', 'xbe'], screenscraper: 55, tgdb: 14 },
  { slug: 'xbox360', name: 'Xbox 360', short_name: 'X360', family: 'Microsoft', manufacturer: 'Microsoft', generation: 7, accent: '#43a047', extensions: ['iso', 'god', 'xex', 'zar'], screenscraper: 56, tgdb: 15 },
  { slug: 'xboxone', name: 'Xbox One', short_name: 'XB1', family: 'Microsoft', manufacturer: 'Microsoft', generation: 8, accent: '#2e7d32', extensions: ['xvc', 'msixvc'], screenscraper: 392, tgdb: null },
  { slug: 'xboxseries', name: 'Xbox Series X|S', short_name: 'XSX', family: 'Microsoft', manufacturer: 'Microsoft', generation: 9, accent: '#1b5e20', extensions: ['xvc', 'msixvc'], screenscraper: 391, tgdb: null },

  /* ───────────────────────── Sega ───────────────────────── */
  { slug: 'genesis', name: 'Sega Genesis / Mega Drive', short_name: 'GEN', family: 'Sega', manufacturer: 'Sega', generation: 4, accent: '#1a237e', extensions: ['md', 'gen', 'smd', '68k'], screenscraper: 1, tgdb: 18 },
  { slug: 'mastersystem', name: 'Sega Master System', short_name: 'SMS', family: 'Sega', manufacturer: 'Sega', generation: 3, accent: '#0d47a1', extensions: ['sms'], screenscraper: 2, tgdb: 16 },
  { slug: 'gamegear', name: 'Sega Game Gear', short_name: 'GG', family: 'Sega', manufacturer: 'Sega', generation: 4, accent: '#283593', extensions: ['gg'], screenscraper: 21, tgdb: 20 },
  { slug: 'segacd', name: 'Sega CD', short_name: 'SCD', family: 'Sega', manufacturer: 'Sega', generation: 4, accent: '#4a148c', extensions: ['cue', 'chd', 'iso'], screenscraper: 20, tgdb: 21 },
  { slug: 'sega32x', name: 'Sega 32X', short_name: '32X', family: 'Sega', manufacturer: 'Sega', generation: 4, accent: '#6a1b9a', extensions: ['32x', 'zip'], screenscraper: 19, tgdb: 19 },
  { slug: 'saturn', name: 'Sega Saturn', short_name: 'SAT', family: 'Sega', manufacturer: 'Sega', generation: 5, accent: '#37474f', extensions: ['chd', 'cue', 'iso'], screenscraper: 22, tgdb: 17 },
  { slug: 'dreamcast', name: 'Sega Dreamcast', short_name: 'DC', family: 'Sega', manufacturer: 'Sega', generation: 6, accent: '#ff6f00', extensions: ['cdi', 'gdi', 'chd', 'dat'], screenscraper: 23, tgdb: 22 },
  { slug: 'segamodel2', name: 'Sega Model 2', short_name: 'M2', family: 'Sega', manufacturer: 'Sega', generation: 5, accent: '#5e35b1', extensions: ['zip', '7z'], screenscraper: 130, tgdb: null },
  { slug: 'segamodel3', name: 'Sega Model 3', short_name: 'M3', family: 'Sega', manufacturer: 'Sega', generation: 5, accent: '#4527a0', extensions: ['zip', '7z'], screenscraper: 131, tgdb: null },
  { slug: 'naomi', name: 'Sega NAOMI', short_name: 'NMI', family: 'Sega', manufacturer: 'Sega', generation: 6, accent: '#00838f', extensions: ['zip', '7z', 'dat', 'lst'], screenscraper: 56, tgdb: null },
  { slug: 'atomiswave', name: 'Sammy Atomiswave', short_name: 'AWS', family: 'Sega', manufacturer: 'Sammy', generation: 6, accent: '#00695c', extensions: ['zip', '7z'], screenscraper: 53, tgdb: null },

  /* ───────────────────────── Atari ───────────────────────── */
  { slug: 'atari2600', name: 'Atari 2600', short_name: '2600', family: 'Atari', manufacturer: 'Atari', generation: 2, accent: '#795548', extensions: ['a26'], screenscraper: 25, tgdb: 22 },
  { slug: 'atari5200', name: 'Atari 5200', short_name: '5200', family: 'Atari', manufacturer: 'Atari', generation: 2, accent: '#6d4c41', extensions: ['a52'], screenscraper: 26, tgdb: 26 },
  { slug: 'atari7800', name: 'Atari 7800', short_name: '7800', family: 'Atari', manufacturer: 'Atari', generation: 3, accent: '#5d4037', extensions: ['a78'], screenscraper: 27, tgdb: 27 },
  { slug: 'lynx', name: 'Atari Lynx', short_name: 'LYNX', family: 'Atari', manufacturer: 'Atari', generation: 4, accent: '#4e342e', extensions: ['lnx'], screenscraper: 28, tgdb: 28 },
  { slug: 'jaguar', name: 'Atari Jaguar', short_name: 'JAG', family: 'Atari', manufacturer: 'Atari', generation: 5, accent: '#3e2723', extensions: ['j64', 'jag'], screenscraper: 29, tgdb: 29 },

  /* ───────────────────────── Others ───────────────────────── */
  { slug: 'turbografx16', name: 'TurboGrafx-16 / PC Engine', short_name: 'TG16', family: 'NEC / SNK', manufacturer: 'NEC', generation: 4, accent: '#ef6c00', extensions: ['pce', 'sgx'], screenscraper: 31, tgdb: 34 },
  { slug: 'neogeo', name: 'Neo Geo', short_name: 'NEO', family: 'NEC / SNK', manufacturer: 'SNK', generation: 4, accent: '#b71c1c', extensions: ['neo', 'zip'], screenscraper: 142, tgdb: 24 },
  { slug: 'neogeopocket', name: 'Neo Geo Pocket Color', short_name: 'NGPC', family: 'NEC / SNK', manufacturer: 'SNK', generation: 5, accent: '#880e4f', extensions: ['ngc', 'ngpc'], screenscraper: 82, tgdb: 4922 },
  { slug: 'wonderswan', name: 'WonderSwan Color', short_name: 'WSC', family: 'NEC / SNK', manufacturer: 'Bandai', generation: 5, accent: '#00838f', extensions: ['ws', 'wsc'], screenscraper: 45, tgdb: 4925 },
  { slug: '3do', name: '3DO Interactive Multiplayer', short_name: '3DO', family: 'Others', manufacturer: 'The 3DO Company', generation: 5, accent: '#616161', extensions: ['iso', 'cue', 'chd'], screenscraper: 43, tgdb: 25 },
  { slug: 'cdi', name: 'Philips CD-i', short_name: 'CDi', family: 'Others', manufacturer: 'Philips', generation: 4, accent: '#9e9e9e', extensions: ['cue', 'chd', 'iso'], screenscraper: 42, tgdb: 4917 },
  { slug: 'pcenginecd', name: 'PC Engine CD', short_name: 'PCE-CD', family: 'NEC / SNK', manufacturer: 'NEC', generation: 4, accent: '#f57c00', extensions: ['cue', 'chd', 'iso', 'zip'], screenscraper: 114, tgdb: 4950 },
  { slug: 'arcade', name: 'Arcade', short_name: 'ARC', family: 'Arcade', manufacturer: 'Various', generation: 3, accent: '#00695c', extensions: ['zip', '7z'], screenscraper: 75, tgdb: 23 },
  { slug: 'mame', name: 'MAME', short_name: 'MAME', family: 'Arcade', manufacturer: 'Various', generation: null, accent: '#004d40', extensions: ['zip'], screenscraper: 75, tgdb: 23 },
  { slug: 'fba', name: 'FinalBurn Neo', short_name: 'FBN', family: 'Arcade', manufacturer: 'Various', generation: null, accent: '#1de9b6', extensions: ['zip', '7z'], screenscraper: 75, tgdb: 23 },
  { slug: 'scummvm', name: 'ScummVM', short_name: 'SCUMM', family: 'Others', manufacturer: 'Various', generation: null, accent: '#6a1b9a', extensions: ['scummvm', 'svm'], screenscraper: 123, tgdb: null },
  { slug: 'dos', name: 'DOS', short_name: 'DOS', family: 'Others', manufacturer: 'Microsoft', generation: null, accent: '#37474f', extensions: ['dosz', 'exe', 'com', 'conf'], screenscraper: 135, tgdb: null },
  { slug: 'other', name: 'Other', short_name: 'OTHER', family: 'Others', manufacturer: 'Various', generation: null, accent: '#6b7280', extensions: [], screenscraper: null, tgdb: null }
];

export const PLATFORM_BY_SLUG = new Map(PLATFORMS.map((p) => [p.slug, p]));

// Canonical extension -> slug. Ambiguous extensions (iso, chd, cue, bin, pkg, nsp…)
// deliberately resolve to nothing here; they need a folder hint to be safe.
export const EXTENSION_MAP = (() => {
  const counts = new Map();
  for (const p of PLATFORMS) for (const ext of p.extensions) {
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const map = new Map();
  for (const p of PLATFORMS) {
    for (const ext of p.extensions) {
      if (counts.get(ext) > 1) continue; // ambiguous, skip
      map.set(ext, p.slug);
    }
  }
  return map;
})();

// Every extension any platform claims, canonical or alias.
export const ALL_EXTENSIONS = (() => {
  const set = new Set();
  for (const p of PLATFORMS) {
    for (const ext of p.extensions || []) set.add(ext);
    for (const ext of p.aliases || []) set.add(ext);
  }
  return set;
})();

// Folder names people actually use, beyond the slug/short name/name.
export const PLATFORM_FOLDER_ALIASES = {
  ps1: ['psx', 'psone', 'playstation1'],
  ps2: ['playstation2'],
  ps3: ['playstation3'],
  ps4: ['playstation4', 'ps4pro'],
  ps5: ['playstation5'],
  psp: ['playstationportable'],
  psvita: ['vita', 'psv'],
  xbox: ['xbx', 'xboxclassic', 'xboxoriginal'],
  xbox360: ['x360', 'xboxthree sixty'],
  xboxone: ['xb1'],
  xboxseries: ['xsx', 'xboxseriess', 'xboxseriesx', 'xboxseriesxs'],
  switch: ['nsw', 'switch1'],
  switch2: ['nsw2'],
  gamecube: ['ngc', 'gc', 'gcn'],
  n64: ['nintendo64'],
  snes: ['supernintendo', 'supernes', 'sfc'],
  nes: ['nintendoentertainmentsystem', 'famicom'],
  gb: ['gameboy', 'dmg'],
  gbc: ['gameboycolor'],
  gba: ['gameboyadvance'],
  nds: ['nintendods', 'ds'],
  '3ds': ['nintendo3ds'],
  virtualboy: ['vb'],
  genesis: ['megadrive', 'segagenesis', 'md'],
  mastersystem: ['sms', 'segamastersystem'],
  gamegear: ['gg', 'segagamegear'],
  saturn: ['segasaturn'],
  dreamcast: ['dc', 'segadreamcast'],
  segamodel2: ['model2', 'm2', 'segamodel2'],
  segamodel3: ['model3', 'm3', 'segamodel3'],
  naomi: ['nmi', 'naomi', 'seganaomi'],
  atomiswave: ['aws', 'atomiswave', 'sammyatomiswave'],
  turbografx16: ['tg16', 'pcengine', 'pce'],
  neogeo: ['neogeoaes', 'mvs'],
  arcade: ['mame', 'fbneo', 'fba', 'coinop'],
  wii: ['nintendowii'],
  wiiu: ['nintendowiiu']
};

/** Which platforms could a file with this extension belong to? */
/** Platforms that accept ONLY their listed extensions, whatever the source or
 *  upload says. MAME romsets are .zip by definition; other archives/files are
 *  not romsets and must never be catalogued under it. */
const STRICT_PLATFORMS = new Set(['mame']);
export function extensionAllowed(slug, filename) {
  if (!STRICT_PLATFORMS.has(slug)) return true;
  const p = PLATFORM_BY_SLUG.get(slug);
  const ext = (String(filename).split('.').pop() || '').toLowerCase();
  return !!p && p.extensions.includes(ext);
}

export function candidatePlatforms(ext) {
  const e = String(ext || '').toLowerCase();
  const hits = [];
  for (const p of PLATFORMS) {
    if (p.extensions?.includes(e)) hits.push(p.slug);
  }
  for (const p of PLATFORMS) {
    if (p.aliases?.includes(e) && !hits.includes(p.slug)) hits.push(p.slug);
  }
  return hits;
}

/** Unambiguous extension lookup, or null when the extension is shared. */
/** All folder-name spellings for a platform, normalised for comparison. */
export function folderNamesFor(slug) {
  const p = PLATFORM_BY_SLUG.get(slug);
  if (!p) return [];
  const raw = [p.slug, p.short_name, p.name, ...(PLATFORM_FOLDER_ALIASES[slug] || [])];
  return [...new Set(raw.filter(Boolean).map((n) => n.toLowerCase().replace(/[^a-z0-9]/g, '')))];
}

export function detectPlatform(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  return EXTENSION_MAP.get(ext) || null;
}

export const PLATFORM_SLUGS = new Set(PLATFORMS.map((p) => p.slug));

export function seedPlatforms(db) {
  const stmt = db.prepare(`
    INSERT INTO platforms (slug, name, short_name, family, manufacturer, generation, accent, screenscraper_id, tgdb_id, extensions)
    VALUES (@slug, @name, @short_name, @family, @manufacturer, @generation, @accent, @screenscraper, @tgdb, @extensions)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name, short_name = excluded.short_name, family = excluded.family,
      manufacturer = excluded.manufacturer, generation = excluded.generation,
      accent = excluded.accent, screenscraper_id = excluded.screenscraper_id,
      tgdb_id = excluded.tgdb_id, extensions = excluded.extensions
  `);
  const rows = PLATFORMS.map((p) => ({
    ...p,
    extensions: [...(p.extensions || []), ...(p.aliases || [])].join(','),
    screenscraper: p.screenscraper ?? null,
    tgdb: p.tgdb ?? null
  }));
  db.transaction(() => { for (const r of rows) stmt.run(r); })();
}

// Curated emulator guide: one top pick per popular platform.
// This is links + metadata only — game-sauce never redistributes emulator
// binaries. Binaries enter the vault only when YOU put them there (manual
// upload, or "save to vault" fetching the official release asset).
//
// bios_needed is three-valued and drives the badge in the Emulators view
// (rendered by public/app.js renderEmuGuide):
//   false      — nothing needed, plays out of the box
//   'optional' — runs without a BIOS, but a dump improves some titles/cores
//   'required' — will not (fully) boot without BIOS/system files you dump
//                from your own console.
// Entries with `slug` are addressable by that key too (multi-system picks
// like RetroArch that belong to no single platform).

export const EMULATORS = [
  {
    slug: 'retroarch',
    platforms: [],
    platform_label: 'Multi-system',
    name: 'RetroArch',
    homepage: 'https://www.retroarch.org/',
    download: 'https://www.retroarch.org/downloads',
    github: 'libretro/RetroArch',
    notes: 'All-in-one frontend: dozens of libretro cores (NES → PS1, arcade, computers) in one app. Heavier to set up than single-system picks, but the best "one installer covers everything" option. Cores install from inside the app.',
    bios_needed: 'retroarch'
  },
  {
    platforms: ['nes'],
    platform_label: 'NES',
    name: 'Mesen',
    homepage: 'https://mesen.ca/',
    download: 'https://github.com/nesdev-org/MesenCE/releases/latest',
    github: 'nesdev-org/MesenCE',
    notes: 'Now MesenCE (Community Edition) — the original SourMesen/Mesen2 repo is archived. Most accurate NES, multi-system.',
    bios_needed: false
  },
  {
    platforms: ['snes'],
    platform_label: 'Super Nintendo',
    name: 'Snes9x',
    homepage: 'https://www.snes9x.com/',
    download: 'https://www.snes9x.com/phpbb3/viewforum.php?f=6',
    github: 'snes9xgit/snes9x',
    notes: 'Fast, compatible, easy UI. bsnes/higan is the accuracy alternative.',
    bios_needed: false
  },
  {
    platforms: ['n64'],
    platform_label: 'Nintendo 64',
    name: 'simple64',
    homepage: 'https://simple64.github.io/',
    download: 'https://simple64.github.io/',
    github: 'simple64/simple64',
    notes: 'Low-level RDP accuracy fork of mupen64plus. Needs a real N64 ROM dump.',
    bios_needed: false
  },
  {
    platforms: ['gamecube', 'wii'],
    platform_label: 'GameCube / Wii',
    name: 'Dolphin',
    homepage: 'https://dolphin-emu.org/',
    download: 'https://dolphin-emu.org/download/',
    github: 'dolphin-emu/dolphin',
    notes: 'The standard. Beta builds beat Stable for new fixes.',
    bios_needed: false
  },
  {
    platforms: ['wiiu'],
    platform_label: 'Wii U',
    name: 'Cemu',
    homepage: 'https://cemu.info/',
    download: 'https://cemu.info/#download',
    github: 'cemu-project/Cemu',
    notes: 'Needs Wii U system files dumped from your console (otp.bin, seeprom.bin).',
    bios_needed: 'wiiu'
  },
  {
    platforms: ['switch'],
    platform_label: 'Nintendo Switch',
    name: 'Eden',
    homepage: 'https://eden-emu.dev/',
    download: 'https://eden-emu.dev/download',
    github: null,
    notes: 'Community Yuzu successor. Releases repo was DMCA-disabled on GitHub — download from the official site instead. Needs prod.keys + firmware dumped from YOUR Switch. Check local law before use.',
    bios_needed: 'required'
  },
  {
    platforms: ['gb', 'gbc', 'gba'],
    platform_label: 'Game Boy / Color / Advance',
    name: 'mGBA',
    homepage: 'https://mgba.io/',
    download: 'https://mgba.io/downloads.html',
    github: 'mgba-emu/mgba',
    notes: 'One emulator for all three handhelds. Excellent Mister/RetroArch core too.',
    bios_needed: false
  },
  {
    platforms: ['nds'],
    platform_label: 'Nintendo DS',
    name: 'melonDS',
    homepage: 'https://melonds.kuribo64.net/',
    download: 'https://melonds.kuribo64.net/downloads.php',
    github: 'melonDS-emu/melonDS',
    notes: 'Runs without a BIOS for most games; DS firmware dumped from your console improves compatibility.',
    bios_needed: 'optional'
  },
  {
    platforms: ['3ds'],
    platform_label: 'Nintendo 3DS',
    name: 'Azahar',
    homepage: 'https://azahar-emu.org/',
    download: 'https://azahar-emu.org/download/',
    github: 'azahar-emu/azahar',
    notes: 'Active Citra fork. Needs 3DS firmware dumped from your console (free download from Nintendo also works).',
    bios_needed: false
  },
  {
    platforms: ['ps1'],
    platform_label: 'PlayStation',
    name: 'DuckStation',
    homepage: 'https://www.duckstation.org/',
    download: 'https://www.duckstation.org/',
    github: 'stenzek/duckstation',
    notes: 'Needs a PS1 BIOS dumped from your console. Use CHD or BIN/CUE rips.',
    bios_needed: 'bios'
  },
  {
    platforms: ['ps2'],
    platform_label: 'PlayStation 2',
    name: 'PCSX2',
    homepage: 'https://pcsx2.net/',
    download: 'https://pcsx2.net/downloads/',
    github: 'PCSX2/pcsx2',
    notes: 'Nightly builds are much faster than old Stable. Needs PS2 BIOS from your console.',
    bios_needed: 'bios'
  },
  {
    platforms: ['ps3'],
    platform_label: 'PlayStation 3',
    name: 'RPCS3',
    homepage: 'https://rpcs3.net/',
    download: 'https://rpcs3.net/download',
    github: 'RPCS3/rpcs3',
    notes: 'Needs official Sony PS3 firmware PUP (install via File > Install Firmware). No console BIOS dump needed. Heavy CPU requirements.',
    bios_needed: 'firmware'
  },
  {
    platforms: ['psp'],
    platform_label: 'PSP',
    name: 'PPSSPP',
    homepage: 'https://www.ppsspp.org/',
    download: 'https://www.ppsspp.org/downloads.html',
    github: 'hrydgard/ppsspp',
    notes: 'No BIOS needed. Gold build on stores funds development; free builds identical.',
    bios_needed: false
  },
  {
    platforms: ['genesis', 'mastersystem', 'gamegear', 'segacd', 'sega32x'],
    platform_label: 'Sega 8/16-bit',
    name: 'BlastEm',
    homepage: 'https://www.retrodev.com/blastem/',
    download: 'https://www.retrodev.com/blastem/',
    github: null,
    notes: 'Cycle-accurate Genesis/Mega Drive + Master System/Game Gear. Kega Fusion is the classic alternative (unmaintained).',
    bios_needed: false
  },
  {
    platforms: ['saturn'],
    platform_label: 'Sega Saturn',
    name: 'Mednafen',
    homepage: 'https://mednafen.github.io/',
    download: 'https://mednafen.github.io/',
    github: null,
    notes: 'Accuracy-first multi-system core. Needs Saturn BIOS from your console. Kronos is the easier-GUI alternative.',
    bios_needed: 'required'
  },
  {
    platforms: ['dreamcast'],
    platform_label: 'Dreamcast',
    name: 'Flycast',
    homepage: 'https://flyinghead.github.io/flycast/',
    download: 'https://github.com/flyinghead/flycast/releases',
    github: 'flyinghead/flycast',
    notes: 'Needs Dreamcast BIOS (dc_boot.bin, dc_flash.bin) from your console. Also a RetroArch core.',
    bios_needed: 'required'
  },
  {
    platforms: ['arcade', 'mame', 'fba', 'neogeo'],
    platform_label: 'Arcade / Neo Geo',
    name: 'MAME + FinalBurn Neo',
    homepage: 'https://www.mamedev.org/',
    download: 'https://www.mamedev.org/release.html',
    github: 'mamedev/mame',
    notes: 'MAME for breadth, FBNeo for speed on Neo Geo/CPS. Match your ROM set version to the emulator version.',
    bios_needed: false
  },
  {
    platforms: ['atari2600'],
    platform_label: 'Atari 2600',
    name: 'Stella',
    homepage: 'https://stella-emu.github.io/',
    download: 'https://stella-emu.github.io/downloads.html',
    github: 'stella-emu/stella',
    notes: 'The reference 2600 emulator for decades.',
    bios_needed: false
  },
  {
    platforms: ['xbox'],
    platform_label: 'Xbox',
    name: 'xemu',
    homepage: 'https://xemu.app/',
    download: 'https://xemu.app/#download',
    github: 'xemu-project/xemu',
    notes: 'Needs MCPX boot ROM + retail BIOS dumped from your Xbox.',
    bios_needed: 'required'
  },
  {
    platforms: ['ps4'],
    platform_label: 'PlayStation 4',
    name: 'shadPS4',
    homepage: 'https://shadps4.net/',
    download: 'https://shadps4.net/',
    github: 'shadps4-emu/shadPS4',
    notes: 'No BIOS required — boots without one. Benefits from system files extracted from YOUR PS4 for some titles. Early but fast-moving; check the compatibility list.',
    bios_needed: false
  }
];

/** Flat lookup: platform slug (or explicit slug for multi-system picks) -> entry. */
export const EMULATOR_BY_PLATFORM = Object.fromEntries(
  EMULATORS.flatMap((e) => [...(e.platforms || []), e.slug].filter(Boolean).map((slug) => [slug, e]))
);

export function emulatorFor(slug) {
  return EMULATOR_BY_PLATFORM[String(slug || '').toLowerCase()] || null;
}

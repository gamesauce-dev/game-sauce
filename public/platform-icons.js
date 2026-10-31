// Original pictograms for platforms. They are generic shapes (a home console, a handheld, a cartridge...), NOT the real
// console logos, which belong to their makers. Each is drawn on a 24x24 grid in one colour, so a platform's own colour tints it.

export const PLATFORM_ICON_TYPES = [
  { id: 'console',   label: 'Home console',    svg: '<rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6.5 13h4M8.5 11v4"/><circle cx="15" cy="12.2" r=".9" fill="currentColor"/><circle cx="17.6" cy="14.2" r=".9" fill="currentColor"/>' },
  { id: 'handheld',  label: 'Handheld',        svg: '<rect x="6" y="2.5" width="12" height="19" rx="2.5"/><rect x="8.5" y="5" width="7" height="6" rx="1"/><path d="M9.2 15.5h3M10.7 14v3"/><circle cx="15" cy="15" r=".8" fill="currentColor"/><circle cx="16.6" cy="17" r=".8" fill="currentColor"/>' },
  { id: 'cartridge', label: 'Cartridge',       svg: '<path d="M6 3h12v14l-2 4H8l-2-4z"/><rect x="8.5" y="5.5" width="7" height="5" rx=".8"/><path d="M9.5 21v-2M12 21v-2M14.5 21v-2"/>' },
  { id: 'disc',      label: 'Disc',            svg: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/><path d="M12 5a7 7 0 0 1 6.6 4.7"/>' },
  { id: 'arcade',    label: 'Arcade cabinet',  svg: '<path d="M7 21V6l2-3h6l2 3v15z"/><rect x="9" y="5.5" width="6" height="5" rx=".8"/><path d="M9 14.5h6"/><circle cx="10.5" cy="17.2" r=".9" fill="currentColor"/><circle cx="13.8" cy="17.2" r=".9" fill="currentColor"/>' },
  { id: 'computer',  label: 'Computer',        svg: '<rect x="4" y="4" width="16" height="11" rx="1.6"/><path d="M9 20h6M12 15v5"/>' },
  { id: 'pad',       label: 'Controller',      svg: '<path d="M7 7.5h10a4.5 4.5 0 0 1 4.4 5.4l-.8 4a2.6 2.6 0 0 1-4.4 1.2L14 16h-4l-2.2 2.1a2.6 2.6 0 0 1-4.4-1.2l-.8-4A4.5 4.5 0 0 1 7 7.5z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="15.5" cy="11.2" r=".9" fill="currentColor"/><circle cx="17.7" cy="13" r=".9" fill="currentColor"/>' },
  { id: 'chip',      label: 'Other / chip',    svg: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 3v3M12 3v3M15 3v3M9 18v3M12 18v3M15 18v3M3 9h3M3 12h3M3 15h3M18 9h3M18 12h3M18 15h3"/>' }
];

const BY_ID = new Map(PLATFORM_ICON_TYPES.map((t) => [t.id, t]));

/** Slug -> icon type for the built-in platforms. A platform with an icon chosen by the admin uses that instead. */
export const DEFAULT_ICON_BY_SLUG = {
  nes: 'console', snes: 'console', n64: 'console', gamecube: 'console', wii: 'console', wiiu: 'console', switch: 'handheld', switch2: 'handheld',
  gb: 'handheld', gbc: 'handheld', gba: 'handheld', nds: 'handheld', '3ds': 'handheld', virtualboy: 'console', pokemonmini: 'handheld',
  ps1: 'disc', ps2: 'disc', ps3: 'disc', ps4: 'disc', ps5: 'disc', psp: 'handheld', psvita: 'handheld',
  xbox: 'console', xbox360: 'console', xboxone: 'console', xboxseries: 'console',
  genesis: 'console', mastersystem: 'console', gamegear: 'handheld', segacd: 'disc', sega32x: 'cartridge', saturn: 'disc', dreamcast: 'disc',
  segamodel2: 'arcade', segamodel3: 'arcade', naomi: 'arcade', atomiswave: 'arcade',
  atari2600: 'console', atari5200: 'console', atari7800: 'console', lynx: 'handheld', jaguar: 'console',
  turbografx16: 'console', pcenginecd: 'disc', neogeo: 'arcade', neogeopocket: 'handheld', wonderswan: 'handheld',
  '3do': 'disc', cdi: 'disc', arcade: 'arcade', mame: 'arcade', fba: 'arcade', cps1: 'arcade', cps2: 'arcade', cps3: 'arcade', cave: 'arcade',
  scummvm: 'computer', dos: 'computer', other: 'chip'
};

export const iconTypeFor = (p) => (p && BY_ID.has(p.icon) ? p.icon : (p && DEFAULT_ICON_BY_SLUG[p.slug]) || 'chip');

/** The icon as an inline SVG string, drawn in the platform's colour. */
export function platformIconSvg(p, size = 16) {
  const t = BY_ID.get(iconTypeFor(p)) || BY_ID.get('chip');
  const colour = (p && p.accent) || 'currentColor';
  return `<svg class="plat-ico" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${colour}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${t.svg}</svg>`;
}

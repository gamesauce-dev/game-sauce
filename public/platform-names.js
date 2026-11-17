// One set of names for the chips and cover badges of the Physical and the Digital Library, so the same console reads the same on both:
// SWITCH, WII U, XBOX 360, X|S ... (Digital's names, which are shorter and clearer than the Library's own short names) in capitals.
// A platform not listed here keeps the Library's own short name, in capitals. The family chips use the brand people say: PlayStation, Xbox.

/** Badge text for the Library platforms Digital also covers, by Library platform slug. */
export const BADGE = {
  ps2: 'PS2', ps3: 'PS3', ps4: 'PS4', ps5: 'PS5',
  switch2: 'SWITCH 2', switch: 'SWITCH', wii: 'WII', wiiu: 'WII U', '3ds': '3DS', nds: 'DS',
  xbox: 'XBOX', xbox360: 'XBOX 360', xbla: 'XBLA', xboxone: 'XBOX ONE', xboxseries: 'X|S'
};

/** The name a family chip shows: Sony's consoles read PlayStation, and Microsoft's (and the Digital Library's Xbox store) read Microsoft, as in the Library. Other families keep their own name. */
export const FAMILY = { sony: 'PlayStation', playstation: 'PlayStation', microsoft: 'Microsoft', xbox: 'Microsoft' };

/** The text on a platform's chip or cover badge, in capitals. p: { slug, short_name?, name?, badge? } (a Library platform row). A badge text an admin set for the platform (Settings > Platforms) wins over everything. */
export const platformBadge = (p) => String(p?.badge || BADGE[p?.slug] || p?.short_name || p?.name || p?.slug || '').toUpperCase();
/** A short name an admin typed (Settings > Platforms) is not the one the platform came with (short_default, sent by the server). */
const ownShort = (p) => { const s = String(p?.short_name || '').trim(); return s && p?.short_default !== undefined && s !== p.short_default ? s : ''; };
/** The text on a platform's chip: the same, but a badge text is never used (it is for the cover badges only; the chip follows the short name). */
export const platformChip = (p) => (ownShort(p) || platformBadge({ ...p, badge: '' })).toUpperCase();

/** A family's name as people say it (for a tooltip), and the same in capitals (for a chip). */
export const familyName = (f) => FAMILY[String(f || '').toLowerCase()] || String(f || '');
export const familyLabel = (f) => familyName(f).toUpperCase();

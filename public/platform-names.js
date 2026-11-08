// One set of names for the chips and cover badges of the Physical and the Digital Library, so the same console reads the same on both:
// SWITCH, WII U, XBOX 360, X|S ... (Digital's names, which are shorter and clearer than the Library's own short names) in capitals.
// A platform not listed here keeps the Library's own short name, in capitals. The family chips use the brand people say: PlayStation, Xbox.

/** Badge text for the Library platforms Digital also covers, by Library platform slug. */
export const BADGE = {
  ps3: 'PS3', ps4: 'PS4', ps5: 'PS5',
  switch2: 'SWITCH 2', switch: 'SWITCH', wii: 'WII', wiiu: 'WII U', '3ds': '3DS', nds: 'DS',
  xbox: 'XBOX', xbox360: 'XBOX 360', xboxone: 'XBOX ONE', xboxseries: 'X|S'
};

/** The brand a Library family goes by (the Library files Sony's and Microsoft's consoles under those makers). Other families keep their own name. */
export const FAMILY = { sony: 'PlayStation', playstation: 'PlayStation', microsoft: 'Xbox', xbox: 'Xbox' };

/** The text on a platform's chip or cover badge, in capitals. p: { slug, short_name?, name? } (a Library platform row). */
export const platformBadge = (p) => String(BADGE[p?.slug] || p?.short_name || p?.name || p?.slug || '').toUpperCase();

/** A family's name as people say it (for a tooltip), and the same in capitals (for a chip). */
export const familyName = (f) => FAMILY[String(f || '').toLowerCase()] || String(f || '');
export const familyLabel = (f) => familyName(f).toUpperCase();

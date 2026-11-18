// Platform and family buttons: the text with a count (the default), or the logo when the person chose logos (Settings > My account > Platform buttons).
// A platform or family with no logo of its own keeps its text, so a mixed row still reads. The count moves into the hover text.
export const useLogos = (state) => state?.prefs?.chip_style === 'logos';

const logoImg = (url, plate) => `<span class="lib-logo chip-logo-img${plate ? ' on-plate' : ''}"><img src="${url}" alt="" draggable="false" /></span>`;
/** The logo of a family, from any platform row of it (the Library's platform list carries family_logo_v), or ''. */
export const familyLogoHtml = (row) => (row?.family_logo_v ? logoImg(`/api/platforms/families/logo?family=${encodeURIComponent(row.family)}&v=${row.family_logo_v}`, row.family_logo_plate) : '');
/** The logo of a platform row (slug, logo_v, logo_plate), or ''. */
export const platformLogoHtml = (row) => (row?.logo_v ? logoImg(`/api/platforms/${encodeURIComponent(row.slug)}/logo?v=${row.logo_v}`, row.logo_plate) : '');
/** What goes inside the button: the logo when there is one (and logos are on), else the text and its count. */
export const chipFace = (logoHtml, textHtml, countText) => logoHtml || `${textHtml} <small>${countText}</small>`;

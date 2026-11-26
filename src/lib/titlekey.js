// A game's title boiled down to what its video is kept under: lower case, no (region) or [tag] text, only letters and digits. On its own so that
// anything can use it, the visibility rule included, without loading the video services.
export const titleKey = (title) => String(title || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

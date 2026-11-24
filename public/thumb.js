// A tile in a grid shows a small picture: the server sends a WebP thumbnail of our own covers (?w=640, twice the width of a tile, so it stays sharp on a
// high-density screen). A picture from elsewhere, or one already sized, is left alone. The details window uses the full picture.
export const THUMB_W = 640;
export function thumb(url) {
  const u = String(url || '');
  if (!u.startsWith('/api/') || /[?&]w=/.test(u)) return u;
  return u + (u.includes('?') ? '&' : '?') + 'w=' + THUMB_W;
}

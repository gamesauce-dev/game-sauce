// Full-wrap covers: one picture holding the back, the spine and the front of a case side by side (media packs such as EmuMovies keep them like that).
// This cuts one into its parts so the shelf can use the front as the cover and the narrow middle strip as the spine. Pure JavaScript (jpeg-js and pngjs): nothing native to build.
//
// Where the spine sits is a pair of fractions of the picture's width ({ from, to }, 0 to 1). A pack uses one template per platform, so the person sets them once on a sample
// (the importer shows it with two lines to move) and they are remembered. The starting values below were measured on real PS3, Xbox 360 and Switch wraps.
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

export const DEFAULT_SPLIT = { from: 0.475, to: 0.525 };
export const PLATFORM_SPLIT = {
  ps3: { from: 0.471, to: 0.526 },       // the spine is the strip with the PS3 logo; the black "PLAYSTATION 3" band is part of the front
  xbox360: { from: 0.486, to: 0.528 },
  switch: { from: 0.475, to: 0.523 },
  switch2: { from: 0.475, to: 0.523 }
};
const MAX_PIXELS = 40e6;   // refuse something absurd rather than run out of memory

/** A usable { from, to }, or null. */
export function cleanSplit(s) {
  const from = Number(s?.from), to = Number(s?.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  if (from < 0.15 || to > 0.85 || to - from < 0.01 || to - from > 0.35) return null;
  return { from: Math.round(from * 10000) / 10000, to: Math.round(to * 10000) / 10000 };
}
/** The cut to use for a platform: the person's own, else the measured one for that platform, else the middle fifth. */
export const splitFor = (slug, mine) => cleanSplit(mine?.[slug]) || PLATFORM_SPLIT[slug] || DEFAULT_SPLIT;

const isPng = (b) => b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const isJpeg = (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWebp = (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';

/** { width, height, data } (RGBA) from a JPEG or PNG. WebP is not supported here. */
export function decodeImage(buf) {
  let img;
  if (isJpeg(buf)) img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 400 });
  else if (isPng(buf)) { const p = PNG.sync.read(buf); img = { width: p.width, height: p.height, data: p.data }; }
  else if (isWebp(buf)) throw new Error('a WebP wrap cannot be cut yet: save it as JPEG or PNG');
  else throw new Error('that is not a JPEG or PNG picture');
  if (!img.width || !img.height || img.width * img.height > MAX_PIXELS) throw new Error('that picture is too large to cut');
  return img;
}

function crop(img, x0, x1) {
  const w = Math.max(1, x1 - x0), out = new Uint8Array(w * img.height * 4);
  for (let y = 0; y < img.height; y++) out.set(img.data.subarray((y * img.width + x0) * 4, (y * img.width + x0 + w) * 4), y * w * 4);
  return { width: w, height: img.height, data: out };
}
const encode = (img) => Buffer.from(jpeg.encode({ width: img.width, height: img.height, data: img.data }, 92).data);

/** Cut a wrap: the front (right of the spine), the spine, and the back (left of it), as JPEG files. */
export function splitWrap(buf, split) {
  const img = decodeImage(buf), s = cleanSplit(split) || DEFAULT_SPLIT;
  const a = Math.min(img.width - 2, Math.max(1, Math.round(img.width * s.from))), b = Math.min(img.width - 1, Math.max(a + 1, Math.round(img.width * s.to)));
  return { width: img.width, height: img.height, cover: encode(crop(img, b, img.width)), spine: encode(crop(img, a, b)), back: encode(crop(img, 0, a)) };
}

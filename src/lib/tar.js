// Minimal ustar reader/writer, no dependencies. Used by backup (write) and restore (read).
// Only plain files are supported, which is all a game-sauce backup contains.
import fs from 'node:fs';
import path from 'node:path';

const octal = (n, width) => n.toString(8).padStart(width - 1, '0') + '\0';

export function tarHeader(name, size, mtimeSec) {
  if (size > 0o77777777777) throw new Error(`${name} is too large for a tar entry`);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(base) > 100) {
    const cut = base.lastIndexOf('/', 155);
    if (cut <= 0) throw new Error(`Path too long for a tar entry: ${name}`);
    prefix = base.slice(0, cut);
    base = base.slice(cut + 1);
    if (Buffer.byteLength(base) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Path too long for a tar entry: ${name}`);
  }
  const b = Buffer.alloc(512);
  b.write(base, 0, 100, 'utf8');
  b.write(octal(0o644, 8), 100, 8, 'ascii');
  b.write(octal(0, 8), 108, 8, 'ascii');
  b.write(octal(0, 8), 116, 8, 'ascii');
  b.write(octal(size, 12), 124, 12, 'ascii');
  b.write(octal(mtimeSec, 12), 136, 12, 'ascii');
  b.fill(0x20, 148, 156); // checksum field counts as spaces while summing
  b.write('0', 156, 1, 'ascii'); // regular file
  b.write('ustar\0', 257, 6, 'ascii');
  b.write('00', 263, 2, 'ascii');
  b.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return b;
}

export const tarPad = (size) => (size % 512 === 0 ? null : Buffer.alloc(512 - (size % 512)));

const field = (buf, start, len) => {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end >= 0 && end < start + len ? end : start + len);
};

/**
 * Read a tar stream (already gunzipped). `place(name, size)` decides each file's fate:
 * return an absolute path to write it there, return null to skip it, or throw to abort.
 * Returns [{ name, size }] for every file written. Truncated or corrupt archives throw.
 */
export async function extractTar(source, place) {
  let buf = Buffer.alloc(0);
  let state = 'header'; // header | body | pad | done
  let remaining = 0;
  let padLeft = 0;
  let out = null;
  let cur = null;
  let zeroBlocks = 0;
  const written = [];

  const closeOut = () => new Promise((resolve, reject) => {
    if (!out) return resolve();
    out.once('error', reject);
    out.end(() => resolve());
  });

  try {
    for await (const chunk of source) {
      let data = chunk;
      while (data.length && state !== 'done') {
        if (state === 'header') {
          buf = Buffer.concat([buf, data]);
          data = Buffer.alloc(0);
          if (buf.length < 512) break;
          const h = buf.subarray(0, 512);
          data = buf.subarray(512);
          buf = Buffer.alloc(0);
          if (h.every((x) => x === 0)) {
            zeroBlocks++;
            if (zeroBlocks >= 2) state = 'done';
            continue;
          }
          zeroBlocks = 0;
          // Verify the header checksum so garbage or a non-tar file is rejected early.
          let sum = 0;
          for (let i = 0; i < 512; i++) sum += (i >= 148 && i < 156) ? 0x20 : h[i];
          const stored = parseInt(field(h, 148, 8).trim() || '-1', 8);
          if (stored !== sum) throw new Error('This file is not a valid game-sauce backup (bad archive header)');
          const name = (field(h, 345, 155) ? `${field(h, 345, 155)}/` : '') + field(h, 0, 100);
          const size = parseInt(field(h, 124, 12).trim() || '0', 8);
          const type = String.fromCharCode(h[156] || 48);
          if (!Number.isFinite(size) || size < 0) throw new Error('Corrupt backup (bad entry size)');
          if (type === '5') continue; // directory entry: nothing to write
          if (type !== '0') throw new Error(`Unsupported entry type in backup: ${name}`);
          const dest = place(name, size);
          if (dest) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            out = fs.createWriteStream(dest);
            out.on('error', () => {}); // cleanup below destroys it; a write already in flight must not become an uncaught error
            cur = { name, size };
          } else { out = null; cur = null; }
          remaining = size;
          padLeft = size % 512 === 0 ? 0 : 512 - (size % 512);
          state = remaining > 0 ? 'body' : (padLeft ? 'pad' : 'header');
          if (remaining === 0 && cur) { await closeOut(); written.push(cur); out = null; cur = null; }
        } else if (state === 'body') {
          const n = Math.min(remaining, data.length);
          if (out && !out.write(data.subarray(0, n))) await new Promise((r) => out.once('drain', r));
          remaining -= n;
          data = data.subarray(n);
          if (remaining === 0) {
            await closeOut();
            if (cur) written.push(cur);
            out = null; cur = null;
            state = padLeft ? 'pad' : 'header';
          }
        } else if (state === 'pad') {
          const n = Math.min(padLeft, data.length);
          padLeft -= n;
          data = data.subarray(n);
          if (padLeft === 0) state = 'header';
        }
      }
    }
    if (state === 'body' || state === 'pad' || (state === 'header' && buf.length > 0)) {
      throw new Error('The backup file is incomplete (it ends part-way through)');
    }
    if (state !== 'done' && zeroBlocks < 1) throw new Error('The backup file is incomplete (no end marker)');
    return written;
  } catch (err) {
    try { out?.destroy(); } catch { /* already closed */ }
    // Let any in-flight write settle (its error is swallowed above) before reporting.
    await new Promise((r) => setImmediate(r));
    throw err;
  }
}

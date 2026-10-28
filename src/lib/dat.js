// DAT file parsing.
//
// A DAT (No-Intro / Redump / TOSEC datfile) is an XML catalogue of every known
// good dump for a system:
//
//   <datafile>
//     <header><name>Nintendo - Super Nintendo Entertainment System</name></header>
//     <game name="Super Metroid (Japan, USA) (En,Ja)">
//       <description>Super Metroid (Japan, USA) (En,Ja)</description>
//       <rom name="Super Metroid (Japan, USA) (En,Ja).sfc"
//            size="3145728" crc="d0f2f6b5" md5="…" sha1="…"/>
//     </game>
//   </datafile>
//
// These files run from a few MB to tens of MB, so they are parsed as a stream and
// handed to a sink in batches rather than loaded into memory as a tree.

import fs from 'node:fs';
import { Parser } from 'saxen';

/** Normalise a hash attribute: DATs are inconsistent about case and padding. */
export function normaliseHash(value, bits) {
  if (!value) return null;
  const hex = String(value).trim().toLowerCase().replace(/[^0-9a-f]/g, '');
  const want = bits / 4;
  if (!hex) return null;
  if (hex.length > want) return hex.slice(-want);   // some tools prefix 0x or pad oddly
  return hex.padStart(want, '0');
}

/** A TOSEC/clr-mamepro "flags" attribute tells us the dump is not a clean one. */
export function statusFromFlags(flags) {
  const f = String(flags || '').toLowerCase();
  if (!f) return 'verified';
  if (/\bbad\b|\bb[0-9]+\b/.test(f)) return 'bad';
  if (/hack|translation|bootleg|alt|overdump|underdump|pirate|proto|beta|demo|sample/.test(f)) return 'variant';
  return 'verified';
}

/** Infer source and system from the DAT header, which is all No-Intro gives us. */
export function describeDat(header = {}) {
  const name = String(header.name || header.description || '').trim();
  const lower = name.toLowerCase();
  let source = 'unknown';
  // No-Intro DATs put the set name in <name> and leave <version> to the date;
  // their presence (and a date-style version) is the best signal we have.
  if (lower.includes('no-intro') || lower.includes('no intro')) source = 'no-intro';
  else if (/^\d{8}-\d{6}$/.test(String(header.version || ''))) source = 'no-intro';
  if (lower.includes('redump')) source = 'redump';
  if (lower.includes('tosec')) source = 'tosec';
  if (lower.includes('mame')) source = 'mame';

  // "Nintendo - Super Nintendo Entertainment System (20240101-000000)" -> system + version
  const version = (name.match(/\((\d{8}-\d{6})\)/) || [])[1] || header.version || null;
  const system = name.replace(/\s*\(\d{8}-\d{6}\)\s*$/, '').trim() || null;

  return { name, source, version, system };
}

/**
 * Stream-parse a DAT file.
 *
 * @param {string} filePath
 * @param {object} opts
 * @param {(batch: Array) => void} opts.onBatch  receives arrays of entries
 * @param {number} [opts.batchSize=2000]
 * @param {object} [opts.header]                 filled in as the header is read
 * @returns {Promise<{games:number, entries:number, header:object}>}
 */
export function parseDat(filePath, { onBatch, batchSize = 2000, header = {} } = {}) {
  return new Promise((resolve, reject) => {
    const parser = new Parser();

    let current = null;           // the <game>/<machine> being read
    let inHeader = false;
    let headerField = null;
    let games = 0;
    let entries = 0;
    let batch = [];
    let finished = false;

    const flush = () => {
      if (batch.length) {
        onBatch?.(batch);
        batch = [];
      }
    };

    parser.on('openTag', (name, attrGetter) => {
      const attrs = attrGetter() || {};

      if (name === 'header') { inHeader = true; return; }
      if (inHeader && ['name', 'description', 'version', 'datversion', 'date'].includes(name)) {
        headerField = name;
        return;
      }

      if (name === 'game' || name === 'machine') {
        games++;
        current = {
          name: attrs.name || null,
          cloneof: attrs.cloneof || null,
          flags: attrs.flags || null,
          description: null
        };
        return;
      }

      if ((name === 'description' || name === 'title') && current && !attrs.text) {
        // <description> may be a child element with text; handled in onText.
        return;
      }

      if (name === 'rom' && current) {
        const size = Number(attrs.size);
        const crc = normaliseHash(attrs.crc, 32);
        const sha1 = normaliseHash(attrs.sha1, 160);
        const md5 = normaliseHash(attrs.md5, 128);
        if (!crc && !sha1) return; // unusable row

        const title = current.description || current.name || attrs.name || 'Unknown';
        batch.push({
          title,
          rom_name: attrs.name || null,
          size: Number.isFinite(size) ? size : null,
          crc32: crc,
          md5,
          sha1,
          status: statusFromFlags(current.flags),
          cloneof: current.cloneof
        });
        entries++;

        if (batch.length >= batchSize) flush();
      }
    });

    parser.on('text', (text) => {
      if (inHeader && headerField) {
        header[headerField] = (header[headerField] ? `${header[headerField]}${text}` : text).trim();
      } else if (current && !current.description) {
        const t = text.trim();
        if (t) current.description = t;
      }
    });

    parser.on('closeTag', (name) => {
      if (name === 'header') { inHeader = false; headerField = null; return; }
      if (name === 'game' || name === 'machine') { current = null; }
    });

    const done = (err) => {
      if (finished) return;
      finished = true;
      if (err) return reject(err);
      flush();
      resolve({ games, entries, header });
    };

    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024, encoding: 'utf8' });
    stream.on('data', (chunk) => {
      try {
        parser.write(chunk);
      } catch (err) {
        stream.destroy();
        done(err);
      }
    });
    stream.on('error', done);
    stream.on('end', () => {
      try {
        parser.end();
      } catch { /* trailing garbage is not fatal */ }
      done();
    });
  });
}

/** Reject anything that is not plausibly a DAT before we stream it. */
export function looksLikeDat(filePath) {
  let head = '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    head = buf.slice(0, read).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
  const lower = head.toLowerCase();
  if (lower.includes('<!doctype html') || lower.includes('<html')) return false;
  return lower.includes('<datafile') || lower.includes('<mame') || lower.includes('<game ') || lower.includes('<machine ');
}

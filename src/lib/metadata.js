// Filename -> structured metadata. This is the offline, always-available matcher:
// it runs before (and without) any remote provider, so an unplugged library still
// gets clean titles, regions, revisions and years instead of raw filenames.

const REGION_TAGS = {
  USA: 'USA', US: 'USA', U: 'USA',
  EUR: 'Europe', E: 'Europe', EU: 'Europe',
  JPN: 'Japan', JP: 'Japan', J: 'Japan',
  AUS: 'Australia', AU: 'Australia',
  KOR: 'Korea', KR: 'Korea',
  CHN: 'China', CN: 'China',
  BRA: 'Brazil', BR: 'Brazil',
  // Long names are valid tag values (they appear after the first region, e.g.
  // "(USA, Europe)") even though they are not used as short codes.
  EUROPE: 'Europe', JAPAN: 'Japan', AUSTRALIA: 'Australia', KOREA: 'Korea',
  CHINA: 'China', BRAZIL: 'Brazil', GERMANY: 'Germany', FRANCE: 'France',
  ITALY: 'Italy', SPAIN: 'Spain', NETHERLANDS: 'Netherlands', SWEDEN: 'Sweden',
  RUSSIA: 'Russia', CANADA: 'Canada',
  WORLD: 'World', W: 'World',
  GER: 'Germany', DE: 'Germany',
  FRA: 'France', FR: 'France',
  ITA: 'Italy', IT: 'Italy',
  SPA: 'Spain', ES: 'Spain',
  NED: 'Netherlands', NL: 'Netherlands',
  SWE: 'Sweden', SE: 'Sweden',
  RUS: 'Russia', RU: 'Russia',
  CAN: 'Canada', CA: 'Canada',
  // Short codes are also valid as the *first* word of a multi-region tag,
  // e.g. "(U, Europe)". Long names are deliberately excluded here so that a
  // title word like "World" inside "(The World)" cannot trigger the rule.
  J: 'Japan', E: 'Europe', U: 'USA', W: 'World', K: 'Korea', G: 'Germany'
};

const JUNK_TAGS = new Set([
  'beta', 'proto', 'prototype', 'demo', 'sample', 'kiosk', 'unl', 'unlicensed',
  'aftermarket', 'homebrew', 'translation', 'hack', 'trainer', 'fixed', 'fix',
  'bad', 'overdump', 'underdump', 'alt', 'alternate'
]);

const NOISE_WORDS = /\[(?:!|b|c|f|h|o|p|t|a)\d*\]/gi;

function cleanTitle(raw) {
  return raw
    .replace(/\s*[(\[]([^)\]]*)[)\]]/g, (m, inner) => (looksLikeTag(inner) ? '' : m))
    .replace(/\s+/g, ' ')
    // Underscores are separators; a dot is punctuation unless it sits between
    // two non-space characters with no space either side ("Sonic.The.Hedgehog").
    .replace(/_+/g, ' ')
    .replace(/(\S)\.(\S)/g, '$1 $2')
    .replace(/\s*-\s*$/, '')
    .trim();
}

const isRegion = (word) => Boolean(REGION_TAGS[word.toUpperCase()]);

// Region priority for multi-region dumps: "(Japan, USA)" is a US release for
// most people's purposes, so USA/EUROPE outrank Japan/World when both appear.
const REGION_PRIORITY = ['USA', 'Europe', 'World', 'Australia', 'Canada', 'Korea',
  'China', 'Brazil', 'Germany', 'France', 'Italy', 'Spain', 'Netherlands',
  'Sweden', 'Russia', 'Japan'];

function preferredRegion(current, next) {
  if (!current) return next;
  if (current === next) return current;
  const a = REGION_PRIORITY.indexOf(current);
  const b = REGION_PRIORITY.indexOf(next);
  if (a === -1) return next;
  if (b === -1) return current;
  return b < a ? next : current;
}

function looksLikeTag(inner) {
  const parts = inner.split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return true;
  // Multi-region tag: "(Japan, USA)", "(U, Europe)" — any known region anywhere
  // in the list means the whole bracket is metadata, not title.
  if (parts.some(isRegion)) return true;
  return parts.every((p) => {
    const up = p.toUpperCase();
    if (/^(sgb|gbc|cgb|enhanced|sgb enhanced|gbc enhanced)$/i.test(p)) return true;
    if (REGION_TAGS[up]) return true;
    if (JUNK_TAGS.has(up.toLowerCase())) return true;
    if (/^rev\s*[a-z0-9]+$/i.test(p)) return true;
    if (/^v\d+(\.\d+)*$/i.test(p)) return true;
    if (/^\d{4}$/.test(p)) return true;
    if (/^(en|ja|fr|de|es|it|pt|nl|sv|ru|ko|zh|multi[\d-]*)$/i.test(p)) return true;
    if (/^[a-z]\d*$/i.test(p) && REGION_TAGS[up]) return true;
    return false;
  });
}

export function parseFilename(filename) {
  // Strip a compression wrapper first: "Game (USA).sfc.zip" is still a SNES game.
  let name = filename;
  for (let i = 0; i < 2; i++) {
    if (/\.(zip|7z|rar|gz)$/i.test(name)) name = name.replace(/\.(zip|7z|rar|gz)$/i, '');
  }
  const base = name.replace(/\.[^.]+$/, '');
  const withoutNoise = base.replace(NOISE_WORDS, '');

  const groups = [...withoutNoise.matchAll(/[(\[]([^)\]]*)[)\]]/g)].map((m) => m[1]);

  let region = null;
  let revision = null;
  let year = null;
  const extraTags = [];

  for (const group of groups) {
    for (const piece of group.split(',').map((s) => s.trim())) {
      if (!piece) continue;
      const up = piece.toUpperCase();
      if (REGION_TAGS[up]) { region = preferredRegion(region, REGION_TAGS[up]); continue; }
      const rev = piece.match(/^rev\s*([a-z0-9]+)$/i);
      if (rev) { revision = rev[1].toUpperCase(); continue; }
      if (/^\d{4}$/.test(piece)) { year = Number(piece); continue; }
      if (/^v\d+(\.\d+)*$/i.test(piece)) { revision = revision || piece.toUpperCase(); continue; }
      if (/^(en|ja|fr|de|es|it|pt|nl|sv|ru|ko|zh|multi[\d-]*)$/i.test(piece)) { extraTags.push(piece.toLowerCase()); continue; }
      if (/^sgb enhanced$/i.test(piece)) { extraTags.push('sgb'); continue; }
      if (/^(gbc|sgb|cgb) enhanced$/i.test(piece)) { extraTags.push(piece.split(' ')[0].toLowerCase()); continue; }
      if (JUNK_TAGS.has(piece.toLowerCase())) { extraTags.push(piece.toLowerCase()); continue; }
    }
  }

  // Measure what bracket-stripping would remove *before* doing it, so we know
  // whether dots in this name are separators or part of the title.
  const bracketMatches = [...withoutNoise.matchAll(/[([][^)\]]*[)\]]/g)];
  const bracketCount = bracketMatches.filter((m) => looksLikeTag(m[0].slice(1, -1))).length;
  const anyBracket = bracketMatches.length > 0;
  let title = cleanTitle(withoutNoise);

  // Dot-separated dumps: "Sonic.The.Hedgehog.2.USA.md" -> "Sonic The Hedgehog 2".
  // Only applied when there is no bracket metadata at all, so that titles which
  // legitimately contain dots are not mangled.
  // Only for names with no bracket metadata: "Mario Kart 8 Deluxe" has none and
  // dots there are punctuation, while "Sonic.The.Hedgehog.2.USA" uses them as
  // separators. A dot followed by a space is punctuation, never a separator.
  const dottedDump = bracketCount === 0 && !anyBracket
    && /[._]/.test(withoutNoise) && !/\.\s/.test(withoutNoise);
  if (dottedDump) {
    const dotted = withoutNoise.split(/[._]/).filter(Boolean);
    const last = dotted[dotted.length - 1]?.toUpperCase();
    if (dotted.length > 1 && REGION_TAGS[last]) {
      region = region || REGION_TAGS[last];
      dotted.pop();
    }
    title = dotted.join(' ').trim();
  }
  // Trailing region suffix written without brackets: "Sonic 2 (USA)" handled above,
  // but "Sonic 2 - USA" also shows up in dumps from some rippers.
  const trailingRegion = title.match(/^(.*\S)\s*[-–]\s*(USA|Europe|Japan|World|EUR|JPN|AUS)$/i);
  if (trailingRegion) {
    title = trailingRegion[1];
    region = region || REGION_TAGS[trailingRegion[2].toUpperCase()];
  }
  if (!title) title = base;

  // A year in front: "1994 - Super Metroid"
  const leadingYear = title.match(/^((?:19|20)\d{2})\s*[-–]\s*(.+)$/);
  if (leadingYear) { year = year || Number(leadingYear[1]); title = leadingYear[2]; }

  return {
    title: title.trim(),
    region,
    revision,
    year,
    tags: extraTags
  };
}

export function sortTitle(title) {
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

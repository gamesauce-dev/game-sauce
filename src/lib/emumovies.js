// EmuMovies: game video snaps, looked up by title and platform and kept on disk.
//
// !! EmuMovies has no public API documentation. Developers must file a "Developer Access Request" with EmuMovies support, and
// !! they then hand out the instructions. Everything that talks to EmuMovies is therefore in ONE place, `defaultApi` below, and is
// !! a best guess that has NOT been checked against the live service. When the real documentation arrives, only `defaultApi`
// !! (login, findVideo) needs to change; the caching, caps, routes and tests all go through `apiImpl` and do not care.
//
// Videos are fetched on demand (the person opens a game and asks for its video), never in bulk, and are kept in
// storage/videos/<platform>/<title>.<ext>. A video belongs to a game title, not to a person, so two people who own the same
// game share the one file; who owns what is never recorded here and a fetch only ever runs for a game the caller can see.
// Credentials come from settings (stored encrypted) and are never logged or echoed.

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import db from '../db.js';
import { providerEnv } from '../settings.js';
import { PLATFORMS } from './platforms.js';

const envVal = (key) => { const v = process.env[key]; return v == null || String(v).trim() === '' ? undefined : String(v).trim(); };
const cred = (key) => { const v = envVal(key) ?? providerEnv()[key]; return typeof v === 'string' && v.trim() ? v.trim() : null; };

const API_BASE = () => (envVal('EMUMOVIES_API_BASE') || 'https://api.emumovies.com').replace(/\/+$/, '');
const TIMEOUT_MS = 20000;
const MISS_RETRY_DAYS = 7;
const MAX_VIDEO_BYTES = () => (Number(envVal('EMUMOVIES_MAX_VIDEO_MB')) > 0 ? Number(envVal('EMUMOVIES_MAX_VIDEO_MB')) : 200) * 1024 * 1024;
const CACHE_LIMIT_BYTES = () => (Number(envVal('EMUMOVIES_CACHE_GB')) > 0 ? Number(envVal('EMUMOVIES_CACHE_GB')) : 20) * 1024 * 1024 * 1024;

const videosDir = () => path.resolve(process.env.GAMESAUCE_STORAGE_DIR || 'storage', 'videos');

/** EmuMovies system names for the platforms whose game-sauce name differs. Anything not listed is asked for by its own name. */
const SYSTEM_NAMES = {
  nes: 'Nintendo Entertainment System', snes: 'Super Nintendo Entertainment System', n64: 'Nintendo 64', gamecube: 'Nintendo Gamecube',
  wii: 'Nintendo Wii', wiiu: 'Nintendo Wii U', switch: 'Nintendo Switch', gb: 'Nintendo Game Boy', gbc: 'Nintendo Game Boy Color',
  gba: 'Nintendo Game Boy Advance', nds: 'Nintendo DS', '3ds': 'Nintendo 3DS', ps1: 'Sony PlayStation', ps2: 'Sony PlayStation 2',
  ps3: 'Sony PlayStation 3', ps4: 'Sony PlayStation 4', psp: 'Sony PSP', psvita: 'Sony PlayStation Vita', genesis: 'Sega Genesis',
  megadrive: 'Sega Mega Drive', mastersystem: 'Sega Master System', saturn: 'Sega Saturn', dreamcast: 'Sega Dreamcast',
  xbox: 'Microsoft Xbox', xbox360: 'Microsoft Xbox 360', arcade: 'MAME', mame: 'MAME'
};
export const systemNameFor = (platform) => {
  const slug = String(platform?.slug || platform || '');
  if (SYSTEM_NAMES[slug]) return SYSTEM_NAMES[slug];
  const row = db.prepare('SELECT name FROM platforms WHERE slug = ?').get(slug);
  return row?.name || platform?.name || slug;
};

/**
 * A game's video is generic (a trailer or gameplay), and the same title usually comes out on several consoles of one generation (PS2, Xbox, GameCube...).
 * So a game with no video of its own uses the one kept for the same title on another console of the same generation: nothing is copied or fetched twice.
 * Home consoles and handhelds are told apart (a handheld game of the same name is often a different game), and arcade boards and computers never share.
 */
const HANDHELD = new Set(['gb', 'gbc', 'gba', 'nds', '3ds', 'psp', 'psvita', 'gamegear', 'lynx', 'virtualboy', 'pokemonmini', 'neogeopocket', 'wonderswan']);
const NO_SHARING = new Set(['arcade', 'mame', 'fba', 'naomi', 'atomiswave', 'segamodel2', 'segamodel3', 'neogeo', 'scummvm', 'dos', 'other']);
const groupOf = (slug) => {
  const p = PLATFORMS.find((x) => x.slug === slug);
  if (!p || p.generation == null || p.family === 'Arcade' || NO_SHARING.has(slug)) return null;
  return `${p.generation}:${HANDHELD.has(slug) ? 'h' : 'c'}`;
};
const sibCache = new Map();
/** The other platforms whose videos a game on this platform may use (same generation, same kind of machine). */
export function siblingPlatforms(slug) {
  if (!sibCache.has(slug)) { const g = groupOf(slug); sibCache.set(slug, g ? PLATFORMS.filter((p) => p.slug !== slug && groupOf(p.slug) === g).map((p) => p.slug) : []); }
  return sibCache.get(slug);
}

/** The same game under different spellings (tags, case, punctuation) is one key. */
export const titleKey = (title) => String(title || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

/* ─────────────────────────── provider ─────────────────────────── */

export const emumovies = {
  id: 'emumovies',
  label: 'EmuMovies',
  docs: 'https://emumovies.com/',
  get enabled() { return Boolean(cred('EMUMOVIES_USER') && cred('EMUMOVIES_PASSWORD')); },
  // Video only: never a source of titles or covers, so enrich() skips it like SteamGridDB.
  async lookup() { return null; },
  async search() { return { error: 'EmuMovies supplies videos only — no title search', items: [] }; }
};

/* ─────────────────── the EmuMovies API (UNVERIFIED) ─────────────────── */

let tokenCache = null; // { token, until }

/** Never let a credential reach a message: the page may echo what was sent. */
function scrub(text) {
  let out = String(text || '').replace(/\s+/g, ' ').slice(0, 200);
  for (const s of [cred('EMUMOVIES_USER'), cred('EMUMOVIES_PASSWORD'), cred('EMUMOVIES_API_KEY'), cred('SS_DEV_ID'), cred('SS_DEV_PASSWORD'), cred('SS_USER'), cred('SS_PASSWORD')]) if (s && s.length > 2) out = out.split(s).join('•••');
  return out;
}

async function call(urlPath, { method = 'GET', body, token, signal } = {}) {
  const key = cred('EMUMOVIES_API_KEY');
  const res = await fetch(`${API_BASE()}${urlPath}`, {
    method, signal: signal || AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      'User-Agent': 'game-sauce', Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(key ? { 'X-Api-Key': key } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return res;
}

export const defaultApi = {
  /** Signs in with the account and returns a token (kept for 50 minutes). Throws an Error with a safe message. */
  async login() {
    if (tokenCache && tokenCache.until > Date.now()) return tokenCache.token;
    let res;
    try { res = await call('/auth/login', { method: 'POST', body: { username: cred('EMUMOVIES_USER'), password: cred('EMUMOVIES_PASSWORD') } }); }
    catch (err) { throw new Error(err.name === 'TimeoutError' || err.name === 'AbortError' ? 'EmuMovies did not answer in time' : (err.cause?.code === 'ENOTFOUND' || err.cause?.code === 'EAI_AGAIN') ? `The EmuMovies address ${new URL(API_BASE()).host} does not exist (the real API address is not published; see Settings, Metadata providers, EmuMovies)` : `Could not reach EmuMovies (${scrub(err.cause?.code || err.message)})`); }
    if (res.status === 401 || res.status === 403) throw new Error('EmuMovies did not accept the username and password (or this account has no API access yet)');
    if (!res.ok) throw new Error(`EmuMovies answered HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    const token = data?.token || data?.access_token;
    if (!token) throw new Error('EmuMovies accepted the login but sent no token');
    tokenCache = { token, until: Date.now() + 50 * 60 * 1000 };
    return token;
  },
  /** { url, name } for the video snap of this title on this system, or null. Throws on a service problem. */
  async findVideo({ system, title }) {
    const token = await this.login();
    const q = new URLSearchParams({ system, name: title, media: 'video' });
    const res = await call(`/media/search?${q}`, { token });
    if (res.status === 404) return null;
    if (res.status === 401) { tokenCache = null; throw new Error('EmuMovies login expired'); }
    if (res.status === 429) throw new Error('EmuMovies rate limit reached (HTTP 429), try again later');
    if (!res.ok) throw new Error(`EmuMovies answered HTTP ${res.status}`);
    const data = await res.json().catch(() => null);
    const hit = (Array.isArray(data) ? data : data?.results || data?.items || [])[0];
    const url = hit?.url || hit?.download_url;
    return url ? { url: String(url), name: hit.name || null } : null;
  }
};

/** Check the account works (for Settings > Test connection). */
export async function testConnection({ apiImpl = defaultApi } = {}) {
  await apiImpl.login();
  return { ok: true };
}
export function forgetToken() { tokenCache = null; }

/* ─────────────────────────── storage ─────────────────────────── */

function sniffVideo(buf) {
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  return null;
}

/** Streams a video to disk, refusing anything over the size cap or that is not a video. Returns { file, bytes } or throws. */
async function download(url, destBase, fetchImpl, { headers = {}, throttle = null } = {}) {
  if (!/^https?:/i.test(url)) throw new Error('The video source sent an address that is not a web link');
  const max = MAX_VIDEO_BYTES();
  const ask = () => fetchImpl(url, { signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'game-sauce', ...headers } });   // a source's own headers go only to that source
  const res = await (throttle ? throttle(ask) : ask());
  if (!res.ok) throw new Error(`The video download answered HTTP ${res.status}`);
  const declared = Number(res.headers.get('content-length'));
  if (declared && declared > max) throw new Error(`The video is larger than the ${Math.round(max / 1048576)} MB limit`);
  const part = `${destBase}.part`;
  fs.mkdirSync(path.dirname(part), { recursive: true });
  const out = fs.createWriteStream(part);
  let bytes = 0, head = Buffer.alloc(0), tooBig = false;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      bytes += chunk.length;
      if (bytes > max) { tooBig = true; break; }
      if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
  } finally { await new Promise((r) => out.end(r)); }
  const kind = sniffVideo(head);
  if (tooBig || !bytes || !kind) {
    try { fs.unlinkSync(part); } catch { /* gone */ }
    throw new Error(tooBig ? `The video is larger than the ${Math.round(max / 1048576)} MB limit` : 'What the video source sent was not a video');
  }
  const file = `${destBase}.${kind}`;
  fs.renameSync(part, file);
  return { file, bytes };
}

/** Oldest videos go first once the folder is over its limit (EMUMOVIES_CACHE_GB, default 20). */
export function trimCache(keep = null) {
  const limit = CACHE_LIMIT_BYTES();
  // Only videos downloaded from a provider are the cache's: ones linked from a pack the person keeps (source 'folder') are theirs, count for nothing here and are never deleted.
  const rows = db.prepare("SELECT platform, title_key, path, bytes FROM game_videos WHERE path IS NOT NULL AND COALESCE(source, 'emumovies') <> 'folder' ORDER BY fetched_at DESC").all();
  let total = rows.reduce((s, r) => s + (r.bytes || 0), 0);
  for (const r of rows.reverse()) {
    if (total <= limit) break;
    if (keep && r.platform === keep.platform && r.title_key === keep.title_key) continue;
    try { fs.unlinkSync(r.path); } catch { /* already gone */ }
    db.prepare('DELETE FROM game_videos WHERE platform = ? AND title_key = ?').run(r.platform, r.title_key);
    total -= r.bytes || 0;
  }
}

export function videoUsage() {
  const r = db.prepare("SELECT COUNT(path) AS videos, COALESCE(SUM(bytes), 0) AS bytes FROM game_videos WHERE COALESCE(source, 'emumovies') <> 'folder'").get();
  const linked = db.prepare("SELECT COUNT(path) AS videos FROM game_videos WHERE source = 'folder'").get();
  return { videos: r.videos, bytes: r.bytes, limit_bytes: CACHE_LIMIT_BYTES(), linked_videos: linked.videos };
}

/** The cached video for a game: { path, bytes } or null (a file that has gone missing is forgotten). */
export function videoFile({ title, platform }) {
  const slug = String(platform?.slug || platform || ''), key = titleKey(title);
  if (!slug || !key) return null;
  const get = db.prepare('SELECT path, bytes, source FROM game_videos WHERE platform = ? AND title_key = ? AND path IS NOT NULL');
  // Its own video first, then the one kept for the same title on a console of the same generation.
  for (const plat of [slug, ...siblingPlatforms(slug)]) {
    const row = get.get(plat, key);
    if (!row) continue;
    if (!fs.existsSync(row.path)) { db.prepare('DELETE FROM game_videos WHERE platform = ? AND title_key = ?').run(plat, key); continue; }   // a file that has gone is forgotten
    return row;
  }
  return null;
}

/** True when a lookup for this game found nothing recently, so the window does not keep offering a search that will fail. */
export function recentlyMissed({ title, platform }) {
  const row = db.prepare('SELECT tried_at FROM game_videos WHERE platform = ? AND title_key = ? AND path IS NULL AND tried_at > datetime(\'now\', ?)')
    .get(String(platform?.slug || platform || ''), titleKey(title), `-${MISS_RETRY_DAYS} days`);
  return Boolean(row);
}

/** Marks list items that already have a kept video (item.has_video = true), so a tile can offer a preview. One query for the lot; items without one are left alone. */
export function flagVideos(items, titleOf, platformOf) {
  const keys = new Set(db.prepare("SELECT platform || char(10) || title_key AS k FROM game_videos WHERE path IS NOT NULL").all().map((r) => r.k));
  if (!keys.size) return items;
  for (const it of items) {
    const p = platformOf(it); if (!p) continue;
    const k = titleKey(titleOf(it));
    if (keys.has(p + '\n' + k) || siblingPlatforms(p).some((s) => keys.has(s + '\n' + k))) it.has_video = true;   // its own video, or one a console of its generation has
  }
  return items;
}

const inflight = new Map();

/**
 * Where a video can come from. Other modules register a source here (ScreenScraper does, in providers.js); EmuMovies is built in. They are tried in order and each fills the gaps
 * of the one before: a source that has nothing, or is unreachable, hands over to the next. A source: { id, label, enabled(), find({ title, platform }) } where find returns
 * null (no video) or { url, headers?, signUrl?(url), throttle?(fn) }, or throws a safe message. A URL that carries a credential never leaves the source: signUrl adds it at download time.
 */
const registered = [];
export function registerVideoSource(src) { if (!registered.some((x) => x.id === src.id)) registered.push(src); }
const emuSource = (apiImpl) => ({
  id: 'emumovies', label: 'EmuMovies', enabled: () => emumovies.enabled,
  async find({ title, platform }) {
    const hit = await apiImpl.findVideo({ system: systemNameFor(platform), title: String(title) });
    const key = cred('EMUMOVIES_API_KEY');
    return hit ? { url: hit.url, headers: key ? { 'X-Api-Key': key } : {} } : null;
  }
});
const sourcesFor = (apiImpl = defaultApi) => [...registered, emuSource(apiImpl)];
/** The sources that are set up (for the window: is there anything to ask?). */
export const videoSourcesEnabled = () => sourcesFor().filter((x) => x.enabled());
export const videoSourceLabel = (id) => (sourcesFor().find((x) => x.id === id)?.label) || (id === 'folder' ? 'your video pack' : id || '');

/**
 * Look a game's video up and keep it. Returns { status: 'ready' | 'none' | 'disabled' | 'error', path?, bytes?, source?, error? }.
 * Already kept (its own, or a console of its generation's): no request at all. Not found anywhere: remembered for a week (force: true asks again).
 * A service problem is never remembered as "none". One fetch per game at a time.
 */
export function ensureVideo({ title, platform, force = false }, { apiImpl = defaultApi, fetchImpl = fetch } = {}) {
  const slug = String(platform?.slug || platform || ''), key = titleKey(title);
  if (!slug || !key) return Promise.resolve({ status: 'none' });
  const have = videoFile({ title, platform: slug });
  if (have) return Promise.resolve({ status: 'ready', ...have });
  const sources = sourcesFor(apiImpl).filter((x) => x.enabled());
  if (!sources.length) return Promise.resolve({ status: 'disabled' });
  if (!force && recentlyMissed({ title, platform: slug })) return Promise.resolve({ status: 'none' });
  const id = `${slug}:${key}`;
  if (inflight.has(id)) return inflight.get(id);
  const job = (async () => {
    try {
      const errors = [], none = [];
      for (const src of sources) {
        let hit = null;
        try { hit = await src.find({ title: String(title), platform: slug }); } catch (err) { errors.push(scrub(err.message)); continue; }
        if (!hit || hit.none !== undefined) { none.push(hit?.none ? `${src.label}: ${hit.none}` : src.label); continue; }   // no video there (and, when the source can say, why)
        try {
          const dest = path.join(videosDir(), slug.replace(/[^a-z0-9_-]/gi, '_'), key.replace(/ /g, '-').slice(0, 120));
          const got = await download(hit.signUrl ? hit.signUrl(hit.url) : hit.url, dest, fetchImpl, { headers: hit.headers, throttle: hit.throttle });
          db.prepare("INSERT INTO game_videos (platform, title_key, path, bytes, source, fetched_at, tried_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now')) ON CONFLICT(platform, title_key) DO UPDATE SET path = excluded.path, bytes = excluded.bytes, source = excluded.source, fetched_at = datetime('now'), tried_at = datetime('now')").run(slug, key, got.file, got.bytes, src.id);
          trimCache({ platform: slug, title_key: key });
          return { status: 'ready', path: got.file, bytes: got.bytes, source: src.id };
        } catch (err) { errors.push(scrub(err.message)); }   // a bad download from one source: the next one is tried
      }
      // A service problem (login refused, rate limit, timeout) is not "no video": it is not remembered, so the next try asks again.
      // Say what each source said: "ScreenScraper has no video" is an answer, and a source that is down is a separate thing.
      if (errors.length) return { status: 'error', error: `${none.length ? `No video was found at ${none.join(' or ')}. ` : ''}${errors.join('; ')}` };
      db.prepare("INSERT INTO game_videos (platform, title_key, tried_at) VALUES (?, ?, datetime('now')) ON CONFLICT(platform, title_key) DO UPDATE SET path = NULL, tried_at = datetime('now')").run(slug, key);
      return { status: 'none', why: none.join(' · ') };
    } finally { inflight.delete(id); }
  })();
  inflight.set(id, job);
  return job;
}

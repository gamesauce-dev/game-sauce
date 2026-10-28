// Metadata providers. Each provider takes ({ title, platform, hashes }) and returns
// a normalised record or null. Providers are tried in order; the first hit wins and
// its name is stored in roms.meta_source.
//
// Nothing here is required for the app to work: with no credentials configured the
// remote providers report `enabled: false` and the library falls back to filename
// parsing plus anything you edit by hand.
//
// Results are cached in metadata_cache keyed by (provider, platform, hashes|title)
// so a rescan or a "refresh all" does not burn API quota re-fetching the same game.

import db from '../db.js';
// Credentials can come from the environment or from the UI (stored encrypted).
// settings.js is the single source of truth for which.
import { providerEnv } from '../settings.js';
// Empty-string env vars (compose passes "" for every unset key) must never
// shadow the database — reuse the same trim-and-ignore-empty helper.
const _envVal = (key) => {
  const raw = process.env[key];
  if (raw == null) return undefined;
  return String(raw).trim() === '' ? undefined : raw;
};
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TIMEOUT_MS = Number(process.env.META_TIMEOUT_MS || 15000);
const CACHE_TTL_HOURS = Number(process.env.META_CACHE_TTL_HOURS || 168);
const MIN_INTERVAL_MS = Number(process.env.SS_MIN_INTERVAL_MS || 1200);

/** Credential lookup: typed value (env pin or DB) first, then the baked-in
 * shared default from SS_DEV_ID_SHARED / SS_DEV_PASSWORD_SHARED.
 * Empty-string env (what compose passes when .env omits a key) never wins. */
function cred(key) {
  const raw = _envVal(key) ?? providerEnv()[key] ?? null;
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  const sharedEnvKey = { SS_DEV_ID: 'SS_DEV_ID_SHARED', SS_DEV_PASSWORD: 'SS_DEV_PASSWORD_SHARED' }[key];
  if (sharedEnvKey) {
    const shared = _envVal(sharedEnvKey);
    if (typeof shared === 'string' && shared.trim() !== '') return shared.trim();
  }
  return null;
}

/* ─────────────────────────── helpers ─────────────────────────── */

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: { 'User-Agent': 'game-sauce/0.2 (+https://github.com/game-sauce)', ...(options.headers || {}) }
    });
    const text = await res.text();
    if (!res.ok) {
      // ScreenScraper returns its error text in French in the body; keep it so the
      // UI can say *why* rather than just "403".
      const body = text.slice(0, 300).replace(/\s+/g, ' ').trim();
      return { error: `HTTP ${res.status}${body ? ` — ${body}` : ''}`, status: res.status, body };
    }
    try {
      return { data: JSON.parse(text) };
    } catch {
      return { error: `unexpected response: ${text.slice(0, 200).replace(/\s+/g, ' ')}`, body: text.slice(0, 300) };
    }
  } catch (err) {
    return { error: err.name === 'AbortError' ? 'timeout' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

function cacheGet(key) {
  const row = db.prepare(`
    SELECT payload FROM metadata_cache
    WHERE key = ? AND fetched_at > datetime('now', ?)
  `).get(key, `-${CACHE_TTL_HOURS} hours`);
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}

function cacheSet(key, provider, payload) {
  db.prepare(`
    INSERT INTO metadata_cache (key, provider, payload, fetched_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = datetime('now')
  `).run(key, provider, JSON.stringify(payload));
}

function cacheKey(provider, platform, hashes, title) {
  const id = hashes?.sha1 || hashes?.crc32 || (title || '').toLowerCase();
  return `${provider}:${platform.slug || 'any'}:${id}`;
}

/* ─────────────────────── media cache ─────────────────────── */

const mediaDir = () => path.resolve(process.env.GAMESAUCE_STORAGE_DIR || 'storage', 'media');
const MAX_MEDIA_BYTES = 16 * 1024 * 1024;

/**
 * Download a provider image once and keep it on disk. Returns the absolute path,
 * or null. Cached by URL hash, so the same box art is never fetched twice and the
 * library still shows covers when the provider is offline.
 */
export async function cacheMedia(url, kind = 'box2d') {
  if (!url || !/^https?:/i.test(url)) return null;
  const MEDIA_DIR = mediaDir();
  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  const hash = crypto.createHash('sha1').update(url).digest('hex');
  const existing = fs.readdirSync(MEDIA_DIR).find((f) => f.startsWith(`${kind}-${hash}.`));
  if (existing) return path.join(MEDIA_DIR, existing);

  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: { 'User-Agent': 'game-sauce/0.2' }
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_MEDIA_BYTES) return null;

    const ct = res.headers.get('content-type') || '';
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : ct.includes('gif') ? 'gif' : 'jpg';
    const dest = path.join(MEDIA_DIR, `${kind}-${hash}.${ext}`);
    fs.writeFileSync(dest, buf);
    return dest;
  } catch {
    return null;
  }
}

/* ─────────────────────── ScreenScraper ─────────────────────── */

// ScreenScraper enforces a per-account request rate. Requests are serialised
// through this queue with a minimum gap, so a bulk refresh cannot get the
// account throttled or banned.
let ssQueue = Promise.resolve();
let ssLastCall = 0;
let ssQuota = null; // { today, max, raw }

function ssThrottle(fn) {
  const run = async () => {
    const wait = Math.max(0, ssLastCall + MIN_INTERVAL_MS - Date.now());
    if (wait) await new Promise((r) => setTimeout(r, wait));
    ssLastCall = Date.now();
    return fn();
  };
  const p = ssQueue.then(run, run);
  ssQueue = p.catch(() => {});
  return p;
}

function pickLocalized(arr, lang = 'en') {
  if (!Array.isArray(arr)) return null;
  return arr.find((x) => x.langue === lang)?.text
    || arr.find((x) => x.langue === 'en')?.text
    || arr[0]?.text
    || null;
}

function ssMedia(game, type, preferredRegions = ['us', 'eu', 'wor', 'jp']) {
  const media = (game.medias || []).filter((m) => m.type === type && m.url);
  if (!media.length) return null;
  for (const region of preferredRegions) {
    const hit = media.find((m) => (m.region || '').toLowerCase() === region);
    if (hit) return hit.url;
  }
  return media[0].url;
}

const screenscraper = {
  id: 'screenscraper',
  label: 'ScreenScraper',
  docs: 'https://www.screenscraper.fr/membreinscription.php',
  // ScreenScraper always requires a developer id/password pair (issued free via
  // its forum), and the account login adds the account's own quota on top. All
  // four are required for the provider to count as configured.
  get enabled() {
    const dev = Boolean(cred('SS_DEV_ID') && cred('SS_DEV_PASSWORD'));
    const acct = Boolean(cred('SS_USER') && cred('SS_PASSWORD'));
    // Accidental whitespace in typed credentials is the common false 403, so
    // the check is on trimmed values.
    return Boolean(dev && acct);
  },
  get quota() {
    return ssQuota;
  },

  async lookup({ title, platform, hashes, filename }) {
    if (!this.enabled) return null;
    if (!platform.screenscraper_id) {
      return { error: `ScreenScraper has no system id for "${platform.slug}"` };
    }

    // MAME-style romsets: the zip NAME (e.g. sf2.zip) is the identifier; hashes
    // of the zip itself match nothing, so match on romnom only.
    const byName = ARCADE_NAME_MATCH.has(platform.slug) && filename;
    if (byName) hashes = null;
    const key = byName ? `ss-romnom:${platform.slug}:${String(filename).toLowerCase()}` : cacheKey('screenscraper', platform, hashes, title);
    const cached = cacheGet(key);
    if (cached) return { ...cached, cached: true };

    const params = new URLSearchParams({
      softname: 'game-sauce',
      output: 'json',
      devid: cred('SS_DEV_ID'),
      devpassword: cred('SS_DEV_PASSWORD'),
      systemeid: String(platform.screenscraper_id),
      romtype: 'rom',
      ssid: cred('SS_USER'),
      sspassword: cred('SS_PASSWORD')
    });
    // Hashes are far more reliable than names: pass every one we have.
    if (hashes?.crc32) params.set('crc', hashes.crc32);
    if (hashes?.md5) params.set('md5', hashes.md5);
    if (hashes?.sha1) params.set('sha1', hashes.sha1);
    if (byName) {
      params.set('romnom', filename);
    } else if (!hashes?.crc32 && !hashes?.md5 && !hashes?.sha1) {
      params.set('romnom', title);
    }

    const result = await ssThrottle(() =>
      fetchJson(`https://api.screenscraper.fr/api2/jeuInfos.php?${params}`)
    );

    if (result.error) {
      const body = result.body || '';
      if (/quota|limite|max/i.test(body)) ssQuota = { exceeded: true, message: body.slice(0, 200) };

      // ScreenScraper answers "Vérifier les identifiants utilisateurs" for a bad
      // login. Its API always requires developer credentials (devid/devpassword)
      // plus the account login, so a 403 on *every* call almost always means the
      // developer pair is missing/wrong (not the site password): check the dev
      // fields, then the account fields.
      if (result.status === 403) {
        const isLoginError = /identifiants|login|connexion/i.test(body);
        return {
          error: isLoginError
            ? 'ScreenScraper rejected the login (HTTP 403 — "check your login details". Your site password can be 100% correct and this still fails: the usual cause is the DEVELOPER ID/password half missing or wrong, not the site password. You need all four fields: devid + devpassword from a forum request, plus site username + password).'
            : result.error,
          needsDeveloperCredentials: isLoginError
        };
      }
      return { error: result.error };
    }

    const data = result.data;
    if (data?.response?.ssuser) {
      const u = data.response.ssuser;
      ssQuota = {
        today: Number(u.requeststoday) || null,
        max: Number(u.maxrequestsperday) || null,
        threads: Number(u.maxthreads) || null
      };
    }

    const game = data?.response?.jeu;
    if (!game) {
      const header = data?.header != null ? ` (api message: ${data.header})` : '';
      return { error: `no match for this ROM on ScreenScraper${header}` };
    }

    const media = {
      box2d: ssMedia(game, 'box-2D'),
      box2dBack: ssMedia(game, 'box-2D-back'),
      screenshot: ssMedia(game, 'ss'),
      fanart: ssMedia(game, 'fanart'),
      wheel: ssMedia(game, 'wheel'),
      marquee: ssMedia(game, 'wheel-hd') || ssMedia(game, 'screenmarquee'),
      video: ssMedia(game, 'video'),
      manual: ssMedia(game, 'manuel')
    };

    const record = {
      title: pickLocalized(game.noms) || title,
      developer: pickLocalized(game.developpeur),
      publisher: pickLocalized(game.editeur),
      genre: game.genres?.map((g) => pickLocalized(g.noms)).filter(Boolean).join(', ') || null,
      release_year: Number((game.dates || []).find((d) => /us|wor|eu/i.test(d.region || ''))?.text?.slice(0, 4))
        || Number(game.dates?.[0]?.text?.slice(0, 4)) || null,
      players: Number(game.joueurs) || null,
      rating: game.note ? Number(game.note) / 20 : null,
      description: pickLocalized(game.synopsis),
      cover_url: media.box2d,
      media,
      source: 'screenscraper',
      source_id: game.id ? String(game.id) : null
    };

    cacheSet(key, 'screenscraper', record);
    return record;
  },

  /** Ask ScreenScraper how much of today's quota is left. */
  async accountInfo() {
    if (!this.enabled) return null;
    const params = new URLSearchParams({
      softname: 'game-sauce',
      output: 'json',
      devid: cred('SS_DEV_ID'),
      devpassword: cred('SS_DEV_PASSWORD'),
      ssid: cred('SS_USER'),
      sspassword: cred('SS_PASSWORD')
    });
    const result = await ssThrottle(() => fetchJson(`https://api.screenscraper.fr/api2/ssuserInfos.php?${params}`));
    const u = result.data?.response?.ssuser;
    if (!u) return { error: result.error || 'no user info', raw: result.data };
    ssQuota = {
      today: Number(u.requeststoday) || null,
      max: Number(u.maxrequestsperday) || null,
      threads: Number(u.maxthreads) || null
    };
    return ssQuota;
  },

  /** Enumerate systems the account can see; used to verify our id table. */
  async systemList() {
    if (!this.enabled) return null;
    const params = new URLSearchParams({
      softname: 'game-sauce',
      output: 'json',
      devid: cred('SS_DEV_ID'),
      devpassword: cred('SS_DEV_PASSWORD'),
      ssid: cred('SS_USER'),
      sspassword: cred('SS_PASSWORD')
    });
    const result = await ssThrottle(() => fetchJson(`https://api.screenscraper.fr/api2/systemesListe.php?${params}`));
    const systems = result.data?.response?.systemes;
    if (!Array.isArray(systems)) return null;
    return systems.map((s) => ({
      id: Number(s.id),
      name: pickLocalized(s.noms) || `System ${s.id}`,
      short: s.nomcourt || null,
      extensions: s.extensions || null
    }));
  }
};

/* ─────────────────────── TheGamesDB ─────────────────────── */

// Query variants for name search, most specific first. Filenames carry region
// tags, revisions and disc numbers that providers don't index, so the first
// query often misses while a stripped one hits. Each lookup tries them in
// order and stops at the first hit — the cached key stays the *original*
// query so a later manual search isn't polluted by a fallback.
function titleVariants(title) {
  const base = String(title || '').trim();
  if (!base) return [];
  const out = [base];
  const push = (t) => {
    const s = t.replace(/\s+/g, ' ').trim().replace(/[\s\-–—:;,.]+$/, '').trim();
    if (s && s.length >= 2 && !out.includes(s)) out.push(s);
  };
  // "Name (USA, Europe) (Rev 1)" -> "Name"
  push(base.replace(/\s*\([^)]*\)\s*/g, ' '));
  // "Name - Disc 2", "Name, Disc 1", "Name Disc 1 (USA)" -> "Name"
  push(base.replace(/\s*[(\-–,]\s*(disc|disk|tape|side|part)\s*[a-z0-9]*\s*[)\]]?\s*$/i, ''));
  push(base.replace(/\s+(disc|disk|tape|side|part)\s*[a-z0-9]+\s*(\([^)]*\))?\s*$/i, ''));
  // Trailing region word without brackets: "Name USA", "Name Europe"
  push(base.replace(/\s*\b(USA|Europe|Japan|World|EUR|JPN|AUS|UK|Germany|France|Italy|Spain)\b\s*(\([^)]*\))?\s*$/i, ''));
  // Trailing revision / version: "Name Rev A", "Name v1.2", "Name r1"
  push(base.replace(/\s*\b(rev\s*[a-z0-9]+|r\d+|v\d+(\.\d+)*)\s*(\([^)]*\))?\s*$/i, ''));
  // Subtitles / alternates: "Ace Driver: Racing Evolution" -> "Ace Driver",
  // "Name / Other Name" -> "Name". Safe only because arcade lookups (below) verify
  // the hit's title against the query before accepting it.
  {
    const bare = base.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
    for (const sep of [/\s*:\s+/, /\s+\/\s+/, /\s+-\s+/]) {
      const left = bare.split(sep)[0];
      if (left && left !== bare && left.length >= 3) push(left);
    }
    push(bare.replace(/&/g, 'and'));
    push(bare.replace(/['’`]/g, ''));
  }
  // Strip parentheticals one at a time from the right for stacked tags:
  // "Name (En) (Rev A)" -> "Name (En)" -> "Name"
  let cur = base;
  for (let i = 0; i < 3; i++) {
    const next = cur.replace(/\s*\([^()]*\)\s*$/, '').trim();
    if (!next || next === cur || next.length < 2) break;
    push(next);
    cur = next;
  }
  return out;
}

/** Arcade (romset) lookups must not accept a loose hit: "sf2"-style wrong covers came
 *  from taking items[0]. Accept a hit only when its title matches the query
 *  (normalised: case, punctuation, "&"/"and"), and only if it has art — otherwise
 *  fall through to the next variant / provider. */
const normTitle = (t) => String(t || '').toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '');
function pickArcadeHit(items, q) {
  const nq = normTitle(q);
  if (nq.length < 3) return null;
  const ok = (items || []).filter((i) => {
    const n = normTitle(i.title);
    return n === nq || (nq.length >= 5 && (n.startsWith(nq) || nq.startsWith(n)) && n.length >= 5);
  });
  return ok.find((i) => i.cover_url) || null;
}

const thegamesdb = {
  id: 'thegamesdb',
  label: 'TheGamesDB',
  docs: 'https://thegamesdb.net/',
  get enabled() {
    return Boolean(cred('TGDB_API_KEY'));
  },
  async lookup({ title, platform, hashes }) {
    if (!this.enabled) return null;

    const key = cacheKey('thegamesdb', platform, hashes, title);
    const cached = cacheGet(key);
    if (cached) return { ...cached, cached: true };

    // v1/ByGameName returns only the stub fields (id, title, date, platform…).
    // overview/boxart/genres/players only appear if explicitly requested via
    // `fields`, and box art only arrives when `include=boxart` is set — without
    // both params the response has no art at all, which is why lookups used to
    // "match" games but never produce covers.
    //
    // Name queries are strict: try the full title, then progressively stripped
    // variants (region tags, disc numbers, revisions). First hit wins and the
    // winning query is reported so the UI can show what actually matched.
    let lastError = null;
    for (const q of titleVariants(title)) {
      const hits = await this.search(q, platform);
      if (hits.error) { lastError = hits.error; continue; }
      if (!hits.items?.length) continue;
      const strict = ARCADE_NAME_MATCH.has(platform.slug);
      const pick = strict ? pickArcadeHit(hits.items, q) : hits.items[0];
      if (!pick) continue;
      const record = { ...pick, media: { box2d: pick.cover_url }, matched_query: q };
      cacheSet(key, 'thegamesdb', record);
      return record;
    }
    if (lastError) return { error: lastError };
    return null;
  },

  /**
   * Name search returning a ranked candidate list for manual matching.
   * Each item carries everything needed to preview and apply it in one step:
   * normalised fields, cover + art flag, TheGamesDB id, and the exact game row
   * (restricted to safe fields) so the UI can show year/platform/coverage.
   * Capped at 10: the API paginates, but a human picks from the first screen.
   */
  async search(query, platform = {}) {
    if (!this.enabled) return { error: 'TheGamesDB API key is required', items: [] };
    const q = String(query || '').trim();
    if (!q) return { error: 'Empty search query', items: [] };

    const params = new URLSearchParams({
      apikey: cred('TGDB_API_KEY'),
      name: q,
      fields: 'players,publishers,genres,overview,rating',
      include: 'boxart'
    });
    if (platform.tgdb_id) params.set('filter[platform]', String(platform.tgdb_id));

    const result = await fetchJson(`https://api.thegamesdb.net/v1/Games/ByGameName?${params}`);
    if (result.error) return { error: result.error, items: [] };

    const games = result.data?.data?.games || [];
    const base = result.data?.include?.boxart?.base_url?.original;
    const artData = result.data?.include?.boxart?.data || {};

    const items = games.slice(0, 10).map((game) => {
      const artFor = artData[String(game.id)];
      const artRows = Array.isArray(artFor) ? artFor : artFor ? [artFor] : [];
      const front = artRows.find((a) => a?.side === 'front' && a?.filename) || artRows.find((a) => a?.filename);

      const genre = Array.isArray(game.genres)
        ? game.genres.map((g) => (typeof g === 'object' ? g.name || g.genre || g.id : g)).filter(Boolean).join(', ') || null
        : (typeof game.genres === 'string' ? game.genres : null);

      return {
        title: game.game_title || q,
        developer: null,
        publisher: game.publishers?.[0] ? String(game.publishers[0]) : null,
        genre,
        release_year: Number(game.release_date?.slice(0, 4)) || null,
        players: game.players ? Number(game.players) || null : null,
        rating: game.rating ? Number(game.rating) : null,
        description: game.overview || null,
        cover_url: base && front ? `${base}${front.filename}` : null,
        has_cover: Boolean(base && front),
        platform_id: game.platform ?? null,
        game_id: game.id ? String(game.id) : null,
        source: 'thegamesdb'
      };
    });

    return { items };
  }
};

/* ─────────────────────── IGDB (Twitch) ─────────────────────── */

// IGDB is the metadata-heavyweight fallback: huge catalogue, strong on modern
// systems where TheGamesDB/DAT coverage is weakest. Auth is OAuth2 client
// credentials against Twitch: POST id.twitch.tv/oauth2/token with the app's
// Client ID + Secret, cache the bearer token until near expiry, then call
// api.igdb.com/v4/games with a tiny Apicalypse query. No user login involved.
let igdbToken = null; // { access_token, expires_at }

async function igdbTokenValid() {
  if (igdbToken && Date.now() < igdbToken.expires_at - 60_000) return igdbToken.access_token;
  igdbToken = null;

  const id = cred('IGDB_CLIENT_ID');
  const secret = cred('IGDB_CLIENT_SECRET');
  if (!id || !secret) return null;

  const body = new URLSearchParams({
    client_id: id,
    client_secret: secret,
    grant_type: 'client_credentials'
  });
  const res = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data?.access_token) return null;
  igdbToken = {
    access_token: data.access_token,
    expires_at: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return igdbToken.access_token;
}

async function igdbFetch(path, apicalypse) {
  const token = await igdbTokenValid();
  if (!token) return { error: 'IGDB Client ID/secret rejected by Twitch (check both values)' };
  return fetchJson(`https://api.igdb.com/v4/${path}`, {
    method: 'POST',
    body: apicalypse,
    headers: {
      'Client-ID': cred('IGDB_CLIENT_ID'),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'text/plain'
    }
  });
}

// IGDB artwork lives on images.igdb.com; size suffixes pick the rendition.
// t_cover_big (264x352) is the right tile size; t_1080p for the detail view.
const igdbImg = (url, size = 't_cover_big') => {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url.replace(/t_thumb\b/, size)}`;
  return url;
};

// Minimal slug map for the platforms people actually scan. IGDB identifies
// platforms by id; unknown slugs simply search unfiltered rather than failing.
const IGDB_PLATFORMS = {
  nes: 18, snes: 19, n64: 4, gamecube: 21, wii: 5, wiiu: 41,
  switch: 130, gb: 33, gbc: 22, gba: 24, nds: 20, '3ds': 37,
  virtualboy: 87, ps1: 7, ps2: 8, ps3: 9, ps4: 48, ps5: 167,
  psp: 38, psvita: 39, xbox: 11, xbox360: 12, xboxone: 49,
  xboxseries: 169, genesis: 29, mastersystem: 64, gamegear: 67,
  saturn: 32, dreamcast: 23, atari2600: 59, lynx: 61, jaguar: 62,
  turbografx16: 86, neogeo: 24, arcade: 52, mame: 52, dos: 13
};

const igdb = {
  id: 'igdb',
  label: 'IGDB',
  docs: 'https://api-docs.igdb.com/#getting-started',
  get enabled() {
    return Boolean(cred('IGDB_CLIENT_ID') && cred('IGDB_CLIENT_SECRET'));
  },
  async lookup({ title, platform, hashes }) {
    if (!this.enabled) return null;
    const key = cacheKey('igdb', platform, hashes, title);
    const cached = cacheGet(key);
    if (cached) return { ...cached, cached: true };

    let lastError = null;
    for (const q of titleVariants(title)) {
      const hits = await this.search(q, platform);
      if (hits.error) { lastError = hits.error; continue; }
      if (!hits.items?.length) continue;
      const strict = ARCADE_NAME_MATCH.has(platform.slug);
      const pick = strict ? pickArcadeHit(hits.items, q) : hits.items[0];
      if (!pick) continue;
      const record = { ...pick, media: pick.media || { box2d: pick.cover_url }, matched_query: q };
      cacheSet(key, 'igdb', record);
      return record;
    }
    if (lastError) return { error: lastError };
    return null;
  },
  /**
   * Name search returning ranked candidates for manual matching. Same shape
   * contract as thegamesdb.search so the UI can mix both providers' rows.
   * Tries the full title then stripped variants (region tags, disc numbers);
   * the lookup() path leans on this loop, while manual search passes the
   * user's already-clean query and typically hits on the first try.
   */
  async search(query, platform = {}) {
    if (!this.enabled) return { error: 'IGDB Client ID/secret required', items: [] };
    const variants = titleVariants(query);
    if (!variants.length) return { error: 'Empty search query', items: [] };

    const plat = IGDB_PLATFORMS[platform.slug];
    let games = [];
    let usedQuery = variants[0];
    for (const safe of variants) {
      const apicalypse = `search "${safe}"; fields name,summary,first_release_date,rating,cover.url,artworks.url,screenshots.url,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,genres.name,game_modes.name,platforms.slug; limit 10;${plat ? ` where platforms = (${plat});` : ''}`;

      const result = await igdbFetch('games', apicalypse);
      if (result.error) return { error: result.error, items: [] };
      if (Array.isArray(result.data) && result.data.length) {
        games = result.data;
        usedQuery = safe;
        break;
      }
    }
    const items = games.slice(0, 10).map((g) => {
      const year = g.first_release_date
        ? new Date(Number(g.first_release_date) * 1000).getUTCFullYear() || null
        : null;
      const companies = Array.isArray(g.involved_companies) ? g.involved_companies : [];
      const dev = companies.find((c) => c.developer)?.company?.name || null;
      const pub = companies.find((c) => c.publisher)?.company?.name
        || companies.find((c) => !c.developer)?.company?.name || null;
      const genres = Array.isArray(g.genres)
        ? g.genres.map((x) => x?.name).filter(Boolean).join(', ') || null
        : null;
      const cover = g.cover?.url ? igdbImg(g.cover.url) : null;
      const shots = [
        ...(Array.isArray(g.artworks) ? g.artworks : []),
        ...(Array.isArray(g.screenshots) ? g.screenshots : [])
      ].map((m) => m?.url).filter(Boolean).slice(0, 4).map((u) => igdbImg(u, 't_1080p'));

      return {
        title: g.name || usedQuery,
        developer: dev,
        publisher: pub,
        genre: genres,
        release_year: year,
        players: null,
        rating: g.rating ? Math.round((Number(g.rating) / 20) * 10) / 10 : null,
        description: g.summary || null,
        cover_url: cover,
        has_cover: Boolean(cover),
        media: { box2d: cover, ...(shots[0] ? { screenshot: shots[0] } : {}) },
        platform_id: platform.slug || null,
        game_id: g.id ? String(g.id) : null,
        source: 'igdb',
        matched_query: usedQuery
      };
    });

    return { items };
  }
};

/* ─────────────────────── SteamGridDB (art fallback) ─────────────────────── */

// Art-only provider: no metadata, just images. Used ONLY as a cover fallback —
// never as a title/genre source — when a metadata match has no art of its own.
// Free key from the user's own SteamGridDB profile; grids are community uploads.
const steamgriddb = {
  id: 'steamgriddb',
  label: 'SteamGridDB',
  docs: 'https://www.steamgriddb.com/profile/preferences/api',
  get enabled() {
    return Boolean(cred('SGDB_API_KEY'));
  },
  // Not a metadata source: lookup always yields nothing so enrich() skips it.
  async lookup() { return null; },
  async search() { return { error: 'SteamGridDB is art-only — no title search', items: [] }; },
  /**
   * Best-effort cover for an already-identified game. Returns a direct image
   * URL or null; never throws, never caches misses as records.
   */
  async coverFor(title) {
    if (!this.enabled) return null;
    const q = String(title || '').trim();
    if (!q) return null;
    try {
      const searchRes = await fetchJson(
        `https://www.steamgriddb.com/api/v2/search/autocomplete/${encodeURIComponent(q)}`,
        { headers: { Authorization: `Bearer ${cred('SGDB_API_KEY')}` } }
      );
      const game = searchRes.data?.data?.[0];
      if (!game?.id) return null;
      const gridsRes = await fetchJson(
        `https://www.steamgriddb.com/api/v2/grids/game/${game.id}?dimensions=600x900&limit=1`,
        { headers: { Authorization: `Bearer ${cred('SGDB_API_KEY')}` } }
      );
      const grid = gridsRes.data?.data?.[0];
      return grid?.url || null;
    } catch {
      return null;
    }
  }
};

const PROVIDERS = [screenscraper, thegamesdb, igdb, steamgriddb];

export function providerStatus() {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    enabled: p.enabled,
    docs: p.docs,
    quota: p.id === 'screenscraper' ? ssQuota : null
  }));
}

/** Romset platforms matched by zip filename (romnom). For these only
 *  ScreenScraper participates: TheGamesDB/IGDB/SteamGridDB search by TITLE, and a
 *  short name like "sf2" matches the wrong games (duplicate covers). */
export const ARCADE_NAME_MATCH = new Set(['mame']);

export async function enrich({ title, platform, hashes, filename, titleTrusted = false }) {
  const errors = [];
  let best = null;

  for (const provider of PROVIDERS) {
    if (!provider.enabled) continue;
    // steamgriddb is art-only: it never participates in metadata matching.
    if (provider.id === 'steamgriddb') continue;
    // Title search is only safe once the title is real (from the MAME name list).
    if (ARCADE_NAME_MATCH.has(platform.slug) && !titleTrusted && provider.id !== 'screenscraper') continue;
    // Romset zips: the zip's own hashes mean nothing to title providers, and an earlier
    // wrong match is cached under that SHA1 — key the lookup on the real title instead.
    const lookupHashes = ARCADE_NAME_MATCH.has(platform.slug) && provider.id !== 'screenscraper' ? null : hashes;
    const result = await provider.lookup({ title, platform, hashes: lookupHashes, filename });
    if (result?.error) { errors.push(`${provider.id}: ${result.error}`); continue; }
    if (result) {
      if (!best) best = result;
      // A hit WITH a cover wins outright; a bare metadata hit is kept as a
      // fallback while later providers are tried for art.
      if (result.cover_url || result.media?.box2d) { best = result; break; }
    }
  }

  // Cover fallback: if the winning metadata has no art, ask SteamGridDB for
  // just an image and attach it without touching any text fields. 404s and
  // misses are silent — a missing cover is not an enrichment failure.
  if (best && !best.cover_url && !best.media?.box2d && (titleTrusted || !ARCADE_NAME_MATCH.has(platform.slug))) {
    try {
      const art = await steamgriddb.coverFor(best.title || title);
      if (art) {
        best = { ...best, cover_url: art, media: { ...(best.media || {}), box2d: art }, cover_source: 'steamgriddb' };
      }
    } catch { /* art fallback must never fail enrichment */ }
  }

  if (best) return best;
  return errors.length ? { error: errors.join('; ') } : null;
}

export { screenscraper, thegamesdb, igdb, steamgriddb, PROVIDERS };

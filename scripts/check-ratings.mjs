#!/usr/bin/env node
// Which age ratings do your providers really return? A one-off check, before age restrictions are built.
//
//   node scripts/check-ratings.mjs                 a few well-known games and 15 from your library, asked of TheGamesDB, IGDB and ScreenScraper
//   --library 30        how many games to take from your library (0 for none)
//   --only igdb         only some providers: any of thegamesdb, igdb, screenscraper, launchbox (comma separated)
//   --launchbox         also read LaunchBox's public database (a download of about 110 MB, deleted afterwards) and count its ratings
//
// It CHANGES NOTHING: the database is opened read-only, nothing is written to it or to the storage folder, and no secret.key is made.
// It uses your provider keys the way the app does, and never prints them. What it prints (game titles and rating labels) is safe to send on.
// Like any lookup, it sends the game titles to the providers it asks, and counts against their daily or monthly allowances.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { Parser } from 'saxen';
import { openZipEntry } from '../src/lib/launchbox.js';   // reads one file out of a zip; that module touches no database of the app's

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const ALL = ['thegamesdb', 'igdb', 'screenscraper', 'launchbox'];
const only = opt('--only') ? opt('--only').split(',').map((s) => s.trim().toLowerCase()) : ALL.filter((p) => p !== 'launchbox' || args.includes('--launchbox'));
const libraryCount = opt('--library') === null ? 15 : Math.max(0, Math.min(100, Number(opt('--library')) || 0));

// The addresses can be pointed elsewhere, which is how the tests run this against pretend providers.
const URLS = {
  tgdb: process.env.RATINGS_TGDB_BASE || 'https://api.thegamesdb.net/v1',
  twitch: process.env.RATINGS_TWITCH_URL || 'https://id.twitch.tv/oauth2/token',
  igdb: process.env.RATINGS_IGDB_BASE || 'https://api.igdb.com/v4',
  ss: (process.env.SS_API_BASE || 'https://api.screenscraper.fr/api2').replace(/\/+$/, ''),
  launchbox: process.env.RATINGS_LAUNCHBOX_URL || 'https://gamesdb.launchbox-app.com/Metadata.zip'
};
const SS_PAUSE = process.env.RATINGS_NO_PAUSE ? 0 : 1500;

/* ───────────── the database (read-only) and the keys ───────────── */

const dataDir = process.env.GAMESAUCE_DATA_DIR || path.resolve('data');
const dbFile = process.env.GAMESAUCE_DB_FILE || path.join(dataDir, 'gamesauce.db');
if (!fs.existsSync(dbFile)) {
  console.error(`No database at ${dbFile}. Run this where game-sauce runs, with GAMESAUCE_DATA_DIR set the way the app has it.`);
  process.exit(1);
}
const db = new Database(dbFile, { readonly: true, fileMustExist: true });

function secretKey() {
  if (process.env.GAMESAUCE_SECRET_KEY) return crypto.createHash('sha256').update(process.env.GAMESAUCE_SECRET_KEY).digest();
  try { const k = Buffer.from(fs.readFileSync(path.join(dataDir, 'secret.key'), 'utf8').trim(), 'base64'); return k.length === 32 ? k : null; } catch { return null; }   // never made here
}
let unreadable = 0;
function stored(key) {
  const row = db.prepare('SELECT value, encrypted FROM app_settings WHERE key = ?').get(key);
  if (!row?.value) return null;
  if (!row.encrypted) return row.value;
  try {
    const [version, iv, tag, data] = row.value.split(':');
    if (version !== 'v1') throw new Error('unknown form');
    const d = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch { unreadable++; return null; }
}
const SHARED = { SS_DEV_ID: 'SS_DEV_ID_SHARED', SS_DEV_PASSWORD: 'SS_DEV_PASSWORD_SHARED' };
const secrets = new Set();
function cred(key) {
  const v = String(process.env[key] || stored(key) || (SHARED[key] ? process.env[SHARED[key]] : '') || '').trim();
  if (v) secrets.add(v);
  return v || null;
}
const CREDS = Object.fromEntries(['TGDB_API_KEY', 'IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET', 'SS_DEV_ID', 'SS_DEV_PASSWORD', 'SS_USER', 'SS_PASSWORD'].map((k) => [k, cred(k)]));

// Everything printed passes through here, so a key cannot appear even if a provider echoes one back.
const clean = (text) => { let s = String(text); for (const v of secrets) if (v.length >= 4) s = s.split(v).join('***').split(encodeURIComponent(v)).join('***'); return s; };
const say = (line = '') => console.log(clean(line));

/* ───────────── which games ───────────── */

const platforms = new Map(db.prepare('SELECT slug, name, screenscraper_id, tgdb_id FROM platforms').all().map((p) => [p.slug, p]));
const KNOWN = [
  ['Super Mario World', 'snes'], ['Mortal Kombat', 'genesis'], ['Resident Evil 4', 'gamecube'],
  ['Grand Theft Auto: San Andreas', 'ps2'], ['Halo 3', 'xbox360'], ['The Last of Us', 'ps3']
];
const games = KNOWN.filter(([, slug]) => platforms.has(slug)).map(([title, slug]) => ({ title, platform: platforms.get(slug), from: 'well known' }));
if (libraryCount) {
  const mine = db.prepare(`SELECT r.title, p.slug FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.is_system = 0 AND r.missing = 0 ORDER BY RANDOM() LIMIT ?`).all(libraryCount);
  for (const g of mine) games.push({ title: String(g.title).replace(/\s*[([].*$/, '').trim() || g.title, platform: platforms.get(g.slug), from: 'your library' });
}

const key = (s) => String(s || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const closest = (list, title, nameOf) => { const want = key(title); return list.find((g) => nameOf(g).some((n) => key(n) === want)) || list[0] || null; };

async function getJson(url, options = {}) {
  let res;
  try { res = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) }); } catch (e) { return { error: `could not reach it (${e.name === 'TimeoutError' ? 'timed out' : e.cause?.code || e.name})` }; }
  const text = await res.text();
  if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status, body: text.slice(0, 200) };
  try { return { data: JSON.parse(text) }; } catch { return { error: 'the answer was not JSON', body: text.slice(0, 200) }; }
}

const report = [];
function startProvider(name) {
  const r = { name, asked: 0, found: 0, rated: 0, errors: 0, labels: new Map() };
  report.push(r);
  say(`\n=== ${name} ===`);
  return r;
}
function line(r, g, found, labels, error) {
  r.asked++;
  const head = `  ${g.title}  [${g.platform?.slug || '?'}; ${g.from}]`;
  if (error) { r.errors++; say(`${head}\n      error: ${error}`); return; }
  if (!found) { say(`${head}\n      not found`); return; }
  r.found++;
  if (labels.length) r.rated++;
  for (const l of labels) r.labels.set(l, (r.labels.get(l) || 0) + 1);
  say(`${head}\n      matched "${found}": ${labels.length ? labels.join(' | ') : 'no age rating'}`);
}
const tooManyErrors = (r) => r.errors >= 3 && r.found === 0;   // a bad key: stop rather than ask twenty more times

/* ───────────── TheGamesDB ───────────── */

async function checkTheGamesDb() {
  const r = startProvider('TheGamesDB');
  if (!CREDS.TGDB_API_KEY) { say('  not set up (no API key)'); return; }
  let allowance = null;
  for (const g of games) {
    const p = new URLSearchParams({ apikey: CREDS.TGDB_API_KEY, name: g.title, fields: 'rating' });
    if (g.platform?.tgdb_id) p.set('filter[platform]', String(g.platform.tgdb_id));
    const res = await getJson(`${URLS.tgdb}/Games/ByGameName?${p}`);
    if (res.error) { line(r, g, null, [], res.error); if (tooManyErrors(r)) break; continue; }
    allowance = res.data?.remaining_monthly_allowance ?? allowance;
    const hit = closest(res.data?.data?.games || [], g.title, (x) => [x.game_title]);
    line(r, g, hit?.game_title, hit?.rating !== undefined && hit?.rating !== null && String(hit.rating).trim() !== '' ? [`rating = ${JSON.stringify(hit.rating)}`] : []);
  }
  if (allowance !== null) say(`  (lookups left this month: ${allowance})`);
}

/* ───────────── IGDB ───────────── */

async function checkIgdb() {
  const r = startProvider('IGDB');
  if (!CREDS.IGDB_CLIENT_ID || !CREDS.IGDB_CLIENT_SECRET) { say('  not set up (no client ID and secret)'); return; }
  const login = await getJson(URLS.twitch, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CREDS.IGDB_CLIENT_ID, client_secret: CREDS.IGDB_CLIENT_SECRET, grant_type: 'client_credentials' }) });
  const token = login.data?.access_token;
  if (!token) { say(`  Twitch did not accept the client ID and secret (${login.error || 'no token'})`); return; }
  secrets.add(token);
  const ask = (fields, title) => getJson(`${URLS.igdb}/games`, { method: 'POST', headers: { 'Client-ID': CREDS.IGDB_CLIENT_ID, Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' }, body: `search "${title.replace(/["\\;]/g, ' ')}"; fields ${fields}; limit 8;` });
  // The field names have changed over time, so ask for the readable ones and fall back to "everything" if IGDB refuses them.
  let fields = 'name,age_ratings.*,age_ratings.organization.name,age_ratings.rating_category.rating';
  let rawShown = false;
  for (const g of games) {
    let res = await ask(fields, g.title);
    if (res.status === 400 && fields.includes('organization')) { say(`  (IGDB refused the readable fields: ${res.body}; asking for the plain ones)`); fields = 'name,age_ratings.*'; res = await ask(fields, g.title); }
    if (res.error) { line(r, g, null, [], res.error); if (tooManyErrors(r)) break; continue; }
    const hit = closest(Array.isArray(res.data) ? res.data : [], g.title, (x) => [x.name]);
    const labels = (hit?.age_ratings || []).map((a) => {
      const board = a?.organization?.name, label = a?.rating_category?.rating;
      return board && label ? `${board} ${label}` : `raw ${JSON.stringify(a).slice(0, 160)}`;
    });
    if (!rawShown && hit?.age_ratings?.length) { say(`  (one rating exactly as IGDB sends it: ${JSON.stringify(hit.age_ratings[0]).slice(0, 300)})`); rawShown = true; }
    line(r, g, hit?.name, labels);
  }
}

/* ───────────── ScreenScraper ───────────── */

async function checkScreenScraper() {
  const r = startProvider('ScreenScraper');
  if (!CREDS.SS_DEV_ID || !CREDS.SS_DEV_PASSWORD || !CREDS.SS_USER || !CREDS.SS_PASSWORD) { say('  not set up (needs the developer pair and your account)'); return; }
  const auth = { devid: CREDS.SS_DEV_ID, devpassword: CREDS.SS_DEV_PASSWORD, softname: 'game-sauce', output: 'json', ssid: CREDS.SS_USER, sspassword: CREDS.SS_PASSWORD };
  const call = async (page, extra) => { await new Promise((ok) => setTimeout(ok, SS_PAUSE)); return getJson(`${URLS.ss}/${page}?${new URLSearchParams({ ...auth, ...extra })}`); };
  let rawShown = false;
  for (const g of games) {
    if (!g.platform?.screenscraper_id) { say(`  ${g.title}  [${g.platform?.slug || '?'}]\n      skipped: no ScreenScraper system number for this platform`); continue; }
    const system = String(g.platform.screenscraper_id);
    const found = await call('jeuRecherche.php', { systemeid: system, recherche: g.title });
    if (found.status === 404) { line(r, g, null, []); continue; }
    if (found.error) { line(r, g, null, [], found.error); if (tooManyErrors(r)) break; continue; }   // the answer's own text can repeat the login, so it is not shown
    const hit = closest((found.data?.response?.jeux || []).filter((x) => x?.id), g.title, (x) => (x.noms || []).map((n) => n.text));
    if (!hit) { line(r, g, null, []); continue; }
    const got = await call('jeuInfos.php', { systemeid: system, gameid: String(hit.id) });
    if (got.error) { line(r, g, null, [], got.error); if (tooManyErrors(r)) break; continue; }
    const jeu = got.data?.response?.jeu;
    const list = Array.isArray(jeu?.classifications) ? jeu.classifications : [];
    if (!rawShown && list.length) { say(`  (ratings exactly as ScreenScraper sends them: ${JSON.stringify(list).slice(0, 400)})`); rawShown = true; }
    line(r, g, jeu?.noms?.[0]?.text || hit.noms?.[0]?.text, list.map((c) => (c?.type && c?.text ? `${c.type} ${c.text}` : `raw ${JSON.stringify(c).slice(0, 120)}`)));
  }
}

/* ───────────── LaunchBox (its public download) ───────────── */

async function checkLaunchBox() {
  const r = startProvider('LaunchBox');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-ratings-'));
  const zip = path.join(dir, 'Metadata.zip');
  try {
    say('  downloading the public database (about 110 MB)...');
    const res = await fetch(URLS.launchbox, { signal: AbortSignal.timeout(900000) });
    if (!res.ok) { say(`  could not download it (HTTP ${res.status})`); return; }
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
    const entry = await openZipEntry(zip, 'Metadata.xml');
    const stream = entry.stream || entry;
    const wanted = new Map(games.map((g) => [key(g.title), g]));
    const hits = new Map();
    const values = new Map();
    let total = 0, rated = 0, inGame = false, field = null, buf = '', rec = {};
    const parser = new Parser();
    parser.on('openTag', (name) => { if (name === 'Game') { inGame = true; rec = {}; } else if (inGame && (name === 'ESRB' || name === 'Name')) { field = name; buf = ''; } });
    parser.on('text', (text, decode) => { if (field) buf += decode(text); });
    parser.on('closeTag', (name) => {
      if (field === name) { rec[name] = buf.trim(); field = null; return; }
      if (name !== 'Game' || !inGame) return;
      inGame = false; total++;
      if (rec.ESRB) { rated++; values.set(rec.ESRB, (values.get(rec.ESRB) || 0) + 1); }
      const k = key(rec.Name);
      if (wanted.has(k) && (!hits.has(k) || (!hits.get(k).ESRB && rec.ESRB))) hits.set(k, rec);
    });
    stream.setEncoding('utf8');
    await new Promise((resolve, reject) => {   // fed to the parser piece by piece, as the app's own LaunchBox import does
      stream.on('data', (chunk) => { try { parser.write(chunk); } catch (e) { stream.destroy(e); } });
      stream.on('error', reject);
      stream.on('end', () => { try { parser.end(); resolve(); } catch (e) { reject(e); } });
    });
    say(`  games in the database: ${total}; with a value in the ESRB field: ${rated}`);
    say(`  values in that field: ${[...values].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([v, n]) => `${JSON.stringify(v)} x${n}`).join(', ') || 'none'}`);
    say('  (matched by title only, on any platform)');
    for (const g of games) { const hit = hits.get(key(g.title)); line(r, g, hit?.Name, hit?.ESRB ? [`ESRB ${hit.ESRB}`] : []); }
  } catch (e) {
    say(`  could not read it: ${e.message}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* ───────────── run ───────────── */

say('game-sauce age rating check (reads only; nothing is changed)');
say(`${games.length} games: ${games.filter((g) => g.from === 'well known').length} well known, ${games.filter((g) => g.from === 'your library').length} from your library`);
if (unreadable) say(`NOTE: ${unreadable} saved key(s) could not be read. Run this with the app's GAMESAUCE_SECRET_KEY set (it is in the app's environment file).`);

const run = { thegamesdb: checkTheGamesDb, igdb: checkIgdb, screenscraper: checkScreenScraper, launchbox: checkLaunchBox };
for (const name of ALL) if (only.includes(name)) await run[name]();

say('\n=== Summary ===');
for (const r of report) {
  say(`${r.name}: asked ${r.asked}, found ${r.found}, with a rating ${r.rated}${r.errors ? `, errors ${r.errors}` : ''}`);
  if (r.labels.size) say(`  labels seen: ${[...r.labels].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([l, n]) => `${l} (${n})`).join('; ')}`);
}
db.close();

// Where a Library game's age rating comes from: IGDB, the downloaded LaunchBox database and, only when a metadata lookup happens to use it,
// TheGamesDB. ScreenScraper's ratings are not used. This file fetches; src/lib/ratings.js decides what a game then holds.
//
// A rating is only taken from an entry whose name is the game's own (src/lib/launchbox.js sameName): a search's closest guess is good enough for
// a cover, but the sequel's rating on the original, or the other way round, is not. The one exception is a match an admin picked by hand.
import db from '../db.js';
import { igdb, igdbKnowsPlatform, launchboxVariants, ARCADE_NAME_MATCH } from './providers.js';
import { launchboxRatings, launchboxHasRatings, sameName } from './launchbox.js';
import { mameTitleTrusted } from './mamenames.js';
import { addFetched, hasAdminRating, flushRatings } from './ratings.js';

const isSameGame = (title, name) => launchboxVariants(title).some((t) => sameName(t, name));

/** Which sources a rating can be asked of right now. launchbox: 'ready', or 'update' when the download predates ratings or there is none. */
export const ratingSources = () => ({ igdb: igdb.enabled, launchbox: launchboxHasRatings() ? 'ready' : 'update' });

/** Everything IGDB and LaunchBox say about the game of this name on this platform. { items, errors } */
export async function gatherRatings({ title, slug }) {
  const items = [...launchboxRatings(launchboxVariants(title), slug)];
  const errors = [];
  if (igdb.enabled && igdbKnowsPlatform(slug)) {
    try {
      const hits = await igdb.search(title, { slug });
      if (hits.error) errors.push(String(hits.error));
      for (const hit of hits.items || []) if (isSameGame(title, hit.title)) items.push(...(hit.age_ratings || []));
    } catch (err) { errors.push(String(err.message || err)); }
  }
  return { items, errors };
}

/**
 * After a metadata match is put on a game. Takes the ratings that came with the match (when it is this very game, or an admin picked it), and, for a
 * game that has none of its own yet, asks the other sources too, so the setting's own board is found at once. A failure never fails the lookup.
 *   title: the game's name BEFORE the match was applied; meta: the matched record; matched: its name; picked: an admin chose this match
 */
export async function ratingsAfterLookup(romId, { title, meta, matched, picked = false }) {
  try {
    if (hasAdminRating(romId)) return;
    const rom = db.prepare('SELECT r.age_level, r.age_inherited, p.slug FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?').get(romId);
    if (!rom) return;
    const name = picked && matched ? matched : title;
    const items = picked || (matched && isSameGame(title, matched)) ? [...(meta.age_ratings || [])] : [];
    flushRatings();
    const own = db.prepare('SELECT age_level, age_inherited FROM roms WHERE id = ?').get(romId);
    if (name && (!own.age_level || own.age_inherited)) items.push(...(await gatherRatings({ title: name, slug: rom.slug })).items);
    addFetched(romId, items);
  } catch (err) {
    console.error(`Age rating for game ${romId} not fetched: ${err.message}`);
  }
}

/* ───────── the Fetch ratings job (ratings only: nothing else about a game changes) ───────── */

const pause = () => Number(process.env.GAMESAUCE_RATINGS_PAUSE_MS ?? 300);   // IGDB allows four requests a second
const job = { running: false, stop: false, platform: '', recheck: false, total: 0, done: 0, rated: 0, unchanged: 0, none: 0, failed: 0, lastError: '', startedAt: null, finishedAt: null };
export const ratingJob = () => ({ ...job });

// Games the job looks at: not System entries and not rated by an admin. Without "recheck", only those with no rating of their own (unrated, or
// showing another version's). With it, rated ones are asked again too: that can only make them stricter.
const candidateSql = (recheck) => `r.is_system = 0 AND (r.age_source IS NULL OR r.age_source <> 'admin' OR r.age_inherited = 1)${recheck ? '' : ' AND (r.age_level IS NULL OR r.age_inherited = 1)'}`;
const scopeSql = "AND (? = '' OR p.slug = ?)";

/** Stop as soon as every source keeps failing, rather than working through the whole library against a bad key. */
const GIVE_UP_AFTER = 10;

async function run() {
  let cursor = 0, failuresInARow = 0;
  try {
    for (;;) {
      if (job.stop) break;
      flushRatings();
      const rows = db.prepare(`SELECT r.id, r.title, r.filename, r.meta_source, p.slug FROM roms r JOIN platforms p ON p.id = r.platform_id
        WHERE r.id > ? AND ${candidateSql(job.recheck)} ${scopeSql} ORDER BY r.id LIMIT 25`).all(cursor, job.platform, job.platform);
      if (!rows.length) break;
      for (const rom of rows) {
        if (job.stop) break;
        cursor = rom.id;
        job.done++;
        // An arcade game still named after its zip ("sf2") cannot be looked up by name.
        const unnamed = ARCADE_NAME_MATCH.has(rom.slug) && !mameTitleTrusted(rom.slug, rom.filename) && ['filename', null].includes(rom.meta_source);
        if (unnamed || hasAdminRating(rom.id)) { job.none++; continue; }
        try {
          const { items, errors } = await gatherRatings({ title: rom.title, slug: rom.slug });
          if (errors.length) job.lastError = errors[0];
          if (!items.length) {
            if (errors.length) { job.failed++; failuresInARow++; } else { job.none++; failuresInARow = 0; }
          } else {
            failuresInARow = 0;
            if (addFetched(rom.id, items)) job.rated++; else job.unchanged++;
          }
        } catch (err) { job.failed++; failuresInARow++; job.lastError = err.message; }
        if (failuresInARow >= GIVE_UP_AFTER) { job.stop = true; break; }
        if (igdb.enabled && pause() > 0) await new Promise((ok) => setTimeout(ok, pause()));
      }
    }
  } catch (err) { job.lastError = err.message; }
  finally { job.running = false; job.finishedAt = new Date().toISOString(); }
}

export function startRatingJob({ platform = '', recheck = false } = {}) {
  if (job.running) throw Object.assign(new Error('Ratings are already being fetched'), { status: 409 });
  const sources = ratingSources();
  if (!sources.igdb && sources.launchbox !== 'ready') throw Object.assign(new Error('There is nowhere to fetch ratings from yet: set up IGDB, or download the LaunchBox database (Settings > Metadata providers).'), { status: 400 });
  if (platform && !db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(platform)) throw Object.assign(new Error('Unknown platform'), { status: 400 });
  flushRatings();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE ${candidateSql(recheck)} ${scopeSql}`).get(platform, platform).n;
  Object.assign(job, { running: true, stop: false, platform, recheck, total, done: 0, rated: 0, unchanged: 0, none: 0, failed: 0, lastError: '', startedAt: new Date().toISOString(), finishedAt: null });
  run();
  return ratingJob();
}

export function stopRatingJob() {
  if (job.running) job.stop = true;
  return ratingJob();
}

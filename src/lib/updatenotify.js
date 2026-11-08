// Tells the admins, in the Messages page (and with the usual toast), when a newer game-sauce has been published: one notice per version, however many times
// it is checked. It is the same check as the update notice in the top bar (src/lib/updatecheck.js), so it respects GAMESAUCE_UPDATE_CHECK=0 and asks GitHub at most
// once every six hours. It says how to update for the way this copy was installed. The notice carries no link (messages never do): the update notice in the Modern
// top bar and in the Classic home strip links to the release page.
import db from '../db.js';
import { checkForUpdate } from './updatecheck.js';
import { postSystemNotice } from './messages.js';

const KEY = 'update_notified';
const getMeta = (k) => db.prepare('SELECT value FROM meta WHERE key = ?').get(k)?.value ?? null;
const setMeta = (k, v) => db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);

/** Given the result of a check: if a newer version is out and the admins have not been told about it yet, tell them. Returns the notice id, or null. */
export function noticeFromCheck(r) {
  if (!r?.newer || !r.latest) return null;
  if (getMeta(KEY) === r.latest) return null;   // already told about this one (even if the notice was dismissed or withdrawn since)
  const id = postSystemNotice(`game-sauce ${String(r.latest).replace(/^v/i, '')} is available (you have ${r.current}). ${r.how || ''}`.trim());
  setMeta(KEY, r.latest);
  return id;
}

/** Check now and tell the admins if needed. Never throws: a GitHub hiccup must not touch anything else. */
export async function checkAndNotify(fetchLatestRelease) {
  try { return noticeFromCheck(await checkForUpdate(fetchLatestRelease)); } catch { return null; }
}

/** From the server: a first check shortly after start, then every six hours. */
export function startUpdateNotifier(fetchLatestRelease, { firstAfterMs = 2 * 60 * 1000, everyMs = 6 * 60 * 60 * 1000 } = {}) {
  const go = () => { checkAndNotify(fetchLatestRelease); };
  setTimeout(go, firstAfterMs).unref();
  setInterval(go, everyMs).unref();
}

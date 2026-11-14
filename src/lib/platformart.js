// Platform art for Big Screen (and the platform tiles everywhere): the logo of each platform and of each family. Three ways in, all of them gap-filling by default:
//   * an admin uploads one (Settings > Platforms; src/app.js),
//   * a folder the admin listed under Artwork folders holds them (importPlatformLogos): a folder called Platforms (or Systems, Consoles) with one picture per platform named for it,
//   * ScreenScraper keeps a logo for each system it knows (fetchPlatformArt): one list request, then one small picture per platform that has none.
// A picture an admin uploaded is only replaced when they ask for replacing. Nothing here is bundled: console logos are trademarks, so they come from the person's own files or from the provider.
import fs from 'node:fs';
import path from 'node:path';
import db from '../db.js';
import { sniffLogo } from './logos.js';
import { resolvePlatform } from './physical.js';
import { screenscraper } from './providers.js';

/** A little more than an upload may be (512 KB): a logo from a media pack or a provider is often a full-size PNG. */
export const MAX_ART_BYTES = 1536 * 1024;
const IMAGE = /\.(png|jpe?g|webp|svg)$/i;
const LOGO_DIRS = /^(platforms?|systems?|consoles?|platform ?logos?|system ?logos?|platform ?art)$/i;
const squash = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Keep a logo for a platform. Returns 'saved', 'had' (it has one and replace is off), 'invalid' (not a picture we accept) or 'big'. */
export function setPlatformLogo(slug, buf, { replace = false } = {}) {
  if (!db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(slug)) return 'invalid';
  if (!replace && db.prepare('SELECT 1 FROM platform_logos WHERE slug = ?').get(slug)) return 'had';
  if (!Buffer.isBuffer(buf) || buf.length > MAX_ART_BYTES) return 'big';
  const kind = sniffLogo(buf);
  if (!kind || kind.error) return 'invalid';
  db.prepare('INSERT INTO platform_logos (slug, data, type, updated) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data, type = excluded.type, updated = excluded.updated').run(slug, buf, kind.type, Date.now());
  return 'saved';
}

/** The same for a family (Sony, Nintendo...). */
export function setFamilyLogo(family, buf, { replace = false } = {}) {
  if (!db.prepare('SELECT 1 FROM platforms WHERE family = ?').get(family)) return 'invalid';
  if (!replace && db.prepare('SELECT 1 FROM family_logos WHERE family = ?').get(family)) return 'had';
  if (!Buffer.isBuffer(buf) || buf.length > MAX_ART_BYTES) return 'big';
  const kind = sniffLogo(buf);
  if (!kind || kind.error) return 'invalid';
  db.prepare('INSERT INTO family_logos (family, data, type, updated) VALUES (?, ?, ?, ?) ON CONFLICT(family) DO UPDATE SET data = excluded.data, type = excluded.type, updated = excluded.updated').run(family, buf, kind.type, Date.now());
  return 'saved';
}

/** The folders that may hold platform logos: the chosen folder itself when it is called Platforms (or similar), and any folder of that name directly inside it (two levels at most). */
function logoDirs(folder) {
  const out = [];
  if (LOGO_DIRS.test(path.basename(folder))) out.push(folder);
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sub = path.join(folder, e.name);
    if (LOGO_DIRS.test(e.name)) out.push(sub);
    else { try { for (const e2 of fs.readdirSync(sub, { withFileTypes: true })) if (e2.isDirectory() && LOGO_DIRS.test(e2.name)) out.push(path.join(sub, e2.name)); } catch { /* unreadable */ } }
  }
  return [...new Set(out)];
}

/** "PlayStation 2 logo", "ps2-logo", "Sony PlayStation 2" -> the platform it is for. */
function platformFor(base) {
  const name = base.replace(/[-_ ]*(logo|wheel|clear ?logo|system)$/i, '').trim();
  return resolvePlatform(name) || resolvePlatform(base) || null;
}

/** Read the platform logos in a listed artwork folder. Returns what was done; nothing outside the folder is read. */
export function importPlatformLogos(folder, { replace = false } = {}) {
  const res = { folders: [], files: 0, saved: [], had: [], families: [], unmatched: [], invalid: [] };
  const families = new Map(db.prepare('SELECT DISTINCT family FROM platforms WHERE family IS NOT NULL').all().map((r) => [squash(r.family), r.family]));
  for (const dir of logoDirs(folder)) {
    res.folders.push(dir);
    let entries = []; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isFile() || !IMAGE.test(e.name)) continue;
      res.files++;
      const base = e.name.replace(/\.[^.]+$/, '');
      let buf; try { buf = fs.readFileSync(path.join(dir, e.name)); } catch { res.invalid.push(e.name); continue; }
      const slug = platformFor(base);
      if (slug) {
        const r = setPlatformLogo(slug, buf, { replace });
        if (r === 'saved') res.saved.push(slug); else if (r === 'had') res.had.push(slug); else res.invalid.push(e.name);
        continue;
      }
      const fam = families.get(squash(base.replace(/[-_ ]*logo$/i, '')));
      if (fam) { const r = setFamilyLogo(fam, buf, { replace }); if (r === 'saved') res.families.push(fam); else if (r !== 'had') res.invalid.push(e.name); continue; }
      res.unmatched.push(e.name);
    }
  }
  return res;
}

/** The ScreenScraper picture to use as a platform's logo: the clean logo first. */
const SYSTEM_LOGO_TYPES = ['wheel-hd', 'wheel', 'logo-svg', 'logo-monochrome'];
export function pickSystemLogo(medias) {
  for (const type of SYSTEM_LOGO_TYPES) {
    const hit = (medias || []).find((m) => m && m.type === type && m.url);
    if (hit) return hit.url;
  }
  return null;
}

/**
 * Fetch a logo for every platform that has none (or every one, with replace) from ScreenScraper's systems. Returns { got, none, failed, why }.
 * One request lists the systems; each picture is one more request through ScreenScraper's own queue.
 */
export async function fetchPlatformArt({ replace = false } = {}) {
  const out = { got: [], none: [], failed: {}, why: null };
  if (!screenscraper.enabled) { out.why = 'ScreenScraper is not set up (Settings, Metadata providers), so there is nothing to fetch from.'; return out; }
  let systems;
  try { systems = await screenscraper.systemArt(); } catch (err) { out.why = String(err.message || err).slice(0, 200); return out; }
  if (!systems) { out.why = 'ScreenScraper sent no list of systems.'; return out; }
  const byId = new Map(systems.map((s) => [s.id, s]));
  for (const p of db.prepare('SELECT slug, screenscraper_id FROM platforms WHERE screenscraper_id IS NOT NULL ORDER BY slug').all()) {
    if (!replace && db.prepare('SELECT 1 FROM platform_logos WHERE slug = ?').get(p.slug)) continue;
    const url = pickSystemLogo(byId.get(p.screenscraper_id)?.medias);
    if (!url) { out.none.push(p.slug); continue; }
    try {
      const buf = await screenscraper.fetchFile(url, MAX_ART_BYTES);
      const r = setPlatformLogo(p.slug, buf, { replace });
      if (r === 'saved') out.got.push(p.slug); else if (r !== 'had') out.failed[p.slug] = r === 'big' ? 'the picture is over the size limit' : 'it is not a picture we can keep';
    } catch (err) { out.failed[p.slug] = String(err.message || err).slice(0, 120); }
  }
  return out;
}

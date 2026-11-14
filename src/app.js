import { slowLogMiddleware, slowLog } from './lib/slowlog.js';
import { playOnlyGuard } from './lib/playonly.js';
import { clearDuplicateCache } from './lib/duplicates.js';
import { usable, FAMILY_DEFAULTS } from './lib/colours.js';
import multer from 'multer';
import { sniffLogo, MAX_LOGO_BYTES, LOGO_HEADERS } from './lib/logos.js';
import express from 'express';
import db from './db.js';
// Side-effect import: forward-compatible schema migrations (sources, source paths,
// provider ids). Must run before anything queries the new columns.
import './migrations.js';
import { seedPlatforms, ICON_TYPES } from './lib/platforms.js';
import romsRouter, { playableSql } from './routes/roms.js';
import collectionsRouter from './routes/collections.js';
import digitalRouter from './routes/digital.js';
import physicalRouter from './routes/physical.js';
import artRouter from './routes/art.js';
import messagesRouter from './routes/messages.js';
import videosRouter from './routes/videos.js';
import metadataRouter from './routes/metadata.js';
import sourcesRouter from './routes/sources.js';
import datsRouter from './routes/dats.js';
import backupRouter from './routes/backup.js';
import emulatorsRouter from './routes/emulators.js';
import authRouter, {
  attachUser, requireAdmin, requireAuth, sessionCookie
} from './routes/auth.js';
import { audit, bootstrapAdmin, initAuthTables, purgeExpiredSessions } from './auth.js';
import { originGuard, rateLimit } from './lib/guard.js';
import { canDownload } from './lib/policy.js';
import { launcherEntries } from './lib/launcherpack.js';
import { zipChunks } from './lib/export.js';
import { launchFileHandler, launcherSyncHandler, launcherPlatformsHandler, mintSyncToken } from './lib/launch.js';

// The public library list (`GET /api/platforms`) reports ROM counts; the
// admin catalogue below needs extensions as an array and must be auditable,
// so both shapes live here next to those routes.
function shapePlatform(row) {
  if (!row) return row;
  return {
    ...row,
    extensions: row.extensions ? String(row.extensions).split(',').map((s) => s.trim()).filter(Boolean) : []
  };
}

export function createApp() {
  // Users and sessions must exist before dats.js runs: its tables reference
  // users(id), and SQLite resolves foreign keys when the CREATE TABLE runs.
  initAuthTables();

  seedPlatforms(db);
  purgeExpiredSessions();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', process.env.GAMESAUCE_TRUST_PROXY === '1');
  app.use(express.json({ limit: '2mb' }));

  // Basic hardening. No CSP nonce machinery — this is a local single-page app
  // that loads only its own assets.
  // Framing: SAMEORIGIN everywhere (not DENY). DENY also blocks our own
  // in-browser player iframe (/ejs-player.html), which is same-origin by
  // design — the emulator, its audio and its WASM die with the frame on
  // close. SAMEORIGIN still blocks external clickjacking.
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });

  app.use(attachUser);

  /* ─────────────────────────────── API ─────────────────────────────── */

  const api = express.Router();

  // Cross-site request check, then per-user rate limits (see src/lib/guard.js).
  api.use(slowLogMiddleware);
  // The duplicate finder reuses its answer for 30 s. Any request that changes data (lock, hide, system, rename, delete,
  // scan, upload, metadata...) throws that answer away when it finishes, so the finder never shows stale groups after a change.
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') res.once('finish', clearDuplicateCache);
    next();
  });
  api.use(originGuard({ trustProxy: process.env.GAMESAUCE_TRUST_PROXY === '1' }));
  api.use(rateLimit());

  // Public: health and the auth surface. Everything else needs a session.
  api.get('/health', (req, res) => {
    const { roms } = db.prepare('SELECT COUNT(*) AS roms FROM roms').get();
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({ ok: true, roms, users, uptime: Math.round(process.uptime()) });
  });

  api.use('/auth', authRouter);

  // Play locally: the launcher on the user's PC has no session, so the one-time token in the address is its credential
  // (see src/lib/launch.js). Must stay above requireAuth.
  api.get('/launch/:token', launchFileHandler);
  // The launcher reports which platforms it has an emulator for (the one-time sync token is its credential; see mintSyncToken below).
  api.post('/launcher/sync', launcherSyncHandler);
  api.get('/launcher/platforms', launcherPlatformsHandler);

  // Is a newer game-sauce published? Admin only (it is the admin who updates the server). See src/lib/updatecheck.js.
  api.get('/admin/update-check', requireAuth, requireAdmin, async (req, res) => {
    const { checkForUpdate } = await import('./lib/updatecheck.js');
    const { fetchLatestRelease } = await import('./routes/emulators.js');
    const result = await checkForUpdate(fetchLatestRelease);
    (await import('./lib/updatenotify.js')).noticeFromCheck(result);   // the first admin to look also gets it in Messages, if the timer has not already
    res.json(result);
  });

  // Duplicate finder (read-only, admin): see src/lib/duplicates.js. Hiding the extras uses /roms/bulk/hide.
  api.get('/admin/duplicates', requireAuth, requireAdmin, async (req, res) => {
    const { findDuplicates } = await import('./lib/duplicates.js');
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(findDuplicates({ platform: req.query.platform ? String(req.query.platform) : null, limit, offset, uid: req.user.id }));
  });

  // Your say in the duplicate finder: 1 = keep this copy, 0 = do not keep it, null = automatic. Survives re-runs.
  api.post('/admin/duplicates/keep', requireAuth, requireAdmin, (req, res) => {
    const id = Number(req.body?.id);
    const v = req.body?.value === 1 || req.body?.value === 0 ? req.body.value : null;
    if (!Number.isInteger(id) || !db.prepare('SELECT 1 FROM roms WHERE id = ?').get(id)) return res.status(404).json({ error: 'Game not found' });
    db.prepare('UPDATE roms SET keep_override = ? WHERE id = ?').run(v, id);
    res.json({ id, value: v });
  });

  // Requests that took over a second (what, how long, how many others were running): finds out WHY it felt slow.
  api.get('/admin/slow-requests', requireAuth, requireAdmin, (req, res) => res.json(slowLog()));

  // Admin health report (read-only): see src/lib/health.js.
  // Library figures for Settings > Stats (admin, read-only).
  api.get('/admin/stats', requireAuth, requireAdmin, async (req, res) => {
    const { collectStats } = await import('./lib/stats.js');
    res.json(collectStats());
  });

  api.get('/admin/health', requireAuth, requireAdmin, async (req, res) => {
    const { collectHealth, collectSummary, diagnosticsText } = await import('./lib/health.js');
    const report = collectHealth();
    const summary = collectSummary();
    res.json({ ...report, summary, diagnostics: diagnosticsText(report, summary), checked_at: new Date().toISOString() });
  });

  api.use(requireAuth);
  api.use(playOnlyGuard); // play-only accounts: an allow-list, see lib/playonly.js

  // Audited mutations: log every non-GET request with who did it.
  // For ROM-scoped routes, resolve the ROM's title + platform FIRST so the
  // summary can name the game ("deleted ROM 42 (Sonic 2 · Genesis)") instead
  // of a bare id. Mounted on `api` (BEFORE /roms), so req.baseUrl here is
  // "/api" and req.path is the remainder; req.params is still empty at this
  // point, hence the manual match. Single-row SELECT; display-only.
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (/^\/api\/messages(?!\/notices)(?:[/?#]|$)/.test(req.originalUrl || '')) return next();   // private: not in the audit log, which an admin reads
    const m = `${req.originalUrl || ''}`.match(/\/api\/roms\/(\d+)(?:\/|[?#]|$)/);
    if (m) {
      try {
        req.romSnapshot = db.prepare(`
          SELECT r.id, r.title, p.name AS platform_name
          FROM roms r JOIN platforms p ON p.id = r.platform_id
          WHERE r.id = ?
        `).get(Number(m[1])) || null;
      } catch { req.romSnapshot = null; }
    }
    res.on('finish', () => {
      if (res.statusCode < 400) {
        const snap = req.romSnapshot
          ? { rom_id: req.romSnapshot.id, title: req.romSnapshot.title, platform: req.romSnapshot.platform_name, ...(req.romSnapshot.hidden !== undefined ? { hidden: req.romSnapshot.hidden } : {}) }
          : (req.auditDetail || null);
        audit(req.user, `${req.method} ${req.baseUrl}${req.path}`, {
          target: req.params?.id || null,
          detail: snap,
          ip: (req.ip || '').replace(/^::ffff:/, '')
        });
      }
    });
    next();
  });

  // The colour of a family: the one chosen in Settings, else the built-in default for that family, else grey.
  const familyLogoMap = () => Object.fromEntries(db.prepare('SELECT family, updated FROM family_logos').all().map((r) => [r.family, r.updated]));
  const familyPlateMap = () => Object.fromEntries(db.prepare('SELECT family, plate FROM family_logos').all().map((r) => [r.family, r.plate]));
  const familyColourMap = () => {
    const m = { ...FAMILY_DEFAULTS };
    for (const r of db.prepare('SELECT family, colour FROM family_colours').all()) m[r.family] = r.colour;
    return m;
  };
  api.get('/platforms', (req, res) => {
    const fc = familyColourMap(), fl = familyLogoMap(), fp = familyPlateMap();
    res.json({
      items: db.prepare(`
        SELECT p.*, COUNT(r.id) AS count,
               COUNT(CASE WHEN ${playableSql()} AND r.hidden_all = 0 AND r.source_hidden = 0 AND NOT EXISTS (SELECT 1 FROM hidden_roms hp WHERE hp.rom_id = r.id AND hp.user_id = ${req.user ? Number(req.user.id) : -1}) THEN r.id END) AS playable_count,
               COUNT(CASE WHEN r.is_system = 0 AND r.hidden_all = 0 AND r.source_hidden = 0 AND NOT EXISTS (SELECT 1 FROM hidden_roms hr WHERE hr.rom_id = r.id AND hr.user_id = ${req.user ? Number(req.user.id) : -1}) THEN r.id END) AS visible_count
        , (SELECT updated FROM platform_logos pl WHERE pl.slug = p.slug) AS logo_v
        , COALESCE((SELECT plate FROM platform_logos pl WHERE pl.slug = p.slug), 0) AS logo_plate
        FROM platforms p LEFT JOIN roms r ON r.platform_id = p.id${req.user?.role === 'admin' ? ' AND r.source_hidden = 0' : ' AND r.hidden_all = 0 AND r.source_hidden = 0'}
        GROUP BY p.id ORDER BY p.family COLLATE NOCASE, p.name COLLATE NOCASE
      `).all().map((p) => ({ ...p, family_colour: fc[p.family] || '#6b7280', family_logo_v: fl[p.family] || null, family_logo_plate: fp[p.family] || 0 }))
    });
  });

  // NOTE: keep ALL literal /platforms/* routes (all, new, :slug meta, …)
  // registered BEFORE the generic sub-router below. Express matches in
  // registration order, and /roms/bulk/* taught us that a "/:id" route
  // swallows literal segments like "all" if it gets there first.
  const shapePlatform = (row) => row ? ({
    ...row,
    extensions: row.extensions ? String(row.extensions).split(',').map((s) => s.trim()).filter(Boolean) : []
  }) : row;

  // ── Admin platform catalogue ──────────────────────────────────────────
  // Platforms are seed data, but arcade/odd systems (Model 2/3, NAOMI, …)
  // evolve: new rows, corrected provider ids, extra extensions. Admins can
  // manage them here without editing source; every change takes effect
  // immediately because lookups read the DB each time.
  const PLATFORM_FIELDS = ['name', 'short_name', 'family', 'manufacturer', 'generation', 'accent', 'screenscraper_id', 'tgdb_id', 'extensions', 'icon', 'badge'];

  // A family is only a label that groups platforms (nothing in metadata lookups reads it). A name typed in a different case
  // ("sega") joins the existing group ("Sega") instead of making a second one.
  const canonFamily = (name) => {
    const t = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!t) return '';
    const hit = db.prepare('SELECT DISTINCT family FROM platforms WHERE family IS NOT NULL').all().map((r) => r.family).find((f) => f.toLowerCase() === t.toLowerCase());
    return hit || t;
  };

  // Rename a family for every platform in it at once. If the new name is another existing family the two are merged.
  api.post('/platforms/families/rename', requireAdmin, (req, res) => {
    const from = String(req.body?.from || '').trim();
    const to = canonFamily(req.body?.to);
    if (!from) return res.status(400).json({ error: 'Which family?' });
    if (!to) return res.status(400).json({ error: 'The new name cannot be empty' });
    const exists = db.prepare('SELECT COUNT(*) AS n FROM platforms WHERE family = ?').get(from).n;
    if (!exists) return res.status(404).json({ error: 'No such family' });
    const merged = to !== from && db.prepare('SELECT 1 FROM platforms WHERE family = ?').get(to) ? true : false;
    const changed = to === from ? 0 : db.prepare('UPDATE platforms SET family = ? WHERE family = ?').run(to, from).changes;
    if (to !== from) {
      if (merged) db.prepare('DELETE FROM family_logos WHERE family = ?').run(from);
      else db.prepare('UPDATE family_logos SET family = ? WHERE family = ?').run(to, from);
      const mine = db.prepare('SELECT colour FROM family_colours WHERE family = ?').get(from);
      db.prepare('DELETE FROM family_colours WHERE family = ?').run(from);
      if (mine && !merged) db.prepare('INSERT OR REPLACE INTO family_colours (family, colour) VALUES (?, ?)').run(to, mine.colour);
      else if (!mine && !merged && FAMILY_DEFAULTS[from]) db.prepare('INSERT OR IGNORE INTO family_colours (family, colour) VALUES (?, ?)').run(to, FAMILY_DEFAULTS[from]);
    }
    req.auditDetail = { from, to, platforms: changed, merged };
    res.json({ from, to, changed, merged });
  });

  api.get('/platforms/all', requireAdmin, (req, res) => {
    const fc = familyColourMap(), fl = familyLogoMap(), fp = familyPlateMap();
    res.json({
      items: db.prepare('SELECT p.*, (SELECT updated FROM platform_logos pl WHERE pl.slug = p.slug) AS logo_v, COALESCE((SELECT plate FROM platform_logos pl WHERE pl.slug = p.slug), 0) AS logo_plate FROM platforms p ORDER BY p.family COLLATE NOCASE, p.name COLLATE NOCASE').all().map(shapePlatform).map((p) => ({ ...p, family_colour: fc[p.family] || '#6b7280', family_logo_v: fl[p.family] || null, family_logo_plate: fp[p.family] || 0 })),
      defaults: FAMILY_DEFAULTS
    });
  });

  // ── Platform logos (admin uploads; anyone signed in can see them) ──
  const logoUpload = multer({ limits: { fileSize: MAX_LOGO_BYTES } });
  // Family logos. The family name goes in the query (names such as "NEC / SNK" contain a slash). Registered first so "families" is never read as a slug.
  api.get('/platforms/families/logo', requireAuth, (req, res) => {
    const row = db.prepare('SELECT data, type FROM family_logos WHERE family = ?').get(String(req.query.family || ''));
    if (!row) return res.status(404).end();
    res.set(LOGO_HEADERS(row.type)).send(row.data);
  });
  api.post('/platforms/families/logo', requireAdmin, (req, res) => {
    logoUpload.single('logo')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That logo is over 512 KB' : err.message });
      const family = String(req.body?.family || '').trim();
      if (!family || !db.prepare('SELECT 1 FROM platforms WHERE family = ?').get(family)) return res.status(404).json({ error: 'No such family' });
      if (!req.file) return res.status(400).json({ error: 'Choose a picture first' });
      const kind = sniffLogo(req.file.buffer);
      if (!kind) return res.status(400).json({ error: 'That file is not a JPEG, PNG, WebP or SVG picture' });
      if (kind.error) return res.status(400).json({ error: kind.error });
      const v = Date.now();
      db.prepare('INSERT INTO family_logos (family, data, type, updated) VALUES (?, ?, ?, ?) ON CONFLICT(family) DO UPDATE SET data = excluded.data, type = excluded.type, updated = excluded.updated').run(family, req.file.buffer, kind.type, v);
      req.auditDetail = { family, type: kind.type, bytes: req.file.buffer.length };
      res.json({ family, logo_v: v, type: kind.type });
    });
  });
  api.put('/platforms/families/logo/plate', requireAdmin, (req, res) => {
    const family = String(req.body?.family || '');
    const row = db.prepare('SELECT 1 FROM family_logos WHERE family = ?').get(family);
    if (!row) return res.status(404).json({ error: 'That family has no logo yet' });
    const plate = req.body?.plate ? 1 : 0;
    db.prepare('UPDATE family_logos SET plate = ? WHERE family = ?').run(plate, family);
    req.auditDetail = { family, plate: Boolean(plate) };
    res.json({ family, plate });
  });
  api.delete('/platforms/families/logo', requireAdmin, (req, res) => {
    const family = String(req.query.family || '');
    db.prepare('DELETE FROM family_logos WHERE family = ?').run(family);
    req.auditDetail = { family, removed: true };
    res.json({ family, logo_v: null });
  });
  api.get('/platforms/:slug/logo', requireAuth, (req, res) => {
    const row = db.prepare('SELECT data, type FROM platform_logos WHERE slug = ?').get(String(req.params.slug || '').toLowerCase());
    if (!row) return res.status(404).end();
    res.set(LOGO_HEADERS(row.type)).send(row.data);
  });
  api.post('/platforms/:slug/logo', requireAdmin, (req, res) => {
    logoUpload.single('logo')(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That logo is over 512 KB' : err.message });
      const slug = String(req.params.slug || '').toLowerCase();
      if (!db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(slug)) return res.status(404).json({ error: 'Unknown platform' });
      if (!req.file) return res.status(400).json({ error: 'Choose a picture first' });
      const kind = sniffLogo(req.file.buffer);
      if (!kind) return res.status(400).json({ error: 'That file is not a JPEG, PNG, WebP or SVG picture' });
      if (kind.error) return res.status(400).json({ error: kind.error });
      const v = Date.now();
      db.prepare('INSERT INTO platform_logos (slug, data, type, updated) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO UPDATE SET data = excluded.data, type = excluded.type, updated = excluded.updated').run(slug, req.file.buffer, kind.type, v);
      req.auditDetail = { platform: slug, type: kind.type, bytes: req.file.buffer.length };
      res.json({ slug, logo_v: v, type: kind.type });
    });
  });
  api.put('/platforms/:slug/logo/plate', requireAdmin, (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    if (!db.prepare('SELECT 1 FROM platform_logos WHERE slug = ?').get(slug)) return res.status(404).json({ error: 'That platform has no logo yet' });
    const plate = req.body?.plate ? 1 : 0;
    db.prepare('UPDATE platform_logos SET plate = ? WHERE slug = ?').run(plate, slug);
    req.auditDetail = { platform: slug, plate: Boolean(plate) };
    res.json({ slug, plate });
  });
  api.delete('/platforms/:slug/logo', requireAdmin, (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    db.prepare('DELETE FROM platform_logos WHERE slug = ?').run(slug);
    req.auditDetail = { platform: slug, removed: true };
    res.json({ slug, logo_v: null });
  });

  // Set (or, with an empty colour, reset) a family's colour. Refused when it could not be seen on both themes.
  api.put('/platforms/families/colour', requireAdmin, (req, res) => {
    const family = String(req.body?.family || '').trim();
    if (!family || !db.prepare('SELECT 1 FROM platforms WHERE family = ?').get(family)) return res.status(404).json({ error: 'No such family' });
    const raw = String(req.body?.colour || '').trim();
    if (!raw) {
      db.prepare('DELETE FROM family_colours WHERE family = ?').run(family);
      req.auditDetail = { family, reset: true };
      return res.json({ family, colour: FAMILY_DEFAULTS[family] || '#6b7280', reset: true });
    }
    const u = usable(raw);
    if (!u.ok) return res.status(400).json({ error: u.reason });
    db.prepare('INSERT INTO family_colours (family, colour) VALUES (?, ?) ON CONFLICT(family) DO UPDATE SET colour = excluded.colour').run(family, u.colour);
    req.auditDetail = { family, colour: u.colour };
    res.json({ family, colour: u.colour });
  });

  api.post('/platforms', requireAdmin, (req, res) => {
    const slug = String(req.body?.slug || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!slug) return res.status(400).json({ error: 'slug is required (lowercase letters/digits)' });
    if (db.prepare('SELECT 1 FROM platforms WHERE slug = ?').get(slug)) {
      return res.status(409).json({ error: 'That slug already exists' });
    }
    const name = String(req.body?.name || slug).trim();
    const exts = [...new Set(Array.isArray(req.body?.extensions)
      ? req.body.extensions.map((s) => String(s).toLowerCase().replace(/^\./, '').trim()).filter(Boolean)
      : String(req.body?.extensions || '').split(',').map((s) => s.toLowerCase().replace(/^\./, '').trim()).filter(Boolean))];
    const row = {
      slug,
      name,
      short_name: String(req.body?.short_name || slug.toUpperCase().slice(0, 6)).trim(),
      family: canonFamily(req.body?.family) || 'Others',
      manufacturer: String(req.body?.manufacturer || '').trim() || null,
      generation: req.body?.generation === '' || req.body?.generation == null ? null : Number(req.body.generation),
      accent: String(req.body?.accent || '#6b7280').trim(),
      screenscraper_id: req.body?.screenscraper_id === '' || req.body?.screenscraper_id == null ? null : Number(req.body.screenscraper_id),
      tgdb_id: req.body?.tgdb_id === '' || req.body?.tgdb_id == null ? null : Number(req.body.tgdb_id),
      extensions: exts.join(','),
      icon: ICON_TYPES.includes(String(req.body?.icon || '')) ? String(req.body.icon) : null
    };
    if (row.generation !== null && !Number.isFinite(row.generation)) return res.status(400).json({ error: 'generation must be a number' });
    if (row.screenscraper_id !== null && !Number.isFinite(row.screenscraper_id)) return res.status(400).json({ error: 'screenscraper_id must be a number' });
    if (row.tgdb_id !== null && !Number.isFinite(row.tgdb_id)) return res.status(400).json({ error: 'tgdb_id must be a number' });
    try {
      db.prepare(`
        INSERT INTO platforms (slug, name, short_name, family, manufacturer, generation, accent, screenscraper_id, tgdb_id, extensions, icon)
        VALUES (@slug, @name, @short_name, @family, @manufacturer, @generation, @accent, @screenscraper_id, @tgdb_id, @extensions, @icon)
      `).run(row);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.status(201).json(shapePlatform(db.prepare('SELECT * FROM platforms WHERE slug = ?').get(slug)));
  });

  api.patch('/platforms/:slug', requireAdmin, (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    const existing = db.prepare('SELECT * FROM platforms WHERE slug = ?').get(slug);
    if (!existing) return res.status(404).json({ error: 'Unknown platform' });
    const sets = [];
    const params = { slug };
    for (const f of PLATFORM_FIELDS) {
      if (req.body[f] === undefined) continue;
      let v = req.body[f];
      const normExts = (x) => [...new Set((Array.isArray(x) ? x : String(x).split(',')).map((s) => String(s).toLowerCase().replace(/^\./, '').trim()).filter(Boolean))].join(',');
      if (f === 'extensions') v = normExts(v);
      if ((f === 'generation' || f === 'screenscraper_id' || f === 'tgdb_id') && (v === '' || v == null)) v = null;
      if ((f === 'generation' || f === 'screenscraper_id' || f === 'tgdb_id') && v !== null) {
        v = Number(v);
        if (!Number.isFinite(v)) return res.status(400).json({ error: `${f} must be a number or empty` });
      }
      if ((f === 'manufacturer') && v === '') v = null;
      if (f === 'badge') { v = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 12); if (v === '') v = null; }   // the text on its badges; empty = the default
      if (f === 'family') v = canonFamily(v) || 'Others';
      if (f === 'icon') { v = v === '' || v == null ? null : String(v); if (v !== null && !ICON_TYPES.includes(v)) return res.status(400).json({ error: `icon must be one of: ${ICON_TYPES.join(', ')}` }); }
      sets.push(`${f} = @${f}`);
      params[f] = v;
    }
    if (!sets.length) return res.json(shapePlatform(existing));
    try {
      db.prepare(`UPDATE platforms SET ${sets.join(', ')} WHERE slug = @slug`).run(params);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    res.json(shapePlatform(db.prepare('SELECT * FROM platforms WHERE slug = ?').get(slug)));
  });

  api.delete('/platforms/:slug', requireAdmin, (req, res) => {
    const slug = String(req.params.slug || '').toLowerCase();
    if (slug === 'other') return res.status(400).json({ error: 'The fallback platform cannot be deleted' });
    const existing = db.prepare('SELECT * FROM platforms WHERE slug = ?').get(slug);
    if (!existing) return res.status(404).json({ error: 'Unknown platform' });
    const inUse = db.prepare('SELECT COUNT(*) AS n FROM roms WHERE platform_id = (SELECT id FROM platforms WHERE slug = ?)').get(slug).n;
    if (inUse > 0 && req.query.reassign !== 'other') {
      return res.status(409).json({ error: `Platform still has ${inUse} ROM(s); pass ?reassign=other to move them to Other first`, roms: inUse });
    }
    const txn = db.transaction(() => {
      db.prepare('DELETE FROM platform_logos WHERE slug = ?').run(slug);
      if (inUse > 0) {
        db.prepare(`UPDATE roms SET platform_id = (SELECT id FROM platforms WHERE slug = 'other') WHERE platform_id = (SELECT id FROM platforms WHERE slug = ?)`).run(slug);
      }
      db.prepare('DELETE FROM dat_entries WHERE platform_slug = ?').run(slug);
      db.prepare('DELETE FROM platforms WHERE slug = ?').run(slug);
    });
    txn();
    res.json({ deleted: slug, reassigned: inUse > 0 ? inUse : 0 });
  });

  // The app version and the database (schema) version, for My account: any signed-in person, nothing secret.
  api.get('/version', async (req, res) => {
    const { currentVersion } = await import('./lib/updatecheck.js');
    res.json({ version: currentVersion(), schema: Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0) });
  });

  api.get('/stats', (req, res) => {
    const mine = req.user ? Number(req.user.id) : null;
    res.json({
      library: db.prepare(`
        SELECT COUNT(*) AS roms, COALESCE(SUM(size_bytes),0) AS bytes,
               COUNT(DISTINCT platform_id) AS platforms,
               (SELECT COUNT(*) FROM favorites WHERE user_id = ${mine == null ? -1 : mine}) AS favorites
        FROM roms${req.user?.role === 'admin' ? ' WHERE source_hidden = 0' : ' WHERE hidden_all = 0 AND source_hidden = 0'}
      `).get(),
      mine: mine == null ? { favorites: 0, downloads: 0 } : {
        favorites: db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?').get(mine).n,
        downloads: db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE user_id = ? AND kind = 'download'").get(mine).n
      },
      recent: db.prepare(`
        SELECT r.id, r.title, EXISTS (SELECT 1 FROM favorites fv WHERE fv.rom_id = r.id AND fv.user_id = ${mine == null ? -1 : mine}) AS favorite, r.cover_path, r.created_at,
               p.short_name AS platform_short, p.badge AS platform_badge, p.accent AS platform_accent,
               p.slug AS platform
        FROM roms r JOIN platforms p ON p.id = r.platform_id
        WHERE r.hidden_all = 0 AND r.source_hidden = 0
        ORDER BY r.created_at DESC LIMIT 24
      `).all().map((r) => ({ ...r, cover_url: r.cover_path ? `/api/roms/${r.id}/cover` : null })),
      downloads: db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE kind = \'download\'').get().n,
      // Most-downloaded counts ACTUAL manual downloads only (kind='download').
      // Browser-play streams are kind='play' and excluded, so this number is
      // real downloads, not fetch events.
      topDownloaded: db.prepare(`
        SELECT r.id, r.title, r.cover_path,
               p.short_name AS platform_short, p.badge AS platform_badge, p.accent AS platform_accent,
               p.slug AS platform, COUNT(*) AS dl_count
        FROM downloads d JOIN roms r ON r.id = d.rom_id
        JOIN platforms p ON p.id = r.platform_id
        WHERE d.kind = 'download'
        GROUP BY d.rom_id ORDER BY dl_count DESC LIMIT 1
      `).get() || null,
      sources: db.prepare('SELECT COUNT(*) AS n FROM sources').get().n,
      byPlatform: db.prepare(`
        SELECT p.short_name AS label, p.accent AS color, COUNT(r.id) AS count
        FROM platforms p JOIN roms r ON r.platform_id = p.id
        GROUP BY p.id ORDER BY count DESC LIMIT 10
      `).all()
    });
  });

  // "Check my PC": a one-time token the page hands to the launcher (gamesauce://sync?...), which answers with the platforms it has an emulator for.
  // Same rule as playing locally: only people allowed to download use the launcher.
  api.post('/launcher/sync-token', (req, res) => {
    if (!canDownload(req.user)) return res.status(403).json({ error: 'Playing locally needs the ROM file, and downloads are turned off for this account.' });
    res.json(mintSyncToken(req.user.id));
  });

  // The launcher as a zip, for a PC that has only a browser (the desktop app already carries it). Same rule as playing locally: only people allowed to download.
  api.get('/launcher/download', (req, res) => {
    if (!canDownload(req.user)) return res.status(403).json({ error: 'Playing locally needs the ROM file, and downloads are turned off for this account.' });
    const entries = launcherEntries(`${req.protocol}://${req.get('host')}`);
    if (!entries.length) return res.status(404).json({ error: 'The launcher is not part of this installation.' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="game-sauce-launcher.zip"');
    try { for (const chunk of zipChunks(entries)) res.write(chunk); } catch (err) { return res.destroy(err); }
    res.end();
  });

  // Per-user preferences (whitelisted keys only). Scoped to the signed-in user.
  const PREF_KEYS = { identify_provider: ['thegamesdb', 'igdb', 'launchbox'], ui_mode: ['classic', 'modern'] };
  api.get('/prefs', (req, res) => {
    const out = {};
    for (const r of db.prepare('SELECT key, value FROM user_prefs WHERE user_id = ?').all(req.user.id)) out[r.key] = r.value;
    res.json(out);
  });
  api.put('/prefs/:key', (req, res) => {
    const allowed = PREF_KEYS[req.params.key];
    if (!allowed) return res.status(400).json({ error: 'Unknown preference' });
    const value = req.body?.value;
    if (value === null || value === '') {
      db.prepare('DELETE FROM user_prefs WHERE user_id = ? AND key = ?').run(req.user.id, req.params.key);
      return res.json({ key: req.params.key, value: null });
    }
    if (!allowed.includes(value)) return res.status(400).json({ error: 'Invalid value' });
    db.prepare('INSERT INTO user_prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value')
      .run(req.user.id, req.params.key, value);
    res.json({ key: req.params.key, value });
  });

  api.use('/roms', romsRouter);
  api.use('/collections', collectionsRouter);
  api.use('/digital', digitalRouter);
  api.use('/physical', physicalRouter);
  api.use('/art', artRouter);   // import pictures and manuals from folders on the server
  api.use('/messages', messagesRouter);
  api.use('/videos', videosRouter);
  api.use('/metadata', metadataRouter);
  api.use('/emulators', emulatorsRouter);

  // Source paths, the filesystem browser and DAT tooling are an admin capability:
  // the former reveals and scans arbitrary folders on the host, the latter imports
  // and deletes verification catalogues. Emulator writes (vault upload / fetch)
  // are admin-only inside their router; the guide + latest-release check are
  // safe for any signed-in user.
  api.use('/sources', requireAdmin, sourcesRouter);
  api.use('/dats', requireAdmin, datsRouter);
  // Backups hold the encryption key and password hashes: admin only.
  api.use('/backup', requireAdmin, backupRouter);

  // Back-compat: earlier builds mounted the DAT router at /api/datfiles.
  api.use('/datfiles', requireAdmin, datsRouter);

  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown API route' }));

  /* ───────────────────────────── frontend ───────────────────────────── */

  app.use(express.static('public', { extensions: ['html'] }));
  app.get('*', (req, res) => res.sendFile('index.html', { root: 'public' }));

  /* ─────────────────────────────── errors ─────────────────────────────── */

  app.use((err, req, res, next) => {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : err.status || 500;
    if (status >= 500) console.error('[error]', err.message);
    res.status(status).json({ error: err.message || 'Internal error' });
  });

  return app;
}

/** Async setup that must finish before the server listens. */
export async function prepareApp() {
  const admin = await bootstrapAdmin();
  const app = createApp();
  return { app, admin };
}

export { sessionCookie };

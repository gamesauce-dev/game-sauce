import express from 'express';
import db from './db.js';
// Side-effect import: forward-compatible schema migrations (sources, source paths,
// provider ids). Must run before anything queries the new columns.
import './migrations.js';
import { seedPlatforms } from './lib/platforms.js';
import romsRouter from './routes/roms.js';
import collectionsRouter from './routes/collections.js';
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
  api.use(originGuard({ trustProxy: process.env.GAMESAUCE_TRUST_PROXY === '1' }));
  api.use(rateLimit());

  // Public: health and the auth surface. Everything else needs a session.
  api.get('/health', (req, res) => {
    const { roms } = db.prepare('SELECT COUNT(*) AS roms FROM roms').get();
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    res.json({ ok: true, roms, users, uptime: Math.round(process.uptime()) });
  });

  api.use('/auth', authRouter);

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

  // Admin health report (read-only): see src/lib/health.js.
  api.get('/admin/health', requireAuth, requireAdmin, async (req, res) => {
    const { collectHealth, collectSummary, diagnosticsText } = await import('./lib/health.js');
    const report = collectHealth();
    const summary = collectSummary();
    res.json({ ...report, summary, diagnostics: diagnosticsText(report, summary), checked_at: new Date().toISOString() });
  });

  api.use(requireAuth);

  // Audited mutations: log every non-GET request with who did it.
  // For ROM-scoped routes, resolve the ROM's title + platform FIRST so the
  // summary can name the game ("deleted ROM 42 (Sonic 2 · Genesis)") instead
  // of a bare id. Mounted on `api` (BEFORE /roms), so req.baseUrl here is
  // "/api" and req.path is the remainder; req.params is still empty at this
  // point, hence the manual match. Single-row SELECT; display-only.
  api.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
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

  api.get('/platforms', (req, res) => {
    res.json({
      items: db.prepare(`
        SELECT p.*, COUNT(r.id) AS count
        FROM platforms p LEFT JOIN roms r ON r.platform_id = p.id
        GROUP BY p.id ORDER BY p.family COLLATE NOCASE, p.name COLLATE NOCASE
      `).all()
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
  const PLATFORM_FIELDS = ['name', 'short_name', 'family', 'manufacturer', 'generation', 'accent', 'screenscraper_id', 'tgdb_id', 'extensions'];

  api.get('/platforms/all', requireAdmin, (req, res) => {
    res.json({
      items: db.prepare('SELECT * FROM platforms ORDER BY family COLLATE NOCASE, name COLLATE NOCASE').all().map(shapePlatform)
    });
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
      family: String(req.body?.family || 'Others').trim() || 'Others',
      manufacturer: String(req.body?.manufacturer || '').trim() || null,
      generation: req.body?.generation === '' || req.body?.generation == null ? null : Number(req.body.generation),
      accent: String(req.body?.accent || '#6b7280').trim(),
      screenscraper_id: req.body?.screenscraper_id === '' || req.body?.screenscraper_id == null ? null : Number(req.body.screenscraper_id),
      tgdb_id: req.body?.tgdb_id === '' || req.body?.tgdb_id == null ? null : Number(req.body.tgdb_id),
      extensions: exts.join(',')
    };
    if (row.generation !== null && !Number.isFinite(row.generation)) return res.status(400).json({ error: 'generation must be a number' });
    if (row.screenscraper_id !== null && !Number.isFinite(row.screenscraper_id)) return res.status(400).json({ error: 'screenscraper_id must be a number' });
    if (row.tgdb_id !== null && !Number.isFinite(row.tgdb_id)) return res.status(400).json({ error: 'tgdb_id must be a number' });
    try {
      db.prepare(`
        INSERT INTO platforms (slug, name, short_name, family, manufacturer, generation, accent, screenscraper_id, tgdb_id, extensions)
        VALUES (@slug, @name, @short_name, @family, @manufacturer, @generation, @accent, @screenscraper_id, @tgdb_id, @extensions)
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
      if (inUse > 0) {
        db.prepare(`UPDATE roms SET platform_id = (SELECT id FROM platforms WHERE slug = 'other') WHERE platform_id = (SELECT id FROM platforms WHERE slug = ?)`).run(slug);
      }
      db.prepare('DELETE FROM dat_entries WHERE platform_slug = ?').run(slug);
      db.prepare('DELETE FROM platforms WHERE slug = ?').run(slug);
    });
    txn();
    res.json({ deleted: slug, reassigned: inUse > 0 ? inUse : 0 });
  });

  api.get('/stats', (req, res) => {
    const mine = req.user ? Number(req.user.id) : null;
    res.json({
      library: db.prepare(`
        SELECT COUNT(*) AS roms, COALESCE(SUM(size_bytes),0) AS bytes,
               COUNT(DISTINCT platform_id) AS platforms,
               (SELECT COUNT(*) FROM favorites WHERE user_id = ${mine == null ? -1 : mine}) AS favorites
        FROM roms
      `).get(),
      mine: mine == null ? { favorites: 0, downloads: 0 } : {
        favorites: db.prepare('SELECT COUNT(*) AS n FROM favorites WHERE user_id = ?').get(mine).n,
        downloads: db.prepare("SELECT COUNT(*) AS n FROM downloads WHERE user_id = ? AND kind = 'download'").get(mine).n
      },
      recent: db.prepare(`
        SELECT r.id, r.title, EXISTS (SELECT 1 FROM favorites fv WHERE fv.rom_id = r.id AND fv.user_id = ${mine == null ? -1 : mine}) AS favorite, r.cover_path, r.created_at,
               p.short_name AS platform_short, p.accent AS platform_accent,
               p.slug AS platform
        FROM roms r JOIN platforms p ON p.id = r.platform_id
        ORDER BY r.created_at DESC LIMIT 16
      `).all().map((r) => ({ ...r, cover_url: r.cover_path ? `/api/roms/${r.id}/cover` : null })),
      downloads: db.prepare('SELECT COUNT(*) AS n FROM downloads WHERE kind = \'download\'').get().n,
      // Most-downloaded counts ACTUAL manual downloads only (kind='download').
      // Browser-play streams are kind='play' and excluded, so this number is
      // real downloads, not fetch events.
      topDownloaded: db.prepare(`
        SELECT r.id, r.title, r.cover_path,
               p.short_name AS platform_short, p.accent AS platform_accent,
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

  // Per-user preferences (whitelisted keys only). Scoped to the signed-in user.
  const PREF_KEYS = { identify_provider: ['thegamesdb', 'igdb'] };
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

import express from 'express';
import db from '../db.js';
import { requireAdmin } from './auth.js';
import { enrich, providerStatus, screenscraper, thegamesdb, igdb, launchbox, steamgriddb } from '../lib/providers.js';
import { launchboxStatus, startLaunchBoxUpdate } from '../lib/launchbox.js';
import {
  describeProviderConfig, saveProviderConfig, clearProviderConfig, PROVIDER_FIELDS
} from '../settings.js';
import { applyMetadataRecord } from './roms.js';
import { downloadCover } from '../lib/storage.js';
import { mameTitleTrusted } from '../lib/mamenames.js';

const router = express.Router();

router.get('/', (req, res) => {
  const counts = db.prepare(`
    SELECT COALESCE(meta_source, 'none') AS source, COUNT(*) AS count
    FROM roms GROUP BY meta_source
  `).all();
  res.json({ providers: providerStatus(), counts, config: describeProviderConfig() });
});

/* ────────────────── LaunchBox local database ────────────────── */

router.get('/launchbox', (req, res) => res.json(launchboxStatus()));

/** Download and index the LaunchBox database in the background (admin). Poll GET /launchbox for progress. */
router.post('/launchbox/update', requireAdmin, (req, res) => {
  const r = startLaunchBoxUpdate();
  res.status(r.started ? 202 : 409).json({ ...launchboxStatus(), ...(r.started ? {} : { error: 'An update is already running' }) });
});

/* ────────────────── provider credentials (UI) ────────────────── */

/** Current credential state. Secrets are masked, never returned. */
router.get('/providers', (req, res) => {
  res.json({
    ...describeProviderConfig(),
    status: providerStatus(),
    available: Object.keys(PROVIDER_FIELDS)
  });
});

/**
 * Save credentials. Admin-only: the router is mounted behind requireAuth, and
 * this endpoint additionally checks the role because a stored credential lets
 * its holder spend the account's API quota.
 */
router.put('/providers', requireAdmin, (req, res) => {
  const result = saveProviderConfig(req.body?.fields || req.body || {}, req.user?.id);
  res.json({
    ...result,
    ...describeProviderConfig(),
    status: providerStatus()
  });
});

router.delete('/providers', requireAdmin, (req, res) => {
  clearProviderConfig(req.user?.id);
  res.json({ ...describeProviderConfig(), status: providerStatus() });
});

/** Check the credentials work right now, without touching the library. */
router.post('/providers/test', requireAdmin, async (req, res, next) => {
  try {
    const provider = String(req.body?.provider || 'screenscraper');
    if (provider === 'screenscraper') {
      if (!screenscraper.enabled) {
        const nonEmpty = (k) => { const v = process.env[k]; return Boolean(v && String(v).trim() !== ''); };
        const hasShared = nonEmpty('SS_DEV_ID_SHARED') && nonEmpty('SS_DEV_PASSWORD_SHARED');
        return res.status(400).json({
          ok: false,
          error: hasShared
            ? 'ScreenScraper is missing something (all four halves must resolve: developer ID + password, account username + password). You left the Developer fields blank and the shared default is set, so check your account username/password — save, then test again.'
            : 'ScreenScraper needs all four halves to call its API (their rule, not ours): developer ID + developer password from a free ScreenScraper forum request, plus your screenscraper.fr account username + password. This server has NO shared dev pair set up (SS_DEV_ID_SHARED is empty), so leaving the Developer fields blank cannot work — fill all four and save, then test again.'
        });
      }
      const info = await screenscraper.accountInfo();
      if (!info || info.error) {
        return res.json({
          ok: false,
          error: info?.error || 'ScreenScraper did not accept the credentials',
          hint: info?.needsDeveloperCredentials
            ? 'The site login looks fine, so this is the DEVELOPER ID/password half failing. Those come from a separate forum request (not your account page). Fill devid + devpassword, save, and Test connection again.'
            : null
        });
      }
      return res.json({ ok: true, detail: info });
    }

    if (provider === 'thegamesdb') {
      if (!thegamesdb.enabled) return res.status(400).json({ ok: false, error: 'API key is required' });
      const result = await thegamesdb.lookup({ title: 'Super Mario Bros.', platform: { tgdb_id: 7 } });
      if (!result) return res.json({ ok: false, error: 'TheGamesDB rejected the key or returned nothing' });
      if (result.error) return res.json({ ok: false, error: result.error });
      return res.json({ ok: true, detail: { sample: result.title, cover: Boolean(result.cover_url) } });
    }

    if (provider === 'igdb') {
      if (!igdb.enabled) return res.status(400).json({ ok: false, error: 'IGDB Client ID + Client secret are required' });
      const result = await igdb.lookup({ title: 'Super Mario Bros.', platform: {}, hashes: {} });
      if (!result) return res.json({ ok: false, error: 'IGDB accepted the credentials but returned no match for the probe title' });
      if (result.error) return res.json({ ok: false, error: result.error });
      return res.json({ ok: true, detail: { sample: result.title, cover: Boolean(result.cover_url) } });
    }

    if (provider === 'steamgriddb') {
      if (!steamgriddb.enabled) return res.status(400).json({ ok: false, error: 'API key is required' });
      const art = await steamgriddb.coverFor('Super Mario Bros.');
      if (!art) return res.json({ ok: false, error: 'Key accepted but no grid art found for the probe title' });
      return res.json({ ok: true, detail: { sample: art } });
    }

    res.status(400).json({ ok: false, error: 'Unknown provider' });
  } catch (err) { next(err); }
});

/** ScreenScraper account/quota probe — tells you how many requests are left today. */
router.get('/screenscraper/account', async (req, res, next) => {
  try {
    if (!screenscraper.enabled) {
      return res.status(400).json({ error: 'Set all four ScreenScraper fields first: SS_DEV_ID, SS_DEV_PASSWORD, SS_USER, SS_PASSWORD' });
    }
    const info = await screenscraper.accountInfo();
    res.json(info || { error: 'no response' });
  } catch (err) { next(err); }
});

/**
 * Compare our platform table against ScreenScraper's live system list.
 * Returns matched / mismatched / unknown ids so a stale systemeid is visible
 * instead of quietly returning the wrong game's metadata.
 */
router.get('/screenscraper/systems', async (req, res, next) => {
  try {
    const systems = await screenscraper.systemList();
    if (!systems) return res.status(400).json({ error: 'ScreenScraper is not configured or did not respond' });

    const byId = new Map(systems.map((s) => [s.id, s]));
    const platforms = db.prepare('SELECT slug, name, screenscraper_id FROM platforms WHERE screenscraper_id IS NOT NULL').all();

    const rows = platforms.map((p) => {
      const match = byId.get(p.screenscraper_id);
      return {
        slug: p.slug,
        name: p.name,
        screenscraper_id: p.screenscraper_id,
        resolved_name: match?.name || null,
        ok: Boolean(match)
      };
    });

    res.json({
      checked: rows.length,
      missing: rows.filter((r) => !r.ok),
      rows
    });
  } catch (err) { next(err); }
});

/** Re-run the metadata lookup for one ROM. */
router.post('/:id/refresh', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Unknown API route' });
    const rom = db.prepare(`
      SELECT r.*, p.slug AS platform_slug, p.name AS platform_name,
             p.screenscraper_id, p.tgdb_id, p.family
      FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.id = ?
    `).get(id);

    if (!rom) return res.status(404).json({ error: 'ROM not found' });

    const result = await enrich({
      filename: rom.filename,
      titleTrusted: mameTitleTrusted(rom.platform_slug, rom.filename),
      title: rom.title,
      year: rom.release_year,
      platform: {
        slug: rom.platform_slug,
        name: rom.platform_name,
        family: rom.family,
        screenscraper_id: rom.screenscraper_id,
        tgdb_id: rom.tgdb_id
      },
      hashes: { crc32: rom.crc32, md5: rom.md5, sha1: rom.sha1 }
    });

    if (!result) return res.json({ updated: false, reason: 'no provider returned a match' });
    if (result.error) return res.json({ updated: false, reason: result.error });

    // A refresh must also replace a stale cover, so don't reuse the old one.
    if (result.cover_url) db.prepare('UPDATE roms SET cover_path = NULL WHERE id = ?').run(rom.id);
    const updated = await applyMetadataRecord(rom.id, result, req.user?.id);

    res.json({ updated: true, source: result.source, cached: Boolean(result.cached), rom: updated });
  } catch (err) { next(err); }
});

/**
 * Manual identify: search TheGamesDB (and IGDB when configured) by free text
 * and return ranked candidates for the user to pick from.
 * Body: { q, platform?, provider? } — platform is a slug, "all" or omitted;
 * provider is "thegamesdb" (default) or "igdb". Results share the candidate
 * shape so the UI mixes sources freely.
 */
router.post('/search', async (req, res, next) => {
  try {
    const q = String(req.body?.q || '').trim();
    if (!q) return res.status(400).json({ error: 'Search text is required' });

    const which = String(req.body?.provider || 'thegamesdb');
    if (which !== 'thegamesdb' && which !== 'igdb' && which !== 'launchbox') {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    const slug = req.body?.platform && req.body.platform !== 'all' ? req.body.platform : null;
    let tgdb_id = null;
    if (which === 'thegamesdb' && slug) {
      const row = db.prepare('SELECT tgdb_id FROM platforms WHERE slug = ?').get(slug);
      if (!row) return res.status(400).json({ error: 'Unknown platform' });
      tgdb_id = row.tgdb_id;
    }

    const svc = which === 'igdb' ? igdb : which === 'launchbox' ? launchbox : thegamesdb;
    const hits = await svc.search(q, { slug, tgdb_id });
    if (hits.error && !hits.items?.length) {
      return res.status(502).json({ error: hits.error, items: [] });
    }
    res.json({ items: hits.items || [], error: hits.error || null, provider: which });
  } catch (err) { next(err); }
});

/**
 * Apply one manually chosen candidate to a ROM. The candidate shape is exactly
 * what POST /metadata/search returns, so the UI can pass the picked row back
 * verbatim: { title, publisher, genre, release_year, players, rating,
 * description, cover_url, has_cover, platform_id, game_id }.
 */
router.post('/:id/apply', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Unknown API route' });
    const cand = req.body?.candidate;
    if (!cand || typeof cand !== 'object') {
      return res.status(400).json({ error: 'candidate object is required' });
    }

    const exists = db.prepare('SELECT id FROM roms WHERE id = ?').get(id);
    if (!exists) return res.status(404).json({ error: 'ROM not found' });

    const meta = {
      title: cand.title || null,
      developer: cand.developer ?? null,
      publisher: cand.publisher ?? null,
      genre: cand.genre ?? null,
      release_year: cand.release_year ?? null,
      players: cand.players ?? null,
      rating: cand.rating ?? null,
      description: cand.description ?? null,
      cover_url: cand.cover_url || null,
      media: cand.cover_url ? { box2d: cand.cover_url } : {},
      source: cand.source || 'thegamesdb',
      source_id: cand.game_id ? String(cand.game_id) : null,
      cover_source: cand.source || 'thegamesdb',
      has_cover: Boolean(cand.cover_url)
    };

    const rom = await applyMetadataRecord(id, meta, req.user?.id);
    res.json({ updated: true, source: meta.source, rom });
  } catch (err) { next(err); }
});

export default router;

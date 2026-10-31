// Admin health report: one place to see whether the server is in good shape, with a plain-English
// reason when it is not. Every check returns { id, label, status: 'ok' | 'warn' | 'bad', detail }.
// Nothing here changes any state, and nothing secret (keys, passwords, tokens, absolute paths) is
// included, so the whole report can be pasted into a bug report as it is.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import db from '../db.js';
import { rootDir } from './storage.js';
import { getBackupSettings, listBackups } from './backup.js';
import { describeProviderConfig, encryptionInfo } from '../settings.js';
import { membersCanDownload } from './policy.js';

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')); }
  catch { return {}; }
})();

const dataDir = () => path.resolve(process.env.GAMESAUCE_DATA_DIR || 'data');
const GB = 1024 ** 3;
const MB = 1024 ** 2;

export function fmtBytes(n) {
  if (!Number.isFinite(n)) return 'unknown';
  if (n >= GB) return `${(n / GB).toFixed(1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(0)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

export function fmtAge(ms) {
  const m = Math.round(ms / 60000);
  if (m < 2) return 'just now';
  if (m < 120) return `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

function diskFree(dir) {
  try {
    const s = fs.statfsSync(dir);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}

function dirSize(dir, limit = 200000) {
  let total = 0, seen = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (seen++ > limit) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  };
  walk(dir);
  return { bytes: total, truncated: seen > limit };
}

export function diskCheck(id, label, dir) {
  const d = diskFree(dir);
  if (!d) return { id, label, status: 'warn', detail: 'Free space could not be read here.' };
  const pct = d.total ? (d.free / d.total) * 100 : 100;
  const detail = `${fmtBytes(d.free)} free of ${fmtBytes(d.total)} (${pct.toFixed(0)}% free)`;
  if (d.free < 0.5 * GB || pct < 2) return { id, label, status: 'bad', detail: `${detail}. Almost full: scans, covers and backups will start failing.` };
  if (d.free < 2 * GB || pct < 8) return { id, label, status: 'warn', detail: `${detail}. Getting low.` };
  return { id, label, status: 'ok', detail };
}

export function collectHealth() {
  const checks = [];
  const now = Date.now();

  // Database: integrity and size.
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const okDb = (row?.quick_check || Object.values(row || {})[0]) === 'ok';
    const file = path.join(dataDir(), 'gamesauce.db');
    let size = 0; try { size = fs.statSync(file).size; } catch { /* custom DB_FILE */ }
    checks.push({
      id: 'database', label: 'Database',
      status: okDb ? 'ok' : 'bad',
      detail: okDb ? `Healthy${size ? `, ${fmtBytes(size)}` : ''}.` : 'SQLite reports a problem with the database file. Restore a recent backup.'
    });
  } catch (err) {
    checks.push({ id: 'database', label: 'Database', status: 'bad', detail: `Could not be checked: ${err.message}` });
  }

  checks.push(diskCheck('disk-data', 'Disk space: data folder', dataDir()));
  checks.push(diskCheck('disk-storage', 'Disk space: storage folder', rootDir()));

  // ROM sources: reachable? last scan?
  const sources = db.prepare('SELECT id, name, path, enabled, last_scan_at, last_scan_found, last_scan_added, last_scan_error FROM sources ORDER BY name').all();
  if (!sources.length) {
    checks.push({ id: 'sources', label: 'ROM sources', status: 'ok', detail: 'None added (only imported ROMs).' });
  } else {
    for (const s of sources) {
      const label = `Source: ${s.name}`;
      let reachable = true;
      try { fs.accessSync(s.path, fs.constants.R_OK); } catch { reachable = false; }
      for (const x of db.prepare('SELECT path FROM source_paths WHERE source_id = ?').all(s.id)) { try { fs.accessSync(x.path, fs.constants.R_OK); } catch { reachable = false; } }
      const missing = db.prepare('SELECT COUNT(*) AS n FROM roms WHERE source_id = ? AND missing = 1').get(s.id).n;
      if (!s.enabled) { checks.push({ id: `source-${s.id}`, label, status: 'ok', detail: 'Disabled.' }); continue; }
      if (!reachable) {
        checks.push({ id: `source-${s.id}`, label, status: 'bad', detail: 'Folder is not reachable (drive unplugged, share not mounted, or the path changed). Its games stay in the library.' });
        continue;
      }
      const bits = [];
      if (s.last_scan_at) bits.push(`last scan ${fmtAge(now - new Date(`${s.last_scan_at.replace(' ', 'T')}Z`).getTime())}: ${s.last_scan_found} found, ${s.last_scan_added} new`);
      else bits.push('not scanned yet');
      if (missing) bits.push(`${missing} file(s) missing`);
      if (s.last_scan_error) { checks.push({ id: `source-${s.id}`, label, status: 'warn', detail: `Reachable, but the last scan reported: ${String(s.last_scan_error).slice(0, 140)}` }); continue; }
      checks.push({ id: `source-${s.id}`, label, status: missing ? 'warn' : 'ok', detail: `Reachable; ${bits.join('; ')}.` });
    }
  }

  // Backups: do they exist, and are they recent?
  try {
    const bs = getBackupSettings();
    const list = listBackups(bs.effective_dir);
    const newest = list[0];
    if (bs.last_error) {
      checks.push({ id: 'backup', label: 'Backups', status: 'bad', detail: `The last automatic backup failed: ${String(bs.last_error).slice(0, 160)}` });
    } else if (!newest) {
      checks.push({ id: 'backup', label: 'Backups', status: 'warn', detail: 'No backup has been made yet. Settings → Backups can make one now.' });
    } else {
      const age = now - new Date(newest.created_at).getTime();
      const stale = age > 14 * 24 * 3600 * 1000;
      checks.push({
        id: 'backup', label: 'Backups', status: stale ? 'warn' : 'ok',
        detail: `${list.length} kept on the server, newest ${fmtAge(age)} (${fmtBytes(newest.size)}). Automatic backups: ${bs.interval_hours ? `every ${bs.interval_hours} h` : 'off'}.`
      });
    }
  } catch (err) {
    checks.push({ id: 'backup', label: 'Backups', status: 'warn', detail: `Could not be checked: ${err.message}` });
  }

  // Metadata providers and encryption.
  try {
    const { enabled } = describeProviderConfig();
    const names = { screenscraper: 'ScreenScraper', thegamesdb: 'TheGamesDB', igdb: 'IGDB', steamgriddb: 'SteamGridDB' };
    const on = Object.keys(names).filter((k) => enabled[k]).map((k) => names[k]);
    checks.push({
      id: 'providers', label: 'Metadata providers', status: on.length ? 'ok' : 'warn',
      detail: on.length ? `Configured: ${on.join(', ')}.` : 'None configured, so covers and details fall back to the file name. Add a provider under Settings → Metadata providers.'
    });
    const enc = encryptionInfo();
    checks.push({
      id: 'encryption', label: 'Credential encryption', status: enc.warn ? 'warn' : 'ok',
      detail: enc.key_source === 'env'
        ? 'Provider credentials are encrypted with the key from GAMESAUCE_SECRET_KEY, which is kept outside the database.'
        : 'Provider credentials are encrypted, but the key file sits next to the database. Set GAMESAUCE_SECRET_KEY to keep it separate.'
    });
  } catch (err) {
    checks.push({ id: 'providers', label: 'Metadata providers', status: 'warn', detail: `Could not be checked: ${err.message}` });
  }

  // Transport security: only a warning, since plain HTTP is normal on a home network.
  const secureCookie = ['1', 'true'].includes(String(process.env.GAMESAUCE_COOKIE_SECURE || '').trim());
  checks.push({
    id: 'https', label: 'HTTPS', status: 'ok',
    detail: secureCookie ? 'Secure cookies are on.' : 'Plain HTTP (fine on a home network). If you expose it beyond that, put HTTPS in front and set GAMESAUCE_COOKIE_SECURE=1.'
  });

  const worst = checks.some((c) => c.status === 'bad') ? 'bad' : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { status: worst, checks };
}

export function collectSummary() {
  const count = (sql) => db.prepare(sql).get().n;
  const roms = count('SELECT COUNT(*) AS n FROM roms');
  const store = dirSize(rootDir());
  return {
    version: pkg.version || 'unknown',
    schema: Number(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()?.value || 0),
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    uptime_s: Math.round(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / MB),
    roms,
    with_covers: count('SELECT COUNT(*) AS n FROM roms WHERE cover_path IS NOT NULL'),
    missing_files: count('SELECT COUNT(*) AS n FROM roms WHERE missing = 1'),
    sources: count('SELECT COUNT(*) AS n FROM sources'),
    users: count('SELECT COUNT(*) AS n FROM users'),
    storage_bytes: store.bytes,
    storage_truncated: store.truncated,
    members_can_download: membersCanDownload()
  };
}

/** The shareable, secret-free text version of the report. */
export function diagnosticsText({ status, checks }, summary) {
  const mark = { ok: 'OK  ', warn: 'WARN', bad: 'FAIL' };
  const up = summary.uptime_s;
  const lines = [
    `game-sauce ${summary.version} (schema ${summary.schema})`,
    `Node ${summary.node} on ${summary.platform}`,
    `Up ${up >= 3600 ? `${Math.floor(up / 3600)} h ${Math.floor((up % 3600) / 60)} min` : `${Math.floor(up / 60)} min`}, memory ${summary.memory_mb} MB`,
    `${summary.roms} ROMs (${summary.with_covers} with covers, ${summary.missing_files} missing files), ${summary.sources} sources, ${summary.users} users`,
    `Imported storage: ${fmtBytes(summary.storage_bytes)}${summary.storage_truncated ? '+' : ''}`,
    `Members can download: ${summary.members_can_download ? 'yes' : 'no'}`,
    `Overall: ${status.toUpperCase()}`,
    ''
  ];
  for (const c of checks) lines.push(`[${mark[c.status]}] ${c.label}: ${c.detail}`);
  return lines.join('\n');
}

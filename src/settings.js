import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import db from './db.js';
// app_settings references users(id); make sure that table exists first.
import { initAuthTables } from './auth.js';

// Provider credentials entered in the UI.
//
// They are encrypted at rest with AES-256-GCM. The key comes from
// GAMESAUCE_SECRET_KEY when set (recommended — then the key lives outside the
// database). Otherwise a random key is generated once and stored in
// <data>/secret.key with owner-only permissions, which protects against someone
// reading the .db file but NOT against someone with full access to the data
// directory. That limitation is reported honestly by /api/settings/providers.
//
// Environment variables always win over stored values, so a deployment can pin
// credentials without them being editable in the UI.

initAuthTables();

db.exec(`
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  encrypted  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
`);

function keyFilePath() {
  const dir = process.env.GAMESAUCE_DATA_DIR || path.resolve('data');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'secret.key');
}

let cachedKey = null;

function encryptionKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.GAMESAUCE_SECRET_KEY;
  if (fromEnv) {
    // Accept base64 or hex; derive 32 bytes deterministically from whatever it is.
    cachedKey = crypto.createHash('sha256').update(fromEnv).digest();
    cachedKey.source = 'env';
    return cachedKey;
  }

  const file = keyFilePath();
  if (fs.existsSync(file)) {
    cachedKey = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    if (cachedKey.length !== 32) throw new Error('secret.key is corrupt');
    cachedKey.source = 'file';
    return cachedKey;
  }

  cachedKey = crypto.randomBytes(32);
  fs.writeFileSync(file, cachedKey.toString('base64'), { mode: 0o600 });
  cachedKey.source = 'generated';
  return cachedKey;
}

export function encryptionInfo() {
  const key = encryptionKey();
  return {
    algorithm: 'aes-256-gcm',
    key_source: key.source,
    // Stored in the database is only as good as the key's location.
    at_rest_protection: key.source === 'env' ? 'key kept outside the database' : 'key file alongside the database',
    warn: key.source === 'env'
      ? null
      : 'Set GAMESAUCE_SECRET_KEY so the encryption key is not stored next to gamesauce.db.'
  };
}

export function encryptSecret(plaintext) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptSecret(payload) {
  if (!payload) return null;
  const [version, ivB64, tagB64, dataB64] = String(payload).split(':');
  if (version !== 'v1') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/* ─────────────────────── provider credential model ─────────────────────── */

// Everything the UI can set. `secret: true` fields are encrypted and never
// returned in plaintext.
//
// ScreenScraper dev credentials work in three tiers, highest priority first:
//   1. typed into the form (stored encrypted in app_settings)
//   2. baked-in shared default from the environment (SS_DEV_ID_SHARED /
//      SS_DEV_PASSWORD_SHARED) — set by whoever distributes the app so it
//      works out of the box at a shared, slower quota
//   3. nothing — provider reports not-configured
// A per-user typed value always beats the shared default; clearing the form
// field falls back to the shared default rather than to nothing.
export const PROVIDER_FIELDS = {
  screenscraper: {
    label: 'ScreenScraper',
    docs: 'https://www.screenscraper.fr/forumsujets.php?frub=12',
    note: 'ScreenScraper always needs a developer ID/password pair plus your site login — that is their API rule, not ours. If this server has a shared dev pair set up (see status below), you may leave the Developer fields empty to use it at a slower shared quota; otherwise all four fields are required. A free dev pair from a forum request is yours alone and gets your own faster quota.',
    fields: [
      { key: 'SS_DEV_ID', label: 'Developer ID (required — unless the banner above says a shared pair is active)', secret: false, required: false, shared: true },
      { key: 'SS_DEV_PASSWORD', label: 'Developer password (required — unless the banner above says a shared pair is active)', secret: true, required: false, shared: true },
      { key: 'SS_USER', label: 'Account username', secret: false, required: true },
      { key: 'SS_PASSWORD', label: 'Account password', secret: true, required: true }
    ]
  },
  thegamesdb: {
    label: 'TheGamesDB',
    docs: 'https://thegamesdb.net/',
    note: 'A free API key from your TheGamesDB account page.',
    fields: [
      { key: 'TGDB_API_KEY', label: 'API key', secret: true, required: true }
    ]
  },
  igdb: {
    label: 'IGDB (Twitch)',
    docs: 'https://api-docs.igdb.com/#getting-started',
    note: 'Free for non-commercial use. Create a Twitch developer app to get a Client ID + Client Secret (takes minutes, no approval wait); game-sauce trades them for a token itself.',
    fields: [
      { key: 'IGDB_CLIENT_ID', label: 'Client ID', secret: false, required: true },
      { key: 'IGDB_CLIENT_SECRET', label: 'Client secret', secret: true, required: true }
    ]
  },
  steamgriddb: {
    label: 'SteamGridDB',
    docs: 'https://www.steamgriddb.com/profile/preferences/api',
    note: 'Art only, no metadata. Free key from your SteamGridDB profile (sign in with Steam → Preferences → API). Used as a cover fallback when a metadata match has no art.',
    fields: [
      { key: 'SGDB_API_KEY', label: 'API key', secret: true, required: true }
    ]
  }
};

const SECRET_KEYS = new Set(
  Object.values(PROVIDER_FIELDS).flatMap((p) => p.fields.filter((f) => f.secret).map((f) => f.key))
);

const ALL_KEYS = Object.values(PROVIDER_FIELDS).flatMap((p) => p.fields.map((f) => f.key));

/**
 * Env lookup that treats empty/whitespace as absent.
 *
 * docker-compose.yml declares `IGDB_CLIENT_ID: "${IGDB_CLIENT_ID:-}"` etc, so a
 * compose deployment ALWAYS sets these vars — to "" when the user has nothing
 * in `.env`. A naive `process.env[key] ?? dbValue` then lets "" shadow the
 * database: the UI saves to the DB fine, but every read sees "" and reports
 * "not set". That is the "save immediately clears them out" bug. Every env
 * read in this file must go through here.
 */
function envVal(key) {
  const raw = process.env[key];
  if (raw == null) return undefined;
  return String(raw).trim() === '' ? undefined : raw;
}

/** A stored value, or null. */
function stored(key) {
  const row = db.prepare('SELECT value, encrypted FROM app_settings WHERE key = ?').get(key);
  if (!row) return null;
  return row.encrypted ? decryptSecret(row.value) : row.value;
}

// Distributor-baked shared defaults (env only, never stored in the DB).
// Lets a shared build work out of the box at a shared, slower quota while
// letting any user paste their own pair to get their own faster quota.
export const SHARED_DEFAULTS = {
  SS_DEV_ID: 'SS_DEV_ID_SHARED',
  SS_DEV_PASSWORD: 'SS_DEV_PASSWORD_SHARED'
};

/** Effective value: typed-in (env pin or DB) first, then shared default. */
export function getProviderConfig() {
  const out = {};
  for (const key of ALL_KEYS) {
    const fromEnv = envVal(key);
    const fromDb = stored(key);
    const sharedEnvKey = SHARED_DEFAULTS[key];
    const fromShared = sharedEnvKey ? envVal(sharedEnvKey) : undefined;
    const value = fromEnv ?? fromDb ?? fromShared ?? null;
    out[key] = {
      value,
      source: fromEnv !== undefined ? 'env' : (fromDb ? 'database' : (fromShared !== undefined ? 'shared' : null)),
      secret: SECRET_KEYS.has(key)
    };
  }
  return out;
}

/** The shape the providers module consumes: plain `{ SS_DEV_ID: '…' }`. */
export function providerEnv() {
  const config = getProviderConfig();
  const out = {};
  for (const [key, entry] of Object.entries(config)) {
    if (entry.value) out[key] = entry.value;
  }
  return out;
}

/** For the API: secrets are masked, never returned. */
export function describeProviderConfig() {
  const config = getProviderConfig();
  const providers = Object.entries(PROVIDER_FIELDS).map(([id, def]) => ({
    id,
    label: def.label,
    docs: def.docs,
    note: def.note,
    fields: def.fields.map((f) => {
      const entry = config[f.key];
      const set = Boolean(entry?.value);
      const sharedFallback = Boolean(f.shared && entry?.source === 'shared');
      return {
        key: f.key,
        label: f.label,
        secret: f.secret,
        required: Boolean(f.required),
        shared: Boolean(f.shared),
        set,
        source: entry?.source || null,
        sharedFallback,
        // Show the last 4 characters of non-secret values so a user can tell
        // which account is configured without us echoing the password.
        // Never echo a shared default's tail — it belongs to the distributor.
        preview: set && !f.secret && !sharedFallback ? entry.value : (set ? `••••${String(entry.value).slice(-2)}` : null),
        locked_by_env: entry?.source === 'env'
      };
    })
  }));

  const enabled = {
    // A site login is always required. The dev pair is satisfied by a typed
    // value OR the baked-in shared default — four effective values total.
    screenscraper: Boolean(
      config.SS_DEV_ID?.value && config.SS_DEV_PASSWORD?.value &&
      config.SS_USER?.value && config.SS_PASSWORD?.value
    ),
    thegamesdb: Boolean(config.TGDB_API_KEY?.value),
    igdb: Boolean(config.IGDB_CLIENT_ID?.value && config.IGDB_CLIENT_SECRET?.value),
    steamgriddb: Boolean(config.SGDB_API_KEY?.value)
  };

  return { providers, enabled, encryption: encryptionInfo(), sharedDevDefault: Boolean(envVal('SS_DEV_ID_SHARED') && envVal('SS_DEV_PASSWORD_SHARED')) };
}

/** Save credentials. Admin-only on the API. An empty string clears a value;
 * undefined leaves it alone. Fields pinned by a (non-empty) environment
 * variable are rejected rather than silently ignored — an empty-string compose
 * default does NOT count as pinned. */
export function saveProviderConfig(updates, userId = null) {
  const saved = [];
  const rejected = [];

  db.transaction(() => {
    for (const [key, value] of Object.entries(updates || {})) {
      if (!ALL_KEYS.includes(key)) { rejected.push({ key, reason: 'unknown field' }); continue; }
      if (envVal(key) !== undefined) { rejected.push({ key, reason: 'set by an environment variable' }); continue; }

      if (value === null || value === '') {
        db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
        saved.push({ key, cleared: true });
        continue;
      }

      const secret = SECRET_KEYS.has(key);
      db.prepare(`
        INSERT INTO app_settings (key, value, encrypted, updated_by, updated_at)
        VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted,
          updated_by = excluded.updated_by, updated_at = datetime('now')
      `).run(key, secret ? encryptSecret(value) : String(value), secret ? 1 : 0, userId);

      saved.push({ key, cleared: false });
    }
  })();

  return { saved, rejected };
}

export function clearProviderConfig(userId = null) {
  db.transaction(() => {
    for (const key of ALL_KEYS) {
      if (envVal(key) !== undefined) continue; // never touch env-pinned values
      db.prepare('DELETE FROM app_settings WHERE key = ?').run(key);
    }
  })();
  return { cleared: true, by: userId };
}

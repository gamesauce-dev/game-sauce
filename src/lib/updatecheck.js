// "Is there a newer game-sauce?" Looks at the latest published release of the project on GitHub.
//
// Load on GitHub: one request per server per six hours at most (the answer is cached, also across restarts, and shared with the
// emulator lookups' rate-limit back-off). Every household's server asks from its own address, and GitHub allows 60 anonymous
// requests an hour per address, so this stays far below any limit however many people use the project.
// Privacy: the only thing sent is an ordinary anonymous request for the project's release page; nothing about your library or
// your accounts leaves the server. Set GAMESAUCE_UPDATE_CHECK=0 to turn it off completely.
import fs from 'node:fs';

export const REPO = 'gamesauce-dev/game-sauce';

const pkg = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')); } catch { return {}; }
})();
export const currentVersion = () => String(pkg.version || '0.0.0');

const parts = (v) => String(v || '').replace(/^[^0-9]*/, '').split(/[.\-+]/).map((x) => parseInt(x, 10)).map((n) => (Number.isFinite(n) ? n : 0));
/** True when `latest` is a higher version than `current` ("v0.2.0" and "0.2.0" are the same). */
export function isNewer(latest, current) {
  const a = parts(latest), b = parts(current);
  for (let i = 0; i < Math.max(a.length, b.length, 3); i++) {
    const x = a[i] || 0, y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

export const updateCheckEnabled = () => !/^(0|false|off|no)$/i.test(String(process.env.GAMESAUCE_UPDATE_CHECK ?? '1').trim());

export async function checkForUpdate(fetchLatestRelease) {
  const current = currentVersion();
  if (!updateCheckEnabled()) return { enabled: false, current };
  const out = await fetchLatestRelease(REPO);
  if (out.missing) return { enabled: true, current, latest: null, newer: false, reason: out.missing };
  const tag = out.payload?.tag || out.payload?.name || null;
  return { enabled: true, current, latest: tag, newer: Boolean(tag) && isNewer(tag, current), url: out.payload?.url || null, stale: out.stale || null };
}

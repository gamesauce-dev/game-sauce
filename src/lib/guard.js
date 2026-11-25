// Request guards for the API: a cross-site (CSRF) check and simple in-memory rate limits.
//
// CSRF: browsers attach the session cookie to any request, even one fired by another site's page.
// For every request that changes something (not GET/HEAD/OPTIONS) we require that, when the browser
// says where the request came from (Origin header, or Sec-Fetch-Site), it came from this same site.
// Programs such as curl or the test suite send neither header and are let through: they cannot be
// tricked into using your cookie, and they authenticate with a token anyway.
//
// Rate limits: a sliding one-minute window per signed-in user (or per address before sign-in).
// Memory only, so a restart resets it. Tunable with GAMESAUCE_RATE_LIMIT (requests per minute,
// 0 turns the limits off), the optional per-kind caps GAMESAUCE_RATE_LIMIT_METADATA / _DOWNLOAD /
// _UPLOAD / _HEAVY (0 turns that one off), and GAMESAUCE_ALLOWED_ORIGINS (extra origins, comma separated).

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

const envInt = (name, fallback) => {
  const raw = String(process.env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

function allowedOrigins() {
  return String(process.env.GAMESAUCE_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
}

/** Host the browser used, honouring a reverse proxy only when the operator said to trust it. */
function requestHost(req, trustProxy) {
  const fwd = trustProxy ? String(req.headers['x-forwarded-host'] || '').split(',')[0].trim() : '';
  return (fwd || req.headers.host || '').toLowerCase();
}

export function originGuard({ trustProxy = false } = {}) {
  return (req, res, next) => {
    if (SAFE.has(req.method)) return next();

    const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    const origin = String(req.headers.origin || '').trim();

    // Fetch metadata is set by the browser itself and cannot be forged by a web page.
    if (site === 'cross-site') {
      return res.status(403).json({ error: 'Blocked: this request came from another website.' });
    }
    if (!origin) return next();   // No Origin: a non-browser client, or an old browser.
    // 'null' is a page with no origin of its own (sandboxed, or opened from a file): let through only when the browser itself says it is this site.
    if (origin === 'null' && site === 'same-origin') return next();

    let host = '';
    try { host = new URL(origin).host.toLowerCase(); } catch { /* malformed */ }
    if (host && host === requestHost(req, trustProxy)) return next();
    if (allowedOrigins().includes(origin.replace(/\/+$/, '').toLowerCase())) return next();

    return res.status(403).json({
      error: 'Blocked: this request came from a different address than the one this server is using. If you reach game-sauce through a reverse proxy, set GAMESAUCE_TRUST_PROXY=1 or list the address in GAMESAUCE_ALLOWED_ORIGINS.'
    });
  };
}

/* ───────────────────────────── rate limiting ───────────────────────────── */

const WINDOW_MS = 60 * 1000;
const buckets = new Map(); // key -> array of timestamps (ms)

const sweep = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const [k, arr] of buckets) {
    while (arr.length && arr[0] <= cutoff) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, WINDOW_MS);
sweep.unref?.();

/** Returns seconds to wait when over the limit, or 0 when the call is allowed (and counted). */
export function hit(key, limit, now = Date.now()) {
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  const cutoff = now - WINDOW_MS;
  while (arr.length && arr[0] <= cutoff) arr.shift();
  if (arr.length >= limit) return Math.max(1, Math.ceil((arr[0] + WINDOW_MS - now) / 1000));
  arr.push(now);
  return 0;
}

export function resetRateLimits() { buckets.clear(); }

// Cover art and media are hundreds of small GETs when a library page loads: never count them. That is every picture a list shows: the Library's covers, media
// and files (spine, disc, back), the Digital library's console covers, the Physical shelf's covers, backs, discs and spines, the platform and family logos and the
// profile pictures. (The Digital and Physical ones used to be counted: a big console list went over the limit, and the covers past it came back "too many
// requests" and stayed as empty tiles until the page was refreshed.)
const FREE_PATH = /^\/(health$|roms\/\d+\/(cover|media\/|file\/)|digital\/cover\/|physical\/(cover|back|disc|spine)\/\d+|platforms\/(families\/logo|[^/]+\/logo)$|auth\/avatar\/\d+)/;

// Actions that cost real resources (provider quota, disk, bandwidth), with their own, tighter caps.
const EXPENSIVE = [
  { name: 'metadata', test: (m, p) => m === 'POST' && (/^\/metadata\//.test(p) || /^\/roms\/\d+\/refresh/.test(p) || p === '/roms/bulk/refresh'), per: 'METADATA', fallback: 60 },
  { name: 'download', test: (m, p) => m === 'GET' && /^\/roms\/\d+\/download/.test(p), per: 'DOWNLOAD', fallback: 60 },
  { name: 'upload', test: (m, p) => m === 'POST' && (p === '/roms/upload' || /^\/roms\/\d+\/cover/.test(p)), per: 'UPLOAD', fallback: 60 },
  { name: 'restore', test: (m, p) => m === 'POST' && /^\/backup\/(restore|run)/.test(p), per: 'HEAVY', fallback: 20 }
];

export function rateLimit() {
  return (req, res, next) => {
    const general = envInt('GAMESAUCE_RATE_LIMIT', 900);
    if (general === 0) return next();
    const p = req.path;
    if (FREE_PATH.test(p)) return next();

    const who = req.user ? `u${req.user.id}` : `ip${req.ip}`;
    for (const e of EXPENSIVE) {
      if (!e.test(req.method, p)) continue;
      // The expensive caps scale with the general one, so turning the general limit up loosens them too.
      const cap = envInt(`GAMESAUCE_RATE_LIMIT_${e.per}`, Math.max(1, Math.round(e.fallback * (general / 900))));
      if (cap === 0) continue; // 0 switches this one cap off (it must not mean "allow nothing")
      const wait = hit(`${who}|${e.name}`, cap);
      if (wait) return tooMany(res, wait, `Too many ${e.name} requests. Try again in ${wait} s.`);
    }
    const wait = hit(`${who}|all`, general);
    if (wait) return tooMany(res, wait, `Too many requests. Try again in ${wait} s.`);
    return next();
  };
}

function tooMany(res, wait, error) {
  res.setHeader('Retry-After', String(wait));
  return res.status(429).json({ error, retry_after: wait });
}

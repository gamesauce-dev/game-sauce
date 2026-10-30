// Slow-request log. The app answers one request at a time on a single thread, so one slow job can make everything
// else feel stuck. This notes every request that takes over a second (what it was, how long, and what else had
// started while it ran) so the cause can be seen in Health instead of guessed at. Kept in memory only.
const SLOW_MS = Number(process.env.GAMESAUCE_SLOW_MS || 1000);
const KEEP = 50;
const entries = [];
let inFlight = 0;

export function slowLogMiddleware(req, res, next) {
  const start = Date.now();
  const startedWhile = inFlight; // requests already running when this one began
  inFlight++;
  const onDone = () => {
    inFlight = Math.max(0, inFlight - 1);
    const ms = Date.now() - start;
    if (ms >= SLOW_MS && req.originalUrl?.startsWith('/api')) {
      entries.unshift({
        at: new Date().toISOString(),
        method: req.method,
        path: String(req.originalUrl).split('?')[0],
        query: String(req.originalUrl).includes('?') ? String(req.originalUrl).split('?')[1].slice(0, 120) : '',
        ms,
        status: res.statusCode,
        others_running: startedWhile,
        user: req.user?.username || null
      });
      entries.length = Math.min(entries.length, KEEP);
    }
  };
  res.once('finish', onDone);
  res.once('close', () => { if (!res.writableFinished) onDone(); });
  next();
}

export function slowLog() {
  return { threshold_ms: SLOW_MS, entries: entries.slice() };
}

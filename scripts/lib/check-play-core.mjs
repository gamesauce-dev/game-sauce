// The engine behind scripts/check-play.mjs (command line) and scripts/check-play-gui.mjs (the window in your browser).
// It signs in, picks the games, plays each one in a headless browser, looks at the picture and records a verdict.
// It prints nothing itself: everything it wants to say goes out through emit(type, data), so each front end can show it its own way.
//
// Events: 'log' (text), 'plan' ({ total, minutes }), 'begin' ({ id, title, platform }), 'game' ({ rec, finished, of, tally }),
//         'step' ({ platform, from, to, ran, tried, tooFew }), 'applied' ({ switchedOn, switchedOff }).
import fs from 'node:fs';
import path from 'node:path';
import { verdict, planBuckets, judgeSteps, isSparse, isFailure } from '../../src/lib/playcheck.js';

export const RESULTS_FILE = 'results.jsonl';

/** Sign in as an admin. Throws an Error whose message says what to do next. */
export async function connect(server, user, password) {
  server = String(server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(server)) throw new Error('The server address must start with http:// or https:// (for example http://192.168.1.50:8765).');
  let lr;
  try {
    lr = await fetch(`${server}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password }) });
  } catch (e) { throw new Error(`Cannot reach ${server}: ${e.message}`); }
  const login = await lr.json().catch(() => ({}));
  if (!lr.ok || !login.token) throw new Error(`Sign-in failed: ${login.error || lr.status}`);
  if (login.user?.role !== 'admin') throw new Error('This check needs an admin account.');
  const H = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(server + p, { headers: H }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
  return { server, token: login.token, user: login.user, H, get };
}

export async function listPlatforms(conn) { return (await conn.get('/api/platforms')).items; }

/** Every game of one platform that matches `playable` ('1' offered for browser play, 'candidates' also those not offered yet). */
async function fetchGames(conn, slug, { candidates, recheck }) {
  let all = [];
  for (let off = 0; ; off += 500) {
    const page = await conn.get(`/api/roms?platform=${encodeURIComponent(slug)}&playable=${candidates ? 'candidates' : '1'}${recheck ? '' : '&skip_on=1'}&sort=title&limit=500&offset=${off}`);
    all = all.concat(page.items);
    if (all.length >= page.total || !page.items.length) break;
  }
  return all;
}

/** The games offered for browser play on these platforms (what --off switches off). */
export async function offeredGames(conn, platforms, only = '') {
  let list = [];
  for (const slug of platforms) {
    for (let off = 0; ; off += 500) {
      const page = await conn.get(`/api/roms?platform=${encodeURIComponent(slug)}&playable=1&sort=title&limit=500&offset=${off}`);
      list = list.concat(page.items.map((g) => ({ ...g, slug })));
      if (list.length >= page.total || !page.items.length) break;
    }
  }
  const q = String(only || '').toLowerCase();
  return q ? list.filter((g) => String(g.title).toLowerCase().includes(q)) : list;
}

/** Switch browser play off for these games. Returns { n, failed }. */
export async function switchOff(conn, games, onProgress) {
  let n = 0, failed = 0;
  for (const g of games) {
    try { const x = await fetch(`${conn.server}/api/roms/${g.id}/play-override`, { method: 'POST', headers: conn.H, body: JSON.stringify({ value: false }) }); x.ok ? n++ : failed++; } catch { failed++; }
    if ((n + failed) % 50 === 0) onProgress?.(n + failed, games.length);
  }
  return { n, failed };
}

/** The saved results of earlier runs, as a Map by game id (a torn last line is skipped). */
export function loadResults(outDir) {
  const done = new Map();
  const file = path.join(outDir, RESULTS_FILE);
  if (!fs.existsSync(file)) return done;
  for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); done.set(r.id, r); } catch { /* skip a torn line */ } }
  return done;
}

/** What the games should be switched to, judged from saved results: ON for games that ran, OFF for ones that failed. */
export function pendingChanges(records) {
  const toOn = records.filter((r) => r.verdict === 'runs' && !r.was_on);
  const toOff = records.filter((r) => isFailure(r.verdict) && (r.offered || r.was_on));
  return { toOn, toOff };
}

/** Switch games ON/OFF from saved results, without testing anything. mode: 'on' | 'off' | 'both'. */
export async function applyResults(conn, records, mode = 'both', emit = () => {}) {
  const { toOn, toOff } = pendingChanges(records);
  let switchedOn = 0, switchedOff = 0, failed = 0;
  const send = async (r, value) => {
    try { const x = await fetch(`${conn.server}/api/roms/${r.id}/play-override`, { method: 'POST', headers: conn.H, body: JSON.stringify({ value }) }); if (x.ok) { value ? switchedOn++ : switchedOff++; } else failed++; } catch { failed++; }
  };
  if (mode === 'on' || mode === 'both') for (const r of toOn) await send(r, true);
  if (mode === 'off' || mode === 'both') for (const r of toOff) await send(r, false);
  emit('applied', { switchedOn, switchedOff });
  return { switchedOn, switchedOff, failed };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function writeReport(outDir, all, server) {
  const bad = all.filter((r) => r.verdict !== 'runs');
  fs.writeFileSync(path.join(outDir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Play check</title><style>body{font:14px system-ui;background:#111;color:#eee;margin:20px}.g{display:inline-block;width:210px;margin:6px;vertical-align:top}.g img{width:210px;border:1px solid #444}.t{font-size:12px;margin-top:3px}.m{color:#ff8a8a}.b{color:#ffcf6e}</style><h1>Play check</h1><p>${all.length} games checked, ${bad.length} not running. Checked ${new Date().toLocaleString()} against ${esc(server)}.</p>${bad.map((r) => `<div class="g">${r.shot ? `<img src="${r.shot}">` : ''}<div class="t"><b>${esc(r.title)}</b><br>${esc(r.platform)}${r.year ? ' · ' + r.year : ''}<br><span class="${r.verdict === 'retroarch-menu' ? 'm' : 'b'}">${esc(r.verdict)}</span></div></div>`).join('')}`);
}

/** Tally of verdicts per platform: { mame: { runs: 3, 'retroarch-menu': 1 } }. */
export function tallyByPlatform(all) {
  const by = {};
  for (const r of all) { (by[r.platform] ||= {})[r.verdict] = (by[r.platform]?.[r.verdict] || 0) + 1; }
  return by;
}

/** Wait up to `ms`, but wake early when the run is stopped. */
const nap = (ms, signal) => new Promise((res) => {
  if (signal?.aborted) return res();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal?.removeEventListener('abort', done); res(); }
  signal?.addEventListener('abort', done, { once: true });
});

/** The options a run understands, with their defaults. Anything unknown is dropped. */
export function normaliseOptions(o = {}) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const cutoff = Boolean(o.cutoff);
  return {
    platforms: (Array.isArray(o.platforms) ? o.platforms : String(o.platforms || '').split(',')).map((s) => String(s).trim()).filter(Boolean),
    sample: o.all ? 0 : Math.max(0, Math.floor(num(o.sample, 20))),
    all: Boolean(o.all),
    limit: Math.max(0, Math.floor(num(o.limit, 0))),
    only: String(o.only || '').toLowerCase(),
    seconds: Math.max(4, num(o.seconds, 12)),
    concurrency: Math.max(1, Math.min(6, Math.floor(num(o.concurrency, 2)))),
    apply: Boolean(o.apply),
    recheck: Boolean(o.recheck),
    cutoff,
    candidates: Boolean(o.candidates) || cutoff,
    perYear: Math.max(3, Math.floor(num(o.perYear, 8))),
    resume: Boolean(o.resume),
    headed: Boolean(o.headed),
  };
}

/**
 * Run a check. conn comes from connect(). opts as in normaliseOptions (plus outDir). emit(type, data) reports progress.
 * signal (an AbortSignal) stops it: games already judged stay saved, so the run can be carried on later with resume.
 * Returns { nothing, aborted, all, cutoffReport, switchedOn, switchedOff }.
 */
export async function runCheck(conn, rawOpts, { emit = () => {}, signal } = {}) {
  const opts = normaliseOptions(rawOpts);
  const outDir = path.resolve(rawOpts.outDir || './play-check');
  const { server, H } = conn;
  const log = (t) => emit('log', t);
  const { sample, limit, only, seconds, concurrency, apply, recheck, candidates, cutoff, perYear, resume } = opts;

  // ---- which games
  const plats = await listPlatforms(conn);
  for (const s of opts.platforms) if (!plats.some((p) => p.slug === s)) throw new Error(`No platform called "${s}". Slugs here: ${plats.map((p) => p.slug).join(', ')}`);
  const wanted = cutoff && !opts.platforms.length ? ['mame'] : opts.platforms.length ? opts.platforms : plats.filter((p) => p.count > 0).map((p) => p.slug);

  fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
  const jsonl = path.join(outDir, RESULTS_FILE);
  const done = resume ? loadResults(outDir) : new Map();
  const sampled = {};
  const games = [];
  for (const slug of wanted) {
    let all = await fetchGames(conn, slug, { candidates, recheck });
    if (only) all = all.filter((g) => String(g.title).toLowerCase().includes(only));
    if (cutoff) { /* chosen year by year below */ }
    else if (limit) all = all.slice(0, limit);
    else if (sample && resume) {
      // Carry on: draw only from games not tested yet, and when not many are left just do them all (so a platform finishes).
      const fresh = all.filter((g) => !done.has(g.id));
      const left = fresh.length;
      if (left > sample * 2) { for (let i = fresh.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [fresh[i], fresh[j]] = [fresh[j], fresh[i]]; } all = fresh.slice(0, sample); }
      else all = fresh;
      if (left > all.length) sampled[slug] = left - all.length;
    }
    else if (sample && all.length > sample) { for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; } all = all.slice(0, sample); }
    if (!cutoff && !limit && sample && !resume && all.length === sample) log(`${slug}: only a random ${sample} will be checked. Add --all to check every game.`);
    log(`${slug}: ${all.length} game${all.length === 1 ? '' : 's'} ${cutoff ? 'to pick from' : 'to check'}`);
    games.push(...all.map((g) => ({ ...g, slug })));
  }
  if (!games.length) {
    log('Nothing left to check. Every game on those platforms is already switched on (it passed earlier) or switched off (it failed), or none can play.');
    log('Add --recheck to test the ones switched on again' + (candidates ? '.' : ', or --candidates to include games the app does not offer yet.'));
    return { nothing: true, aborted: false, all: [...done.values()], cutoffReport: [], switchedOn: 0, switchedOff: 0, outDir };
  }

  const todo = cutoff ? [] : games.filter((g) => !done.has(g.id));
  if (!(resume && fs.existsSync(jsonl))) {
    // A fresh run starts a fresh results file. The old one is kept beside it, so a forgotten --resume cannot lose a long run.
    if (fs.existsSync(jsonl) && fs.statSync(jsonl).size > 0) fs.renameSync(jsonl, path.join(outDir, `results-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl.bak`));
    fs.writeFileSync(jsonl, '');
  }
  for (const [slug, n] of Object.entries(sampled)) log(`${slug}: ${n} more untested after this batch. Add --all to do every one of them in a single run.`);
  const minutes = Math.ceil(todo.length * (seconds + 4) / concurrency / 60);
  if (!cutoff) { log(`\n${todo.length} to check${done.size ? ` (${done.size} already done)` : ''}; about ${minutes} minute(s) at ${concurrency} at a time.\n`); emit('plan', { total: todo.length, alreadyDone: done.size, minutes }); }

  // ---- the browser
  let chromium;
  try { ({ chromium } = await import('playwright')); }
  catch { throw new Error('The test browser tooling is not installed. In the game-sauce folder run:  npm ci  and then  npx playwright install chromium'); }
  let browser;
  try {
    browser = await chromium.launch({ headless: !opts.headed, args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  } catch (e) { throw new Error(`Could not start the test browser: ${String(e.message).split('\n')[0]}. Run  npx playwright install chromium  once, then try again.`); }
  const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
  await ctx.addCookies([{ name: 'gamesauce_session', value: conn.token, url: server }]);
  const analyser = await ctx.newPage();

  /** Count the colours in a PNG: how many there are, and the three most common with their share of the picture. */
  async function measure(png) {
    return analyser.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const x = c.getContext('2d'); x.drawImage(img, 0, 0);
      const px = x.getImageData(0, 0, c.width, c.height).data, hist = new Map(); let n = 0;
      for (let i = 0; i < px.length; i += 4) { const k = ((px[i] >> 3) << 10) | ((px[i + 1] >> 3) << 5) | (px[i + 2] >> 3); hist.set(k, (hist.get(k) || 0) + 1); n++; }
      const top = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => ({ r: (k >> 10) * 8, g: ((k >> 5) & 31) * 8, b: (k & 31) * 8, share: v / n }));
      return { colours: hist.size, top };
    }, png.toString('base64'));
  }

  // apply works game by game, right after each one is judged, so stopping the run (or the PC going to sleep) loses nothing.
  const applied = new Set();
  let switchedOn = 0, switchedOff = 0;
  async function applyOne(rec) {
    if (!apply || applied.has(rec.id)) return;
    let value = null;
    if (rec.verdict === 'runs' && !rec.was_on) value = true;
    else if (isFailure(rec.verdict) && (rec.offered || rec.was_on)) value = false;
    if (value === null) { applied.add(rec.id); return; }
    try {
      const x = await fetch(`${server}/api/roms/${rec.id}/play-override`, { method: 'POST', headers: H, body: JSON.stringify({ value }) });
      if (x.ok) { applied.add(rec.id); value ? switchedOn++ : switchedOff++; }
    } catch { /* the end of the run tries again */ }
  }

  /** Test one game. Returns null when the run was stopped part-way (nothing is recorded: the game is tested next time). */
  async function checkOne(g) {
    const page = await ctx.newPage();
    let romStatus = null;
    emit('begin', { id: g.id, title: g.title, platform: g.slug });
    // Read-only: no saved states are offered or written, and the test play is not counted as a real one.
    await page.route('**/api/roms/*/saves**', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: [] } }) : r.fulfill({ status: 204, body: '' })));
    await page.route('**/api/roms/*/play/**', (r) => r.continue({ headers: { ...r.request().headers(), 'x-gamesauce-check': '1' } }));
    page.on('response', (r) => { if (r.url().includes('/api/roms/') && r.url().includes('/play/')) romStatus = r.status(); });
    const frames = [], pngs = [];
    const shoot = async () => {
      const png = await page.locator('#game canvas').first().screenshot({ timeout: 4000 }).catch(() => null);
      if (png) { pngs.push(png); frames.push(await measure(png)); }
    };
    try {
      const params = new URLSearchParams({ id: String(g.id), rom: `/api/roms/${g.id}/play/${encodeURIComponent(g.filename)}`, core: g.candidate_core || g.playable_core || '', title: g.title });
      await page.goto(`${server}/ejs-player.html?${params}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      for (const share of [0.5, 0.3, 0.2]) { // a picture at half, 80% and the end of the wait
        await nap(seconds * 1000 * share, signal);
        if (signal?.aborted) break;
        await shoot();
      }
      // Still almost all black (a start-up self-test, a slow boot)? Give it more time, twice, before judging.
      for (let extra = 0; extra < 2 && !signal?.aborted && frames.length && isSparse(frames[frames.length - 1]); extra++) {
        await nap(7000, signal);
        if (signal?.aborted) break;
        await shoot();
      }
    } catch (e) { /* judged below from what we saw */ }
    await page.close().catch(() => {});
    if (signal?.aborted) return null;
    let v = romStatus && romStatus >= 400 ? 'rom-unreachable' : verdict(frames);
    if (v === 'rom-unreachable' && romStatus === 400) v = 'not-playable-here';
    const rec = { id: g.id, platform: g.slug, title: g.title, year: g.release_year || null, file: g.filename, offered: Boolean(g.playable), was_on: g.play_override === 1, verdict: v, at: new Date().toISOString() };
    if (v !== 'runs' && pngs.length) { rec.shot = `shots/${g.id}.png`; fs.writeFileSync(path.join(outDir, rec.shot), pngs[pngs.length - 1]); }
    fs.appendFileSync(jsonl, JSON.stringify(rec) + '\n');
    done.set(g.id, rec);
    await applyOne(rec);
    return rec;
  }

  let finished = 0;
  const tally = {};
  async function runBatch(list, of) {
    let i = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (i < list.length && !signal?.aborted) {
        const g = list[i++];
        const rec = done.get(g.id) && resume ? done.get(g.id) : await checkOne(g);
        if (!rec) return;
        finished++;
        tally[rec.verdict] = (tally[rec.verdict] || 0) + 1;
        emit('game', { rec, finished, of, tally: { ...tally } });
      }
    }));
  }

  const cutoffReport = [];
  try {
    if (!cutoff) {
      await runBatch(todo, todo.length);
    } else {
      // Oldest year first, a handful of games per year. Stop once two years in a row mostly fail: from there on it is not going to get better.
      for (const slug of wanted) {
        if (signal?.aborted) break;
        const mine = games.filter((g) => g.slug === slug);
        const counts = new Map();
        for (const g of mine) if (g.release_year) counts.set(g.release_year, (counts.get(g.release_year) || 0) + 1);
        const steps = planBuckets([...counts].map(([year, count]) => ({ year, count })), perYear);
        const minEvidence = Math.min(5, perYear);
        const results = [];
        const nogame = mine.filter((g) => !g.release_year).length;
        log(`\n${slug}: ${steps.length} step(s) from ${steps[0]?.from} to ${steps[steps.length - 1]?.to}, up to ${perYear} games each, oldest first.${nogame ? ` (${nogame} games with no year are left out.)` : ''}\n`);
        let verdictSoFar = { stop: false };
        for (const st of steps) {
          if (signal?.aborted) break;
          const pool = mine.filter((g) => g.release_year >= st.from && g.release_year <= st.to).sort(() => Math.random() - 0.5).slice(0, perYear);
          await runBatch(pool, null);
          if (signal?.aborted) break; // a half-tested step proves nothing
          const recs = pool.map((g) => done.get(g.id)).filter(Boolean);
          const ran = recs.filter((r) => r.verdict === 'runs').length;
          results.push({ from: st.from, to: st.to, tried: recs.length, ran });
          const label = st.from === st.to ? `${st.from}` : `${st.from} to ${st.to}`;
          log(`   ${label}: ${ran} of ${recs.length} run (${recs.length ? Math.round(ran / recs.length * 100) : 0}%)${recs.length < minEvidence ? '  [too few games to count]' : ''}\n`);
          emit('step', { platform: slug, from: st.from, to: st.to, ran, tried: recs.length, tooFew: recs.length < minEvidence });
          verdictSoFar = judgeSteps(results, minEvidence);
          if (verdictSoFar.stop) break;
        }
        cutoffReport.push({ platform: slug, summary: true, results, ...verdictSoFar });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const all = [...done.values()];
  writeReport(outDir, all, server);
  if (apply) for (const r of all) await applyOne(r); // anything not sent during the run (an earlier run without apply, or a hiccup)
  if (apply) emit('applied', { switchedOn, switchedOff });
  return { nothing: false, aborted: Boolean(signal?.aborted), all, cutoffReport, switchedOn, switchedOff, outDir };
}

#!/usr/bin/env node
// Checks which games flagged "play in browser" really start, by loading each one in a real (headless) browser and looking at
// the picture. A game the browser core cannot run drops into RetroArch's own menu; the emulator never reports that as an
// error, so this looks at what is drawn. Run it on a PC, pointed at your server. It needs a signed-in ADMIN.
//
//   npm ci                                    (once, in the game-sauce folder: this installs the test browser tooling)
//   npx playwright install chromium           (once: downloads the browser, about 150 MB)
//   node scripts/check-play.mjs --server http://192.168.0.10:8765 --user admin --platform mame,fba
//
// It READS only. It plays each game for a few seconds with saving switched off, and test plays are not counted in "Continue
// playing" or the stats. Nothing is changed unless you add --apply (which switches off browser play for the games that
// landed in the RetroArch menu; you can switch any of them back on from the game's ⋯ menu).
//
// Options
//   --server URL        your server (default http://127.0.0.1:8765)
//   --user NAME         an admin account;  the password is asked for, or set GAMESAUCE_PASSWORD
//   --platform a,b      platform slugs to check, e.g. mame,fba,neogeo,nes (default: every platform that can play)
//   --sample N          check N random games per platform (default 20: a quick health check)
//   --all               check EVERY playable game (slow: about 12 seconds each, a few at a time)
//   --limit N           only the first N games per platform (alphabetical)
//   --seconds N         how long to let each game run before judging it (default 12)
//   --concurrency N     games checked at once (default 2)
//   --resume            carry on an earlier run (skips games already in the output folder)
//   --apply             switch off browser play for games that show the RetroArch menu
//   --out DIR           where to put the results (default ./play-check)
//   --headed            show the browser while it runs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { verdict } from '../src/lib/playcheck.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

if (flag('--help') || flag('-h')) { console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).map((l) => l.slice(3)).join('\n')); process.exit(0); }

const server = (opt('--server', 'http://127.0.0.1:8765')).replace(/\/+$/, '');
const user = opt('--user', 'admin');
const platforms = (opt('--platform', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const sample = flag('--all') ? 0 : Number(opt('--sample', 20));
const limit = Number(opt('--limit', 0)) || 0;
const seconds = Math.max(4, Number(opt('--seconds', 12)));
const concurrency = Math.max(1, Math.min(6, Number(opt('--concurrency', 2))));
const outDir = path.resolve(opt('--out', './play-check'));
const apply = flag('--apply');

async function ask(question, hidden) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) { rl._writeToOutput = (s) => { if (s.includes(question)) process.stdout.write(s); }; }
  return new Promise((res) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); res(a); }));
}

const pw = process.env.GAMESAUCE_PASSWORD || await ask(`Password for ${user}: `, true);
const lr = await fetch(`${server}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: user, password: pw }) }).catch((e) => { console.error(`Cannot reach ${server}: ${e.message}`); process.exit(1); });
const login = await lr.json().catch(() => ({}));
if (!lr.ok || !login.token) { console.error(`Sign-in failed: ${login.error || lr.status}`); process.exit(1); }
if (login.user?.role !== 'admin') { console.error('This check needs an admin account.'); process.exit(1); }
const H = { Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json' };
const get = async (p) => { const r = await fetch(server + p, { headers: H }); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };

// ---- which games
const plats = (await get('/api/platforms')).items;
const wanted = platforms.length ? platforms : plats.filter((p) => p.count > 0).map((p) => p.slug);
for (const s of platforms) if (!plats.some((p) => p.slug === s)) { console.error(`No platform called "${s}". Slugs here: ${plats.map((p) => p.slug).join(', ')}`); process.exit(1); }
const games = [];
for (const slug of wanted) {
  let all = [];
  for (let off = 0; ; off += 500) {
    const page = await get(`/api/roms?platform=${encodeURIComponent(slug)}&playable=1&sort=title&limit=500&offset=${off}`);
    all = all.concat(page.items);
    if (all.length >= page.total || !page.items.length) break;
  }
  if (limit) all = all.slice(0, limit);
  else if (sample && all.length > sample) { for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; } all = all.slice(0, sample); }
  console.log(`${slug}: ${all.length} game${all.length === 1 ? '' : 's'} to check`);
  games.push(...all.map((g) => ({ ...g, slug })));
}
if (!games.length) { console.log('Nothing to check: no games are flagged playable for those platforms.'); process.exit(0); }

fs.mkdirSync(path.join(outDir, 'shots'), { recursive: true });
const jsonl = path.join(outDir, 'results.jsonl');
const done = new Map();
if (flag('--resume') && fs.existsSync(jsonl)) for (const l of fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean)) { try { const r = JSON.parse(l); done.set(r.id, r); } catch { /* skip a torn line */ } }
else fs.writeFileSync(jsonl, '');
const todo = games.filter((g) => !done.has(g.id));
console.log(`\n${todo.length} to check${done.size ? ` (${done.size} already done)` : ''}; about ${Math.ceil(todo.length * (seconds + 4) / concurrency / 60)} minute(s) at ${concurrency} at a time.\n`);

// ---- the browser
const browser = await chromium.launch({ headless: !flag('--headed'), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 480 } });
await ctx.addCookies([{ name: 'gamesauce_session', value: login.token, url: server }]);
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

async function checkOne(g) {
  const page = await ctx.newPage();
  let romStatus = null;
  // Read-only: no saved states are offered or written, and the test play is not counted as a real one.
  await page.route('**/api/roms/*/saves**', (r) => (r.request().method() === 'GET' ? r.fulfill({ json: { items: [] } }) : r.fulfill({ status: 204, body: '' })));
  await page.route('**/api/roms/*/play/**', (r) => r.continue({ headers: { ...r.request().headers(), 'x-gamesauce-check': '1' } }));
  page.on('response', (r) => { if (r.url().includes('/api/roms/') && r.url().includes('/play/')) romStatus = r.status(); });
  const frames = [], pngs = [];
  try {
    const params = new URLSearchParams({ id: String(g.id), rom: `/api/roms/${g.id}/play/${encodeURIComponent(g.filename)}`, core: g.playable_core || '', title: g.title });
    await page.goto(`${server}/ejs-player.html?${params}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    for (const share of [0.5, 0.3, 0.2]) { // a picture at half, 80% and the end of the wait
      await page.waitForTimeout(seconds * 1000 * share);
      const png = await page.locator('#game canvas').first().screenshot({ timeout: 4000 }).catch(() => null);
      if (png) { pngs.push(png); frames.push(await measure(png)); }
    }
  } catch (e) { /* judged below from what we saw */ }
  await page.close().catch(() => {});
  let v = romStatus && romStatus >= 400 ? 'rom-unreachable' : verdict(frames);
  if (v === 'rom-unreachable' && romStatus === 400) v = 'not-playable-here';
  const rec = { id: g.id, platform: g.slug, title: g.title, year: g.release_year || null, file: g.filename, verdict: v, at: new Date().toISOString() };
  if (v !== 'runs' && pngs.length) { rec.shot = `shots/${g.id}.png`; fs.writeFileSync(path.join(outDir, rec.shot), pngs[pngs.length - 1]); }
  fs.appendFileSync(jsonl, JSON.stringify(rec) + '\n');
  done.set(g.id, rec);
  return rec;
}

let idx = 0, finished = 0;
const tally = {};
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (idx < todo.length) {
    const g = todo[idx++];
    const rec = await checkOne(g);
    finished++;
    tally[rec.verdict] = (tally[rec.verdict] || 0) + 1;
    const mark = rec.verdict === 'runs' ? '  ok ' : rec.verdict === 'retroarch-menu' ? ' FAIL' : ' ??  ';
    console.log(`[${finished}/${todo.length}] ${mark} ${rec.platform.padEnd(8)} ${rec.title}  ${rec.verdict === 'runs' ? '' : '(' + rec.verdict + ')'}`);
  }
}));
await browser.close();

// ---- report
const all = [...done.values()];
const by = {};
for (const r of all) { (by[r.platform] ||= {})[r.verdict] = (by[r.platform]?.[r.verdict] || 0) + 1; }
console.log('\n=== Result ===');
for (const [p, v] of Object.entries(by)) { const n = Object.values(v).reduce((a, b) => a + b, 0); console.log(`${p.padEnd(10)} ${n} checked: ${Object.entries(v).map(([k, c]) => `${c} ${k}`).join(', ')}`); }
const bad = all.filter((r) => r.verdict !== 'runs');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
fs.writeFileSync(path.join(outDir, 'report.html'), `<!doctype html><meta charset="utf-8"><title>Play check</title><style>body{font:14px system-ui;background:#111;color:#eee;margin:20px}.g{display:inline-block;width:210px;margin:6px;vertical-align:top}.g img{width:210px;border:1px solid #444}.t{font-size:12px;margin-top:3px}.m{color:#ff8a8a}.b{color:#ffcf6e}</style><h1>Play check</h1><p>${all.length} games checked, ${bad.length} not running. Checked ${new Date().toLocaleString()} against ${esc(server)}.</p>${bad.map((r) => `<div class="g">${r.shot ? `<img src="${r.shot}">` : ''}<div class="t"><b>${esc(r.title)}</b><br>${esc(r.platform)}${r.year ? ' · ' + r.year : ''}<br><span class="${r.verdict === 'retroarch-menu' ? 'm' : 'b'}">${esc(r.verdict)}</span></div></div>`).join('')}`);
console.log(`\nResults: ${outDir}${path.sep}results.jsonl   Pictures of the failures: ${outDir}${path.sep}report.html`);

const toOff = all.filter((r) => r.verdict === 'retroarch-menu');
if (apply && toOff.length) {
  let n = 0;
  for (const r of toOff) { const x = await fetch(`${server}/api/roms/${r.id}/play-override`, { method: 'POST', headers: H, body: JSON.stringify({ value: false }) }); if (x.ok) n++; }
  console.log(`\nSwitched browser play OFF for ${n} game${n === 1 ? '' : 's'} that showed the RetroArch menu. (Any can be switched back on from the game's ⋯ menu.)`);
} else if (toOff.length) {
  console.log(`\n${toOff.length} game${toOff.length === 1 ? '' : 's'} showed the RetroArch menu. Look at report.html, then run again with --resume --apply to switch browser play off for them.`);
}

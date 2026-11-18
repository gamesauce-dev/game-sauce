// Records the shelf clip for the intro from a live game-sauce: the Physical library as a shelf of spines, a spine pulled out, the case brought forward, turned over, opened, the manual read.
//   set GS_USER and GS_PASS (and optionally GS_URL), then:  node record-shelf.cjs     Output: work/shelf-live.webm   (it only opens and closes cases: nothing is changed)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const URL = (process.env.GS_URL || 'http://192.168.0.149:8765').replace(/\/?$/, '/');
const USER = process.env.GS_USER, PASS = process.env.GS_PASS;
if (!USER || !PASS) { console.error('Set GS_USER and GS_PASS first.'); process.exit(1); }
const OUT = path.join(__dirname, 'work', 'shelf-rec');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--hide-scrollbars'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  const clickIn = (sel, i = 0) => page.evaluate(([s, n]) => { const els = document.querySelectorAll(s); if (els[n]) { els[n].click(); return true; } return false; }, [sel, i]);
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.fill('#login-username', USER); await page.fill('#login-password', PASS); await page.press('#login-password', 'Enter');
  await page.waitForSelector('[data-view="physical"], [data-mview="physical"]', { state: 'attached', timeout: 30000 });
  await wait(1500);
  await page.evaluate(() => document.querySelector('[data-view="physical"], [data-mview="physical"]').click());
  await page.waitForSelector('#ph-tiles .ph-card, #ph-shelf .ph-spine', { timeout: 30000 });
  await wait(2500);                                                                          // the tiles first
  await clickIn('[data-ph-view="shelf"]'); await page.waitForSelector('#ph-shelf .ph-spine', { timeout: 30000 }); await wait(3500);   // then the shelf of spines
  const n = await page.locator('#ph-shelf .ph-spine').count();
  console.log('spines:', n);
  let done = false;
  // GS_GAME = part of a game's title to use (one with a disc inside and a manual); otherwise it tries spines along the shelf until one has a back picture
  const want = (process.env.GS_GAME || '').toLowerCase();
  const titles = await page.$$eval('#ph-shelf .ph-spine', (els) => els.map((e) => (e.getAttribute('aria-label') || e.getAttribute('title') || e.textContent || '').toLowerCase()));
  const order = want ? titles.map((t, i) => (t.includes(want) ? i : -1)).filter((i) => i >= 0) : Array.from({ length: Math.min(14, n) }, (_, k) => Math.min(n - 1, 3 + k * 2));
  console.log('games on the shelf:', titles.join(' / '));
  if (want && !order.length) console.log('no spine matches', want);
  for (const i of order) {
    if (done) break;
    await clickIn('#ph-shelf .ph-spine', i); await wait(process.env.GS_VIDEO ? 5200 : 2200);                               // the spine is pulled out
    await clickIn('#ph-shelf .ph-spine.is-open', 0); await wait(2400);                      // the case comes forward
    if (await page.locator('.ph-case-turn').count()) {
      await clickIn('.ph-case-turn'); await wait(2600);                                      // turned over to its back
      await clickIn('.ph-case-turn'); await wait(2200);                                      // and round again
      await page.evaluate(() => document.querySelector('.ph-case')?.click()); await wait(3200);   // opened: the booklet and the disc
      await clickIn('.ph-case-inside'); await wait(3800);                                    // the manual read
      done = true;
    } else { await page.keyboard.press('Escape'); await wait(1500); }
  }
  console.log(done ? 'recorded a full case sequence' : 'no game with a back picture was found');
  await page.keyboard.press('Escape'); await wait(1500);
  await ctx.close(); await browser.close();
  const f = fs.readdirSync(OUT).find((x) => x.endsWith('.webm'));
  fs.copyFileSync(path.join(OUT, f), path.join(__dirname, 'work', 'shelf-live.webm'));
  console.log('saved work/shelf-live.webm');
})().catch((e) => { console.error(e); process.exit(1); });

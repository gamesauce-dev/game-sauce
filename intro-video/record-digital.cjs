// Records the Digital library for the intro from a live game-sauce: the store chips (with their logos, when chosen), a click through the stores, a slow scroll through the covers.
//   set GS_USER and GS_PASS (and optionally GS_URL), then:  node record-digital.cjs     Output: work/digital-live.webm  (only looks at things and clicks the chips: nothing is changed)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const URL = (process.env.GS_URL || 'http://192.168.0.149:8765').replace(/\/?$/, '/');
const USER = process.env.GS_USER, PASS = process.env.GS_PASS;
if (!USER || !PASS) { console.error('Set GS_USER and GS_PASS first.'); process.exit(1); }
const OUT = path.join(__dirname, 'work', 'digital-rec');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// the covers load a moment after a chip is clicked: wait until the ones on screen have loaded (up to 20 s), then a beat more
const covers = (page) => page.waitForFunction(() => [...document.querySelectorAll('#view-digital img')].filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; }).every((i) => i.complete && i.naturalWidth > 0), null, { timeout: 20000 }).catch(() => {}).then(() => wait(1200));
(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--hide-scrollbars'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.fill('#login-username', USER); await page.fill('#login-password', PASS); await page.press('#login-password', 'Enter');
  await page.waitForSelector('[data-view="digital"], [data-mview="digital"]', { state: 'attached', timeout: 30000 });
  await wait(1500);
  await page.evaluate(() => document.querySelector('[data-view="digital"], [data-mview="digital"]').click());   // clicked in the page: it can sit in a collapsed menu
  await page.waitForSelector('#dg-chips .ph-chip', { timeout: 30000 });
  await covers(page); await wait(1500);                                                            // the chips and the covers
  const stores = await page.$$eval('[data-dg-chip-store]', (bs) => bs.map((b) => b.dataset.dgChipStore));
  console.log('stores:', stores);
  for (const s of stores.slice(0, 3)) { await page.evaluate((x) => document.querySelector(`[data-dg-chip-store="${x}"]`).click(), s); await wait(600); await covers(page); await wait(1200); }
  await page.evaluate(() => document.querySelector('[data-dg-chip-all]')?.click()); await wait(1500);
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, 380); await wait(450); }                 // a slow scroll through the covers
  await wait(1500);
  await ctx.close(); await browser.close();
  const f = fs.readdirSync(OUT).find((n) => n.endsWith('.webm'));
  fs.copyFileSync(path.join(OUT, f), path.join(__dirname, 'work', 'digital-live.webm'));
  console.log('saved work/digital-live.webm');
})().catch((e) => { console.error(e); process.exit(1); });

// Records the Carousel clip for the intro from a live game-sauce: scrolling, the A-Z rail, the letter jump and the favourite stars.
//   set GS_USER and GS_PASS (and optionally GS_URL, GS_PLATFORM = a platform chip such as snes, GS_HIDE = chips to hide, default 'switch 2'), then:  node record-carousel.cjs
// It stars three games for the shot and takes the stars off again at the end (only the ones it starred). Output: work/carousel-live.webm
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = (process.env.GS_URL || 'http://192.168.0.149:8765').replace(/\/?$/, '/');
const USER = process.env.GS_USER, PASS = process.env.GS_PASS, PLAT = process.env.GS_PLATFORM || '';
if (!USER || !PASS) { console.error('Set GS_USER and GS_PASS first.'); process.exit(1); }
const OUT = path.join(__dirname, 'work', 'carousel-rec');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--hide-scrollbars'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, recordVideo: { dir: OUT, size: { width: 1920, height: 1080 } } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.fill('#login-username', USER); await page.fill('#login-password', PASS); await page.press('#login-password', 'Enter');
  await page.waitForSelector('#open-carousel, [data-open="carousel"]', { state: 'attached', timeout: 30000 });
  await wait(1500);
  console.log('carousel openers found:', await page.locator('#open-carousel, [data-open="carousel"]').count());
  await page.evaluate(() => { const b = document.querySelector('#open-carousel, [data-open="carousel"]'); b.click(); });   // clicked in the page: the button can sit in a collapsed menu
  try { await page.waitForSelector('.cv-card', { timeout: 30000 }); }
  catch (e) { await page.screenshot({ path: path.join(__dirname, 'work', 'carousel-fail.png') }); console.error('The carousel did not open. A screenshot is in work/carousel-fail.png'); throw e; }
  // hide the chips of platforms that should not be in the picture (names matched case-insensitively; GS_HIDE = comma list, default 'switch 2')
  const HIDE = (process.env.GS_HIDE || 'switch 2').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  await page.evaluate((hide) => {
    const sweep = () => document.querySelectorAll('.cv-chip, [data-plat], [data-fam]').forEach((el) => { const t = (el.textContent || '').toLowerCase(); if (hide.some((h) => t.includes(h))) el.style.display = 'none'; });
    sweep(); new MutationObserver(sweep).observe(document.body, { childList: true, subtree: true, characterData: true });
  }, HIDE);
  if (PLAT) { const chip = page.locator(`[data-plat="${PLAT}"]`); if (await chip.count()) { await chip.first().click(); await wait(1500); } }
  await page.waitForSelector('.cv-card img', { timeout: 30000 });
  await wait(2500);                                   // the opening: covers, rail, title
  const t0 = Date.now();                              // the shot begins here: trim the video before this
  const starred = [];
  const star = async () => { const b = page.locator('.cv-favbtn'); if (await b.count() && (await b.getAttribute('aria-pressed')) === 'false') { await b.click(); starred.push(await page.locator('.cv-title').innerText()); } await wait(1200); };
  for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowRight'); await wait(550); }     // scroll along
  await star();
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowRight'); await wait(550); }
  await star();
  const letters = await page.$$eval('#cv-az button.has', (bs) => bs.map((b) => b.dataset.l));   // the letters that have games here
  const pick = (f) => letters[Math.min(letters.length - 1, Math.floor(letters.length * f))];
  await page.locator(`#cv-az button.has[data-l="${pick(0.45)}"]`).click(); await wait(1800);     // the rail: jump to a letter in the middle
  await star();
  await page.locator(`#cv-az button.has[data-l="${pick(0.8)}"]`).click(); await wait(1800);      // and one further on
  for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowLeft'); await wait(550); }
  await page.locator(`#cv-az button.has[data-l="${pick(0)}"]`).click(); await wait(2200);        // and back to the first
  console.log('shot started at', ((t0 - 0) / 1000).toFixed(1), 's; starred:', starred);
  // clean up: take the stars off again
  for (const title of starred) {
    await page.locator('#cv-az button.has').first().click(); await wait(300);
    for (let n = 0; n < 4000; n++) {
      if ((await page.locator('.cv-title').innerText()).trim() === title.trim()) { const b = page.locator('.cv-favbtn'); if ((await b.getAttribute('aria-pressed')) === 'true') await b.click(); break; }
      await page.keyboard.press('ArrowRight', { delay: 0 }); if (n % 20 === 0) await wait(30);
    }
  }
  await ctx.close(); await browser.close();
  const f = fs.readdirSync(OUT).find((n) => n.endsWith('.webm'));
  fs.copyFileSync(path.join(OUT, f), path.join(__dirname, 'work', 'carousel-live.webm'));
  console.log('saved work/carousel-live.webm');
  console.log('Games starred for the shot (and unstarred again):', starred);
})().catch((e) => { console.error(e); process.exit(1); });

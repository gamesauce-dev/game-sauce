// Renders the chat scene of the intro, frame by frame: the Messages page with the admin's notice, a conversation opening, the other person's messages
// arriving and the person's own being typed and sent. Needs the test server up and seeded (seed-chat.cjs).
//   node render-chat.cjs [url] [seconds]   -> work/chat-frames/f0000.png ...
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] || 'http://localhost:8795/';
const SECONDS = Number(process.argv[3] || 8.0);
const FPS = 30;
const OUT = path.join(__dirname, 'work', 'chat-frames');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const token = (await (await fetch(URL + 'api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'tools-test-pass-1' }) })).json()).token;
  await fetch(URL + 'api/prefs/ui_mode', { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ value: 'modern' }) });
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--hide-scrollbars'] });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await ctx.addInitScript((t) => { try { sessionStorage.setItem('gamesauce_token', t); localStorage.setItem('gamesauce_token', t); localStorage.setItem('gamesauce_last_look', 'modern'); } catch (e) {} }, token);
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.fill('#login-username', 'tester'); await page.fill('#login-password', 'tools-test-pass-1'); await page.press('#login-password', 'Enter');
  await page.waitForSelector('.mb-navbtn[data-mview="messages"]', { timeout: 30000 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '25px'; });
  await page.click('.mb-navbtn[data-mview="messages"]');
  await page.waitForSelector('#msg-convs .msg-conv');
  await page.waitForTimeout(600);
  // the notice and conversation list are shown from the start; the thread opens at 1.2 s
  await page.click('#msg-convs .msg-conv');
  await page.waitForSelector('#msg-list .msg');
  await page.waitForTimeout(400);

  const info = await page.evaluate(() => {
    const bubbles = [...document.querySelectorAll('#msg-list .msg')];
    bubbles.forEach((b, i) => { b.dataset.i = i; b.style.visibility = 'hidden'; });
    document.querySelectorAll('.msg-conv-last').forEach((e) => { e.style.visibility = 'hidden'; });
    const input = document.getElementById('msg-input'); input.value = ''; input.blur();
    const mine = bubbles.map((b) => b.classList.contains('mine'));
    // one place for the whole timeline
    const SCRIPT = [
      { at: 1.7, i: 0 },                                                   // Sam
      { type: [2.6, 4.0], to: 'send', sendAt: 4.2, i: 1 },                 // me: typed, then sent
      { at: 5.0, i: 2 },                                                   // Sam
      { type: [5.5, 7.1], to: 'send', sendAt: 7.3, i: 3 },                 // me
      { at: 8.0, i: 4 }                                                    // Sam
    ];
    const texts = bubbles.map((b) => b.querySelector('.msg-text')?.textContent || '');
    window.__chat = { SCRIPT, texts, bubbles, input, mine };
    return { n: bubbles.length, mine, texts };
  });
  console.log('thread', info);
  if (info.n < 5) throw new Error('expected the five seeded messages');

  // the page's own time is not what drives this: each frame sets what is shown at its moment
  const state = { shown: new Set() };
  const total = Math.round(SECONDS * FPS);
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    await page.evaluate((tt) => {
      const { SCRIPT, texts, bubbles, input } = window.__chat;
      let typing = null;
      for (const s of SCRIPT) {
        const revealAt = s.at ?? s.sendAt;
        const b = bubbles[s.i];
        if (tt >= revealAt) { if (!b.__a) { b.style.visibility = 'visible'; const a = b.animate([{ transform: 'translateY(22px) scale(.92)', opacity: 0 }, { transform: 'translateY(-3px) scale(1.02)', opacity: 1, offset: 0.6 }, { transform: 'none', opacity: 1 }], { duration: 380, fill: 'both', easing: 'ease-out' }); a.pause(); b.__a = a; b.__t = revealAt; document.getElementById('msg-list').scrollTop = document.getElementById('msg-list').scrollHeight; } b.__a.currentTime = Math.max(0, (tt - b.__t) * 1000); }
        else if (s.type && tt >= s.type[0]) typing = { text: texts[s.i], frac: Math.min(1, (tt - s.type[0]) / (s.type[1] - s.type[0])) };
      }
      if (typing) { input.focus(); input.value = typing.text.slice(0, Math.ceil(typing.text.length * typing.frac)); input.dispatchEvent(new Event('input', { bubbles: true })); }
      else { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); if (document.activeElement === input && tt < 2.5) input.blur(); }
    }, t);
    await page.screenshot({ path: path.join(OUT, 'f' + String(i).padStart(4, '0') + '.png'), type: 'png' });
    if (i % 30 === 0) console.log('frame', i, '/', total);
  }
  await browser.close();
  console.log('done', total, 'frames');
})().catch((e) => { console.error(e); process.exit(1); });

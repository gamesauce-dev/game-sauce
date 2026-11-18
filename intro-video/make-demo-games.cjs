// Adds ~50 invented games with generated covers to the throwaway demo instance (cvdemo), so the Carousel and its A-Z rail have something to show.
const { chromium } = require('playwright');
const Database = require('better-sqlite3');
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const HOME = 'C:/Users/numan/AppData/Local/Temp/cvdemo';
const titles = ['99 Lanterns', '3D Pinball Pals', 'Alpine Rush', 'Astro Gardener', 'Bubble Harbor', 'Banner of Dawn Remix', 'Cobalt Blade', 'Crystal Quest Saga', 'Candy Comet', 'Dungeon of Echoes', 'Dino Delivery', 'Drift Kingdom', 'Ember Tactics', 'Echo Valley', 'Frost Fighters', 'Fox and Forest', 'Glitch Garden', 'Galaxy Grocer', 'Hero Hollow', 'Honey Heist', 'Iron Orchard', 'Ink Island', 'Jelly Jungle', 'Jet Jockey', 'Kite Kingdom', 'Knight Knack', 'Lunar Lagoon', 'Lava Lanes', 'Mega Marble', 'Midnight Market', 'Neon Ninja', 'Nova Nursery', 'Orbit Oasis', 'Octo Odyssey', 'Pixel Pirates', 'Puzzle Palace', 'Quest for Quartz', 'Quick Quokka', 'Rocket Ranch', 'Retro Rally', 'Starlight Stack', 'Sky Sailors', 'Turbo Tortoise', 'Tiny Tavern', 'Ultra Umbrella', 'Vortex Valley', 'Viking Volley', 'Wizard Wash', 'Wild Waves', 'Xeno Xylophone', 'Yeti Yard', 'Zen Zeppelin'];
const PLAT = Number(process.env.PLAT || 2);   // the platform id the games go on (2 = the one that already has Super Metroid)
const palettes = [['#e8b923', '#8a6b0a'], ['#3b8fd4', '#175a99'], ['#e55b3c', '#8c1f1f'], ['#3fbf6e', '#1d7a43'], ['#a855d6', '#5b2a8a'], ['#f28c2e', '#a24a0a'], ['#2cc4c4', '#12787a'], ['#e0559b', '#8c1e5a']];
(async () => {
  const db = new Database(path.join(HOME, 'data/gamesauce.db'));
  db.prepare("delete from roms where meta_source = 'introgen'").run();
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
  const page = await (await browser.newContext({ viewport: { width: 300, height: 420 } })).newPage();
  const ins = db.prepare(`insert into roms (platform_id, title, sort_title, filename, storage_path, size_bytes, region, release_year, developer, publisher, genre, players, rating, description, cover_path, crc32, md5, sha1, meta_source) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'introgen')`);
  fs.mkdirSync(path.join(HOME, 'storage/covers'), { recursive: true });
  let n = 0;
  for (const t of titles) {
    const [a, b] = palettes[n % palettes.length];
    await page.setContent(`<body style="margin:0;width:300px;height:420px;background:linear-gradient(160deg,${a},${b});display:flex;flex-direction:column;justify-content:flex-end;font-family:Segoe UI,Arial,sans-serif"><div style="height:60px;background:rgba(255,255,255,.9);margin-bottom:34px"></div><div style="color:#fff;font-weight:800;font-size:30px;line-height:1.05;padding:0 20px 34px;text-shadow:0 2px 6px rgba(0,0,0,.4)">${t}</div></body>`);
    const cp = path.join(HOME, 'storage/covers', `introgen-${n}.png`).split('/').join(String.fromCharCode(92));
    await page.screenshot({ path: cp });
    const h = crypto.createHash('sha1').update('gen' + t).digest('hex');
    ins.run(PLAT, t, t.toLowerCase(), t + '.sfc', 'C:' + String.fromCharCode(92) + 'nowhere' + String.fromCharCode(92) + h + '.sfc', 8192, 'USA', 1990 + (n % 9), 'Sauce Studio', 'Sauce Studio', ['Platformer', 'Puzzle', 'Adventure', 'Racing'][n % 4], 1 + (n % 2), 4 + (n % 10) / 10, 'An invented game for the video.', cp, h.slice(0, 8), h.slice(0, 32), h, );
    n++;
  }
  await browser.close();
  console.log('added', n, 'games on platform', PLAT);
})().catch((e) => { console.error(e); process.exit(1); });

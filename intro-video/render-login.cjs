// Renders the sign-in scene of the intro, frame by frame (so it is smooth whatever the PC): the real sign-in page, with the logo's controller, joystick and
// wordmark animated, the username and password typed, and a flash that opens into the library.
//   node render-login.cjs [url] [seconds]   -> work/login-frames/f0000.png ...  (then build-en.sh joins them)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const URL = process.argv[2] || 'http://localhost:8795/';
const SECONDS = Number(process.argv[3] || 5.6);
const FPS = 30;
const OUT = path.join(__dirname, 'work', 'login-frames');
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', args: ['--hide-scrollbars'] });
  const page = await (await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
  await page.clock.install({ time: 0 });          // the page's own animation (the neon grid) follows a clock this script steps
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('#auth-screen:not(.hidden) .auth-logo');

  // Bigger everything (the page is sized in rem), the logo as live SVG with its parts findable, and the typing and flash helpers.
  await page.evaluate(async () => {
    document.documentElement.style.fontSize = '27px';
    const img = document.querySelector('.auth-logo');
    const svgText = await (await fetch('/logo-wide.svg')).text();
    const holder = document.createElement('div');
    holder.innerHTML = svgText.replace(/<\?xml[^>]*>/, '');
    const svg = holder.querySelector('svg');
    svg.setAttribute('class', 'auth-logo-svg');
    svg.style.cssText = 'width:100%;height:auto;display:block;overflow:visible;margin:-0.6rem 0 0';
    img.replaceWith(svg);
    document.querySelector('.auth-brand').style.cssText += ';display:block;text-align:center';
    document.querySelector('.auth-card').style.width = '24rem';
    document.querySelector('.brand-sub').style.cssText += ';font-size:0.8rem;margin-top:0.2rem';
    // the overlay used for the flash into the library
    const flash = document.createElement('div');
    flash.id = 'intro-flash'; flash.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;z-index:99;pointer-events:none';
    document.body.appendChild(flash);
    window.__setup = true;
  });

  // The parts of the logo, found by what they are. (The wide logo: the controller group, the joystick group, then the lettering.)
  const parts = await page.evaluate(() => {
    const svg = document.querySelector('.auth-logo-svg');
    const controller = svg.querySelector('g[filter="url(#filter-1)"]');
    const joystick = svg.querySelector('g[filter="url(#filter-4)"]');
    const lettering = joystick.nextElementSibling;   // the lettering group follows the joystick
    // joystick: the stem and the ball turn together about the foot of the stem
    const stick = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    const lines = [...joystick.querySelectorAll('line, .cls-17, .cls-18')];
    lines[0].parentNode.insertBefore(stick, lines[0]);
    lines.forEach((l) => stick.appendChild(l));
    const sticksKnobs = [...controller.querySelectorAll('circle.cls-11, circle.cls-12')];
    const buttons = [...controller.querySelectorAll('.cls-6, .cls-7, .cls-8, .cls-9')];
    const dpad = controller.querySelector('.cls-4');
    const letters = [...lettering.children];
    const tag = (el, name) => el.setAttribute('data-part', name);
    tag(controller, 'controller'); tag(joystick, 'joystick'); tag(stick, 'stick'); tag(lettering, 'lettering');
    sticksKnobs.forEach((k, i) => tag(k, 'knob' + i)); buttons.forEach((b, i) => tag(b, 'btn' + i)); if (dpad) tag(dpad, 'dpad'); letters.forEach((l, i) => tag(l, 'letter' + i));
    return { letters: letters.length, buttons: buttons.length, knobs: sticksKnobs.length };
  });
  console.log('logo parts', parts);

  // All the movement as paused Web Animations, so each frame sets the time and nothing else decides it.
  await page.evaluate(() => {
    const $ = (s) => document.querySelector(`[data-part="${s}"]`);
    const all = [];
    const add = (el, keyframes, timing) => { if (!el) return; el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; const a = el.animate(keyframes, { fill: 'both', ...timing }); a.pause(); all.push(a); return a; };
    const ease = 'cubic-bezier(.22,1.2,.36,1)';
    // coming together: the controller from the left, the joystick from the right, the lettering rising
    add($('controller'), [{ transform: 'translateX(-260px) rotate(-18deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 900, delay: 100, easing: ease });
    add($('joystick'), [{ transform: 'translateX(260px) rotate(18deg)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 900, delay: 250, easing: ease });
    document.querySelectorAll('[data-part^="letter"]').forEach((l, i) => add(l, [{ transform: 'translateY(60px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: 600, delay: 500 + i * 45, easing: ease }));
    // idling: the controller floats and tilts, the thumbsticks move, the buttons press in turn, the d-pad nods
    add($('controller'), [{ transform: 'translateY(0) rotate(-2deg)' }, { transform: 'translateY(-9px) rotate(2deg)' }], { duration: 1500, delay: 1000, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out', composite: 'add' });
    add($('knob0'), [{ transform: 'translate(-5px,-3px)' }, { transform: 'translate(5px,4px)' }], { duration: 900, delay: 1000, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
    add($('knob1'), [{ transform: 'translate(5px,-4px)' }, { transform: 'translate(-4px,5px)' }], { duration: 1100, delay: 1000, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' });
    document.querySelectorAll('[data-part^="btn"]').forEach((b, i) => add(b, [{ transform: 'scale(1)', filter: 'brightness(1)' }, { transform: 'scale(.78)', filter: 'brightness(1.5)', offset: 0.14 }, { transform: 'scale(1)', filter: 'brightness(1)', offset: 0.3 }, { transform: 'scale(1)', filter: 'brightness(1)' }], { duration: 1200, delay: 1200 + i * 300, iterations: Infinity }));
    add($('dpad'), [{ transform: 'scale(1)' }, { transform: 'scale(.86)', offset: 0.1 }, { transform: 'scale(1)', offset: 0.22 }, { transform: 'scale(1)' }], { duration: 1500, delay: 1300, iterations: Infinity });
    // the joystick: the stem swings about its foot, the red ball with it
    const stick = $('stick'); if (stick) { stick.style.transformBox = 'view-box'; stick.style.transformOrigin = '606.9px 226.8px'; const a = stick.animate([{ transform: 'rotate(-17deg)' }, { transform: 'rotate(17deg)' }], { duration: 850, delay: 1100, direction: 'alternate', iterations: Infinity, easing: 'cubic-bezier(.45,0,.55,1)', fill: 'both' }); a.pause(); all.push(a); }
    // the lettering: a wave runs through it
    document.querySelectorAll('[data-part^="letter"]').forEach((l, i) => add(l, [{ transform: 'translateY(0)' }, { transform: 'translateY(-14px)' }, { transform: 'translateY(0)' }], { duration: 1500, delay: 1700 + i * 90, iterations: Infinity, easing: 'ease-in-out', composite: 'add' }));
    window.__anims = all;
    // the flash and opening zoom at the end, and the typing
    const flash = document.getElementById('intro-flash');
    const fa = flash.animate([{ opacity: 0 }, { opacity: 0, offset: 0.35 }, { opacity: 1 }], { duration: 900, delay: 4700, fill: 'both', easing: 'ease-in' }); fa.pause(); all.push(fa);
    const screen = document.getElementById('auth-screen');
    const za = screen.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.9)' }], { duration: 900, delay: 4700, fill: 'both', easing: 'cubic-bezier(.5,0,.9,.4)' }); za.pause(); all.push(za);
    window.__type = (t) => {
      const u = document.getElementById('login-username'), p = document.getElementById('login-password'), btn = document.getElementById('login-submit');
      const name = 'player one', pass = 'secret-pass';
      const nU = Math.max(0, Math.min(name.length, Math.floor((t - 2.3) / 0.11)));
      const nP = Math.max(0, Math.min(pass.length, Math.floor((t - 3.5) / 0.09)));
      u.value = name.slice(0, nU); p.value = pass.slice(0, nP);
      if (t >= 3.3) { if (document.activeElement !== p) p.focus(); } else if (t >= 2.2) { if (document.activeElement !== u) u.focus(); }
      btn.style.transform = t >= 4.45 && t < 4.75 ? 'scale(.95)' : ''; btn.style.filter = t >= 4.45 ? 'brightness(1.35)' : '';
    };
  });

  const total = Math.round(SECONDS * FPS);
  let fakeNow = 0;
  for (let i = 0; i < total; i++) {
    const t = i / FPS;
    const step = Math.round((i + 1) * 1000 / FPS) - Math.round(i * 1000 / FPS);
    await page.evaluate((tt) => { window.__anims.forEach((a) => { a.currentTime = tt * 1000; }); window.__type(tt); }, t);
    await page.clock.runFor(step); fakeNow += step;
    await page.screenshot({ path: path.join(OUT, 'f' + String(i).padStart(4, '0') + '.png'), type: 'png' });
    if (i % 30 === 0) console.log('frame', i, '/', total);
  }
  await browser.close();
  console.log('done', total, 'frames');
})().catch((e) => { console.error(e); process.exit(1); });

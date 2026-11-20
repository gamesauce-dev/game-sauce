/* Pixel-arcade background for the sign-in screen: a dark night sky of square stars that scroll down in three layers (a vertical shooter's starfield),
 * little pixel coins, hearts and gems drifting up with a gentle sway, faint scanlines and a vignette that keeps the card readable. One <canvas>, no libraries,
 * no images. It runs only while the sign-in screen is visible, pauses when the tab is hidden, and shows a still frame for people who ask for reduced motion.
 *
 *   window.neonBg.start()  /  window.neonBg.stop()
 */
(function () {
  'use strict';
  const canvas = document.getElementById('neon-bg');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  let w = 0, h = 0, dpr = 1, raf = 0, last = 0, running = false;
  let stars = [], bits = [];
  const rnd = (a, b) => a + Math.random() * (b - a);

  // 7x7 pixel pictures: a coin, a heart and a gem (drawn for game-sauce)
  const SPRITES = [
    ['..###..', '.#yyy#.', '#yy.yy#', '#yy.yy#', '#yy.yy#', '.#yyy#.', '..###..'],
    ['.##.##.', '#rrrrr#', '#rrrrr#', '#rrrrr#', '.#rrr#.', '..#r#..', '...#...'],
    ['..ccc..', '.cwccc.', 'cwccccc', 'ccccccc', '.ccccc.', '..ccc..', '...c...']
  ];
  const COLOURS = { '#': '#0b1a2e', y: '#ffd23f', r: '#ff4d5a', c: '#35e0c4', w: '#ffffff' };
  const STAR_COLOURS = ['#4b6a9b', '#9fc1f2', '#ffffff'];   // far, middle, near

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: a 4K screen at 3x would be wasteful
    w = canvas.clientWidth; h = canvas.clientHeight;
    if (!w || !h) return false; // not laid out yet (hidden or just shown): the caller retries
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round(Math.min(200, (w * h) / 9000)) }, () => { const l = (Math.random() * 3) | 0; return { x: Math.random() * w, y: Math.random() * h, l, sp: 12 + l * 22 }; });
    bits = Array.from({ length: Math.round(Math.min(16, (w * h) / 90000)) + 4 }, () => ({ x: Math.random() * w, y: Math.random() * h, k: (Math.random() * SPRITES.length) | 0, ph: Math.random() * 6.28, sp: rnd(10, 26) }));
    draw(0);
    return true;
  }

  function draw(dt) {
    const sec = dt / 1000;
    const sky = ctx.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, '#05070f'); sky.addColorStop(1, '#0c1d3b');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);

    for (const s of stars) {
      s.y += s.sp * sec; if (s.y > h) { s.y = 0; s.x = Math.random() * w; }
      const size = 2 + s.l * 2;
      ctx.fillStyle = STAR_COLOURS[s.l];
      ctx.fillRect(Math.round(s.x / 2) * 2, Math.round(s.y / 2) * 2, size, size);
    }

    for (const b of bits) {
      b.y -= b.sp * sec; b.ph += sec;
      if (b.y < -40) { b.y = h + 20; b.x = Math.random() * w; }
      const px = 5, x = Math.round((b.x + Math.sin(b.ph) * 14) / px) * px, y = Math.round(b.y / px) * px;
      SPRITES[b.k].forEach((row, ry) => [...row].forEach((ch, rx) => { if (ch === '.') return; ctx.fillStyle = COLOURS[ch]; ctx.fillRect(x + rx * px, y + ry * px, px, px); }));
    }

    // Scanlines (CRT feel)
    ctx.fillStyle = 'rgba(0, 0, 0, .18)';
    for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 2);

    // Vignette keeps the sign-in card readable
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(0, 0, 0, 0)'); vg.addColorStop(1, 'rgba(0, 0, 0, .65)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
  }

  function frame(now) {
    if (!running) return;
    // Safety net: if the first measurement happened before layout, measure again as soon as it is visible.
    if ((!w || !h || canvas.clientWidth !== w || canvas.clientHeight !== h) && !resize()) { raf = requestAnimationFrame(frame); return; }
    const dt = last ? Math.min(now - last, 60) : 16;
    last = now;
    draw(dt);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    if (running) return;
    canvas.hidden = false;
    resize();
    if (reduce && reduce.matches) { // one still frame, no animation
      if (!w || !h) requestAnimationFrame(() => { resize(); });
      return;
    }
    running = true; last = 0;
    raf = requestAnimationFrame(frame);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener('resize', () => { if (!canvas.hidden) resize(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stop();
    else if (!canvas.hidden && !(reduce && reduce.matches)) { running = true; last = 0; raf = requestAnimationFrame(frame); }
  });

  window.neonBg = { start, stop };
})();

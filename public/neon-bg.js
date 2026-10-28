/* Retro-cyberpunk background for the sign-in screen: a synthwave horizon with a scrolling
 * perspective grid, a striped neon sun, drifting stars and faint scanlines. One <canvas>,
 * no libraries, no images. It runs only while the sign-in screen is visible, pauses when the
 * tab is hidden, and shows a still frame for people who ask for reduced motion.
 *
 *   window.neonBg.start()  /  window.neonBg.stop()
 */
(function () {
  'use strict';
  const canvas = document.getElementById('neon-bg');
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d', { alpha: false });
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');

  let w = 0, h = 0, dpr = 1, raf = 0, last = 0, t = 0, running = false;
  let stars = [];

  const PINK = '255, 61, 168';
  const VIOLET = '124, 92, 255';
  const CYAN = '34, 211, 238';

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2); // cap: a 4K screen at 3x would be wasteful
    w = canvas.clientWidth; h = canvas.clientHeight;
    if (!w || !h) return false; // not laid out yet (hidden or just shown): the caller retries
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round(Math.min(120, (w * h) / 14000));
    stars = Array.from({ length: n }, () => ({
      x: Math.random(), y: Math.random() * 0.52, r: Math.random() * 1.3 + 0.3,
      tw: Math.random() * Math.PI * 2, sp: 0.4 + Math.random() * 1.4
    }));
    draw(0);
    return true;
  }

  function draw(dt) {
    t += dt;
    const horizon = h * 0.58;

    // Sky
    const sky = ctx.createLinearGradient(0, 0, 0, horizon);
    sky.addColorStop(0, '#07060f');
    sky.addColorStop(0.55, '#150a2e');
    sky.addColorStop(1, '#3a0f4f');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, horizon + 1);

    // Stars (twinkle)
    for (const s of stars) {
      const a = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(s.tw + t * s.sp));
      ctx.fillStyle = `rgba(255,255,255,${a * 0.8})`;
      ctx.fillRect(s.x * w, s.y * h, s.r, s.r);
    }

    // Sun: gradient disc with horizontal cut-outs that grow toward the bottom
    const sr = Math.min(w, h) * 0.2;
    const sx = w / 2, sy = horizon - sr * 0.28;
    const glow = ctx.createRadialGradient(sx, sy, sr * 0.2, sx, sy, sr * 2.4);
    glow.addColorStop(0, `rgba(${PINK}, .38)`); glow.addColorStop(1, `rgba(${PINK}, 0)`);
    ctx.fillStyle = glow; ctx.fillRect(sx - sr * 2.4, sy - sr * 2.4, sr * 4.8, sr * 4.8);
    ctx.save();
    ctx.beginPath(); ctx.arc(sx, sy, sr, 0, Math.PI * 2); ctx.clip();
    const sun = ctx.createLinearGradient(0, sy - sr, 0, sy + sr);
    sun.addColorStop(0, '#ffe66d'); sun.addColorStop(0.45, '#ff6bb5'); sun.addColorStop(1, '#8a2be2');
    ctx.fillStyle = sun; ctx.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    ctx.fillStyle = '#150a2e';
    for (let i = 0; i < 7; i++) {
      const y = sy + sr * (0.05 + i * 0.14);
      const thick = sr * (0.02 + i * 0.018);
      ctx.fillRect(sx - sr, y, sr * 2, thick);
    }
    ctx.restore();

    // Ground
    const ground = ctx.createLinearGradient(0, horizon, 0, h);
    ground.addColorStop(0, '#1a0b33'); ground.addColorStop(1, '#07060f');
    ctx.fillStyle = ground; ctx.fillRect(0, horizon, w, h - horizon);

    // Horizon glow line
    ctx.fillStyle = `rgba(${CYAN}, .85)`; ctx.fillRect(0, horizon - 1, w, 2);
    const hg = ctx.createLinearGradient(0, horizon - 28, 0, horizon + 28);
    hg.addColorStop(0, `rgba(${CYAN}, 0)`); hg.addColorStop(0.5, `rgba(${CYAN}, .22)`); hg.addColorStop(1, `rgba(${CYAN}, 0)`);
    ctx.fillStyle = hg; ctx.fillRect(0, horizon - 28, w, 56);

    // Perspective grid: vertical lines fan out from a vanishing point, horizontal lines
    // scroll toward the viewer and spread with perspective (z^2 spacing).
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = `rgba(${VIOLET}, .55)`;
    ctx.shadowColor = `rgba(${VIOLET}, .9)`; ctx.shadowBlur = 6;
    const vx = w / 2, depth = h - horizon;
    const cols = 26;
    ctx.beginPath();
    for (let i = -cols; i <= cols; i++) {
      ctx.moveTo(vx, horizon);
      ctx.lineTo(vx + i * (w / cols) * 1.35, h);
    }
    ctx.stroke();
    const rows = 16, scroll = (t * 0.00022) % 1;
    ctx.strokeStyle = `rgba(${PINK}, .6)`; ctx.shadowColor = `rgba(${PINK}, .9)`;
    ctx.beginPath();
    for (let i = 0; i < rows; i++) {
      const z = (i + scroll) / rows;
      const y = horizon + depth * z * z;
      ctx.moveTo(0, y); ctx.lineTo(w, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Fade the grid into the distance so it does not shimmer at the horizon
    const fade = ctx.createLinearGradient(0, horizon, 0, horizon + depth * 0.22);
    fade.addColorStop(0, 'rgba(26, 11, 51, 1)'); fade.addColorStop(1, 'rgba(26, 11, 51, 0)');
    ctx.fillStyle = fade; ctx.fillRect(0, horizon, w, depth * 0.22);

    // Scanlines + a slow rolling highlight band (CRT feel)
    ctx.fillStyle = 'rgba(0, 0, 0, .13)';
    for (let y = 0; y < h; y += 3) ctx.fillRect(0, y, w, 1);
    const band = ((t * 0.00006) % 1) * (h + 160) - 80;
    const bg = ctx.createLinearGradient(0, band - 80, 0, band + 80);
    bg.addColorStop(0, 'rgba(255,255,255,0)'); bg.addColorStop(0.5, 'rgba(255,255,255,.035)'); bg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = bg; ctx.fillRect(0, band - 80, w, 160);

    // Vignette keeps the sign-in card readable
    const vg = ctx.createRadialGradient(w / 2, h * 0.5, Math.min(w, h) * 0.25, w / 2, h * 0.5, Math.max(w, h) * 0.75);
    vg.addColorStop(0, 'rgba(7, 6, 15, 0)'); vg.addColorStop(1, 'rgba(7, 6, 15, .75)');
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

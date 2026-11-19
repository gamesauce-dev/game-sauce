import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const LANGS = ['fr', 'zh', 'es', 'pt', 'de', 'ja', 'it'];

test('the website hero is a slider: each slide has a picture, a title and a link to a section that exists, and the controls are labelled', () => {
  const html = read('site/index.html');
  const slides = [...html.matchAll(/<div class="slide(?: is-on| fit)?"([^>]*)>([\s\S]*?)<a class="slide-hit" href="#([a-z]+)" aria-label="([^"]+)"><\/a>\s*<\/div>/g)];
  assert.ok(slides.length >= 6, 'several slides');
  let clips = 0;
  for (const [, attrs, body, target, label] of slides) {
    assert.ok(html.includes(`id="${target}"`), `the section #${target} exists`);
    const img = /<img (?:data-)?src="(img\/[^"]+)"[^>]*alt="([^"]+)"/.exec(body), clip = /<video class="slide-video"[^>]*(?:data-)?poster="(img\/[^"]+)"[^>]*aria-label="[^"]+"><source src="(video\/[^"]+)"/.exec(body);
    assert.ok(img || clip, 'a picture or a clip');
    for (const file of img ? [img[1]] : [clip[1], clip[2]]) assert.ok(fs.existsSync(new URL('../site/' + file, import.meta.url)), 'the file exists: ' + file);
    if (clip) { clips++; assert.ok(Number(/data-seconds="(\d+)"/.exec(attrs)?.[1]) >= 6, 'a clip slide says how long it stays'); }
    assert.ok(body.includes(`<p class="slide-title">${label}</p>`), 'the link says what the title says');
  }
  assert.ok(clips >= 4, 'the demo clips play in the slider');
  assert.ok(html.includes('video:not(.slide-video)') && html.includes('v.pause()'), "the page's own video script leaves the clips to the slider, which plays only the showing one");
  assert.equal([...html.matchAll(/class="slide is-on"/g)].length, 1, 'one slide shows before the script runs');
  for (const l of ['Pause slideshow', 'Play slideshow', 'Previous slide', 'Next slide', 'Featured screens']) assert.ok(html.includes(`aria-label="${l}"`), l);
  assert.ok(html.includes("addEventListener('animationend'") && html.includes("prefers-reduced-motion: reduce"), 'it steps when the progress line fills, and stays still for reduced motion');
});

test('every language page has the slider in its own language', () => {
  const dict = JSON.parse(read('i18n/site.json'));
  for (const l of LANGS) {
    const page = read(`site/${l}/index.html`);
    assert.ok(page.includes('class="slider"'), l + ' has the slider');
    for (const k of ['Pause slideshow', 'Play slideshow', 'Previous slide', 'Next slide', 'Featured screens']) {
      assert.ok(dict[k]?.[l], `${k} in ${l}`);
      assert.ok(page.includes(`aria-label="${dict[k][l]}"`), `${k} is on the ${l} page`);
    }
    assert.ok(!page.includes('<p class="slide-title">Everything for a collection you already have</p>'), l + ': the first title is translated');
  }
});

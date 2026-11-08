import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('Settings > Platforms shows each platform\'s colour and logo on its row, without opening Edit', () => {
  const app = read('public/app.js'), css = read('public/styles.css');
  // the row: a swatch in the platform's colour (its code as the hover text), the logo (or a quiet "no logo"), and the code in the detail line
  assert.match(app, /const platId = \(p\) => `<span class="plat-id" data-plat-id>/);
  assert.match(app, /<i class="plat-swatch" style="background:\$\{esc\(p\.accent\)\}" title="Colour \$\{esc\(p\.accent\)\}"/);
  assert.match(app, /No logo yet: add one under Edit/);
  assert.match(app, /\$\{platId\(p\)\}\n\s+<span class="name">/, 'drawn on every row, before the name');
  assert.match(app, /slug: \$\{esc\(p\.slug\)\} · colour: \$\{esc\(hexOk\(p\.accent\) \? p\.accent : '—'\)\} · ext:/);
  // a colour that is not a valid code shows as an empty swatch, not as a broken style
  assert.match(app, /const hexOk = \(c\) => \/\^#\[0-9a-f\]\{6\}\$\/i\.test\(c \|\| ''\);/); assert.match(app, /plat-swatch none/);
  // changing the logo in the editor updates the row at once, without redrawing the list (which would close the editor)
  assert.match(app, /const repaintRowLogo = \(v, plate\) =>/);
  assert.match(app, /repaintRowLogo\(j\.logo_v, /); assert.match(app, /repaintRowLogo\(null, false\)/);
  assert.match(app, /\.plat-logo`\)\?\.classList\.toggle\('on-plate', e\.target\.checked\)/);
  // the same logo picture and "light backing" the Library heading uses
  assert.match(app, /lib-logo plat-logo\$\{plate \? ' on-plate' : ''\}/); assert.match(app, /\/api\/platforms\/\$\{encodeURIComponent\(slug\)\}\/logo\?v=\$\{v\}/);
  assert.match(css, /\.plat-swatch \{[^}]*width: 1\.15rem;/); assert.match(css, /\.plat-logo \{ width: 4\.4rem; height: 1\.7rem; \}/);
});

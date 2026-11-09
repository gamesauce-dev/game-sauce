import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isNewer, checkForUpdate, updateCheckEnabled, currentVersion } from '../src/lib/updatecheck.js';

test('version comparison: v-prefix ignored, higher wins, equal is not newer', () => {
  assert.equal(isNewer('v0.2.0', '0.1.0'), true);
  assert.equal(isNewer('0.1.1', '0.1.0'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('v0.1.0', '0.1.0'), false);
  assert.equal(isNewer('0.0.9', '0.1.0'), false);
  assert.equal(isNewer('0.10.0', '0.9.0'), true, 'numbers, not text: 10 is more than 9');
  assert.equal(isNewer('', '0.1.0'), false);
  assert.equal(isNewer('nightly', '0.1.0'), false, 'a non-version tag never claims to be an update');
});

test('the check reports a newer release, a current one, a missing one, and can be switched off', async () => {
  const cur = currentVersion();
  const higher = '999.0.0';
  let calls = 0;
  const ask = (payload) => async () => { calls++; return payload; };
  const newer = await checkForUpdate(ask({ payload: { tag: 'v' + higher, url: 'https://x/y' } }));
  assert.equal(newer.newer, true); assert.equal(newer.latest, 'v' + higher); assert.equal(newer.current, cur);
  const same = await checkForUpdate(ask({ payload: { tag: 'v' + cur } }));
  assert.equal(same.newer, false);
  const none = await checkForUpdate(ask({ missing: 'GitHub is limiting requests' }));
  assert.equal(none.newer, false); assert.match(none.reason, /limiting/);
  process.env.GAMESAUCE_UPDATE_CHECK = '0';
  const before = calls;
  const off = await checkForUpdate(ask({ payload: { tag: 'v999' } }));
  assert.equal(off.enabled, false); assert.equal(calls, before, 'switched off: GitHub is never asked');
  assert.equal(updateCheckEnabled(), false);
  delete process.env.GAMESAUCE_UPDATE_CHECK;
  assert.equal(updateCheckEnabled(), true);
});

test('the notice says how to update for how this copy was installed, and only ever links to github.com', async () => {
  const { installKind, howToUpdate } = await import('../src/lib/updatecheck.js');
  const was = process.env.GAMESAUCE_INSTALL;
  try {
    for (const [k, re] of [['docker', /pulling the new image/], ['desktop', /new installer/], ['download', /unpack/], ['', /release page/], ['nonsense', /release page/]]) {
      process.env.GAMESAUCE_INSTALL = k;
      assert.equal(installKind(), ['docker', 'desktop', 'download'].includes(k) ? k : ''); assert.match(howToUpdate(), re, k);
    }
    process.env.GAMESAUCE_INSTALL = 'docker';
    const ask = (url) => async () => ({ payload: { tag: 'v999.0.0', url } });
    const good = await checkForUpdate(ask('https://github.com/gamesauce-dev/game-sauce/releases/tag/v999.0.0'));
    assert.equal(good.url, 'https://github.com/gamesauce-dev/game-sauce/releases/tag/v999.0.0'); assert.equal(good.kind, 'docker'); assert.match(good.how, /image/);
    for (const bad of ['http://github.com/x', 'https://evil.example/github.com/', 'javascript:alert(1)', '']) assert.equal((await checkForUpdate(ask(bad))).url, null, bad);
  } finally { if (was === undefined) delete process.env.GAMESAUCE_INSTALL; else process.env.GAMESAUCE_INSTALL = was; }
});

test('the update notice is a link in the Modern ticker (Classic has no ticker); each kind of install says how it was started', () => {
  const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const m = read('public/modern.js'), a = read('public/app.js');
  assert.ok(m.includes('class="mh-link"') && m.includes("rel=\"noopener noreferrer\"") && m.includes('^https:\\/\\/github\\.com\\/'));
  assert.ok(!a.includes('data-ov-update') && a.includes("if (!document.body.classList.contains('ui-modern')) { clearInterval(overviewTimer)"), 'Classic has no rolling strip, so no update slide in it');
  assert.ok(read('Dockerfile').includes('ENV GAMESAUCE_INSTALL=docker'));
  assert.ok(read('scripts/start.mjs').includes("GAMESAUCE_INSTALL: 'download'"));
  assert.ok(read('desktop/src-tauri/src/main.rs').includes('.env("GAMESAUCE_INSTALL", "desktop")'));
});

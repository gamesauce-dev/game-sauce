import { test } from 'node:test';
import assert from 'node:assert/strict';
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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { describeLaunch, fmtLeft } = await import('../public/launch-progress.js');
const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('the card shows waiting, with a hint to check the launcher once it has taken a while', () => {
  const quick = describeLaunch({ phase: 'waiting', age_s: 2, bytes: 0, total: 0 });
  assert.equal(quick.pct, null, 'no time to show yet');
  assert.equal(quick.meta, '');
  const slow = describeLaunch({ phase: 'waiting', age_s: 20, bytes: 0, total: 0 });
  assert.match(slow.meta, /launcher is installed/);
  assert.match(slow.meta, /LOCAL-LAUNCH/);
});

test('a download shows how much has arrived, the percentage, the speed and the time left', () => {
  const MB = 1024 * 1024;
  const d = describeLaunch({ phase: 'downloading', bytes: 300 * MB, total: 1200 * MB }, { speed: 10 * MB });
  assert.equal(Math.round(d.pct), 25);
  assert.equal(d.tone, 'busy');
  assert.match(d.meta, /300 MB of 1\.2 GB \(25%\)/);
  assert.match(d.meta, /10(\.0)? MB\/s/);
  assert.match(d.meta, /about 2 min left/, '900 MB at 10 MB/s is about a minute and a half');
  const noSpeed = describeLaunch({ phase: 'downloading', bytes: 5 * MB, total: 50 * MB });
  assert.doesNotMatch(noSpeed.meta, /left/, 'no time left until a speed is known');
  const unknown = describeLaunch({ phase: 'downloading', bytes: 5 * MB, total: 0 });
  assert.equal(unknown.pct, null, 'a size that is not known shows a moving bar, not a wrong percentage');
});

test('the steps after the download, a finished launch and a failed one', () => {
  assert.equal(describeLaunch({ phase: 'unpacking', bytes: 1, total: 1 }).pct, null);
  assert.match(describeLaunch({ phase: 'unpacking', bytes: 1, total: 1 }).line, /Unpacking/);
  assert.match(describeLaunch({ phase: 'starting', bytes: 1, total: 1 }).line, /Starting your emulator/);
  const run = describeLaunch({ phase: 'running', bytes: 1, total: 1 });
  assert.equal(run.tone, 'ok'); assert.ok(run.hold > 0, 'the card goes away by itself');
  const sent = describeLaunch({ phase: 'sent', bytes: 1, total: 1 });
  assert.equal(sent.pct, 100); assert.ok(sent.hold > 0, 'an older launcher says nothing more: the card goes away by itself');
  const bad = describeLaunch({ phase: 'error', message: 'Could not start emu.exe: file not found', bytes: 0, total: 0 });
  assert.equal(bad.tone, 'bad'); assert.equal(bad.line, 'Could not start emu.exe: file not found'); assert.equal(bad.hold, 0, 'an error stays until it is closed');
  assert.match(describeLaunch({ phase: 'error', bytes: 0, total: 0 }).line, /launch failed/);
});

test('fmtLeft gives a rough time left', () => {
  assert.equal(fmtLeft(0.2), '1 s');
  assert.equal(fmtLeft(42), '42 s');
  assert.equal(fmtLeft(300), '5 min');
  assert.equal(fmtLeft(5400 + 600), '1 h 40 min');
  assert.equal(fmtLeft(NaN), '');
  assert.equal(fmtLeft(-5), '');
});

test('every place that starts a local launch shows the card, and hands the launcher the launch id and size', () => {
  for (const f of ['public/app.js', 'public/carousel.js', 'public/bigscreen.js']) {
    const src = read(f);
    assert.ok(src.includes("import { trackLaunch } from './launch-progress.js'"), `${f} imports the card`);
    assert.ok(src.includes('trackLaunch({'), `${f} shows it`);
    assert.ok(src.includes("lid: j.lid ?? '', size: j.size ?? ''"), `${f} passes the launch id and size in the link`);
  }
});

test('the strings of the card are translated in every language', () => {
  const src = read('public/launch-progress.js');
  const keys = [...src.matchAll(/\bt\('([^']+(?:\\'[^']*)*)'/g)].map((m) => m[1].replace(/\\'/g, "'"));
  assert.ok(keys.length >= 10, 'found the strings');
  for (const l of ['fr', 'zh', 'es', 'pt', 'de', 'ja', 'it']) {
    const dict = JSON.parse(read(`public/lang/${l}.json`));
    for (const k of keys) assert.ok(dict[k], `${l} has "${k}"`);
  }
});

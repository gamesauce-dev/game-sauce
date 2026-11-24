// Every script the page loads must at least parse. The page is plain files with no build step, so one stray character in a file
// (a comment that swallows the rest of its line, a missing bracket) stops the whole app, and the sign-in form falls back to a plain page load.
// Other tests read these files as text, so they would not notice.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const files = (dir, ext) => fs.readdirSync(dir).filter((f) => f.endsWith(ext)).map((f) => path.join(dir, f));

test('every script in public/ and the launcher parses', () => {
  const list = [...files('public', '.js'), ...files('launcher', '.mjs')];
  assert.ok(list.length > 20, 'found the scripts');
  const bad = [];
  for (const f of list) {
    const r = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(f), encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${f}: ${(r.stderr || '').split('\n').find((l) => /Error/.test(l)) || 'does not parse'}`);
  }
  assert.deepEqual(bad, []);
});

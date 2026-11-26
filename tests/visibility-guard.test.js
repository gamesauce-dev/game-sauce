// Reads the code itself, so that a new query cannot decide who sees a ROM Library game without src/lib/visibility.js.
// tests/visibility-rule.test.js checks what the routes actually send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Where the two "hidden from everyone" columns may be named outside the rule: writing them, or showing the value. Never to decide which games somebody gets.
// Each is taken out of the file the stated number of times; any other mention fails.
const RULE = 'src/lib/visibility.js';
const SCHEMA = 'src/migrations.js';
const MAY_NAME = {
  'src/lib/export.js': [['r.is_system, r.hidden_all,', 1], ["r.hidden_all ? 'yes' : ''", 1]],   // a column of the admin's CSV
  'src/lib/scanner.js': [['SET source_id = ?, source_hidden = ?,', 1], ['meta_source, source_hidden\n', 1]],   // a scan writes the source's mark
  'src/lib/stats.js': [['FROM roms WHERE hidden_all = 1 OR id IN (SELECT rom_id FROM hidden_roms)', 1]],   // the admin's total of hidden games
  'src/routes/sources.js': [['UPDATE roms SET source_hidden = ? WHERE source_id = ?', 1], ['UPDATE roms SET source_hidden = 0 WHERE source_id = ?', 1]],
  'src/routes/roms.js': [
    ['WHEN r.hidden_all = 1 THEN 1 ELSE 0 END AS hidden, r.keep_override, r.is_system, r.hidden_all,', 1],   // the "hidden" mark sent with a game
    ["UPDATE roms SET hidden_all = ?, updated_at = datetime('now') WHERE id = ? AND hidden_all <> ?", 1],
    ["UPDATE roms SET hidden_all = ?, updated_at = datetime('now') WHERE id = ?", 3],
    ['hidden_all: Boolean(v)', 1], ['hidden_all: next', 1],
    ['(SELECT COUNT(*) FROM roms r2 WHERE r2.hidden_all = 1 AND NOT EXISTS', 1],   // added to the admin's own "hidden" count only
    ["db.prepare('SELECT id, hidden_all FROM roms WHERE id = ?')", 1], ['(isAdmin && rom.hidden_all === 1)', 1]
  ]
};

// Every file that reads the roms table, and why what it reads is safe. A file not listed here fails: decide how it keeps to the rule first.
const READS_ROMS = {
  'src/app.js': 'members: platform, Home and stats queries use the rule. The rest are the admin\'s',
  'src/dats.js': 'admin only (DAT matching and coverage)',
  'src/lib/artimport.js': 'a member\'s video import matches only games they may see. The Library pictures are the admin\'s',
  'src/lib/assets.js': 'admin only (Find assets and Fill the gaps for Library games)',
  'src/lib/backup.js': 'admin only', 'src/lib/coverzip.js': 'admin only', 'src/lib/duplicates.js': 'admin only', 'src/lib/export.js': 'admin only',
  'src/lib/hashjob.js': 'server job', 'src/lib/health.js': 'admin only', 'src/lib/mamenames.js': 'server job', 'src/lib/namecsv.js': 'admin only', 'src/lib/reports.js': 'admin only',
  'src/lib/launch.js': 'the game a launch code names: limits are checked again when the code is used',
  'src/lib/messages.js': 'a shared game is checked for sender and reader',
  'src/lib/restore.js': 'admin only', 'src/lib/romdeps.js': 'companion files: the caller says which games may be sent',
  'src/lib/saves.js': 'own saves: a game is named only when visible',
  'src/lib/scanner.js': 'server job', 'src/lib/stats.js': 'admin only', 'src/lib/storageclean.js': 'admin only',
  'src/lib/visibility.js': 'the rule', 'src/lib/webp.js': 'admin only (picture preview)', 'src/lib/webpjob.js': 'admin only', 'src/migrations.js': 'schema',
  'src/routes/collections.js': 'members: every list uses the rule',
  'src/routes/dats.js': 'admin only', 'src/routes/metadata.js': 'admin only where it reads games', 'src/routes/sources.js': 'admin only',
  'src/routes/roms.js': 'members: lists use the rule, and every /:id route is checked before it runs',
  'src/routes/videos.js': 'checked with canSeeRom first'
};

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.js') ? [path.join(dir, e.name)] : []));
const sources = () => walk('src').map((f) => [f.split(path.sep).join('/'), fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')]);

test('only the visibility rule asks whether a game is hidden from everyone', () => {
  const wrong = [];
  for (const [file, text] of sources()) {
    if (file === RULE || file === SCHEMA) continue;
    let left = text;
    for (const [snippet, times] of MAY_NAME[file] || []) {
      const found = left.split(snippet).length - 1;
      if (found !== times) wrong.push(`${file}: expected ${times} of "${snippet}", found ${found} (update the list in this test if the line only writes or shows the value)`);
      left = left.split(snippet).join('');
    }
    for (const line of left.split('\n')) if (/hidden_all|source_hidden/.test(line)) wrong.push(`${file}: ${line.trim().slice(0, 200)}`);
  }
  assert.deepEqual(wrong, [], 'use a helper from src/lib/visibility.js (add one there if none fits)');
});

test('every file that reads the ROM table is accounted for', () => {
  const real = sources().filter(([, text]) => /\b(FROM|JOIN)\s+roms\b/i.test(text)).map(([file]) => file);
  assert.deepEqual(real.filter((f) => !READS_ROMS[f]), [], 'NEW FILE READS GAMES: use src/lib/visibility.js if anyone but the admin gets them, then list it in this test');
  assert.deepEqual(Object.keys(READS_ROMS).filter((f) => !real.includes(f)), [], 'listed here but no longer reads the table');
});

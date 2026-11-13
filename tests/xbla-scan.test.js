import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-xbla-scan-'));
process.env.GAMESAUCE_DATA_DIR = path.join(TMP, 'data');
process.env.GAMESAUCE_STORAGE_DIR = path.join(TMP, 'storage');
process.env.GAMESAUCE_ADMIN_USER = 'xblaadmin';
process.env.GAMESAUCE_ADMIN_PASSWORD = 'xbla-admin-password-1';

const { prepareApp } = await import('../src/app.js');
await prepareApp();
const db = (await import('../src/db.js')).default;
const { scanSource } = await import('../src/lib/scanner.js');
after(() => { try { db.close(); } catch { /* closed */ } try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* best effort */ } });

const HEX = '9F2DAA064D494AA82B43B65362C59E9B89A88F8F58';

test('XBLA: a scan adds the package as an Xbox 360 game named after its folder, and a rescan keeps it that way', async () => {
  const root = path.join(TMP, 'xbla');
  const file = path.join(root, 'CASTLEVANIA SYMPHONY OF THE NIGHT', '58410847', '000D0000', HEX);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from('LIVE'), Buffer.alloc(100, 7)]));
  const id = Number(db.prepare("INSERT INTO sources (name, path, recursive) VALUES ('XBLA', ?, 1)").run(root).lastInsertRowid);

  const first = await scanSource(id, { hash: true });
  assert.equal(first.added, 1);
  const row = () => db.prepare('SELECT r.title, r.filename, r.storage_path, p.slug AS platform FROM roms r JOIN platforms p ON p.id = r.platform_id WHERE r.source_id = ?').get(id);
  let r = row();
  assert.equal(r.platform, 'xbox360');
  assert.equal(r.title, 'CASTLEVANIA SYMPHONY OF THE NIGHT');
  assert.equal(r.filename, 'CASTLEVANIA SYMPHONY OF THE NIGHT.xbla');
  assert.equal(r.storage_path, file, 'it plays from the real file');

  const again = await scanSource(id, { hash: true });
  assert.equal(again.added, 0);
  r = row();
  assert.equal(r.platform, 'xbox360', 'unchanged files keep their platform on a rescan');
  assert.equal(r.title, 'CASTLEVANIA SYMPHONY OF THE NIGHT');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM roms WHERE source_id = ?').get(id).n, 1);
});

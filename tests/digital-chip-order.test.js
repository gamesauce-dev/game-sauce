// The Digital Library's chips are in the Library's order: families A to Z, then the platforms of each A to Z.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('the Digital chips follow the Library family order: families A to Z, Steam (no family) last, consoles A to Z', async () => {
  const { orderStores, orderConsoles } = await import('../public/platform-order.js');
  assert.deepEqual(orderStores(['steam', 'playstation', 'nintendo', 'xbox'].map((store) => ({ store }))).map((s) => s.store), ['xbox', 'nintendo', 'playstation', 'steam']);
  const names = { wiiu: 'Nintendo Wii U', switch: 'Nintendo Switch', '3ds': 'Nintendo 3DS', switch2: 'Nintendo Switch 2' };
  assert.deepEqual(orderConsoles(Object.keys(names).map((platform) => ({ platform })), (p) => names[p.platform]).map((p) => p.platform), ['3ds', 'switch', 'switch2', 'wiiu']);
  const dg = read('public/digital.js');
  assert.match(dg, /const stores = orderStores\(STORE_ORDER/);
  assert.match(dg, /const subsOf = \(s\) => orderConsoles\(/);
});

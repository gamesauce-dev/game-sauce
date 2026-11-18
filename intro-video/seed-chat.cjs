// Seeds the throwaway test server with the two people and the conversation shown in the intro (run once, with the server up on port 8795).
const base = process.env.BASE || 'http://localhost:8795';
const DB = process.env.DBFILE || 'C:/Users/numan/AppData/Local/Temp/toolstest/data/gamesauce.db';
const json = (token, body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
const login = async (u, p) => (await (await fetch(base + '/api/auth/login', json(null, { username: u, password: p }))).json()).token;
(async () => {
  const admin = await login('tester', 'tools-test-pass-1');
  await fetch(base + '/api/auth/users', json(admin, { username: 'sam', password: 'sam-demo-pass-1', role: 'user', display_name: 'Sam' }));
  const sam = await login('sam', 'sam-demo-pass-1');
  const D = require('better-sqlite3'); const d = new D(DB);
  const ids = Object.fromEntries(d.prepare("select id, username from users where username in ('tester','sam')").all().map((r) => [r.username, r.id]));
  d.prepare("update users set display_name = 'Sam' where username = 'sam'").run();
  d.prepare("delete from messages where sender_id in (?, ?) or recipient_id in (?, ?)").run(ids.tester, ids.sam, ids.tester, ids.sam);
  d.prepare('delete from notices').run();
  const lines = [['sam', 'Finally beat Block Blitz last night. That last level is brutal!'], ['tester', 'Ha, it took me ages. Have you tried the two-player mode?'], ['sam', 'Not yet. Saturday?'], ['tester', 'Deal. Dungeon of Echoes is on my Co-op list.'], ['sam', 'Perfect. Bringing snacks.']];
  for (const [who, body] of lines) await fetch(base + '/api/messages/with/' + (who === 'sam' ? ids.tester : ids.sam), json(who === 'sam' ? sam : admin, { body }));
  // times that read well on screen
  const rows = d.prepare('select id from messages where (sender_id = ? and recipient_id = ?) or (sender_id = ? and recipient_id = ?) order by id').all(ids.sam, ids.tester, ids.tester, ids.sam);
  const times = ['22:31', '22:33', '22:35', '22:37', '22:38'];
  rows.forEach((r, i) => d.prepare("update messages set created_at = ?, read_at = ? where id = ?").run('2026-11-18 ' + times[i] + ':00', '2026-11-18 ' + times[i] + ':30', r.id));
  await fetch(base + '/api/messages/notices', json(admin, { body: 'The server restarts at 10pm tonight. Save your games!', hours: 24 }));
  console.log('seeded', rows.length, 'messages', ids);
})().catch((e) => { console.error(e); process.exit(1); });

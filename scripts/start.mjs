#!/usr/bin/env node
// One-command launcher for people who just want to try game-sauce on their own computer.
//   ./start.sh            (Linux / macOS)        start.bat   (Windows)
// It picks a free port, keeps your data in a folder of its own (so updating the program never touches it),
// starts the server for this computer only, waits until it answers, and opens your browser.
// Options:  --lan  let other devices on your home network connect     --no-open  don't open the browser
//           --port 9000  choose the port                              --data <folder>  choose where your data lives
//           --reset-password [name]  forgotten the password? sets a new one for that account (default: the first admin), shows it, and exits
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };

const say = (m = '') => console.log(m);
const box = (lines) => { const w = Math.max(...lines.map((l) => l.length)) + 4; say('\n' + '─'.repeat(w)); for (const l of lines) say('  ' + l); say('─'.repeat(w) + '\n'); };

// 1. Node version: the app needs 22 or newer (its database library has no build for older ones).
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  box([`game-sauce needs Node.js 22 or newer. You have ${process.versions.node}.`, 'Get the current version from https://nodejs.org (choose "LTS"), then run this again.']);
  process.exit(1);
}

// 2. Where the data lives. An old ./data folder with a database in it keeps being used; otherwise a folder in your
//    home directory, so replacing the program folder with a newer download never loses your library or accounts.
const explicit = opt('--data') || process.env.GAMESAUCE_HOME;
const legacy = path.join(root, 'data', 'gamesauce.db');
const home = explicit ? path.resolve(explicit) : (fs.existsSync(legacy) ? root : path.join(os.homedir(), 'game-sauce-data'));
const dataDir = home === root ? path.join(root, 'data') : path.join(home, 'data');
const storageDir = home === root ? path.join(root, 'storage') : path.join(home, 'storage');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(storageDir, { recursive: true });
const firstRun = !fs.existsSync(path.join(dataDir, 'gamesauce.db'));

// 3. Dependencies (first run only).
if (!fs.existsSync(path.join(root, 'node_modules', 'express'))) {
  say('First run: installing game-sauce (this takes a minute)...');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const r = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    box(['The install did not finish.',
      `You are running Node.js ${process.versions.node}. game-sauce is tested on Node 22 and newer LTS versions (22, 24, 26).`,
      'If the messages above mention "node-gyp" or a failed build, check your Node version:',
      '  check it with  node --version  and install the current LTS from https://nodejs.org, then run this again.',
      ...(process.platform === 'linux' ? [
        'On Linux it can also be missing build tools:',
        '  Ubuntu / Debian / Mint:  apt install build-essential python3   (as administrator)',
        '  Fedora:                  dnf groupinstall "Development Tools"  (as administrator)'] : []),
      'If it still fails, see docs/QUICKSTART-DESKTOP.md.']);
    process.exit(1);
  }
}

// 3b. Forgotten password: set a new one for an account (the first admin unless a name is given), show it once, and stop (start it normally afterwards).
if (flag('--reset-password')) {
  const given = opt('--reset-password');
  const who = given && !given.startsWith('--') ? given : '';
  const code = `
    import db from './src/db.js';
    import { setPassword } from './src/auth.js';
    import { randomToken, passwordProblems } from './src/lib/auth.js';
    const who = ${JSON.stringify(who)};
    const user = who ? db.prepare('SELECT id, username FROM users WHERE username = ? COLLATE NOCASE').get(who)
                     : db.prepare("SELECT id, username FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY id LIMIT 1").get();
    if (!user) { console.log(who ? 'There is no account called "' + who + '".' : 'There is no account yet: start game-sauce normally and it will make one.'); process.exit(2); }
    let pw; do { pw = randomToken(12); } while (passwordProblems(pw).length);
    await setPassword(user.id, pw);
    db.prepare('UPDATE users SET disabled = 0 WHERE id = ?').run(user.id);
    try { db.prepare('DELETE FROM login_attempts').run(); } catch { /* no lockouts to clear */ }
    console.log('username: ' + user.username);
    console.log('password: ' + pw);`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env: { ...process.env, GAMESAUCE_DATA_DIR: dataDir, GAMESAUCE_STORAGE_DIR: storageDir }, encoding: 'utf8' });
  if (r.status === 0) box(['The password has been reset. Sign in with:', ...String(r.stdout).trim().split('\n'), 'It is shown once: change it under Settings after signing in. Anyone signed in as that account was signed out.', 'Now start game-sauce as usual.']);
  else box([String(r.stdout || r.stderr).trim().split('\n')[0] || 'The password could not be reset.', `Your data is in: ${home}`]);
  process.exit(r.status === 0 ? 0 : 1);
}

// 4. A free port (8765 by default, then the next ones).
const isFree = (port, host) => new Promise((resolve) => {
  const s = net.createServer().once('error', () => resolve(false)).once('listening', () => s.close(() => resolve(true))).listen(port, host);
});
const want = Number(opt('--port') || process.env.PORT || 8765);
let port = want;
while (!(await isFree(port, '127.0.0.1')) && port < want + 50) port++;
if (port !== want) say(`Port ${want} is busy, using ${port} instead.`);

// 5. Start the server.
const lan = flag('--lan');
const host = lan ? '0.0.0.0' : '127.0.0.1';
const env = { GAMESAUCE_INSTALL: 'download', ...process.env, HOST: host, PORT: String(port), GAMESAUCE_DATA_DIR: dataDir, GAMESAUCE_STORAGE_DIR: storageDir };   // GAMESAUCE_INSTALL: how an update notice words its advice
const server = spawn(process.execPath, ['src/server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
let ready = false, shown = false;
server.stdout.on('data', (buf) => {
  const text = buf.toString();
  // The first account's password is printed by the app exactly once: keep it visible.
  if (/created the first account|created admin account/.test(text)) { shown = true; process.stdout.write(text); }
  else if (!ready) process.stdout.write(text);
});
server.on('exit', (code) => { if (!ready) box([`game-sauce stopped before it was ready (exit code ${code}).`, 'The message above says why.']); process.exit(code ?? 1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.kill(sig); setTimeout(() => process.exit(0), 300); });

// 6. Wait until it answers, then say where it is and open the browser.
const url = `http://127.0.0.1:${port}`;
const up = async () => { try { return (await fetch(`${url}/api/health`)).ok; } catch { return false; } };
for (let i = 0; i < 120 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
if (!(await up())) { box(['game-sauce did not start in time.', 'Look at the messages above, then try again.']); server.kill(); process.exit(1); }
ready = true;
const lanIp = lan ? Object.values(os.networkInterfaces()).flat().find((n) => n && n.family === 'IPv4' && !n.internal)?.address : null;
box([
  'game-sauce is running.',
  `Open it here:   ${url}`,
  ...(lanIp ? [`On your network: http://${lanIp}:${port}`] : []),
  ...(firstRun && !shown ? ['First time: sign in with the account shown above.'] : []),
  ...(!firstRun ? ['Welcome back: sign in with the account you made before.', 'Forgotten the password? Close this and start with  --reset-password  (see READ ME FIRST).'] : []),
  `Your library and accounts are kept in: ${home}`,
  'Stop it with Ctrl+C (or close this window). Start it again the same way.'
]);
if (!flag('--no-open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser: the address above is enough */ }
}

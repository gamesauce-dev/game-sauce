#!/usr/bin/env node
// One-command launcher for people who just want to try game-sauce on their own computer.
//   ./start.sh            (Linux / macOS)        start.bat   (Windows)
// It picks a free port, keeps your data in a folder of its own (so updating the program never touches it),
// starts the server for this computer only, waits until it answers, and opens your browser.
// Options:  --lan  let other devices on your home network connect     --no-open  don't open the browser
//           --port 9000  choose the port                              --data <folder>  choose where your data lives
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

// 1. Node version: the app needs 20 or newer.
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) {
  box([`game-sauce needs Node.js 20 or newer. You have ${process.versions.node}.`, 'Get the current version from https://nodejs.org (choose "LTS"), then run this again.']);
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
  const r = spawnSync(npm, ['ci', '--omit=dev'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    box(['The install did not finish.',
      'On Linux this is usually because build tools are missing. Try one of:',
      '  Ubuntu / Debian / Mint:  apt install build-essential python3   (as administrator)',
      '  Fedora:                  dnf groupinstall "Development Tools"  (as administrator)',
      'then run this again. If it still fails, see docs/QUICKSTART-DESKTOP.md.']);
    process.exit(1);
  }
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
const env = { ...process.env, HOST: host, PORT: String(port), GAMESAUCE_DATA_DIR: dataDir, GAMESAUCE_STORAGE_DIR: storageDir };
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
  `Your library and accounts are kept in: ${home}`,
  'Stop it with Ctrl+C (or close this window). Start it again the same way.'
]);
if (!flag('--no-open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no browser: the address above is enough */ }
}

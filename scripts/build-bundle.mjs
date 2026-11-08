#!/usr/bin/env node
// Builds the "portable bundle": game-sauce plus its own copy of Node.js and its ready-to-run modules, in one folder that is
// zipped (Windows) or tarred (macOS, Linux). The person who downloads it installs nothing: unpack, double-click Start, done.
//
//   node scripts/build-bundle.mjs                 build for the OS and CPU this runs on
//   node scripts/build-bundle.mjs --smoke         ...and start the finished bundle once to prove it answers
//   --out <folder>      where to put the result (default ./dist)
//   --version <x.y.z>   the version in the file name (default: package.json)
//   --name <folder>     a fixed folder name;  --stage-only  stop after the folder is built (no zip), used by the desktop app
//   --node-version <v>  an exact Node.js (default: the newest release of the Node major this script runs on)
//
// A bundle can only be built on the OS and CPU it is for (the database library has a native part), so the release workflow
// builds each one on its own runner. The Node major used to install the modules is the one bundled, so the two always agree.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const die = (m) => { console.error('\nbuild-bundle: ' + m + '\n'); process.exit(1); };
const log = (m) => console.log('• ' + m);

const OS = { win32: ['windows', 'win'], darwin: ['macos', 'darwin'], linux: ['linux', 'linux'] }[process.platform];
if (!OS || !['x64', 'arm64'].includes(process.arch)) die(`no bundle for ${process.platform}/${process.arch}`);
const [osName, nodeOs] = OS;
const arch = process.arch;
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = (opt('--version') || pkg.version).replace(/^v/, '');
const name = opt('--name') || `game-sauce-v${version}-${osName}-${arch}`;   // --name: a fixed folder name, for the desktop app to pick up
const out = path.resolve(opt('--out') || path.join(root, 'dist'));
const stage = path.join(out, name);
const cache = path.join(out, '.cache');
const win = process.platform === 'win32';
// Windows ships its own tar (it also reads and writes .zip); a Git-for-Windows tar earlier on the PATH cannot.
const tar = win ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

const run = (cmd, a, o = {}) => { const r = spawnSync(cmd, a, { stdio: 'inherit', shell: win && /\.cmd$/.test(cmd), ...o }); if (r.status !== 0) die(`${cmd} ${a.join(' ')} failed`); };
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(cache, { recursive: true });

// 1. Node.js: the official build, checked against the checksums nodejs.org publishes.
const major = process.versions.node.split('.')[0];
let nodeVersion = opt('--node-version');
if (!nodeVersion) {
  const index = await (await fetch('https://nodejs.org/dist/index.json')).json();
  nodeVersion = index.find((r) => r.version.startsWith(`v${major}.`))?.version;
  if (!nodeVersion) die(`no Node.js ${major} release found`);
}
if (!nodeVersion.startsWith('v')) nodeVersion = 'v' + nodeVersion;
const ext = win ? 'zip' : process.platform === 'darwin' ? 'tar.gz' : 'tar.xz';
const archive = `node-${nodeVersion}-${nodeOs}-${arch}.${ext}`;
const archivePath = path.join(cache, archive);
if (!fs.existsSync(archivePath)) {
  log(`downloading Node.js ${nodeVersion} (${nodeOs}-${arch})`);
  const res = await fetch(`https://nodejs.org/dist/${nodeVersion}/${archive}`);
  if (!res.ok) die(`could not download ${archive} (${res.status})`);
  fs.writeFileSync(archivePath, Buffer.from(await res.arrayBuffer()));
}
const sums = await (await fetch(`https://nodejs.org/dist/${nodeVersion}/SHASUMS256.txt`)).text();
const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === archive)?.[0];
if (!want) die(`no checksum published for ${archive}`);
if (sha256(fs.readFileSync(archivePath)) !== want) { fs.rmSync(archivePath); die(`${archive} does not match its published checksum`); }
log('Node.js checksum matches nodejs.org');
const unpack = path.join(cache, `unpack-${nodeVersion}-${nodeOs}-${arch}`);
fs.rmSync(unpack, { recursive: true, force: true }); fs.mkdirSync(unpack, { recursive: true });
run(tar, ['-xf', archivePath, '-C', unpack]);
const nodeDir = path.join(unpack, archive.replace(/\.(zip|tar\.gz|tar\.xz)$/, ''));
fs.mkdirSync(path.join(stage, 'runtime'), { recursive: true });
const exe = win ? 'node.exe' : 'node';
fs.copyFileSync(path.join(nodeDir, win ? exe : path.join('bin', exe)), path.join(stage, 'runtime', exe));
fs.chmodSync(path.join(stage, 'runtime', exe), 0o755);
fs.copyFileSync(path.join(nodeDir, 'LICENSE'), path.join(stage, 'runtime', 'NODE-LICENSE.txt'));

// 2. The program: only what runs (no tests, docs, screenshots or tools), then its modules, installed fresh.
const app = path.join(stage, 'app');
fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
for (const f of ['package.json', 'package-lock.json', 'LICENSE', 'CHANGELOG.md']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(app, f));
fs.cpSync(path.join(root, 'src'), path.join(app, 'src'), { recursive: true });
fs.cpSync(path.join(root, 'public'), path.join(app, 'public'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts', 'start.mjs'), path.join(app, 'scripts', 'start.mjs'));
log('installing the modules');
run(win ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: app });
// The database library carries a ready-made file for every kind of computer (Windows, Mac, Linux, ARM, Alpine). Only this computer's is ever used: keep just that one.
// It makes every download smaller, and the tool that builds the Linux AppImage stops at the Alpine one ("Could not find dependency: libc.musl-x86_64.so.1").
const prebuilds = path.join(app, 'node_modules', 'better-sqlite3', 'prebuilds');
const keep = `${process.platform}-${arch}.node`;
if (fs.existsSync(prebuilds)) {
  if (!fs.existsSync(path.join(prebuilds, keep))) die(`the database library has no ready-made file for this computer (${keep})`);
  for (const f of fs.readdirSync(prebuilds)) if (f !== keep) fs.rmSync(path.join(prebuilds, f), { recursive: true, force: true });
  log(`kept only the database file for this computer (${keep})`);
}
// The bundled Node must be able to load the database library, or the bundle is useless: stop here if not.
const probe = spawnSync(path.join(stage, 'runtime', exe), ['-e', "import('better-sqlite3').then((m) => { new m.default(':memory:').prepare('select 1').get(); })"], { cwd: app, encoding: 'utf8' });
if (probe.status !== 0) die('the bundled Node cannot load the database library:\n' + (probe.stderr || probe.stdout));
log('the database library loads under the bundled Node');

// 3. Start files and a short read-me.
const put = (file, text, mode = 0o644) => { fs.writeFileSync(path.join(stage, file), win ? text.replace(/\n/g, '\r\n') : text, { mode }); };
const readme = (start, extra = '') => `game-sauce ${version}
${'='.repeat(('game-sauce ' + version).length)}

TO START:  ${start}
Your browser opens on game-sauce. The first time, sign in with the account shown in the window
(it is shown once: write it down, then change the password under Settings).
Forgotten the password? Use the "Reset admin password" file (or start with --reset-password): it gives the first admin a new one.

Keep that window open while you use game-sauce; closing it stops the program.
By default only this computer can open it. To let phones, TVs and other computers on your home network
use it too, start it with the "share on my network" file instead.

YOUR LIBRARY AND ACCOUNTS are kept OUTSIDE this folder, in "game-sauce-data" in your home folder,
so updating is just: unpack the new version beside (or over) this one and start that. Nothing is lost.
To keep them somewhere else, start it with  --data "D:\\somewhere"  (or the equivalent for your system).
${extra}
Nothing here needs installing: Node.js is included (runtime folder). Help and documents:
https://github.com/gamesauce-dev/game-sauce
`;
if (win) {
  put('Start game-sauce.bat', '@echo off\ncd /d "%~dp0"\n"%~dp0runtime\\node.exe" "%~dp0app\\scripts\\start.mjs" %*\nif errorlevel 1 pause\n');
  put('Start game-sauce (share on my network).bat', '@echo off\ncd /d "%~dp0"\n"%~dp0runtime\\node.exe" "%~dp0app\\scripts\\start.mjs" --lan %*\nif errorlevel 1 pause\n');
  put('Reset admin password.bat', '@echo off\ncd /d "%~dp0"\n"%~dp0runtime\\node.exe" "%~dp0app\\scripts\\start.mjs" --reset-password %*\npause\n');
  put('READ ME FIRST.txt', readme('double-click  "Start game-sauce.bat"', `
Windows may say "Windows protected your PC" the first time (the file is new to it). Choose "More info", then "Run anyway".
Windows Firewall may ask whether to allow it when you share on your network: choose "Private networks".
`));
} else {
  const sh = (lan) => `#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nexec ./runtime/node app/scripts/start.mjs ${lan ? '--lan ' : ''}"$@"\n`;
  if (process.platform === 'darwin') {
    put('Start game-sauce.command', sh(false), 0o755);
    put('Start game-sauce (share on my network).command', sh(true), 0o755);
    put('Reset admin password.command', '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\n./runtime/node app/scripts/start.mjs --reset-password "$@"\nprintf \'Press Return to close. \'; read _\n', 0o755);
    put('READ ME FIRST.txt', readme('double-click  "Start game-sauce.command"', `
The first time, macOS may refuse because the file came from the internet. Right-click (or Control-click) it, choose Open,
then Open again. Or run this once in Terminal, inside this folder:   xattr -dr com.apple.quarantine .
`));
  } else {
    put('start.sh', sh(false), 0o755);
    put('start-shared.sh', sh(true), 0o755);
    put('reset-password.sh', '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nexec ./runtime/node app/scripts/start.mjs --reset-password "$@"\n', 0o755);
    put('READ ME FIRST.txt', readme('run  ./start.sh  (in a terminal, in this folder)', `
For the "share on my network" version run ./start-shared.sh. To start it automatically at boot, see docs/DEPLOYMENT.md in the project.
`));
  }
}

// --stage-only: the desktop app wants just the folder (runtime/ and app/), not a zip.
if (args.includes('--stage-only')) { log(`staged in ${stage}`); process.exit(0); }

// 4. Pack it, with a checksum beside it.
const file = `${name}.${win ? 'zip' : 'tar.gz'}`;
const filePath = path.join(out, file);
fs.rmSync(filePath, { force: true });
run(tar, win ? ['-a', '-c', '-f', filePath, '-C', out, name] : ['-czf', filePath, '-C', out, name]);
fs.writeFileSync(`${filePath}.sha256`, `${sha256(fs.readFileSync(filePath))}  ${file}\n`);
log(`${file}  (${(fs.statSync(filePath).size / 1048576).toFixed(1)} MB)`);

// 5. Smoke test: start the finished bundle exactly as a person would, in a scratch data folder, and see that it answers.
if (args.includes('--smoke')) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-smoke-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(path.join(stage, 'runtime', exe), [path.join(app, 'scripts', 'start.mjs'), '--no-open', '--port', String(port)],
    { cwd: stage, env: { ...process.env, GAMESAUCE_HOME: home, GAMESAUCE_ADMIN_PASSWORD: 'smoke-test-pass-1' }, stdio: 'ignore' });
  let ok = false;
  for (let i = 0; i < 120 && !ok; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try { ok = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { /* not up yet */ }
  }
  let page = false;
  if (ok) { try { page = (await (await fetch(`http://127.0.0.1:${port}/`)).text()).includes('game-sauce'); } catch { /* reported below */ } }
  if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 800));
  try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best effort */ }
  if (!ok || !page) die('the finished bundle did not start and serve its page');
  log('smoke test passed: the bundle starts and serves its page');
}

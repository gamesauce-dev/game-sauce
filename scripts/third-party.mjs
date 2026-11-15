// Writes docs/THIRD-PARTY.md: the licences of everything game-sauce ships or loads.   node scripts/third-party.mjs
// It reads the installed server dependencies (npm ls --omit=dev, so run `npm ci` first) and, when cargo is installed,
// the Rust crates of the desktop app (cargo metadata; the first run downloads crate manifests). Run it before a release
// and commit the result. The hand-written notes at the bottom of this file are the part that needs a person.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const run = (cmd, cwd) => execSync(cmd, { cwd, maxBuffer: 1 << 29, stdio: ['ignore', 'pipe', 'ignore'] }).toString();

// --- the server (npm) ---------------------------------------------------------------------------------------------
const tree = JSON.parse(run('npm ls --omit=dev --all --json', root));
const seen = new Map();
(function walk(deps) { for (const [n, d] of Object.entries(deps || {})) { const k = n + '@' + d.version; if (!seen.has(k)) seen.set(k, n); walk(d.dependencies); } })(tree.dependencies);
const node = [];
for (const [k, name] of seen) {
  const f = path.join(root, 'node_modules', name, 'package.json');
  let lic = '?'; let home = '';
  if (fs.existsSync(f)) { const j = JSON.parse(fs.readFileSync(f, 'utf8')); lic = typeof j.license === 'string' ? j.license : (j.license?.type || (j.licenses || []).map((l) => l.type).join(' OR ') || '?'); home = (typeof j.repository === 'string' ? j.repository : j.repository?.url || j.homepage || '').replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/^http:/, 'https:').replace(/\.git$/, ''); if (/^[\w.-]+\/[\w.-]+$/.test(home)) home = 'https://github.com/' + home; }
  node.push({ name, version: k.slice(name.length + 1), lic, home });
}
node.sort((a, b) => a.name.localeCompare(b.name));
const count = (rows) => { const c = {}; for (const r of rows) c[r.lic] = (c[r.lic] || 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]); };

// --- the desktop app (Rust crates) ---------------------------------------------------------------------------------
let rust = [];
try {
  const meta = JSON.parse(run('cargo metadata --format-version 1 --locked', path.join(root, 'desktop', 'src-tauri')));
  rust = meta.packages.filter((p) => p.source).map((p) => ({ name: p.name, version: p.version, lic: p.license || '(see its files)', home: p.repository || p.homepage || '' }));
  rust.sort((a, b) => a.name.localeCompare(b.name));
} catch { /* no cargo here: the Rust part is left out */ }

const table = (rows) => '| Licence | Packages |\n|---|---|\n' + count(rows).map(([l, n]) => `| ${l} | ${n} |`).join('\n');
const out = [];
out.push('# Third-party software and licences', '',
  'game-sauce itself is under the [MIT licence](../LICENSE). This page lists the software it ships with or loads, and under what terms. It is written by `scripts/third-party.mjs` (the numbers) with notes added by hand (the last section). Run the script before a release.', '',
  '## What counts as "shipped"', '',
  '- **Server (Docker image, Proxmox install, bare Node, desktop app):** the npm packages below, plus Node.js itself and the SQLite engine inside `better-sqlite3`.',
  '- **Desktop app:** the Rust crates below (Tauri and what it uses), statically built into the app, plus the operating system\'s web view (WebView2 on Windows, WebKit on macOS and Linux).',
  '- **Browser page:** `public/vendor/pdfjs` (pdf.js, Apache-2.0, with its licence file) and the icon and flag pictures.',
  '- **Loaded when someone presses Play, not shipped:** EmulatorJS and its emulator cores, fetched by the visitor\'s browser from `cdn.emulatorjs.org`. See the notes.', '',
  `## Server: npm packages (${node.length})`, '', 'Only the production dependencies (what is installed with `npm ci --omit=dev`). Tests and tools such as Playwright are development-only and are never shipped.', '', table(node), '',
  '<details><summary>The full list</summary>', '', '| Package | Version | Licence |', '|---|---|---|', ...node.map((r) => `| ${r.home ? `[${r.name}](${r.home})` : r.name} | ${r.version} | ${r.lic} |`), '', '</details>', '');
if (rust.length) out.push(`## Desktop app: Rust crates (${rust.length})`, '', 'From `desktop/src-tauri/Cargo.lock`, all platforms together (Windows, macOS and Linux crates are all counted).', '', table(rust), '',
  '<details><summary>The full list</summary>', '', '| Crate | Version | Licence |', '|---|---|---|', ...rust.map((r) => `| ${r.home ? `[${r.name}](${r.home})` : r.name} | ${r.version} | ${r.lic} |`), '', '</details>', '');
out.push(fs.existsSync(path.join(root, 'docs', 'THIRD-PARTY-NOTES.md')) ? fs.readFileSync(path.join(root, 'docs', 'THIRD-PARTY-NOTES.md'), 'utf8') : '');
fs.writeFileSync(path.join(root, 'docs', 'THIRD-PARTY.md'), out.join('\n') + '\n');
console.log(`docs/THIRD-PARTY.md written: ${node.length} npm packages, ${rust.length} Rust crates`);

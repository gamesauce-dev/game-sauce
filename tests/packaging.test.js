import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = (rel) => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const exists = (rel) => fs.existsSync(new URL('../' + rel, import.meta.url));

test('the Unraid template matches the Docker image: same image, port and folders, and its icon and address exist in the repo', () => {
  const xml = read('install/unraid/game-sauce.xml'), docker = read('Dockerfile'), ghcr = read('install/docker-compose.ghcr.yml');
  assert.match(xml, /^<\?xml version="1\.0"\?>\n<Container version="2">/); assert.match(xml, /<\/Container>\s*$/);
  const image = /<Repository>([^<]+)<\/Repository>/.exec(xml)[1];
  assert.ok(ghcr.includes(image.replace(/:latest$/, '')), 'the same image the compose file uses');
  const target = (n) => new RegExp(`<Config Name="[^"]+" Target="${n}"[^>]*>`).exec(xml)?.[0];
  assert.ok(target('8080') && /Type="Port"/.test(target('8080')) && /EXPOSE 8080/.test(docker), 'the container port is the one the image listens on');
  for (const p of ['/app/data', '/app/storage']) { assert.ok(target(p) && /Mode="rw"/.test(target(p)), p + ' is kept'); assert.ok(docker.includes(p), p + ' is a folder of the image'); }
  assert.match(target('/roms'), /Mode="ro"/, 'ROMs are mounted read-only');
  assert.match(target('GAMESAUCE_ADMIN_PASSWORD'), /Mask="true"/); assert.match(target('GAMESAUCE_ADMIN_PASSWORD'), /Required="false"/, 'blank is allowed: one is generated');
  assert.match(xml, /<ExtraParams>[^<]*--user 99:100/, 'runs as nobody:users so it can write Unraid shares');
  assert.match(xml, /<WebUI>http:\/\/\[IP\]:\[PORT:8080\]\/<\/WebUI>/);
  const raw = 'https://raw.githubusercontent.com/gamesauce-dev/game-sauce/main/';
  for (const tag of ['TemplateURL', 'Icon']) { const u = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)[1]; assert.ok(u.startsWith(raw) && exists(u.slice(raw.length)), `${tag} points at a file in the repo`); }
  assert.ok(read('docs/UNRAID.md').includes('install/unraid/game-sauce.xml'));
});

test('the release workflow builds the four downloads on their own runners, checks the tag, and publishes with checksums', () => {
  const y = read('.github/workflows/release.yml');
  for (const l of ['windows-x64', 'macos-arm64', 'linux-x64', 'linux-arm64']) assert.ok(y.includes(`label: ${l}`), l);
  assert.ok(!y.includes('macos-x64') && !y.includes('macos-13'), 'Apple Silicon only');
  assert.match(y, /tags: \['v\*'\]/); assert.match(y, /workflow_dispatch/);
  assert.match(y, /build-bundle\.mjs --smoke/, 'every bundle is started once before it is published');
  assert.match(y, /does not match package\.json version/); assert.match(y, /SHA256SUMS/); assert.match(y, /gh release create/);
  assert.match(y, /contents: write/);
});

test('the bundle builder: official Node checked against nodejs.org\'s checksums, its own modules, start files for each system, and a smoke test', () => {
  const s = read('scripts/build-bundle.mjs');
  assert.match(s, /SHASUMS256\.txt/); assert.match(s, /does not match its published checksum/);
  assert.match(s, /npm.*'ci', '--omit=dev'/); assert.match(s, /Start game-sauce\.bat/); assert.match(s, /Start game-sauce\.command/); assert.match(s, /start\.sh/);
  assert.match(s, /--lan/, 'a "share on my network" start file'); assert.match(s, /--smoke/); assert.match(s, /xattr -dr com\.apple\.quarantine/);
  assert.ok(read('.gitignore').includes('dist/'));
});

test('--reset-password: sets a new generated password for the first admin (or a named account), signs them out, and says so when there is nobody to reset', async () => {
  const { spawnSync } = await import('node:child_process'); const os = await import('node:os'); const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const cwd = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gamesauce-reset-test-'));
  const dataDir = path.join(home, 'data'), storageDir = path.join(home, 'storage');
  const start = (...a) => spawnSync(process.execPath, ['scripts/start.mjs', '--data', home, ...a], { cwd, encoding: 'utf8' });
  const node = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd, encoding: 'utf8', env: { ...process.env, GAMESAUCE_DATA_DIR: dataDir, GAMESAUCE_STORAGE_DIR: storageDir } });
  try {
    const none = start('--reset-password'); assert.equal(none.status, 1); assert.match(none.stdout, /There is no account yet/);
    const seed = node(`
      import db from './src/db.js'; import { createUser } from './src/auth.js';
      const a = await createUser({ username: 'owner', password: 'original-pass-1', role: 'admin' });
      await createUser({ username: 'kid', password: 'kids-pass-1234', role: 'user' });
      db.prepare("INSERT INTO sessions (user_id, token_hash, expires_at, last_seen_at) VALUES (?, 'x', datetime('now','+1 day'), datetime('now'))").run(a.id);`);
    assert.equal(seed.status, 0, seed.stderr);
    const r = start('--reset-password'); assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /username: owner/); const pw = /password: (\S+)/.exec(r.stdout)[1];
    const bad = start('--reset-password', 'nobody'); assert.equal(bad.status, 1); assert.match(bad.stdout, /There is no account called "nobody"/);
    const check = node(`
      import db from './src/db.js'; import { verifyPassword } from './src/lib/auth.js';
      const u = db.prepare("SELECT password_hash FROM users WHERE username = 'owner'").get();
      console.log(JSON.stringify({ ok: await verifyPassword(${JSON.stringify(pw)}, u.password_hash), old: await verifyPassword('original-pass-1', u.password_hash), sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n }));`);
    assert.deepEqual(JSON.parse(check.stdout.trim().split('\n').pop()), { ok: true, old: false, sessions: 0 });
    assert.match(start('--reset-password', 'kid').stdout, /username: kid/);
  } finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  const s = read('scripts/build-bundle.mjs');
  for (const f of ['Reset admin password.bat', 'Reset admin password.command', 'reset-password.sh']) assert.ok(s.includes(f), f);
  assert.match(read('scripts/start.mjs'), /Welcome back: sign in with the account you made before/);
});

test('password boxes get an eye (everywhere, including boxes added later); the tour moves on after a password change, with a toast', () => {
  const js = read('public/pwreveal.js'), css = read('public/styles.css'), app = read('public/app.js');
  assert.match(js, /querySelectorAll\?\.\('input\[type="password"\]'\)/); assert.match(js, /new MutationObserver/, 'boxes that appear later are covered');
  assert.match(js, /'Show password'/); assert.match(js, /'Hide password'/); assert.match(js, /aria-pressed/);
  assert.match(js, /addEventListener\('submit'/, 'hidden again when the form is sent');
  assert.match(css, /\.pw-eye \{/); assert.match(css, /::-ms-reveal/, 'not two eyes in Edge');
  assert.match(app, /import '\.\/pwreveal\.js'/);
  const card = app.slice(app.indexOf('function wirePasswordCard'), app.indexOf('function wireSteamCard'));
  assert.match(card, /toast\('Password changed'\)/); assert.match(card, /WELCOME\.step\+\+; paintWelcome\(\)/, 'on to the next card');
});

test('the desktop app: one version everywhere, the server built in as resources, both ways to use it, and built for the three systems on release', () => {
  const root = JSON.parse(read('package.json')).version;
  assert.equal(JSON.parse(read('desktop/package.json')).version, root, 'desktop/package.json');
  const conf = JSON.parse(read('desktop/src-tauri/tauri.conf.json'));
  assert.equal(conf.version, root, 'tauri.conf.json'); assert.equal(conf.productName, 'game-sauce');
  assert.match(read('desktop/src-tauri/Cargo.toml'), new RegExp(`^version = "${root.replace(/\./g, '\.')}"`, 'm'));
  assert.deepEqual(Object.values(conf.bundle.resources).sort(), ['app/', 'runtime/'], 'Node and the server travel inside the app');
  assert.equal(conf.bundle.windows.nsis.installMode, 'currentUser', 'no administrator rights to install');
  const rs = read('desktop/src-tauri/src/main.rs');
  for (const f of ['fn use_local', 'fn use_remote', 'fn get_config', '"game-sauce-data"', 'creation_flags', 'RunEvent::Exit']) assert.ok(rs.includes(f), f);
  assert.ok(rs.includes('"password:"') || rs.includes('strip_prefix("password:")'), 'the first account is shown to the person');
  const ui = read('desktop/ui/index.html');
  assert.ok(ui.includes('Run game-sauce on this computer') && ui.includes('Connect to a game-sauce server') && ui.includes("invoke('use_local'") && ui.includes("invoke('use_remote'"));
  const y = read('.github/workflows/release.yml');
  for (const l of ['windows-x64, bundles: nsis', 'macos-arm64, bundles: dmg', 'linux-x64, bundles: deb, extra: appimage']) assert.ok(y.includes(l), l);
  assert.match(y, /needs: \[bundle, desktop\]/);
  assert.ok(read('desktop/.gitignore').includes('server-stage/') && read('desktop/.gitignore').includes('target/'));
});

test('workflow files: no unquoted "word: word" in a step name or value (a colon there is a YAML error and the whole workflow fails to start)', () => {
  for (const f of fs.readdirSync(new URL('../.github/workflows/', import.meta.url)).filter((x) => x.endsWith('.yml'))) {
    const bad = read('.github/workflows/' + f).split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /^\s*(- )?(name|run|if|with|uses):\s+[^'"|>{\[#\s][^#]*:\s/.test(l) && !/^\s*(- )?(run|if):/.test(l));
    assert.deepEqual(bad, [], `${f}: ${bad.map((b) => b[0]).join(', ')}`);
  }
});

test('the desktop build tries again when GitHub answers 502 while Tauri downloads its packaging tools', () => {
  const y = read('.github/workflows/release.yml');
  assert.match(y, /for i in 1 2 3 4 5; do\n\s+npx tauri build --bundles \$\{\{ matrix\.bundles \}\} && exit 0/);
  assert.ok(y.includes('path: ~\\AppData\\Local\\tauri') && y.includes('path: ~/.cache/tauri'), "Tauri's downloaded packaging tools are kept between runs");
  assert.match(y, /shell: bash/, 'one shell on all three systems');
});

test('the Linux AppImage is optional (the .deb is required), and linuxdeploy can run on a runner without FUSE', () => {
  const y = read('.github/workflows/release.yml');
  assert.ok(y.includes('name: Linux AppImage (optional)') && y.includes('continue-on-error: true'));
  assert.ok(y.includes('APPIMAGE_EXTRACT_AND_RUN: 1'), 'the packaging tool is itself an AppImage: it unpacks itself instead of needing FUSE');
  assert.ok(y.includes('NO_STRIP: true'));
});

test('the desktop app: a menu bar on a Mac, a tray icon (not a menu bar) on Windows and Linux, with the same entries and the address it is running on', () => {
  const rs = read('desktop/src-tauri/src/main.rs');
  assert.match(read('desktop/src-tauri/Cargo.toml'), /features = \["tray-icon"\]/);
  assert.ok(rs.includes('#[cfg(target_os = "macos")]') && rs.includes('#[cfg(not(target_os = "macos"))]'));
  for (const id of ['"open"', '"switch"', '"data"', '"quit"']) assert.ok(rs.includes(id), id);
  assert.ok(rs.includes('TrayIconBuilder') && rs.includes('fn lan_ip') && rs.includes('On your network: http://'));
  assert.ok(rs.includes('GAMESAUCE_DESKTOP_CONFIG'), 'tests can keep their saved choice apart from the real one');
  assert.match(read('docs/DESKTOP.md'), /tray/);
});

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

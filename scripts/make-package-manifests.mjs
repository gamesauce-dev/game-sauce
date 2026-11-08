#!/usr/bin/env node
// Writes the package-manager entries for a published release, from the release's own SHA256SUMS file:
//   install/packages/winget/<version>/   the three files winget wants (Windows, the desktop installer)
//   install/packages/scoop/game-sauce.json   a Scoop manifest (Windows, the portable download)
//   install/packages/homebrew/Casks/game-sauce.rb   a Homebrew cask (Apple Silicon, the desktop app)
// Run it after each release, then see docs/PACKAGES.md for where each one goes:
//   node scripts/make-package-manifests.mjs            (the version in package.json)
//   node scripts/make-package-manifests.mjs 0.3.1      (a given version)
//   node scripts/make-package-manifests.mjs --sums ./SHA256SUMS   (read the checksums from a file instead of GitHub)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const die = (m) => { console.error('\nmake-package-manifests: ' + m + '\n'); process.exit(1); };

const REPO = 'gamesauce-dev/game-sauce';
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = (args.find((a) => /^v?\d+\.\d+\.\d+/.test(a)) || pkg.version).replace(/^v/, '');
const base = `https://github.com/${REPO}/releases/download/v${version}`;

let sums;
if (opt('--sums')) sums = fs.readFileSync(opt('--sums'), 'utf8');
else {
  const res = await fetch(`${base}/SHA256SUMS`);
  if (!res.ok) die(`could not read ${base}/SHA256SUMS (${res.status}). Is v${version} published?`);
  sums = await res.text();
}
const hashOf = Object.fromEntries(sums.split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([h, f]) => [f.replace(/^\*/, ''), h.toLowerCase()]));
const need = (file) => hashOf[file] || die(`${file} is not in SHA256SUMS`);

const files = {
  exe: `game-sauce_${version}_x64-setup.exe`,
  zip: `game-sauce-v${version}-windows-x64.zip`,
  dmg: `game-sauce_${version}_aarch64.dmg`
};
const description = 'A self-hosted game library for your household: your ROMs, your digital games and the boxed games on your shelf, with covers and details found for you, play in the browser, and a small private chat.';
const out = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text.replace(/\r\n/g, '\n')); console.log('•', rel); };

// winget: the desktop installer (an NSIS setup that installs for the current user only)
const id = 'gamesauce-dev.game-sauce';
const wdir = `install/packages/winget/${version}`;
out(`${wdir}/${id}.yaml`, `PackageIdentifier: ${id}
PackageVersion: ${version}
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.6.0
`);
out(`${wdir}/${id}.installer.yaml`, `PackageIdentifier: ${id}
PackageVersion: ${version}
InstallerLocale: en-US
InstallerType: nullsoft
Scope: user
InstallModes:
  - interactive
  - silent
  - silentWithProgress
UpgradeBehavior: install
Installers:
  - Architecture: x64
    InstallerUrl: ${base}/${files.exe}
    InstallerSha256: ${need(files.exe).toUpperCase()}
ManifestType: installer
ManifestVersion: 1.6.0
`);
out(`${wdir}/${id}.locale.en-US.yaml`, `PackageIdentifier: ${id}
PackageVersion: ${version}
PackageLocale: en-US
Publisher: gamesauce-dev
PublisherUrl: https://github.com/gamesauce-dev
PackageName: game-sauce
PackageUrl: https://github.com/${REPO}
License: MIT
LicenseUrl: https://github.com/${REPO}/blob/main/LICENSE
ShortDescription: ${JSON.stringify('A self-hosted game library for your household, in its own window.')}
Description: ${JSON.stringify(description)}
Moniker: game-sauce
Tags:
  - games
  - roms
  - retro
  - emulation
  - self-hosted
ReleaseNotesUrl: https://github.com/${REPO}/releases/tag/v${version}
ManifestType: defaultLocale
ManifestVersion: 1.6.0
`);

// Scoop: the portable download (unpack and run; nothing is installed, and the library lives outside the folder)
out('install/packages/scoop/game-sauce.json', JSON.stringify({
  version,
  description: 'A self-hosted game library for your household (portable: unpack and start).',
  homepage: `https://github.com/${REPO}`,
  license: 'MIT',
  notes: 'Start it from the Start menu (game-sauce), or run "Start game-sauce.bat" in the app folder. Your library and accounts are kept in "game-sauce-data" in your home folder, so updating loses nothing.',
  architecture: { '64bit': { url: `${base}/${files.zip}`, hash: need(files.zip), extract_dir: `game-sauce-v${version}-windows-x64` } },
  shortcuts: [['Start game-sauce.bat', 'game-sauce'], ['Start game-sauce (share on my network).bat', 'game-sauce (share on my network)']],
  checkver: 'github',
  autoupdate: {
    architecture: { '64bit': { url: `https://github.com/${REPO}/releases/download/v$version/game-sauce-v$version-windows-x64.zip`, extract_dir: 'game-sauce-v$version-windows-x64' } },
    hash: { url: `https://github.com/${REPO}/releases/download/v$version/SHA256SUMS`, regex: '$sha256\\s+\\*?$basename' }
  }
}, null, 2) + '\n');

// Homebrew: the desktop app for Apple Silicon. The app is not signed or notarised yet, so the quarantine mark is cleared after install.
out('install/packages/homebrew/Casks/game-sauce.rb', `cask "game-sauce" do
  version "${version}"
  sha256 "${need(files.dmg)}"

  url "https://github.com/${REPO}/releases/download/v#{version}/game-sauce_#{version}_aarch64.dmg"
  name "game-sauce"
  desc "Self-hosted game library for your household, in its own window"
  homepage "https://github.com/${REPO}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64

  app "game-sauce.app"

  # Not signed or notarised yet: without this macOS refuses to open it the first time.
  postflight do
    system_command "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "#{appdir}/game-sauce.app"]
  end

  # Only the app's own settings: the library ("game-sauce-data" in the home folder) is never removed.
  zap trash: [
    "~/Library/Application Support/dev.gamesauce.desktop",
    "~/Library/Caches/dev.gamesauce.desktop",
    "~/Library/WebKit/dev.gamesauce.desktop",
  ]
end
`);
console.log(`\nDone for v${version}. See docs/PACKAGES.md for where each one goes.`);

cask "game-sauce" do
  version "0.3.0"
  sha256 "35e044a09b276645100a15c898ea2327fd859870f75a7c53b5611dda3add77ec"

  url "https://github.com/gamesauce-dev/game-sauce/releases/download/v#{version}/game-sauce_#{version}_aarch64.dmg"
  name "game-sauce"
  desc "Self-hosted game library for your household, in its own window"
  homepage "https://github.com/gamesauce-dev/game-sauce"

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

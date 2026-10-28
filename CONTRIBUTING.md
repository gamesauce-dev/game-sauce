# Contributing to game-sauce

Thanks for wanting to help. game-sauce is a small, self-hosted ROM manager for a personal or household
library, and it is kept deliberately simple: Node + Express + SQLite on the server, one static page on the
client, **no build step**. Bug reports, fixes and ideas are all welcome.

## What this project will and won't take

**Welcome:** bug fixes, tests, documentation, platform and metadata improvements, accessibility and
controller support, translations of the interface, deployment recipes (Docker, Proxmox, NAS), and
performance work on big libraries.

**Not accepted, whatever the reason:**
- ROMs, BIOS files, emulator binaries, or links to places that host them.
- Features that search for, download or share games from the internet.
- Scraping sites whose terms forbid it. Metadata comes from providers with their own API and keys.
- Anything that makes it easier to run as a public ROM site. It is meant for your own collection.
- Moving, renaming or deleting a user's files in a watched folder. Sources are read-only by design.

If you are unsure, open an issue first and ask.

## Before you start

1. **Open an issue** for anything bigger than a small fix, so we can agree on the approach.
2. Keep changes small and focused: one fix or feature per pull request.

## Running it locally

```bash
git clone https://github.com/gamesauce-dev/game-sauce.git
cd game-sauce
npm install
GAMESAUCE_ADMIN_USER=admin GAMESAUCE_ADMIN_PASSWORD=change-me-12345 npm start   # http://127.0.0.1:8080
npm run seed        # optional: a few placeholder games to look at
```

Use a throwaway data folder while developing (`GAMESAUCE_DATA_DIR` and `GAMESAUCE_STORAGE_DIR`), never
your real library. Node 20 or 22.

## Tests

```bash
npm test
```

Everything must pass before a pull request is merged; CI runs the suite on Node 20 and 22 and builds the
Docker image. Please add a test for any behaviour you add or fix. The tests start the real app on a
temporary folder, so look at an existing file such as `tests/downloadpolicy.test.js` for the pattern.

## Code style

- Plain modern JavaScript (ES modules), no TypeScript, no bundler, no front-end framework.
- Match the surrounding code: two-space indent, single quotes, semicolons.
- Keep dependencies to a minimum. Adding one needs a good reason in the pull request.
- Comments explain *why*, not what. Where something looks odd on purpose, say so.
- User-facing text is plain English and says what to do next, not just what went wrong.
- Never put secrets, personal paths, addresses or real names in code, tests, docs or screenshots.
  Screenshots use the invented demo library, never real box art.

## Security-sensitive areas

Changes to sign-in, sessions, backups and restore, the request guard (`src/lib/guard.js`) or anything
that touches files on disk get extra scrutiny and need tests. To report a vulnerability, please open a
GitHub security advisory (Security tab) rather than a public issue.

## Pull requests

- Describe what changed and why, and how you tested it.
- Add a line under **[Unreleased]** in `CHANGELOG.md`.
- Update the README or the guides in `docs/` if behaviour a user can see has changed.
- Be patient and kind in review. This is a hobby project run in spare time.

## Licence

By contributing you agree that your work is released under the project's [MIT licence](LICENSE).

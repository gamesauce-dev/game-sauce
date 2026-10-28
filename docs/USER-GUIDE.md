# game-sauce — User Guide

game-sauce is your self-hosted ROM library: it catalogues ROMs where they already
live, fetches covers and details, verifies dumps against No-Intro/Redump DATs, and
lets you download back out. This guide covers everyday use. Deployment and server
setup live in [DEPLOYMENT.md](DEPLOYMENT.md).

---

## 1. Concepts (read this once)

| Term | Meaning |
|------|---------|
| **Source** | A folder game-sauce *watches in place*. Files stay exactly where they are; the scan only records path + size + date + hashes, then fetches metadata. Best for a big collection you already organise. |
| **Add ROMs** | *Import a copy* into game-sauce (`storage/roms/…`). Your original stays put. Best for one-off additions. |
| **Platform hint** | Forces every file in a source folder to one platform. Leave on *auto* to let folder names (`PlayStation 5`, `Xbox 360`) and extensions decide. |
| **Orphan** | A catalogue row whose source folder is gone (source removed with "keep ROMs"). Still listed, can never be re-scanned → purge it. Different from **missing** (file temporarily unreachable, e.g. unplugged drive — it will re-appear on rescan). |
| **Needs match** | A ROM no provider has ever matched — the manual-identify worklist. |
| **DAT** | A No-Intro / Redump catalogue of known-good dumps. Importing one lets game-sauce verify each ROM locally and use canonical titles. |

Deleting a ROM from the library **never deletes your file** unless you explicitly
tick delete-from-disk. Imported copies in `storage/roms` *are* removed with their row.

---

## 2. First run (5 minutes)

1. Sign in with the admin account (created on first boot from env, or generated
   and printed in the server log).
2. **Sources → Add folder → Browse** to your ROM folder (or type the path),
   give it a **Name** if you like (just a label — `PS4 drive`, `NAS ROMs`),
   leave **Platform hint** on auto, **Add and scan**.
3. Wait for the scan, then open the **Library** — covers arrive as enrichment runs.
4. **Metadata → Accounts**: add TheGamesDB key and/or IGDB credentials for
   better matches (ScreenScraper needs forum-approved dev credentials; the other
   two take minutes).
5. Press **Fetch missing covers** and let it work through the library (25 per run).

---

## 3. Library

- **Sidebar:** `ALL PLATFORMS` + collapsible family headings (Nintendo, Sega,
  Sony…) with per-platform counts. Families collapse/expand; platforms filter.
- **Search** matches title, filename and genre. **★ Favourites**, **◌ Hidden**,
  **⛁ Orphans**, **○ Needs match** pills filter the grid. **☐ Select** enables
  multi-select bulk delete.
- **Cards** show cover (or title initials fallback), platform colour badge, and
  status dots. **Density** toggles comfortable/compact grid.
- **Counts** in the footer: total size, missing files, orphaned rows, ROMs still
  needing a match.

### ROM detail (click any tile)

- Cover, title, platform, region, revision, serial/version, size, hashes
  (CRC32/MD5/SHA1), file path, source, DAT verdict, genre, players, rating.
- Actions: **Identify** (manual match), **Refresh metadata**, **Favourite**,
  **Hide**, **Download**, **Delete**, **Upload cover** (custom art).
- **Identify drawer:** type a query → pick platform/provider → preview candidates
  with `art ✓` flags → **Use this** applies title + art + fields.

---

## 4. Sources (watch folders in place)

**Sources → Add folder:**

1. **Path** — type it or **Browse…** (click a folder to select it, chevron/double-click to drill in, **Use this folder** to confirm).
2. **Name (optional)** — label only. Defaults to the folder name.
3. **Platform hint** — auto-detect, or force one platform for a single-console drive. Grouped by family, A–Z.
4. **Recursive** — scan subfolders too (on by default).
5. **Add and scan** — incremental: only new/changed files are hashed.

Per-source cards show ROM count, size, missing count, last scan. Actions:
**↻ Scan**, **Disable/Enable**, **Remove** (choose keep or purge its ROM rows).

Drives that vanish are flagged **missing**, never deleted — reconnect and rescan.

---

## 5. Add ROMs (import copies)

1. **Add ROMs** → drop files (or a whole folder) in the zone.
2. Pick a platform or leave on auto-detect; untick enrichment to skip lookups.
3. game-sauce hashes each file, rejects duplicates ("duplicate of …"), and moves
   a copy to `storage/roms/<platform>/<sha1>/…`.

---

## 6. Metadata & accounts

**Metadata → Accounts** — one card per provider:

| Provider | Needs | Best for |
|----------|-------|----------|
| ScreenScraper | Dev ID + password (forum approval — required unless the server has a shared pair set up) + user + password | Retro systems, deep catalogue |
| TheGamesDB | Free API key (minutes) | Broad coverage, fast setup |
| IGDB | Twitch Client ID + Secret (minutes) | Modern systems (PS4/5, Switch, Xbox One/Series) |
| SteamGridDB | Free API key | Cover-art fallback when a match has no art |

Each card: **Save**, **Test connection** (real API call), and quota display where
the provider reports one. Credentials are encrypted at rest (AES-256-GCM); set
`GAMESAUCE_SECRET_KEY` so the key lives outside the data dir. `Test connection`
on a fresh key reports green before any lookup runs.

**Coverage panel:** totals (enriched / filename-only / never looked up / missing)
plus **Fetch missing covers** (25 per press — repeat until done) and
**Verify platform ids** (checks every ScreenScraper system id resolves).

**Platforms (admin):** full catalogue grouped by family with slug, extensions,
provider ids. Add your own system (arcade boards, homebrew targets…) — provider
ids optional. Editing/deleting takes effect immediately: the next scan and lookup
read the database. Deleting a platform that still has ROMs moves them to Other
(with a confirmation count).

---

## 7. Emulators

**Emulators** (sidebar) recommends one emulator per popular platform — NES through
PS4, handhelds, arcade — with links to the official site and download page, a
BIOS/keys warning where one is needed, and a **Check latest releases** button
that queries each project's GitHub for its newest published release (10-minute
cache; nightly-only projects say so instead of showing a version). Pick your OS
asset from the dropdown and, as an admin, **Save to vault**: the server downloads
the official release into `storage/emulators` so the installer lives alongside
your library. You can also upload an installer by hand. Anyone signed in can see
the guide and download from the vault; only admins can add or remove entries.
game-sauce never ships emulator binaries — every vault file got there by an
explicit admin action.

---

## 8. DAT verification (offline)

A `.dat` lists every known-good dump with exact size + hashes. Import one per
system (**Metadata → DAT files → Import DAT**) and game-sauce matches each ROM
by SHA1 → CRC32+size → CRC32, then:

- marks it **verified** (exact), **variant** (same hash family, different bytes — hack/translation), or **not-in-dat**
- replaces filename-guessed titles with canonical title + region + revision, unless you edited the title by hand (then it only marks the verdict; **Re-check** with *force* to override)

**Have/want:** per DAT, `Missing / Have / All` tabs show which entries you own
and which you're missing — a shopping list for your set. **Re-check** re-runs
matching after new imports; deleting a DAT keeps your titles.

---

## 8. Database maintenance (admin)

**Metadata → Database maintenance** shows library ROMs, hidden, missing files,
orphaned rows, never-enriched, imported/seed rows. **Show orphans** jumps to the
filtered library; **Delete orphans…** purges them (catalogue rows always go;
imported copies optionally; your own files never).

---

## 9. Collections, hidden, favourites

- **Collections:** group ROMs into sets ("Co-op nights"). Create from the
  Collections view, add from any ROM detail.
- **Hide** removes a tile from the default view without deleting it
  (◌ Hidden pill reveals them). Useful for duplicates, BIOS files, variants.
- **★ Favourite** pins essentials to the favourites filter.

---

## 10. Users & account (admin)

**Account → Users** (admin): create logins per person (`user` or `admin` role),
disable accounts (kills sessions), reset passwords. The last admin cannot be
removed. Every mutation is recorded in the **audit log** (who did what, when,
from where), visible on the Account view. Non-admins never see Sources, DAT
tooling, platform management, user management, or the audit log.

Change your own password from **Account**. Sessions last 30 days; sign out from
the sidebar ⏻ button.

---

## 11. Keyboard, tips & limits

- Search matches title, filename and genre — a short unique word beats a full filename with tags.
- Identify with **All platforms** first; providers disagree about which system a game belongs to.
- `○ Needs match` + **Fetch missing covers** is the loop: enrich all, then hand-match the leftovers.
- Filename tags in `(...)`/`[...]` are parsed for region/revision/serial — `!p`/`[!]` flags mark bad dumps.
- Enrichment runs serially with gaps (providers rate-limit); 25 per bulk run is deliberate.
- Covers are cached in `storage/media` — deleting the row deletes its cached art.
- DAT import cap is 512 MB (`GAMESAUCE_MAX_DAT`); parsing streams so 40 MB DATs are fine.

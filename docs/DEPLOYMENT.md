# game-sauce — Deployment Guide

Deploy game-sauce on your own hardware: Docker (recommended) or bare Node.js.
Works on Windows 11, Linux, and macOS. One service, one SQLite file, no build step.

> **TL;DR (Docker):** install Docker → copy the app folder → `cp env.example .env`
> (set admin password) → `docker compose up -d --build` → open
> `http://<server-ip>:8765` → sign in.

---

## 1. What you're deploying

- **App:** Node 22 + Express + SQLite (`better-sqlite3`)
- **Listens on:** `PORT` (default `8080`), `/api/health` for checks
- **State (must persist):**
  - `data/gamesauce.db` — the catalogue (ROM rows, users, metadata, DAT index)
  - `data/secret.key` — credential encryption key (auto-created unless
    `GAMESAUCE_SECRET_KEY` is set)
  - `storage/` — imported ROM copies, cached covers/media, uploaded DATs
- **Your ROM folders are never modified.** Sources are scanned in place
  (path + hashes recorded). Only `Add ROMs` imports copies into `storage/roms`.

---

## 2. Prerequisites

| Need | Windows | Linux / macOS |
|------|---------|---------------|
| Docker (option A) | [Docker Desktop](https://www.docker.com/products/docker-desktop/) (WSL2 backend) | Docker Engine + Compose plugin (`docker compose version` should print a version) |
| Node (option B only) | Node 20+ LTS from nodejs.org | Node 20+ via package manager or nodejs.org |
| Ports | Allow `8080` inbound on the server's firewall if other devices should reach it | Same (`ufw allow 8080` on Ubuntu) |
| Disk | Space for `storage/` if you use Add ROMs imports | Same |

Check:

```bash
docker --version && docker compose version   # option A
node --version                                # option B, want v20+
```

---

## 3. Option A — Docker (recommended)

Use this for "another PC / server". The image builds locally — no registry needed.

### 3.1 Copy the folder

Copy the **whole `game-sauce` folder** to the target machine, **excluding**:

- `node_modules/` (rebuilt in the image)
- `data/` (your dev database — start fresh on the server)
- `storage/` (your dev imports/covers — start fresh)

What **must** be present: `Dockerfile`, `docker-compose.yml`, `package.json`,
`package-lock.json`, `public/`, `src/`, `env.example`, `.dockerignore`.

### 3.2 Configure

```bash
cd game-sauce
cp env.example .env        # Windows (cmd):  copy env.example .env
```

Edit `.env` — minimum:

```dotenv
GAMESAUCE_ADMIN_USER=your-name
GAMESAUCE_ADMIN_PASSWORD=at-least-10-chars-with-a-number-1
```

Recommended for production:

```dotenv
GAMESAUCE_SECRET_KEY=<output of: openssl rand -base64 32>
```

Optional providers (all can also be typed into the UI later):

```dotenv
SS_DEV_ID_SHARED=          # shared ScreenScraper dev pair (distributor use)
SS_DEV_PASSWORD_SHARED=
IGDB_CLIENT_ID=            # Twitch app, minutes to create, no approval wait
IGDB_CLIENT_SECRET=
SGDB_API_KEY=              # SteamGridDB art fallback
```

Full variable table is in README "Configuration".

### 3.3 Launch

```bash
docker compose up -d --build
docker compose ps            # want: Up … (healthy) after ~15–30 s
docker compose logs -f game-sauce
```

Open `http://<server-ip>:8765` (or `http://localhost:8765` on the server itself)
and sign in with your admin user.

### 3.4 Scan host ROM folders (read-only)

Your ROMs live on the host; the container sees them through a bind mount.
Add to `docker-compose.yml` under `volumes:`:

```yaml
    volumes:
      - gs-data:/app/data
      - gs-storage:/app/storage
      - /mnt/roms:/roms:ro          # Linux server example
      # - C:/ROMs:/roms:ro          # Windows server example (uncomment instead)
```

Then `docker compose up -d` and in the UI: **Sources → Add folder → Browse** to
`/roms/...`. The `:ro` suffix means the container physically cannot modify your
files even if asked to.

### 3.5 Updating later

```bash
# copy the new code over (same exclusions), then:
docker compose up -d --build
```

Data survives in the named volumes `gs-data` / `gs-storage`.

### 3.6 Stop / wipe

```bash
docker compose down        # stop; data survives
docker compose down -v     # DANGER: deletes the library index + storage too
```

### 3.7 Troubleshooting

- `docker compose logs game-sauce` tells you why (bad env value, port in use, out of disk).
  Common fix: `docker compose down && docker compose up -d --build`.
- Port already in use: set `HOST_PORT=8087` in `.env` (default 8765) and open that port.
- Login fails after moving `.env`: the admin is created **once** on first boot.
  Changing the password in `.env` later does nothing — change it in
  Account, or delete the `gs-data` volume to start over.
- Slow first scan: rescans are incremental (only new/changed files are hashed).
- Behind HTTPS reverse proxy (Caddy/Nginx/Traefik): also set
  `GAMESAUCE_COOKIE_SECURE=1` + `GAMESAUCE_TRUST_PROXY=1` and forward
  `X-Forwarded-Proto`.

---

## 4. Option B — bare Node (no Docker)

Good for a personal Windows 11 box where Docker feels heavy.

**Windows (PowerShell):**

```powershell
node --version            # want v20+
cd game-sauce
npm ci --omit=dev
$env:GAMESAUCE_ADMIN_USER="your-name"
$env:GAMESAUCE_ADMIN_PASSWORD="at-least-10-chars-with-a-number-1"
npm start                 # http://127.0.0.1:8080
```

**Linux / macOS:**

```bash
node --version
cd game-sauce
npm ci --omit=dev
export GAMESAUCE_ADMIN_USER=your-name
export GAMESAUCE_ADMIN_PASSWORD=at-least-10-chars-with-a-number-1
npm start
```

Persistent env vars: put them in `.env` (loaded automatically), a systemd unit,
Task Scheduler, or launchd — see README. To run on boot: Windows → Task Scheduler
or NSSM; Linux → a systemd unit; macOS → launchd.

---

## 5. Backup

Back up these two things and you can rebuild everything else:

1. `data/` — `gamesauce.db` (+ `secret.key` if you didn't set `GAMESAUCE_SECRET_KEY`)
2. `storage/` — only if you used Add ROMs imports (in-place sources don't need it)

```bash
# Docker volumes:
docker compose stop
docker run --rm -v gs-data:/d -v "$PWD/backup:/b" alpine tar czf /b/gs-data.tar.gz -C /d .
docker run --rm -v gs-storage:/s -v "$PWD/backup:/b" alpine tar czf /b/gs-storage.tar.gz -C /s .
docker compose start
```

---

## 6. Security checklist (do before exposing beyond your LAN)

- [ ] Strong unique admin password (min 10 chars, letter + number enforced)
- [ ] `GAMESAUCE_SECRET_KEY` set to a random 32-byte value
- [ ] HTTPS via reverse proxy + `GAMESAUCE_COOKIE_SECURE=1`
- [ ] Bind mounts to ROM folders use `:ro`
- [ ] `data/` backups are private (they hold password/token hashes)
- [ ] Non-admin users created per person (Account → Users); never share the admin

---

## 7. Configuration reference

See README "Configuration" for the full env table (`PORT`, `HOST`,
`GAMESAUCE_DATA_DIR`, `GAMESAUCE_STORAGE_DIR`, `GAMESAUCE_SECRET_KEY`,
`SS_*`, `IGDB_*`, `SGDB_API_KEY`, `GAMESAUCE_MAX_DAT`, proxy flags).

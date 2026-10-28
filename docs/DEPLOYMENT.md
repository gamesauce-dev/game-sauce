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

### 3.4a Use the prebuilt image (no building on the server)

Every push to `main` publishes an image to GitHub's registry, so the server does not need
the source or a build step. Create a folder with just a `docker-compose.yml` and a `.env`
(copy `env.example`), and replace the `build:` line of the service with:

```yaml
    image: ghcr.io/gamesauce-dev/game-sauce:latest
```

Then `docker compose pull && docker compose up -d`. To update later, run the same two
commands. Pin a version instead of `latest` (for example `:v0.1.1`) if you want updates to
be deliberate. The image is multi-architecture: `linux/amd64` (typical PCs, servers and Proxmox VMs) and
`linux/arm64` (Raspberry Pi 4/5, Apple-silicon and other ARM servers); Docker picks the right one
automatically. The ARM build is produced by CI but has had little testing on real ARM hardware, so
please report anything odd.

#### Already have a Docker LXC or VM (arr-stack style)?

Use the ready-made compose file; it needs no source and no build:

```bash
mkdir -p ~/game-sauce && cd ~/game-sauce
curl -fsSLo docker-compose.yml https://raw.githubusercontent.com/gamesauce-dev/game-sauce/main/install/docker-compose.ghcr.yml
nano docker-compose.yml        # set GAMESAUCE_ADMIN_PASSWORD (10+ characters, with a number)
docker compose up -d           # then open http://<host-ip>:8765
```

To scan ROMs, bind-mount the folder read-only (uncomment the `/mnt/roms:/roms:ro` line); the
path on the left must already exist inside that LXC/VM. Update with
`docker compose pull && docker compose up -d`.

### 3.5a Running on Proxmox

- **Use a VM (simplest).** A small Debian or Ubuntu VM with Docker Engine behaves like any
  Linux server, so every step above works unchanged. Avoid installing Docker on the Proxmox
  host itself.
- **LXC works with options.** In the container's *Options → Features*, enable **nesting**
  (and **keyctl**). Without them Docker commonly fails with cgroup or permission errors.
  Unprivileged LXCs are the most fragile; a privileged one is easier but less isolated.
- **One-command install (no Docker, recommended on Proxmox).** Read the script first if you like. On the Proxmox node, as root:
  `bash -c "$(curl -fsSL https://raw.githubusercontent.com/gamesauce-dev/game-sauce/main/install/proxmox-lxc.sh)"`
  creates an unprivileged Debian 12 container, installs Node 22, generates an admin password
  and runs game-sauce as a systemd service. Options (CTID, RAM, DISK, STORAGE, BRIDGE, APP_PORT,
  ROMS) are listed at the top of the script. Update later with `pct exec <id> -- /usr/local/bin/game-sauce-update`.
- **ROM folders.** The guest can only mount paths it can see. Share the ROM folder into the
  VM or container (NFS/SMB mount, or a Proxmox bind mount for LXC), then map that path in the
  `volumes:` block of `docker-compose.yml` as read-only (see 3.4).
- **Persistence.** Keep the `gs-data` and `gs-storage` Docker volumes (or the folders you
  bind-mount in their place) inside the guest's backed-up disk — they hold the database and
  imported files.

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

### 5.1 Built-in backups (Settings → Backups, admin only)

- **Download a backup now:** one `.tar.gz` straight to your browser.
- **Scheduled backups:** pick off / 6 h / 12 h / daily / weekly, how many to keep, and a folder on
  the server (default `data/backups`; `GAMESAUCE_BACKUP_DIR` changes the default). Point it at a NAS
  mount or a second disk, because a backup beside the database does not survive losing the disk.
- **What is inside:** a consistent copy of the database (taken safely while the app runs), the
  encryption key `secret.key`, every player's save states, and a `manifest.json`.
- **What is not:** imported ROMs (`storage/roms`), covers and media. Back up `storage/` separately if you
  use Add ROMs imports; scanned folders are never touched. Covers can be re-fetched.
- **Handle with care:** it holds password hashes and the key that protects your provider credentials.
  If you set `GAMESAUCE_SECRET_KEY`, the key is *not* in the archive. Keep that value somewhere safe.

### 5.2 Restoring

**In the app (Settings → Backups → Restore from a backup, admin only):**

1. Click **Restore…** next to a backup in the server list, or upload a backup file and click **Check this backup**. It is unpacked into a holding area and
   verified (archive, manifest, database integrity, schema version, an admin account exists).
   You see what is inside next to what is on the server now. **Nothing changes yet.**
2. Type `RESTORE` and confirm. A **safety backup** of the current data is saved to the backup
   folder first.
3. The server exits and starts again; before the database opens, the swap happens. The data being
   replaced is moved to `data/pre-restore-<time>/` (database, key and saves), not deleted. If the
   swap fails part-way the previous files are put back.
4. Everyone signs in again (sessions are not restored).

The restart needs a supervisor that starts the process again: **systemd** (the Proxmox installer
sets this up, with `Restart=on-failure`), **Docker** (`restart: unless-stopped`), or
`GAMESAUCE_RESTART=exit` under another supervisor. With none of these the page tells you to restart
game-sauce yourself to finish. A pending restore is applied on the next start either way.
Backups from a newer game-sauce than the server are refused; older ones are upgraded on start.
`GAMESAUCE_MAX_RESTORE` (default 2 GB) caps the upload.

To undo a restore, stop game-sauce and copy the files from `data/pre-restore-<time>/` back (or
restore the safety backup the same way).

**By hand** (if the app will not start): stop game-sauce first, so nothing writes while you replace files.

```bash
# 1. Unpack somewhere temporary and look at manifest.json
mkdir /tmp/gs-restore && tar -xzf game-sauce-backup-XXXX.tar.gz -C /tmp/gs-restore
cat /tmp/gs-restore/manifest.json

# 2. Native / Proxmox LXC install (data in /var/lib/game-sauce):
systemctl stop game-sauce
mv /var/lib/game-sauce/data /var/lib/game-sauce/data.old
mkdir -p /var/lib/game-sauce/data /var/lib/game-sauce/storage/saves
cp /tmp/gs-restore/gamesauce.db /tmp/gs-restore/secret.key /var/lib/game-sauce/data/
cp -r /tmp/gs-restore/saves/. /var/lib/game-sauce/storage/saves/ 2>/dev/null || true
chown -R gamesauce:gamesauce /var/lib/game-sauce
systemctl start game-sauce
```

For Docker, do the same with the `gs-data` and `gs-storage` volumes (stop the container, copy
`gamesauce.db` and `secret.key` into the data volume, and the `saves/` folder into the storage
volume, then start it). A backup from an *older* version is upgraded automatically on start; one from a
*newer* version than the app cannot be used, so update the app first.

Everyone has to sign in again after a restore (sessions are not part of a backup).

### 5.3 Copying the folders yourself

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

game-sauce is meant for a personal or household library. The safest setup is to keep it on your home
network and reach it from outside through a **VPN** (WireGuard, Tailscale and similar) instead of
forwarding a port to the internet. It is not designed to be a public site.

- [ ] Strong unique admin password (min 10 chars, letter + number enforced)
- [ ] `GAMESAUCE_SECRET_KEY` set to a random 32-byte value
- [ ] HTTPS via reverse proxy + `GAMESAUCE_COOKIE_SECURE=1`
- [ ] Bind mounts to ROM folders use `:ro`
- [ ] `data/` backups are private (they hold password/token hashes)
- [ ] Non-admin users created per person (Settings → User accounts); never share the admin
- [ ] Behind a reverse proxy: set `GAMESAUCE_TRUST_PROXY=1` (and `GAMESAUCE_ALLOWED_ORIGINS=https://your.address` if changes are refused with "Blocked: this request came from a different address")
- [ ] Check **Settings → Health** after install and after changes: it flags a nearly full disk, an unplugged source folder, and missing or failed backups
- [ ] Leave **Let members download ROM files** off unless you really want members to copy files
- [ ] Forgotten password? Settings → User accounts → **Reset password** (the user is signed out everywhere)

---

## 7. Configuration reference

See README "Configuration" for the full env table (`PORT`, `HOST`,
`GAMESAUCE_DATA_DIR`, `GAMESAUCE_STORAGE_DIR`, `GAMESAUCE_SECRET_KEY`,
`SS_*`, `IGDB_*`, `SGDB_API_KEY`, `GAMESAUCE_MAX_DAT`, proxy flags).

#!/usr/bin/env bash
# game-sauce — Proxmox VE LXC installer
#
# Run as root on a Proxmox VE node:
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/gamesauce-dev/game-sauce/main/install/proxmox-lxc.sh)"
#
# Creates a small unprivileged Debian 12 container, installs Node 22, clones the app,
# generates an admin password and runs it as a systemd service (no Docker needed).
#
# Everything has a default; override any of these by putting it in front of the command:
#   CTID=120 CT_NAME=game-sauce CORES=2 RAM=1024 DISK=8 STORAGE=local-lvm BRIDGE=vmbr0
#   TEMPLATE_STORAGE=local APP_PORT=8765 ROMS=/mnt/pve/nas/roms GS_BRANCH=main YES=1
# ROMS (optional) bind-mounts a host folder read-only at /roms inside the container.
set -Eeuo pipefail

GS_REPO="${GS_REPO:-https://github.com/gamesauce-dev/game-sauce.git}"
GS_BRANCH="${GS_BRANCH:-main}"
CT_NAME="${CT_NAME:-game-sauce}"
CORES="${CORES:-2}"
RAM="${RAM:-1024}"
DISK="${DISK:-8}"
BRIDGE="${BRIDGE:-vmbr0}"
APP_PORT="${APP_PORT:-8765}"
TEMPLATE_STORAGE="${TEMPLATE_STORAGE:-local}"
ROMS="${ROMS:-}"
YES="${YES:-0}"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_dim=$'\e[2m'; c_off=$'\e[0m'
info() { printf '%s•%s %s\n' "$c_dim" "$c_off" "$*"; }
ok()   { printf '%s✔%s %s\n' "$c_ok" "$c_off" "$*"; }
warn() { printf '%s!%s %s\n' "$c_warn" "$c_off" "$*"; }
die()  { printf '%s✖ %s%s\n' "$c_err" "$*" "$c_off" >&2; exit 1; }

CREATED=0
cleanup_on_error() {
  local code=$?
  if [ "$CREATED" = 1 ] && [ -n "${CTID:-}" ]; then
    warn "Install failed. The container ($CTID) was left in place so you can inspect it:"
    warn "  pct enter $CTID      # then: journalctl -u game-sauce --no-pager | tail"
    warn "  pct stop $CTID && pct destroy $CTID   # to throw it away"
  fi
  exit "$code"
}
trap cleanup_on_error ERR

# ── preflight ────────────────────────────────────────────────────────────────
[ "$(id -u)" = 0 ] || die "Run this as root on the Proxmox node."
command -v pct >/dev/null && command -v pveam >/dev/null && command -v pvesm >/dev/null \
  || die "pct/pveam/pvesm not found — this must run on a Proxmox VE node (not inside a VM or container)."
[[ "$APP_PORT" =~ ^[0-9]+$ ]] && [ "$APP_PORT" -ge 1024 ] && [ "$APP_PORT" -le 65535 ] || die "APP_PORT must be 1024-65535."
[[ "$DISK" =~ ^[0-9]+$ ]] || die "DISK is a number of GB."
if [ -n "$ROMS" ]; then [ -d "$ROMS" ] || die "ROMS folder not found on this node: $ROMS"; fi

CTID="${CTID:-$(pvesh get /cluster/nextid)}"
pct status "$CTID" >/dev/null 2>&1 && die "Container ID $CTID already exists. Choose another: CTID=…"

if [ -z "${STORAGE:-}" ]; then
  # Prefer the usual container-capable defaults, else the first active rootdir storage.
  mapfile -t stores < <(pvesm status --content rootdir 2>/dev/null | awk 'NR>1 && $3=="active"{print $1}')
  [ "${#stores[@]}" -gt 0 ] || die "No active storage that can hold containers (content type 'rootdir'). Set STORAGE=…"
  STORAGE="${stores[0]}"
  for pref in local-lvm local-zfs; do
    for s in "${stores[@]}"; do [ "$s" = "$pref" ] && STORAGE="$s"; done
  done
fi

# Admin password: 16 random alphanumerics plus a digit suffix (the app wants 10+ chars with a number).
ADMIN_PASS="$(openssl rand -base64 36 | tr -dc 'A-Za-z0-9' | head -c 16)7"

cat <<EOF

  game-sauce → new Proxmox container
  ──────────────────────────────────────────
  Container ID   $CTID  ($CT_NAME)
  Resources      $CORES cores · ${RAM} MB RAM · ${DISK} GB disk on '$STORAGE'
  Network        bridge $BRIDGE, DHCP  ·  web port $APP_PORT
  OS             Debian 12 (unprivileged), Node 22, systemd service
  Source         $GS_REPO ($GS_BRANCH)
  ROM folder     ${ROMS:-none (add a mount later, see docs)}

EOF
if [ "$YES" != 1 ]; then
  if [ -r /dev/tty ]; then
    read -r -p "Create it? [Y/n] " reply </dev/tty
    case "${reply:-Y}" in [Yy]*) ;; *) die "Cancelled." ;; esac
  else
    die "No terminal to ask on. Re-run with YES=1 to proceed."
  fi
fi

# ── template ─────────────────────────────────────────────────────────────────
info "Looking for a Debian 12 template…"
pveam update >/dev/null 2>&1 || warn "Could not refresh the template list (offline?); using what is cached."
TEMPLATE="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/{print $2}' | sort -V | tail -n1)"
[ -n "$TEMPLATE" ] || TEMPLATE="$(pveam list "$TEMPLATE_STORAGE" 2>/dev/null | awk '/debian-12-standard/{print $1}' | sed 's|.*/||' | sort -V | tail -n1)"
[ -n "$TEMPLATE" ] || die "No Debian 12 template found. Download one in the Proxmox UI (CT Templates) and re-run."
if ! pveam list "$TEMPLATE_STORAGE" 2>/dev/null | grep -q "$TEMPLATE"; then
  info "Downloading $TEMPLATE to '$TEMPLATE_STORAGE'…"
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE" >/dev/null
fi
ok "Template ready: $TEMPLATE"

# ── container ────────────────────────────────────────────────────────────────
mp_args=()
[ -n "$ROMS" ] && mp_args=(--mp0 "$ROMS,mp=/roms,ro=1")

info "Creating container $CTID…"
pct create "$CTID" "$TEMPLATE_STORAGE:vztmpl/$TEMPLATE" \
  --hostname "$CT_NAME" --ostype debian \
  --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --unprivileged 1 --features nesting=1 --onboot 1 \
  --description "game-sauce ROM manager (installed by install/proxmox-lxc.sh)" \
  "${mp_args[@]}" >/dev/null
CREATED=1
pct start "$CTID"
ok "Container started"

info "Waiting for the network…"
for i in $(seq 1 40); do
  if pct exec "$CTID" -- getent hosts github.com >/dev/null 2>&1; then break; fi
  [ "$i" = 40 ] && die "The container has no internet/DNS. Check the bridge '$BRIDGE' has DHCP and a route out."
  sleep 2
done
ok "Network is up"

# ── install inside the container ─────────────────────────────────────────────
INSTALL="$(mktemp)"
cat >"$INSTALL" <<'INNER'
#!/usr/bin/env bash
set -Eeuo pipefail
export DEBIAN_FRONTEND=noninteractive

echo "• Installing packages…"
apt-get update -qq
apt-get install -y -qq curl git ca-certificates gnupg openssl python3 make g++ >/dev/null

echo "• Installing Node 22…"
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs >/dev/null

id gamesauce >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/game-sauce --shell /usr/sbin/nologin gamesauce
mkdir -p /var/lib/game-sauce/data /var/lib/game-sauce/storage

echo "• Fetching game-sauce ($GS_BRANCH)…"
rm -rf /opt/game-sauce
git clone --quiet --depth 1 --branch "$GS_BRANCH" "$GS_REPO" /opt/game-sauce
chown -R gamesauce:gamesauce /opt/game-sauce /var/lib/game-sauce

echo "• Installing dependencies (compiles the SQLite module if needed)…"
cd /opt/game-sauce
runuser -u gamesauce -- npm ci --omit=dev --no-audit --no-fund >/dev/null

cat >/etc/game-sauce.env <<ENV
NODE_ENV=production
HOST=0.0.0.0
PORT=$APP_PORT
GAMESAUCE_DATA_DIR=/var/lib/game-sauce/data
GAMESAUCE_STORAGE_DIR=/var/lib/game-sauce/storage
GAMESAUCE_ADMIN_USER=admin
GAMESAUCE_ADMIN_PASSWORD=$ADMIN_PASS
ENV
chmod 600 /etc/game-sauce.env

cat >/etc/systemd/system/game-sauce.service <<'UNIT'
[Unit]
Description=game-sauce ROM manager
After=network-online.target
Wants=network-online.target

[Service]
User=gamesauce
Group=gamesauce
WorkingDirectory=/opt/game-sauce
EnvironmentFile=/etc/game-sauce.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT

cat >/usr/local/bin/game-sauce-update <<'UPD'
#!/usr/bin/env bash
# Pull the latest game-sauce and restart. Your data (/var/lib/game-sauce) is untouched.
set -Eeuo pipefail
cd /opt/game-sauce
runuser -u gamesauce -- git pull --ff-only
runuser -u gamesauce -- npm ci --omit=dev --no-audit --no-fund
systemctl restart game-sauce
echo "game-sauce updated and restarted."
UPD
chmod +x /usr/local/bin/game-sauce-update

systemctl daemon-reload
systemctl enable --now game-sauce >/dev/null 2>&1

echo "• Waiting for game-sauce to answer…"
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1; then echo "READY"; exit 0; fi
  sleep 2
done
echo "game-sauce did not become healthy; last log lines:" >&2
journalctl -u game-sauce --no-pager -n 25 >&2
exit 1
INNER

pct push "$CTID" "$INSTALL" /root/gs-install.sh --perms 0755 >/dev/null
rm -f "$INSTALL"
info "Installing inside the container (this takes a few minutes)…"
pct exec "$CTID" -- env GS_REPO="$GS_REPO" GS_BRANCH="$GS_BRANCH" APP_PORT="$APP_PORT" ADMIN_PASS="$ADMIN_PASS" bash /root/gs-install.sh
pct exec "$CTID" -- rm -f /root/gs-install.sh

IP="$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}')"
trap - ERR

cat <<EOF

${c_ok}✔ game-sauce is running${c_off}

  Open        http://${IP:-<container-ip>}:$APP_PORT
  Username    admin
  Password    $ADMIN_PASS
              (also stored in /etc/game-sauce.env inside the container — change it after signing in)

  Container   pct enter $CTID   (opens a root shell, no password needed)
              Proxmox's Console tab shows a "login:" prompt: that is normal. The container has no root
              password on purpose, so use "pct enter $CTID" from this node instead.
  Logs        pct exec $CTID -- journalctl -u game-sauce -f
  Update      pct exec $CTID -- /usr/local/bin/game-sauce-update
  Data        /var/lib/game-sauce  (database + imported files — back this up)
  ROMs        ${ROMS:+mounted read-only at /roms — add it as a Source in the UI}${ROMS:-not mounted. Add one with: pct set $CTID -mp0 /host/path,mp=/roms,ro=1  then  pct reboot $CTID}

EOF

#!/usr/bin/env bash
#
# Ludo Master 3D — one-command update for a LIVE server.
#
# Usage (on your server, as root):
#   1. Upload the new tarball:  scp ludo-deploy.tar.gz root@YOUR_SERVER:/opt/
#   2. Run:  sudo /opt/update-ludo.sh
#
# Does: backs up current install -> extracts new package -> re-runs the
# idempotent setup (migrations are IF NOT EXISTS, so old data is safe) ->
# restarts the game service. Rollback: /opt/ludo-backup-<date> is kept.
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo $0" >&2
  exit 1
fi

TARBALL="/opt/ludo-deploy.tar.gz"
if [[ ! -f "$TARBALL" ]]; then
  echo "Tarball not found at $TARBALL — upload it first (scp)." >&2
  exit 1
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
if [[ -d /opt/ludo ]]; then
  echo "==> Backing up current install to /opt/ludo-backup-$STAMP"
  cp -a /opt/ludo "/opt/ludo-backup-$STAMP"
fi

echo "==> Extracting new package"
mkdir -p /tmp/ludo-update
tar -xzf "$TARBALL" -C /tmp/ludo-update
PKG="$(find /tmp/ludo-update -maxdepth 2 -name setup-server.sh -path '*deploy*' | head -1 | xargs dirname | xargs dirname)"

# Keep the live .env (DB password, JWT secret, admin emails) across updates.
if [[ -f /opt/ludo/server/.env ]]; then
  echo "==> Preserving live .env"
  cp /opt/ludo/server/.env "$PKG/server/.env"
fi

echo "==> Installing new version"
rm -rf /opt/ludo
mv "$PKG" /opt/ludo
rm -rf /tmp/ludo-update

echo "==> Re-running setup (migrations are safe to re-apply)"
cd /opt/ludo
DOMAIN="$(grep -oP '(?<=server_name ).*?(?=;)' /etc/nginx/sites-enabled/ludo 2>/dev/null | head -1 || true)"
./deploy/setup-server.sh "${DOMAIN:-localhost}"

echo "==> Restarting game service"
systemctl restart ludo
systemctl --no-pager --lines=3 status ludo | head -8

echo ""
echo "✅ Update complete. Backup kept at /opt/ludo-backup-$STAMP"
echo "   Rollback: sudo rm -rf /opt/ludo && sudo mv /opt/ludo-backup-$STAMP /opt/ludo && sudo systemctl restart ludo"

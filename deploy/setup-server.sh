#!/usr/bin/env bash
#
# Ludo Master 3D — Ubuntu server setup (one-shot).
# Run from the extracted deploy package root:
#     sudo ./deploy/setup-server.sh YOUR_DOMAIN_OR_IP
#
# Does: Node 20 + PostgreSQL + nginx install, DB + user creation,
# .env generation, migrations, static client publish, systemd + nginx wiring.
# Safe to re-run (idempotent where it matters).
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo $0 YOUR_DOMAIN_OR_IP" >&2
  exit 1
fi

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo $0 YOUR_DOMAIN_OR_IP   (domain name or public IP)" >&2
  exit 1
fi

PKG_DIR="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> Package dir: $PKG_DIR"
echo "==> Public address: $DOMAIN"

# ---------------------------------------------------------------- 1. Packages
echo "==> [1/7] Installing Node.js 20, PostgreSQL, nginx..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg postgresql nginx > /dev/null
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null
  apt-get install -y -qq nodejs > /dev/null
fi
echo "    node $(node -v), psql $(psql --version | awk '{print $3}'), nginx $(nginx -v 2>&1 | awk -F/ '{print $2}')"

# ------------------------------------------------------- 2. System user + dirs
echo "==> [2/7] Creating ludo user and directories..."
id -u ludo >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin ludo
mkdir -p /opt/ludo /var/www/ludo
cp -r "$PKG_DIR/server" "$PKG_DIR/shared" /opt/ludo/
cp -r "$PKG_DIR/client/." /var/www/ludo/
# config.js auto-uses same-origin on non-localhost hosts — no rewrite needed.
chown -R ludo:ludo /opt/ludo
chown -R www-data:www-data /var/www/ludo
echo "    client published (config.js auto-points at this server)"

# ------------------------------------------------------- 3. Node dependencies
echo "==> [3/7] Installing server dependencies..."
cd /opt/ludo/server
sudo -u ludo npm install --omit=dev --no-audit --no-fund > /dev/null
echo "    done"

# ------------------------------------------------------- 4. Database
echo "==> [4/7] Setting up PostgreSQL..."
systemctl enable --now postgresql > /dev/null
DB_PASS="$(openssl rand -hex 16)"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<EOF > /dev/null
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ludo') THEN
    CREATE ROLE ludo LOGIN PASSWORD '$DB_PASS';
  ELSE
    ALTER ROLE ludo LOGIN PASSWORD '$DB_PASS';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE ludo OWNER ludo'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'ludo')\gexec
EOF
JWT_SECRET="$(openssl rand -hex 32)"
cat > /opt/ludo/server/.env <<EOF
PORT=3000
JWT_SECRET=$JWT_SECRET
DATABASE_URL=postgres://ludo:$DB_PASS@localhost:5432/ludo
EOF
chmod 600 /opt/ludo/server/.env
chown ludo:ludo /opt/ludo/server/.env
export DATABASE_URL="postgres://ludo:$DB_PASS@localhost:5432/ludo"
psql "$DATABASE_URL" -f /opt/ludo/server/migrations.sql > /dev/null
echo "    database 'ludo' ready, migrations applied"

# ------------------------------------------------------- 5. systemd service
echo "==> [5/7] Installing systemd service..."
cp "$PKG_DIR/deploy/ludo.service" /etc/systemd/system/ludo.service
systemctl daemon-reload
systemctl enable --now ludo
sleep 2
if systemctl is-active --quiet ludo; then
  echo "    ludo service running"
else
  echo "    ERROR: ludo service failed to start — see: journalctl -u ludo -e" >&2
  exit 1
fi

# ------------------------------------------------------- 6. nginx
echo "==> [6/7] Configuring nginx..."
sed "s/YOUR_DOMAIN_OR_IP/$DOMAIN/g" "$PKG_DIR/deploy/nginx-ludo.conf" > /etc/nginx/sites-available/ludo
ln -sf /etc/nginx/sites-available/ludo /etc/nginx/sites-enabled/ludo
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "    nginx serving http://$DOMAIN"

# ------------------------------------------------------- 7. Verify
echo "==> [7/7] Verifying..."
sleep 1
if curl -sf http://127.0.0.1:3000/api/health | grep -q '"ok":true'; then
  echo "    API health: OK"
else
  echo "    WARNING: API health check failed — see: journalctl -u ludo -e" >&2
fi

echo
echo "================================================================"
echo " Done! Your Ludo game is live at:  http://$DOMAIN"
echo
echo " Test it now:"
echo "   1. Open http://$DOMAIN in your phone/browser"
echo "   2. Sign up -> you start with 5410 virtual coins"
echo "   3. Join a 2-player room -> a computer opponent joins in ~20s"
echo
echo " Useful commands:"
echo "   sudo journalctl -u ludo -f      # live server logs"
echo "   sudo systemctl restart ludo     # restart after changes"
echo
echo " Optional next step: free HTTPS with Let's Encrypt:"
echo "   sudo apt install certbot python3-certbot-nginx -y"
echo "   sudo certbot --nginx -d $DOMAIN"
echo "   (then change http://$DOMAIN to https://$DOMAIN in"
echo "    /var/www/ludo/js/config.js)"
echo "================================================================"
echo " NOTE: virtual coins only — no real money, no cash-out anywhere."

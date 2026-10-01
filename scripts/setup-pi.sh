#!/bin/bash
# One-shot setup for aniwatch on a Raspberry Pi (64-bit Raspberry Pi OS / Debian),
# built to sit next to the vensin.dev portfolio setup (same Caddy, same DNS at Vercel).
#
#   - Node 22+ (NodeSource 24 if missing)
#   - app in ~/aniwatch (git pull if it is a repo, otherwise the folder you copied over)
#   - env in /etc/aniwatch.env, data (sqlite) in /var/lib/aniwatch
#   - systemd service "aniwatch" on PORT (default 3100)
#   - Caddy site block for DOMAIN (default aniwatch.vensin.dev) via /etc/caddy/sites/*.caddy,
#     imported from the main Caddyfile without touching the existing vensin.dev block
#   - cron job that keeps the A-record for the subdomain at Vercel DNS on the home IP
#
# Run as your normal user (not root), it uses sudo where needed:
#   bash scripts/setup-pi.sh
# Re-running is safe: it pulls, rebuilds and restarts instead of reinstalling.
#
# Optional env vars:
#   REPO           github repo to clone (default vxnsin/aniwatch); ignored if APP_DIR already has the app
#   GITHUB_TOKEN   token with repo access for a private repo
#   DOMAIN         default aniwatch.vensin.dev
#   APP_DIR        default $HOME/aniwatch
#   PORT           default 3100
set -euo pipefail

REPO="${REPO:-vxnsin/aniwatch}"
DOMAIN="${DOMAIN:-aniwatch.vensin.dev}"
APP_DIR="${APP_DIR:-$HOME/aniwatch}"
DATA_DIR="${DATA_DIR:-/var/lib/aniwatch}"
PORT="${PORT:-3100}"
ENV_FILE=/etc/aniwatch.env
SERVICE=aniwatch
USER_NAME="$(id -un)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$EUID" -eq 0 ]; then
  echo "Bitte als normaler Benutzer ausfuehren, nicht als root (das Script nutzt sudo)."; exit 1
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- packages
say "System-Pakete"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

# ---------------------------------------------------------------- node
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  MINOR="$(node -p 'process.versions.node.split(".")[1]')"
  # node:sqlite needs 22.13+
  if [ "$MAJOR" -gt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -ge 13 ]; }; then NEED_NODE=0; fi
fi
if [ "$NEED_NODE" -eq 1 ]; then
  say "Node 24 (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
say "Node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------- caddy
if ! command -v caddy >/dev/null 2>&1; then
  say "Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi

# ---------------------------------------------------------------- data dir
say "Datenverzeichnis $DATA_DIR"
sudo mkdir -p "$DATA_DIR"
sudo chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"

# ---------------------------------------------------------------- app
if [ -d "$APP_DIR/.git" ]; then
  say "Repo aktualisieren ($APP_DIR)"
  git -C "$APP_DIR" pull --ff-only
elif [ -f "$APP_DIR/package.json" ]; then
  say "App-Ordner gefunden ($APP_DIR, kein git) – wird so verwendet"
elif [ -f "$SCRIPT_DIR/../package.json" ] && [ "$(cd "$SCRIPT_DIR/.." && pwd)" != "$APP_DIR" ]; then
  say "App aus $(cd "$SCRIPT_DIR/.." && pwd) nach $APP_DIR kopieren"
  mkdir -p "$APP_DIR"
  rsync -a --exclude node_modules --exclude dist --exclude data --exclude .env "$SCRIPT_DIR/../" "$APP_DIR/" 2>/dev/null \
    || cp -r "$SCRIPT_DIR/../." "$APP_DIR/"
else
  say "Repo klonen nach $APP_DIR"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" "$APP_DIR"
    git -C "$APP_DIR" remote set-url origin "https://github.com/${REPO}.git"
  else
    git clone "https://github.com/${REPO}.git" "$APP_DIR"
  fi
fi
# sqlite lives in /var/lib so a re-clone never loses rooms/profiles
rm -rf "$APP_DIR/data" 2>/dev/null || true
ln -sfn "$DATA_DIR" "$APP_DIR/data"

# ---------------------------------------------------------------- env file
if [ ! -f "$ENV_FILE" ]; then
  say "Env-Datei $ENV_FILE anlegen"
  {
    echo "NODE_ENV=production"
    echo "PORT=$PORT"
    echo "ALLOW_DEV=0"
    echo "# Discord Developer Portal -> deine App -> OAuth2"
    echo "DISCORD_CLIENT_ID="
    echo "DISCORD_CLIENT_SECRET="
    echo "VITE_DISCORD_CLIENT_ID="
    echo "# Vercel API token fuer den DNS-Cron (Account Settings -> Tokens); leer lassen, wenn /etc/vensin.env schon einen hat"
    echo "VERCEL_TOKEN="
    echo "VERCEL_TEAM_ID="
  } | sudo tee "$ENV_FILE" >/dev/null
  sudo chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
  ENV_CREATED=1
else
  ENV_CREATED=0
fi
# VITE_DISCORD_CLIENT_ID mirrors DISCORD_CLIENT_ID if only one was filled in
if grep -q '^DISCORD_CLIENT_ID=.\+' "$ENV_FILE" && grep -q '^VITE_DISCORD_CLIENT_ID=$' "$ENV_FILE"; then
  CID="$(grep '^DISCORD_CLIENT_ID=' "$ENV_FILE" | cut -d= -f2-)"
  sed -i "s/^VITE_DISCORD_CLIENT_ID=$/VITE_DISCORD_CLIENT_ID=$CID/" "$ENV_FILE"
fi

# ---------------------------------------------------------------- build
say "npm ci"
cd "$APP_DIR"
npm ci --no-audit --no-fund
say "vite build"
set -a; source "$ENV_FILE"; set +a
npm run build

# ---------------------------------------------------------------- systemd
say "systemd-Dienst $SERVICE"
sudo tee /etc/systemd/system/$SERVICE.service >/dev/null <<UNIT
[Unit]
Description=aniwatch ($DOMAIN)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) server/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE" >/dev/null
sudo systemctl restart "$SERVICE"

# ---------------------------------------------------------------- caddy config
# the portfolio setup writes /etc/caddy/Caddyfile for vensin.dev; we add a site file and an import line
say "Caddy: Site-Block fuer $DOMAIN"
sudo mkdir -p /etc/caddy/sites
sudo tee /etc/caddy/sites/aniwatch.caddy >/dev/null <<CADDY
$DOMAIN {
	reverse_proxy localhost:$PORT
	encode gzip zstd
}
CADDY
if [ ! -f /etc/caddy/Caddyfile ]; then
  echo "import sites/*.caddy" | sudo tee /etc/caddy/Caddyfile >/dev/null
elif ! grep -q 'import sites/\*\.caddy' /etc/caddy/Caddyfile; then
  # the import has to be the first line of the Caddyfile (global position)
  sudo sed -i '1i import sites/*.caddy\n' /etc/caddy/Caddyfile
fi
sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

# ---------------------------------------------------------------- dynamic dns
say "Dynamic-DNS fuer $DOMAIN (Vercel) + Cron"
sudo tee /usr/local/bin/aniwatch-ddns.sh >/dev/null <<'DDNS'
#!/bin/bash
# Keeps the A-record for the aniwatch subdomain at Vercel DNS pointed at the current home IP.
# Token: VERCEL_TOKEN from /etc/aniwatch.env, otherwise from /etc/vensin.env (same account).
set -e
[ -f /etc/aniwatch.env ] && source /etc/aniwatch.env
if [ -z "${VERCEL_TOKEN:-}" ] && [ -f /etc/vensin.env ]; then source /etc/vensin.env; fi
[ -n "${VERCEL_TOKEN:-}" ] || { echo "VERCEL_TOKEN fehlt (in /etc/aniwatch.env oder /etc/vensin.env)"; exit 0; }
FQDN="__DOMAIN__"
ROOT="$(echo "$FQDN" | awk -F. '{print $(NF-1)"."$NF}')"
NAME="${FQDN%.$ROOT}"
IP=$(curl -4 -fs https://ifconfig.me) || exit 0
API="https://api.vercel.com"
H="Authorization: Bearer $VERCEL_TOKEN"
Q=""; [ -n "${VERCEL_TEAM_ID:-}" ] && Q="teamId=$VERCEL_TEAM_ID"
RECORDS=$(curl -fs -H "$H" "$API/v4/domains/$ROOT/records?limit=100${Q:+&$Q}") || { echo "$(date) listing records failed (token scope / team id?)"; exit 1; }
ID=$(echo "$RECORDS" | jq -r --arg n "$NAME" '.records[] | select(.type=="A" and .name==$n) | .id' | head -1)
CUR=$(echo "$RECORDS" | jq -r --arg n "$NAME" '.records[] | select(.type=="A" and .name==$n) | .value' | head -1)
if [ -z "$ID" ]; then
  curl -fs -X POST -H "$H" -H "Content-Type: application/json" \
    -d "{\"name\":\"$NAME\",\"type\":\"A\",\"value\":\"$IP\",\"ttl\":60}" \
    "$API/v2/domains/$ROOT/records${Q:+?$Q}" >/dev/null
  echo "$(date) created $NAME -> $IP"
elif [ "$CUR" != "$IP" ]; then
  curl -fs -X PATCH -H "$H" -H "Content-Type: application/json" \
    -d "{\"value\":\"$IP\"}" "$API/v1/domains/records/$ID${Q:+?$Q}" >/dev/null
  echo "$(date) updated $NAME -> $IP"
fi
DDNS
sudo sed -i "s/__DOMAIN__/$DOMAIN/" /usr/local/bin/aniwatch-ddns.sh
sudo chmod +x /usr/local/bin/aniwatch-ddns.sh
sudo touch /var/log/aniwatch-ddns.log && sudo chown "$USER_NAME" /var/log/aniwatch-ddns.log
CRON_LINE="*/5 * * * * /usr/local/bin/aniwatch-ddns.sh >> /var/log/aniwatch-ddns.log 2>&1"
( crontab -l 2>/dev/null | grep -v aniwatch-ddns.sh || true; echo "$CRON_LINE" ) | crontab -
/usr/local/bin/aniwatch-ddns.sh || true

# ---------------------------------------------------------------- summary
PUBLIC_IP="$(curl -4 -fs https://ifconfig.me || echo '?')"
LAN_IP="$(hostname -I | awk '{print $1}')"
say "Fertig"
cat <<SUMMARY

  App:         http://$LAN_IP:$PORT  (LAN)   ->  https://$DOMAIN (sobald DNS steht)
  Dienst:      sudo systemctl status $SERVICE     Logs: journalctl -u $SERVICE -f
  Caddy:       /etc/caddy/sites/aniwatch.caddy     Logs: journalctl -u caddy -f
  Env:         $ENV_FILE  (danach: bash scripts/setup-pi.sh  oder  sudo systemctl restart $SERVICE)
  Daten:       $DATA_DIR/aniwatch.sqlite
  DDNS:        /usr/local/bin/aniwatch-ddns.sh, alle 5 min, Log /var/log/aniwatch-ddns.log

Noch zu tun:
  1. $ENV_FILE: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET (und VERCEL_TOKEN, falls /etc/vensin.env keinen hat)
     dann nochmal: bash $APP_DIR/scripts/setup-pi.sh   (baut den Client mit der Client-ID neu)
  2. Router: TCP 80 und 443 zeigen schon auf den Pi (vensin.dev) – nichts zu tun
  3. Discord Developer Portal -> Activities -> URL Mappings: Prefix /  ->  $DOMAIN
  4. Von aussen testen: https://$DOMAIN/api/info  muss JSON liefern
SUMMARY
if [ "$ENV_CREATED" -eq 1 ]; then
  echo
  echo "  Hinweis: $ENV_FILE wurde neu angelegt und ist noch leer. Erst ausfuellen, dann Script nochmal laufen lassen."
fi
if ! grep -q '^DISCORD_CLIENT_ID=.\+' "$ENV_FILE"; then
  echo "  Hinweis: DISCORD_CLIENT_ID fehlt noch – die Activity kann sich so noch nicht anmelden."
fi

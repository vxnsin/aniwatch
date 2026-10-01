#!/bin/bash
# Setup for aniwatch on a Raspberry Pi / any Debian-like box.
#
# What it does
#   - Node 22.13+ (installs Node 24 from NodeSource if missing)
#   - app in an app folder (git pull if it is a repo, otherwise the folder you copied over, otherwise clone)
#   - env file in /etc/<service>.env, sqlite data in /var/lib/<service>
#   - systemd service on the chosen port
#   - Caddy site block for the domain (automatic HTTPS) via /etc/caddy/sites/<service>.caddy,
#     imported from the main Caddyfile without touching other sites
#   - optional cron job that keeps the domain's A-record at Vercel DNS on the current public IP
#
# Interactive: the script asks for every setting and proposes a default. Press Enter to accept.
# Non-interactive: pass values as env vars and/or `--yes` to take all defaults, e.g.
#   DOMAIN=watch.example.org PORT=3100 bash setup-pi.sh --yes
#   curl -fsSL https://raw.githubusercontent.com/vxnsin/aniwatch/main/scripts/setup-pi.sh | bash
# Re-running is safe: it pulls, rebuilds and restarts instead of reinstalling.
#
# Settings (env var → question → default):
#   REPO            github repo to clone                     vxnsin/aniwatch
#   GITHUB_TOKEN    token for a private repo                 (empty)
#   DOMAIN          public domain                            aniwatch.example.org
#   APP_DIR         app folder                               $HOME/aniwatch
#   PORT            port                                     3100
#   SERVICE         systemd service / file names             aniwatch
#   DATA_DIR        sqlite folder                            /var/lib/<service>
#   SETUP_DDNS      keep DNS at Vercel updated (yes/no)      yes
#   DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET                asked once when the env file is created
set -euo pipefail

YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) YES=1 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
  esac
done
[ -t 0 ] || [ -r /dev/tty ] || YES=1 # no terminal at all: take defaults

if [ "$EUID" -eq 0 ]; then
  echo "Bitte als normaler Benutzer ausfuehren, nicht als root (das Script nutzt sudo)."; exit 1
fi

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
# ask VAR "Frage" "default"  – keeps a value that came in as env var, otherwise asks (or takes the default with --yes)
ask() {
  local var="$1" prompt="$2" def="$3" ans=""
  if [ -n "${!var:-}" ]; then return; fi
  if [ "$YES" -eq 1 ]; then printf -v "$var" '%s' "$def"; return; fi
  read -r -p "$prompt [${def:-leer}]: " ans < /dev/tty || ans=""
  printf -v "$var" '%s' "${ans:-$def}"
}
ask_secret() {
  local var="$1" prompt="$2" ans=""
  if [ -n "${!var:-}" ] || [ "$YES" -eq 1 ]; then return; fi
  read -r -s -p "$prompt (Eingabe bleibt unsichtbar, Enter = ueberspringen): " ans < /dev/tty || ans=""
  echo
  printf -v "$var" '%s' "$ans"
}
yesno() { case "${1,,}" in y|yes|j|ja|1|true) return 0 ;; *) return 1 ;; esac; }

# ---------------------------------------------------------------- settings
say "Einstellungen (Enter = Vorschlag uebernehmen)"
ask REPO      "GitHub-Repo (owner/name)" "vxnsin/aniwatch"
ask DOMAIN    "Oeffentliche Domain" "aniwatch.example.org"
ask APP_DIR   "App-Ordner" "$HOME/aniwatch"
ask PORT      "Port" "3100"
ask SERVICE   "Dienstname (systemd, Dateinamen)" "aniwatch"
ask DATA_DIR  "Datenordner (sqlite)" "/var/lib/$SERVICE"
ask SETUP_DDNS "DNS bei Vercel automatisch auf die Heim-IP setzen? (ja/nein)" "ja"
ENV_FILE="/etc/$SERVICE.env"
USER_NAME="$(id -un)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"

cat <<SUMMARY

  Repo:        $REPO
  Domain:      $DOMAIN
  App-Ordner:  $APP_DIR
  Port:        $PORT
  Dienst:      $SERVICE   (Env: $ENV_FILE, Daten: $DATA_DIR)
  Vercel-DDNS: $SETUP_DDNS
SUMMARY
if [ "$YES" -eq 0 ]; then
  read -r -p "So einrichten? (J/n): " ok < /dev/tty || ok="j"
  case "${ok,,}" in n|no|nein) echo "Abgebrochen."; exit 1 ;; esac
fi

# ---------------------------------------------------------------- packages
say "System-Pakete"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl jq rsync ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https

# ---------------------------------------------------------------- node
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  MINOR="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$MAJOR" -gt 22 ] || { [ "$MAJOR" -eq 22 ] && [ "$MINOR" -ge 13 ]; }; then NEED_NODE=0; fi # node:sqlite needs 22.13+
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
  rsync -a --exclude node_modules --exclude dist --exclude data --exclude .env "$SCRIPT_DIR/../" "$APP_DIR/"
else
  say "Repo klonen nach $APP_DIR"
  ask_secret GITHUB_TOKEN "GitHub-Token (nur fuer private Repos)"
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    git clone "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git" "$APP_DIR"
    git -C "$APP_DIR" remote set-url origin "https://github.com/${REPO}.git"
  else
    git clone "https://github.com/${REPO}.git" "$APP_DIR"
  fi
fi
# sqlite lives in DATA_DIR so a re-clone never loses rooms/profiles
if [ ! -L "$APP_DIR/data" ]; then rm -rf "$APP_DIR/data"; fi
ln -sfn "$DATA_DIR" "$APP_DIR/data"

# ---------------------------------------------------------------- env file
if [ ! -f "$ENV_FILE" ]; then
  say "Env-Datei $ENV_FILE anlegen"
  echo "Die Discord-Werte stehen im Developer Portal unter OAuth2. Du kannst sie auch spaeter in $ENV_FILE eintragen."
  ask DISCORD_CLIENT_ID "Discord Client ID" ""
  ask_secret DISCORD_CLIENT_SECRET "Discord Client Secret"
  if yesno "$SETUP_DDNS"; then
    ask_secret VERCEL_TOKEN "Vercel API Token fuer DNS (leer, wenn /etc/vensin.env schon einen hat)"
    ask VERCEL_TEAM_ID "Vercel Team ID (nur bei Team-Domain, sonst leer)" ""
  fi
  {
    echo "NODE_ENV=production"
    echo "PORT=$PORT"
    echo "ALLOW_DEV=0"
    echo "# Discord Developer Portal -> deine App -> OAuth2"
    echo "DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID:-}"
    echo "DISCORD_CLIENT_SECRET=${DISCORD_CLIENT_SECRET:-}"
    echo "VITE_DISCORD_CLIENT_ID=${DISCORD_CLIENT_ID:-}"
    echo "# Unter OAuth2 -> Redirects genau diesen Wert eintragen (Platzhalter, wird nie aufgerufen)"
    echo "DISCORD_REDIRECT_URI=https://127.0.0.1"
    echo "# Vercel API token fuer den DNS-Cron (Account Settings -> Tokens)"
    echo "VERCEL_TOKEN=${VERCEL_TOKEN:-}"
    echo "VERCEL_TEAM_ID=${VERCEL_TEAM_ID:-}"
  } | sudo tee "$ENV_FILE" >/dev/null
  sudo chown "$USER_NAME:$USER_NAME" "$ENV_FILE"
  sudo chmod 600 "$ENV_FILE"
  ENV_CREATED=1
else
  ENV_CREATED=0
  # keep PORT in the env file in sync with the chosen port
  if grep -q '^PORT=' "$ENV_FILE"; then sudo sed -i "s/^PORT=.*/PORT=$PORT/" "$ENV_FILE"; else echo "PORT=$PORT" | sudo tee -a "$ENV_FILE" >/dev/null; fi
fi
# VITE_DISCORD_CLIENT_ID mirrors DISCORD_CLIENT_ID if only one was filled in
if grep -q '^DISCORD_CLIENT_ID=.\+' "$ENV_FILE" && grep -q '^VITE_DISCORD_CLIENT_ID=$' "$ENV_FILE"; then
  CID="$(grep '^DISCORD_CLIENT_ID=' "$ENV_FILE" | cut -d= -f2-)"
  sudo sed -i "s/^VITE_DISCORD_CLIENT_ID=$/VITE_DISCORD_CLIENT_ID=$CID/" "$ENV_FILE"
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
sudo tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<UNIT
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
# one file per site in /etc/caddy/sites, the main Caddyfile only imports them – other sites stay untouched
say "Caddy: Site-Block fuer $DOMAIN"
sudo mkdir -p /etc/caddy/sites
sudo tee "/etc/caddy/sites/$SERVICE.caddy" >/dev/null <<CADDY
$DOMAIN {
	reverse_proxy localhost:$PORT
	encode gzip zstd
}
CADDY
if [ ! -f /etc/caddy/Caddyfile ]; then
  echo "import sites/*.caddy" | sudo tee /etc/caddy/Caddyfile >/dev/null
elif ! grep -q 'import sites/\*\.caddy' /etc/caddy/Caddyfile; then
  sudo sed -i '1i import sites/*.caddy\n' /etc/caddy/Caddyfile
fi
sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null
sudo systemctl reload caddy || sudo systemctl restart caddy

# ---------------------------------------------------------------- dynamic dns (optional)
if yesno "$SETUP_DDNS"; then
  say "Dynamic-DNS fuer $DOMAIN (Vercel) + Cron"
  DDNS_BIN="/usr/local/bin/$SERVICE-ddns.sh"
  sudo tee "$DDNS_BIN" >/dev/null <<'DDNS'
#!/bin/bash
# Keeps the A-record for __DOMAIN__ at Vercel DNS pointed at the current public IP.
# Token: VERCEL_TOKEN from __ENV_FILE__, otherwise from /etc/vensin.env (same account).
set -e
[ -f "__ENV_FILE__" ] && source "__ENV_FILE__"
if [ -z "${VERCEL_TOKEN:-}" ] && [ -f /etc/vensin.env ]; then source /etc/vensin.env; fi
[ -n "${VERCEL_TOKEN:-}" ] || { echo "VERCEL_TOKEN fehlt (in __ENV_FILE__ oder /etc/vensin.env)"; exit 0; }
FQDN="__DOMAIN__"
ROOT="$(echo "$FQDN" | awk -F. '{print $(NF-1)"."$NF}')"
NAME="${FQDN%.$ROOT}"; [ "$NAME" = "$FQDN" ] && NAME=""
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
  echo "$(date) created ${NAME:-@} -> $IP"
elif [ "$CUR" != "$IP" ]; then
  curl -fs -X PATCH -H "$H" -H "Content-Type: application/json" \
    -d "{\"value\":\"$IP\"}" "$API/v1/domains/records/$ID${Q:+?$Q}" >/dev/null
  echo "$(date) updated ${NAME:-@} -> $IP"
fi
DDNS
  sudo sed -i "s#__DOMAIN__#$DOMAIN#g; s#__ENV_FILE__#$ENV_FILE#g" "$DDNS_BIN"
  sudo chmod +x "$DDNS_BIN"
  sudo touch "/var/log/$SERVICE-ddns.log" && sudo chown "$USER_NAME" "/var/log/$SERVICE-ddns.log"
  CRON_LINE="*/5 * * * * $DDNS_BIN >> /var/log/$SERVICE-ddns.log 2>&1"
  ( crontab -l 2>/dev/null | grep -v "$DDNS_BIN" || true; echo "$CRON_LINE" ) | crontab -
  "$DDNS_BIN" || true
fi

# ---------------------------------------------------------------- summary
PUBLIC_IP="$(curl -4 -fs https://ifconfig.me || echo '?')"
LAN_IP="$(hostname -I | awk '{print $1}')"
say "Fertig"
cat <<SUMMARY

  App:         http://$LAN_IP:$PORT  (LAN)   ->  https://$DOMAIN (sobald DNS steht)
  Dienst:      sudo systemctl status $SERVICE     Logs: journalctl -u $SERVICE -f
  Caddy:       /etc/caddy/sites/$SERVICE.caddy     Logs: journalctl -u caddy -f
  Env:         $ENV_FILE  (danach: bash $APP_DIR/scripts/setup-pi.sh --yes  oder  sudo systemctl restart $SERVICE)
  Daten:       $DATA_DIR/aniwatch.sqlite
SUMMARY
if yesno "$SETUP_DDNS"; then
  echo "  DDNS:        /usr/local/bin/$SERVICE-ddns.sh, alle 5 min, Log /var/log/$SERVICE-ddns.log"
else
  echo "  DNS:         A-Record $DOMAIN -> $PUBLIC_IP selbst anlegen"
fi
cat <<TODO

Noch zu tun:
  1. Router: TCP 80 und 443 auf diesen Rechner ($LAN_IP) weiterleiten (falls noch nicht)
  2. Discord Developer Portal -> Activities -> URL Mappings: Prefix /  ->  $DOMAIN
  3. Von aussen testen: https://$DOMAIN/api/info  muss JSON liefern
TODO
if ! grep -q '^DISCORD_CLIENT_ID=.\+' "$ENV_FILE"; then
  echo "  Hinweis: DISCORD_CLIENT_ID fehlt in $ENV_FILE – eintragen und das Script nochmal laufen lassen (baut den Client neu)."
fi

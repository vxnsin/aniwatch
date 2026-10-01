<p align="center"><img src=".github/wordmark.svg" width="420" alt="aniwatch"></p>

<p align="center">Anime zusammen schauen – als Discord Activity direkt im Sprachkanal.<br>Host steuert, alle reihen ein, Autoplay läuft weiter. Streams von aniworld.to.</p>

<p align="center"><img src=".github/screenshot.jpg" width="800" alt="aniwatch im dev-modus: player links, suche mit aniworld-profil rechts"></p>

# aniwatch

Anime zusammen schauen – als **Discord Activity** direkt im Sprachkanal. Streams von aniworld.to, gleiche Technik und gleicher Look wie aniplay.

## Was es kann

- **Host-Rolle:** Wer zuerst im Raum ist, ist Host. Nur der Host (oder alle, wenn der Host es freigibt) startet Folgen, pausiert, spult, wechselt Sprache und Hoster. Der Host kann die Rolle abgeben. Geht der Host kurz offline (Reload), bleibt die Rolle 25 s reserviert.
- **Alle synchron:** Server-Uhr, jeder Client korrigiert Drift automatisch. „Sync“-Knopf, falls jemand hängt.
- **Warteschlange:** Jeder darf Folgen oder ganze Staffeln einreihen, sortieren und eigene Einträge entfernen. Ist die Schlange leer, läuft mit **Autoplay** die nächste Folge des aktuellen Animes weiter, auch über Staffelgrenzen.
- **Suche mit Autocomplete** (aniworld-Suche), AniWorld-Link einfügen geht auch.
- **AniWorld-Profil pro Nutzer** (optional): zuletzt geschaut, Watchlist, Abos als Schnellauswahl; gesehene Folgen werden markiert.
- **Discord-Profile** aller Anwesenden oben in der Leiste, Host mit Krone. Rich Presence „schaut Solo Leveling – S1E01“.
- **Hoster-Fallback:** spielt der Stream beim Host nicht, wird automatisch der nächste Hoster genommen.
- Chat im Raum, Raum-Zustand überlebt Server-Neustarts (SQLite).

## Lokal ausprobieren (ohne Discord)

```
npm install
npm run build
npm start
```

Dann `http://localhost:3100/?dev=1&name=luis&room=test` öffnen, in einem zweiten Tab `?dev=1&name=mia&room=test`. Für den Dev-Modus muss `ALLOW_DEV=1` in `.env` stehen (siehe `.env.example`). Im Dev-Modus gibt es keine Discord-Avatare, nur Initialen.

## Auf dem Raspberry Pi (wie das Portfolio)

Der Pi hat schon Caddy, DNS bei Vercel und Port 80/443 vom Router. aniwatch kommt daneben:

```
scp -r AniWatch pi@<pi-ip>:~/aniwatch      # oder das Repo klonen
ssh pi@<pi-ip>
bash ~/aniwatch/scripts/setup-pi.sh
```

Das Script fragt beim Start nach Repo, Domain, Ordner, Port, Dienstname und DNS und schlägt Standardwerte vor (Enter übernimmt). Mit `--yes` oder Umgebungsvariablen läuft es ohne Fragen, etwa `DOMAIN=watch.example.org bash scripts/setup-pi.sh --yes`. Es installiert nichts doppelt, legt `/etc/aniwatch.env` an, baut, richtet den systemd-Dienst `aniwatch` ein, hängt einen Caddy-Block für `aniwatch.vensin.dev` an (ohne den vensin.dev-Block anzufassen) und legt den A-Record bei Vercel per Cron an. Danach `/etc/aniwatch.env` ausfüllen und das Script nochmal laufen lassen. Re-Runs machen Pull, Build und Restart.


## Als Discord Activity einrichten

1. **App anlegen:** https://discord.com/developers/applications → „New Application“. Als App-Icon liegt `.github/logo.png` (1024 px) bereit.
2. **OAuth2:** Client ID und Client Secret kopieren → in `.env` eintragen (`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `VITE_DISCORD_CLIENT_ID`). Eine Redirect-URL ist für Activities nicht nötig.
3. **Activities aktivieren:** Reiter „Activities“ → „Enable Activities“.
4. **URL Mapping:** unter Activities → „URL Mappings“ den Root `/` auf deine öffentliche Adresse zeigen lassen, z. B. `aniwatch.vensin.dev`. Discord lädt die App über seinen eigenen Proxy, deshalb muss der Server **öffentlich per HTTPS** erreichbar sein. Es werden keine weiteren Mappings gebraucht, alles (Streams, Bilder, Fonts) läuft über unseren Server.
5. **Öffentlich machen:** Zum Testen reicht ein Cloudflare Tunnel:
   ```
   cloudflared tunnel --url http://localhost:3100
   ```
   Die ausgegebene `*.trycloudflare.com`-Adresse als URL Mapping eintragen. Dauerhaft: der Pi hinter Cloudflare, Subdomain auf Port 3100.
6. **Bauen und starten:**
   ```
   npm run build
   npm start
   ```
7. **Testen:** In Discord in einen Sprachkanal gehen → Activities-Button (Rakete) → deine App erscheint unter „Entwickler“, solange sie nicht veröffentlicht ist. Alle Tester müssen in den Developer-Settings der App als Tester eingetragen sein, bis die App eine Discord-Prüfung durchlaufen hat.

## Bedienung

| Wer | darf |
|---|---|
| Host | Folge starten, Play/Pause, spulen, Sprache/Hoster, nächste Folge, Stop, Warteschlange sortieren/leeren, Host abgeben, „alle dürfen steuern“ |
| Alle | suchen, einreihen, eigene Einträge entfernen, Lautstärke, Vollbild, Sync, Chat, eigenes AniWorld-Profil |

Tastatur: `Space` Play/Pause, `←/→` ±10 s (nur mit Steuerrecht), `f` Vollbild, `m` Stumm.

## Struktur

```
server/index.js    Express, Discord-Token-Tausch, WebSocket pro Raum, Stream- und Bild-Proxy
server/rooms.js    Raum-Logik: Host, Warteschlange, Sync, Autoplay, Fallback
server/db.js       SQLite (node:sqlite): Nutzer, Sessions, Raum-Zustand, Fortschritt
lib/               aniworld-Scraper und Hoster-Loader (identisch mit aniplay)
client/            Vite-App: discord.js (SDK), main.js (UI + Player), style.css, Fonts
```

## Hinweise

- Streams laufen über `/api/proxy`, damit Referer und User-Agent stimmen. Innerhalb von Discord ist nur unsere eigene Adresse erreichbar, deshalb sind auch Fonts und Cover-Bilder lokal bzw. über `/api/img` geproxyt.
- Doodstream läuft nur als Iframe (Cloudflare) und kann dann nicht synchronisiert werden – der Host sollte VOE, Vidmoly oder Filemoon wählen.
- Rechtliches wie bei aniplay: das ist ein privates Werkzeug für aniworld.to.

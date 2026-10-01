/**
 * AniWatch – Anime zusammen schauen als Discord Activity.
 * server/index.js: Express + WebSocket, Discord OAuth token exchange, rooms, stream/image proxy.
 */

require('./env');
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable } = require('stream');
const WebSocket = require('ws');

const aw = require('../lib/aniworld');
const { UA, request } = require('../lib/http');
const db = require('./db');
const { getRoom } = require('./rooms');
const pkg = require('../package.json');

const PORT = parseInt(process.env.PORT || '3100', 10);
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || '';
// activities never redirect, but discord's token endpoint wants the registered redirect uri in the exchange anyway
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'https://127.0.0.1';
const ALLOW_DEV = process.env.ALLOW_DEV === '1';
const DIST = path.join(__dirname, '..', 'dist');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ noServer: true });

app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

const wrap = (fn) => async (req, res) => {
  try {
    res.json(await fn(req, res));
  } catch (e) {
    console.error(`[API] ${req.method} ${req.path}:`, e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
};
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

// ─────────────────────────────────────────────────────────────────────────────
// Auth: Discord OAuth2 code (from the Embedded App SDK) → access token + our session token
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/token', wrap(async (req) => {
  const { code } = req.body || {};
  if (!code) throw bad('code fehlt');
  if (!CLIENT_ID || !CLIENT_SECRET) throw bad('DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET fehlen in .env', 503);
  const res = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI }),
  });
  const token = await res.json();
  if (!res.ok || !token.access_token) throw bad(`discord token: ${token.error_description || token.error || res.status}`, 401);
  const me = await (await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${token.access_token}` } })).json();
  if (!me?.id) throw bad('discord /users/@me fehlgeschlagen', 401);
  const user = {
    id: me.id,
    name: me.global_name || me.username,
    avatar: me.avatar ? `https://cdn.discordapp.com/avatars/${me.id}/${me.avatar}.png?size=64` : null,
  };
  db.saveUser(user);
  const session = crypto.randomBytes(24).toString('hex');
  db.createSession(session, user.id);
  return { access_token: token.access_token, session, user: { ...user, aniworld: db.getUser(user.id)?.aniworld || null } };
}));

// Developing in a normal browser without Discord: ?dev=1&name=luis
app.post('/api/dev-session', wrap(async (req) => {
  if (!ALLOW_DEV) throw bad('dev mode ist aus (ALLOW_DEV=1 setzen)', 403);
  const name = String(req.body?.name || 'dev').slice(0, 32);
  const user = { id: `dev-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`, name, avatar: null };
  db.saveUser(user);
  const session = crypto.randomBytes(24).toString('hex');
  db.createSession(session, user.id);
  return { session, user: { ...user, aniworld: db.getUser(user.id)?.aniworld || null } };
}));

function auth(req) {
  const token = req.headers['x-session'] || req.query.session;
  const s = token && db.getSession(String(token));
  if (!s) throw bad('nicht angemeldet', 401);
  return { id: s.user_id, name: s.name, avatar: s.avatar, aniworld: s.aniworld };
}

// ─────────────────────────────────────────────────────────────────────────────
// Content API (read only – playback changes go through the websocket)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/info', (_req, res) => res.json({ name: pkg.name, version: pkg.version, clientId: CLIENT_ID, dev: ALLOW_DEV }));
app.get('/api/search', wrap(async (req) => ({ results: await aw.search(req.query.q || '') })));
app.get('/api/anime/:slug', wrap(async (req) => ({ anime: await aw.getSeries(req.params.slug) })));
app.get('/api/season', wrap(async (req) => ({ episodes: await aw.getSeason(String(req.query.href || '')) })));
app.get('/api/profile/:name', wrap(async (req) => ({ profile: await aw.getProfile(req.params.name) })));

app.get('/api/me', wrap(async (req) => ({ user: auth(req) })));
app.post('/api/me/aniworld', wrap(async (req) => {
  const user = auth(req);
  const name = String(req.body?.name || '').trim();
  if (name && !/^[\w.-]{2,40}$/.test(name)) throw bad('ungültiger aniworld-name');
  if (name) await aw.getProfile(name);
  db.setAniworld(user.id, name);
  for (const room of require('./rooms').rooms.values()) {
    const m = room.members.get(user.id);
    if (m) { m.aniworld = name || null; room.broadcast(); }
  }
  return { ok: true, aniworld: name || null };
}));

// ─────────────────────────────────────────────────────────────────────────────
// Proxies – inside Discord's iframe only our own origin is reachable, so
// streams (with the hoster's Referer) and cover images go through here.
// ─────────────────────────────────────────────────────────────────────────────
const proxied = (url, referer) => `/api/proxy?r=${encodeURIComponent(referer || '')}&u=${encodeURIComponent(url)}`;
function rewritePlaylist(text, baseUrl, referer) {
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxied(new URL(u, baseUrl).href, referer)}"`);
    try { return proxied(new URL(t, baseUrl).href, referer); } catch { return line; }
  }).join('\n');
}

app.get('/api/proxy', async (req, res) => {
  const target = req.query.u;
  const referer = req.query.r || '';
  if (!target || !/^https?:\/\//i.test(target)) return res.status(400).send('ungültige url');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  try {
    const headers = { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.5' };
    if (referer) { headers.Referer = referer; try { headers.Origin = new URL(referer).origin; } catch { /* ignore */ } }
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await request(target, { headers, signal: ac.signal, timeout: 30000 });
    const ct = upstream.headers.get('content-type') || '';
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    const playlist = /mpegurl/i.test(ct) || /\.m3u8(\?|$)/i.test(target) || /master\.txt(\?|$)/i.test(target);
    if (playlist || (/^text\//i.test(ct) && !req.headers.range)) {
      const text = await upstream.text();
      if (text.trimStart().startsWith('#EXTM3U')) return res.status(upstream.status).type('application/vnd.apple.mpegurl').send(rewritePlaylist(text, upstream.url || target, referer));
      res.status(upstream.status);
      if (ct) res.type(ct);
      return res.send(text);
    }
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  } catch (e) {
    if (ac.signal.aborted) return;
    if (!res.headersSent) res.status(502).send(e.message);
  }
});

app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!/^https:\/\/(aniworld\.to|cdn\.discordapp\.com|img-place\.com)\//.test(u)) return res.status(400).end();
  try {
    const up = await request(u, { headers: { Referer: 'https://aniworld.to/', Accept: 'image/*' }, timeout: 15000 });
    if (!up.ok || !up.body) return res.status(up.status).end();
    res.setHeader('Content-Type', up.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    Readable.fromWeb(up.body).on('error', () => res.end()).pipe(res);
  } catch {
    res.status(502).end();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket: /ws?room=<instanceId>&session=<token>
// ─────────────────────────────────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') return socket.destroy();
  const s = db.getSession(url.searchParams.get('session') || '');
  const roomId = (url.searchParams.get('room') || '').slice(0, 80);
  if (!s || !roomId) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.user = { id: s.user_id, name: s.name, avatar: s.avatar, aniworld: s.aniworld };
    ws.roomId = roomId;
    wss.emit('connection', ws, req);
  });
});

const send = (ws, type, data = {}) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data })); };

wss.on('connection', (ws) => {
  const room = getRoom(ws.roomId);
  const user = ws.user;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const unsubscribe = room.subscribe((type, payload) => send(ws, type, payload));
  room.join(user, ws);
  send(ws, 'hello', { you: user, state: room.snapshot() });
  console.log(`[WS] ${user.name} → room ${room.id} (${room.members.size})`);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      await handle(room, user, ws, msg);
    } catch (e) {
      send(ws, 'toast', { text: e.message.split('\n')[0] });
    }
  });
  ws.on('close', () => {
    unsubscribe();
    room.leave(user, ws);
    console.log(`[WS] ${user.name} ← room ${room.id} (${room.members.size})`);
  });
});

async function handle(room, user, ws, msg) {
  const control = () => { if (!room.canControl(user.id)) throw new Error('nur der host darf das'); };
  const host = () => { if (!room.isHost(user.id)) throw new Error('nur der host darf das'); };
  switch (msg.type) {
    case 'ping': send(ws, 'pong', { serverNow: Date.now() }); break;
    case 'get_state': send(ws, 'state', { state: room.snapshot() }); break;

    // playback
    case 'play': control(); room.setPlaying(true); break;
    case 'pause': control(); room.setPlaying(false); break;
    case 'toggle': control(); room.setPlaying(!room.playback.playing); break;
    case 'seek': control(); room.seekTo(room.expectedPosition() + (Number(msg.delta) || 0)); break;
    case 'seek_to': control(); room.seekTo(Number(msg.position) || 0); break;
    case 'report': if (room.isHost(user.id) || (!room.members.has(room.hostId))) room.report(msg.position, msg.duration); break;
    case 'ended': if (room.isHost(user.id)) await room.ended(); break;
    case 'player_error': if (room.isHost(user.id)) await room.playerError(msg.message); break;

    // content
    case 'start': control(); await room.play(String(msg.href), { restart: !!msg.restart, langKey: msg.langKey, by: user.name }); break;
    case 'next': control(); await room.advance(user.name); break;
    case 'stop': control(); room.stop(); break;
    case 'hoster': control(); await room.switchHoster(String(msg.hosterId)); break;
    case 'lang': control(); await room.switchLang(parseInt(msg.langKey, 10)); break;

    // queue – everyone
    case 'queue_add': room.addToQueue(Array.isArray(msg.items) ? msg.items.slice(0, 60) : [], user); break;
    case 'queue_remove': room.removeFromQueue(String(msg.id), user); break;
    case 'queue_move': control(); room.moveInQueue(String(msg.id), msg.dir > 0 ? 1 : -1); break;
    case 'queue_clear': control(); room.clearQueue(); break;
    case 'queue_play': { control(); const i = room.queue.findIndex((q) => q.id === msg.id); if (i >= 0) { const [it] = room.queue.splice(i, 1); room.broadcast(); await room.play(it.episode.href, { restart: true, by: user.name }); } break; }

    // room settings – host
    case 'set_host': host(); if (room.members.has(msg.userId)) { room.hostId = msg.userId; room.emit('system', { text: `${room.members.get(msg.userId).name} ist jetzt host` }); room.broadcast(); room.persist(); } break;
    case 'open_control': host(); room.openControl = !!msg.value; room.broadcast(); room.persist(); break;
    case 'autoplay': control(); room.settings.autoplay = !!msg.value; room.broadcast(); room.persist(); break;

    case 'chat': { const text = String(msg.text || '').trim().slice(0, 300); if (text) room.emit('chat', { user: { id: user.id, name: user.name, avatar: user.avatar }, text }); break; }
    default: break;
  }
}

setInterval(() => {
  wss.clients.forEach((ws) => { if (ws.isAlive === false) return ws.terminate(); ws.isAlive = false; ws.ping(); });
}, 30000).unref();
setInterval(() => db.housekeeping(), 6 * 3600_000).unref();

process.on('unhandledRejection', (e) => console.error('[Unhandled]', e?.stack || e));
process.on('uncaughtException', (e) => console.error('[Uncaught]', e?.stack || e));

// ─────────────────────────────────────────────────────────────────────────────
// Static client (vite build → dist)
// ─────────────────────────────────────────────────────────────────────────────
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, extensions: ['html'] }));
  app.get(/^\/(?!api\/|ws).*/, (_req, res) => res.sendFile(path.join(DIST, 'index.html')));
} else {
  app.get('/', (_req, res) => res.type('text').send('kein build gefunden – `npm run build` ausführen oder `npm run dev:client` nutzen'));
}

server.listen(PORT, () => {
  console.log(`\n  aniwatch v${pkg.version} läuft auf http://localhost:${PORT}`);
  console.log(`  discord client id: ${CLIENT_ID || '(fehlt – .env ausfüllen)'} · dev mode: ${ALLOW_DEV ? 'an' : 'aus'}\n`);
});

import Hls from 'hls.js';
import { connect, setActivity, insideDiscord } from './discord.js';

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (s) => { s = Math.max(0, Math.floor(Number(s) || 0)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`; };
const epLabel = (ep) => (!ep ? '' : ep.seasonNum === 0 ? `Film ${ep.num}` : `S${ep.seasonNum}E${String(ep.num).padStart(2, '0')}`);
const img = (u) => (u ? `/api/img?u=${encodeURIComponent(u)}` : '');
const LANG = { 1: 'Deutsch', 2: 'Eng Sub', 3: 'Ger Sub', 4: 'English' };
const LANG_SHORT = { 1: 'DE', 2: 'EN-SUB', 3: 'DE-SUB', 4: 'EN' };

const ICONS = {
  play: '<path d="M4 2l10 6-10 6z"/>', pause: '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>', stop: '<path d="M3 3h10v10H3z"/>',
  next: '<path d="M12 2h2v12h-2zM2 2l9 6-9 6z"/>', rew: '<path d="M8 2L1 8l7 6zM15 2L8 8l7 6z"/>', fwd: '<path d="M8 2l7 6-7 6zM1 2l7 6-7 6z"/>',
  volume: '<path d="M2 6h3l4-4v12l-4-4H2z"/><path d="M11 5v6h1V5zM13 3v10h1V3z"/>', mute: '<path d="M2 6h3l4-4v12l-4-4H2z"/><path d="M10.6 5.2l1.4 1.4 1.4-1.4L14.8 6.6 13.4 8l1.4 1.4-1.4 1.4L12 9.4l-1.4 1.4-1.4-1.4L10.6 8 9.2 6.6z"/>',
  fullscreen: '<path d="M2 2h5v2H4v3H2zM9 2h5v5h-2V4H9zM2 9h2v3h3v2H2zM12 9h2v5H9v-2h3z"/>', sync: '<path d="M8 2a6 6 0 0 1 5.2 3H15v4h-4V7h1.6A4 4 0 0 0 4 8H2a6 6 0 0 1 6-6zM8 14a6 6 0 0 1-5.2-3H1V7h4v2H3.4A4 4 0 0 0 12 8h2a6 6 0 0 1-6 6z"/>',
  plus: '<path d="M7 2h2v5h5v2H9v5H7V9H2V7h5z"/>', x: '<path d="M3.4 2L8 6.6 12.6 2 14 3.4 9.4 8l4.6 4.6-1.4 1.4L8 9.4 3.4 14 2 12.6 6.6 8 2 3.4z"/>',
  up: '<path d="M8 3l6 6-1.4 1.4L8 5.8l-4.6 4.6L2 9z"/>', down: '<path d="M8 13L2 7l1.4-1.4L8 10.2l4.6-4.6L14 7z"/>',
  crown: '<path d="M2 12h12v2H2zM2 4l3 3 3-5 3 5 3-3-1 7H3z"/>', list: '<path d="M2 3h12v2H2zM2 7h12v2H2zM2 11h12v2H2z"/>', chev: '<path d="M5 2l6 6-6 6-1.4-1.4L8.2 8 3.6 3.4z"/>',
  check: '<path d="M6 11.2L2.8 8l1.4-1.4L6 8.4l5.8-5.8L13.2 4z"/>', users: '<path d="M5 3a2 2 0 110 4 2 2 0 010-4zm6 1a2 2 0 110 4 2 2 0 010-4zM1 13c0-3 2-4 4-4s4 1 4 4zm8 0c0-2 .7-3.3 1.8-4 .4-.1.8-.1 1.2-.1 2 0 3 1.5 3 4.1z"/>',
};
const icon = (n, cls = '') => `<svg class="ico ${cls}"><use href="#i-${n}"></use></svg>`;
function sprite() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
  svg.innerHTML = Object.entries(ICONS).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 16 16" fill="currentColor" shape-rendering="crispEdges">${v}</symbol>`).join('');
  document.body.prepend(svg);
}

let toastEl, toastTimer;
function toast(msg, ms = 2800) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'toast'; document.body.appendChild(toastEl); }
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ─────────────────────────────────────────────────────────────────────────────
// state
// ─────────────────────────────────────────────────────────────────────────────
let conn = null; // { sdk, dev, user, session, roomId }
let R = null; // room snapshot
let ws = null;
let clockOffset = 0; // serverNow - Date.now()
let hls = null;
let currentKey = null; // url of the loaded stream
let unlocked = false; // autoplay unlocked by a click
let suppressEvents = false;
let volume = parseFloat(localStorage.getItem('aniwatch:vol') || '1');
let P = null; // aniworld profile of me
let anime = null; // anime shown in the search tab { ...series, episodes, seasonHref }
let tab = 'search';
let lastPlaybackMsg = null;
let leaving = false; // page is being closed/reloaded: ignore the browser's own pause/play events
window.addEventListener('pagehide', () => { leaving = true; });
window.addEventListener('beforeunload', () => { leaving = true; });

const serverNow = () => Date.now() + clockOffset;
const me = () => conn?.user;
const isHost = () => R && me() && R.hostId === me().id;
const canControl = () => R && (R.openControl || isHost());
const api = async (path, body, method) => {
  const r = await fetch(path, { method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json', 'X-Session': conn?.session || '' }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch {}
  if (!r.ok || j?.error) throw new Error(j?.error || `HTTP ${r.status}`);
  return j;
};
const send = (obj) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); };

// ─────────────────────────────────────────────────────────────────────────────
// boot
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  sprite();
  // a normal browser visit (not inside discord, dev mode off): show a small landing page instead of an error
  if (!insideDiscord()) {
    const info = await fetch('/api/info').then((r) => r.json()).catch(() => ({}));
    if (!info.dev) {
      $('boot').innerHTML = `<div class="wordmark">ani<span>watch</span></div>
        <div class="muted" style="max-width:460px">anime zusammen schauen – als discord activity direkt im sprachkanal. host steuert, alle reihen ein, autoplay läuft weiter.</div>
        <div class="muted xs" style="max-width:460px">in discord: sprachkanal betreten → aktivitäten (rakete) → aniwatch.</div>
        <div class="row" style="justify-content:center;margin-top:6px"><a class="btn" href="/terms">nutzungsbedingungen</a><a class="btn" href="/privacy">datenschutz</a><a class="btn" href="https://github.com/vxnsin/aniwatch" target="_blank" rel="noreferrer">github</a></div>
        <div class="muted xs">ein projekt von <a href="https://vensin.dev" target="_blank" rel="noreferrer">vensin</a></div>`;
      return;
    }
  }
  try {
    conn = await connect((s) => { $('boot-text').innerHTML = `<span class="blink accent">▮</span> ${esc(s)}`; });
  } catch (e) {
    $('boot-text').innerHTML = `<span class="accent">✗</span> ${esc(e.message)}<br><span class="xs">in .env die discord-werte eintragen und neu bauen. ohne discord: <a href="?dev=1">dev-modus</a></span>`;
    return;
  }
  renderLayout();
  openWs();
})();

function openWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  let retry = 1000;
  const open = () => {
    ws = new WebSocket(`${proto}://${location.host}/ws?room=${encodeURIComponent(conn.roomId)}&session=${encodeURIComponent(conn.session)}`);
    ws.onopen = () => { retry = 1000; $('conn-dot').className = 'status-dot on'; send({ type: 'ping' }); };
    ws.onclose = () => { $('conn-dot').className = 'status-dot off'; setTimeout(open, retry); retry = Math.min(retry * 1.6, 8000); };
    ws.onmessage = (e) => { try { onMessage(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
  };
  open();
  setInterval(() => send({ type: 'ping' }), 20000);
}

function onMessage(msg) {
  switch (msg.type) {
    case 'pong': clockOffset = msg.serverNow - Date.now(); break;
    case 'hello': R = msg.state; syncClock(R.playback); renderAll(); if (R.current?.stream) loadStream(R.current, R.playback); break;
    case 'state': R = msg.state; syncClock(R.playback); renderAll(); if (R.current?.stream && R.current.stream.url !== currentKey) loadStream(R.current, R.playback); if (!R.current && currentKey) unload(); break;
    case 'load': if (R) { R.current = msg.current; R.playback = msg.playback; } syncClock(msg.playback); loadStream(msg.current, msg.playback); renderAll(); break;
    case 'playback': if (R) R.playback = msg.playback; syncClock(msg.playback); applyPlayback(msg.playback); renderControls(); break;
    case 'stopped': unload(); break;
    case 'toast': toast(msg.text, 3500); break;
    case 'system': case 'chat': if (R) { R.chat = [...(R.chat || []), msg].slice(-30); renderChat(); } if (msg.type === 'chat' && tab !== 'people' && msg.user?.id !== me()?.id) toast(`${msg.user.name}: ${msg.text}`, 3000); break;
  }
}
function syncClock(pb) { if (pb?.serverNow) clockOffset = pb.serverNow - Date.now(); }

// ─────────────────────────────────────────────────────────────────────────────
// player
// ─────────────────────────────────────────────────────────────────────────────
const video = () => $('video');
const proxy = (u, r) => `/api/proxy?r=${encodeURIComponent(r || '')}&u=${encodeURIComponent(u)}`;
let triedAlt = false, errorSent = false, ready = false;

function unload() {
  ready = false; currentKey = null;
  if (hls) { hls.destroy(); hls = null; }
  const v = video(); if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  const f = $('frame'); if (f) { f.src = 'about:blank'; f.classList.add('hidden'); }
  $('idle')?.classList.remove('hidden');
  setActivity(conn?.sdk, null);
  renderAll();
}

function loadStream(current, pb) {
  const s = current?.stream;
  if (!s) return;
  if (hls) { hls.destroy(); hls = null; }
  ready = false; triedAlt = false; errorSent = false;
  currentKey = s.url;
  $('idle').classList.add('hidden');
  const v = video(), f = $('frame');
  if (s.streamType === 'embed') {
    v.classList.add('hidden'); f.classList.remove('hidden');
    f.src = s.embedUrl;
    toast('dieser hoster läuft nur als iframe – keine synchronisation möglich', 5000);
    return;
  }
  f.classList.add('hidden'); v.classList.remove('hidden');
  v.volume = volume;
  startSource(s.url, s.streamType, s.referer, pb);
  setActivity(conn?.sdk, current);
  showOverlay();
}

function startSource(url, type, referer, pb) {
  const v = video();
  const src = proxy(url, referer);
  const onReady = () => { if (ready) return; ready = true; applyPlayback(pb || R.playback, true); };
  if (type === 'hls' && Hls.isSupported()) {
    hls = new Hls({ enableWorker: true, backBufferLength: 60, maxBufferLength: 45, fragLoadingMaxRetry: 4 });
    hls.loadSource(src); hls.attachMedia(v);
    hls.on(Hls.Events.MANIFEST_PARSED, onReady);
    hls.on(Hls.Events.ERROR, (_, d) => { if (!d.fatal) return; if (d.type === Hls.ErrorTypes.MEDIA_ERROR && ready) return hls.recoverMediaError(); fail(d.details); });
  } else {
    v.src = src;
    v.addEventListener('loadedmetadata', onReady, { once: true });
  }
  v.onerror = () => fail(v.error ? `media ${v.error.code}` : 'media');
}

function fail(reason) {
  const s = R?.current?.stream;
  if (s?.altUrl && !triedAlt) { triedAlt = true; toast('hls hakt – probiere mp4 …'); if (hls) { hls.destroy(); hls = null; } ready = false; startSource(s.altUrl, s.altType || 'mp4', s.referer, R.playback); return; }
  if (errorSent) return; errorSent = true;
  if (isHost()) send({ type: 'player_error', message: reason });
  else toast('bei dir spielt dieser hoster nicht – der host kann oben den hoster wechseln', 5000);
}

/** target position right now according to the server */
function expected(pb) {
  pb = pb || R?.playback; if (!pb) return 0;
  return pb.playing ? pb.position + (serverNow() - pb.at) / 1000 : pb.position;
}

function applyPlayback(pb, force) {
  lastPlaybackMsg = pb;
  const v = video();
  if (!ready || !v || v.classList.contains('hidden')) return;
  const target = expected(pb);
  if (force || Math.abs(v.currentTime - target) > 1.2) { suppressEvents = true; try { v.currentTime = Math.max(0, target); } catch {} setTimeout(() => (suppressEvents = false), 300); }
  if (pb.playing) {
    v.play().then(() => { unlocked = true; $('unlock').classList.add('hidden'); }).catch(() => { $('unlock').classList.remove('hidden'); });
  } else {
    v.pause();
  }
  osd(pb.playing ? 'play' : 'pause');
}

// drift correction + host reports
setInterval(() => {
  const v = video(); const pb = R?.playback;
  if (!v || !ready || !pb || v.classList.contains('hidden')) return;
  if (pb.playing && !v.paused) {
    const drift = v.currentTime - expected(pb);
    if (Math.abs(drift) > 2.5 && !isHost()) { suppressEvents = true; v.currentTime = expected(pb); setTimeout(() => (suppressEvents = false), 300); }
    else if (Math.abs(drift) > 0.4 && !isHost()) v.playbackRate = drift > 0 ? 0.95 : 1.05; // gentle catch-up
    else v.playbackRate = 1;
  }
  if (pb.playing && v.paused && unlocked) v.play().catch(() => {});
  if (!pb.playing && !v.paused) v.pause();
  if (isHost()) send({ type: 'report', position: v.currentTime, duration: v.duration || 0 });
  renderTimes();
}, 2000);

let osdTimer;
function osd(name, text) {
  const el = $('osd'); if (!el) return;
  el.innerHTML = icon(name) + (text ? `<span>${esc(text)}</span>` : '');
  el.style.opacity = 1; clearTimeout(osdTimer); osdTimer = setTimeout(() => (el.style.opacity = 0), 700);
}
let overlayTimer;
function showOverlay() { const o = $('overlay'); if (!o) return; o.classList.remove('hidden-soft'); clearTimeout(overlayTimer); overlayTimer = setTimeout(() => o.classList.add('hidden-soft'), 4000); }

function bindVideo() {
  const v = video();
  v.addEventListener('ended', () => { if (isHost()) send({ type: 'ended' }); });
  v.addEventListener('timeupdate', renderTimes);
  // a host pausing via keyboard/media keys should pause everyone
  v.addEventListener('pause', () => { if (suppressEvents || !ready || v.ended || leaving || document.visibilityState === 'hidden') return; if (isHost() && R.playback.playing && Math.abs(v.currentTime - (v.duration || 0)) > 1) send({ type: 'pause' }); });
  v.addEventListener('play', () => { if (suppressEvents || !ready || leaving) return; if (isHost() && !R.playback.playing) send({ type: 'play' }); });
  $('screen').addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (!unlocked) { unlocked = true; $('unlock').classList.add('hidden'); applyPlayback(R.playback, true); return; }
    if (canControl()) send({ type: 'toggle' }); else showOverlay();
  });
  $('screen').addEventListener('dblclick', toggleFullscreen);
  document.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); if (canControl()) send({ type: 'toggle' }); }
    if (e.key === 'ArrowRight' && canControl()) send({ type: 'seek', delta: 10 });
    if (e.key === 'ArrowLeft' && canControl()) send({ type: 'seek', delta: -10 });
    if (e.key === 'f') toggleFullscreen();
    if (e.key === 'm') { v.muted = !v.muted; renderControls(); }
  });
}
function toggleFullscreen() {
  const el = $('stage');
  if (document.fullscreenElement) document.exitFullscreen?.();
  else el.requestFullscreen?.().catch(() => {});
}

// ─────────────────────────────────────────────────────────────────────────────
// render
// ─────────────────────────────────────────────────────────────────────────────
function renderLayout() {
  $('app').innerHTML = `
  <div class="layout">
    <header class="win topbar">
      <div class="win-body">
        <div class="brand">ani<span>watch</span></div>
        <span class="status-dot" id="conn-dot" title="verbindung"></span>
        <div class="members" id="members"></div>
        <span class="spacer"></span>
        <span class="xs muted" id="role-label"></span>
        <button class="btn icon side-toggle" id="side-toggle" title="menü">${icon('list')}</button>
      </div>
    </header>

    <section class="win stage" id="stage">
      <div class="win-body">
        <div class="screen" id="screen">
          <video id="video" playsinline preload="auto"></video>
          <iframe id="frame" class="hidden" allow="autoplay; fullscreen; encrypted-media" allowfullscreen referrerpolicy="no-referrer"></iframe>
          <div class="idle" id="idle">
            <div class="wordmark">ani<span>watch</span></div>
            <div>es läuft noch nichts.</div>
            <div class="xs" id="idle-hint"></div>
          </div>
          <div class="overlay hidden-soft" id="overlay"></div>
          <div class="osd" id="osd" style="opacity:0"></div>
          <div class="center hidden" id="unlock"><div class="win"><div class="win-body" style="text-align:center"><div class="pixel" style="font-size:16px;margin-bottom:8px">bereit?</div><button class="btn primary big" id="unlock-btn">${icon('play')} mitschauen</button><div class="xs muted" style="margin-top:6px">ein klick, damit der browser ton abspielen darf</div></div></div></div>
        </div>
        <div class="controls" id="controls"></div>
      </div>
    </section>

    <aside class="side" id="side">
      <div class="tabs">
        <button class="tab active" data-tab="search">suche</button>
        <button class="tab" data-tab="queue">warteschlange<span class="count" id="q-count"></span></button>
        <button class="tab" data-tab="people">leute<span class="count" id="p-count"></span></button>
      </div>
      <div class="win">
        <div class="win-body">
          <section class="panel active" id="panel-search">
            <div class="search">
              <input class="input" id="q" placeholder="anime suchen oder aniworld-link …" autocomplete="off" autocapitalize="none" spellcheck="false" />
              <div class="suggest hidden" id="suggest"></div>
            </div>
            <div id="anime-view" class="hidden" style="margin-top:10px"></div>
            <div id="profile-view" style="margin-top:10px"></div>
          </section>
          <section class="panel" id="panel-queue"></section>
          <section class="panel" id="panel-people"></section>
        </div>
      </div>
    </aside>
  </div>`;
  bindVideo();
  bindSearch();
  $('unlock-btn').addEventListener('click', (e) => { e.stopPropagation(); unlocked = true; $('unlock').classList.add('hidden'); applyPlayback(R.playback, true); });
  $('side-toggle').addEventListener('click', () => $('side').classList.toggle('open'));
  document.querySelectorAll('.tab[data-tab]').forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t)); document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${tab}`)); }));
  $('controls').addEventListener('click', onControlClick);
  $('panel-queue').addEventListener('click', onQueueClick);
  $('panel-people').addEventListener('click', onPeopleClick);
  $('panel-people').addEventListener('submit', (e) => { e.preventDefault(); const i = $('chat-input'); if (i.value.trim()) { send({ type: 'chat', text: i.value.trim() }); i.value = ''; } });
  loadProfile();
}

function renderAll() {
  if (!R) return;
  $('members').innerHTML = R.members.map((m) => { const host = m.id === R.hostId; return `<span class="chip member ${host ? 'host' : ''} ${m.id === me().id ? 'me' : ''}" title="${esc(m.name)}${host ? ' · host' : ''}${m.aniworld ? ' · aniworld: ' + esc(m.aniworld) : ''}">${avatar(m, host)}<span class="truncate">${esc(m.name)}</span>${host ? icon('crown') : ''}</span>`; }).join('');
  $('role-label').textContent = isHost() ? 'du bist host' : canControl() ? 'alle dürfen steuern' : `host: ${R.members.find((m) => m.id === R.hostId)?.name || '–'}`;
  $('idle-hint').textContent = canControl() ? 'such rechts einen anime und drück ▶' : 'der host sucht gerade was aus. du kannst schon mal was in die warteschlange legen.';
  $('q-count').textContent = R.queue.length ? R.queue.length : '';
  $('p-count').textContent = R.members.length;
  const c = R.current;
  $('overlay').innerHTML = c ? `<div class="t1 truncate">${esc(c.anime.title)}</div><div class="truncate">${esc(epLabel(c.episode))} · ${esc(c.episode.title)}</div><div class="xs muted">${esc(c.stream?.hosterName || '')} · ${esc(c.stream?.langLabel || '')}</div>` : '';
  renderControls();
  renderQueue();
  renderPeople();
  if (anime) renderAnime();
}
const avatar = (m, host) => (m.avatar ? `<img class="avatar ${host ? 'host' : ''}" src="${img(m.avatar)}" title="${esc(m.name)}${host ? ' (host)' : ''}" alt="">` : `<span class="avatar ${host ? 'host' : ''}" title="${esc(m.name)}${host ? ' (host)' : ''}">${esc(m.name.slice(0, 1).toUpperCase())}</span>`);

function renderControls() {
  if (!R) return;
  const c = R.current, pb = R.playback, ctl = canControl();
  if (!c) { $('controls').innerHTML = `<div class="viewer-note">${ctl ? 'nichts geladen. suche → episode → ▶' : 'warte auf den host …'}</div>`; return; }
  const hosters = (c.hosters || []).filter((h) => h.langKey === (c.stream?.langKey || 1));
  const langs = [...new Set((c.hosters || []).map((h) => h.langKey))].sort((a, b) => [1, 3, 2, 4].indexOf(a) - [1, 3, 2, 4].indexOf(b));
  $('controls').innerHTML = `
    <div class="progress clickable" id="seekbar"><i id="seekfill" style="width:0%"></i></div>
    <div class="times"><span id="t-cur">0:00</span><span class="truncate np" style="text-align:center">${esc(c.anime.title)} · ${esc(epLabel(c.episode))} · ${esc(c.episode.title)}</span><span id="t-dur">${pb.duration ? fmt(pb.duration) : '–:––'}</span></div>
    <div class="bar">
      ${ctl ? `<button class="btn primary" data-act="toggle" title="play/pause">${icon(pb.playing ? 'pause' : 'play', 'lg')}</button>
      <button class="btn icon" data-act="seek" data-v="-30" title="-30s">${icon('rew')}</button>
      <button class="btn icon" data-act="seek" data-v="-10" title="-10s">-10</button>
      <button class="btn icon" data-act="seek" data-v="10" title="+10s">+10</button>
      <button class="btn icon" data-act="seek" data-v="30" title="+30s">${icon('fwd')}</button>
      <button class="btn icon" data-act="next" title="nächste folge">${icon('next')}</button>
      <button class="btn icon" data-act="stop" title="stop">${icon('stop')}</button>` : `<span class="chip">${icon(pb.playing ? 'play' : 'pause')} ${pb.playing ? 'läuft' : 'pause'}</span>`}
      <span class="spacer"></span>
      <span class="vol"><button class="btn icon" data-act="mute">${icon(video()?.muted ? 'mute' : 'volume')}</button><input type="range" id="vol" min="0" max="100" value="${Math.round(volume * 100)}"></span>
      <button class="btn icon" data-act="resync" title="neu synchronisieren">${icon('sync')}</button>
      <button class="btn icon" data-act="fs" title="vollbild">${icon('fullscreen')}</button>
    </div>
    <div class="bar">
      <span class="xs muted">sprache</span>${langs.map((l) => `<button class="chip ${l === c.stream?.langKey ? 'active' : ''}" data-act="lang" data-v="${l}" ${ctl ? '' : 'disabled'}>${LANG[l] || l}</button>`).join('')}
      <span class="xs muted" style="margin-left:6px">hoster</span>${hosters.map((h) => `<button class="chip ${h.id === c.stream?.hosterId ? 'active' : ''}" data-act="hoster" data-v="${esc(h.id)}" ${ctl ? '' : 'disabled'}>${esc(h.hosterName)}</button>`).join('')}
      ${c.stream?.streamType === 'embed' ? '<span class="chip accent">iframe · keine sync</span>' : ''}
    </div>`;
  $('seekbar').addEventListener('click', (e) => { if (!ctl || !pb.duration) return; const r = e.currentTarget.getBoundingClientRect(); send({ type: 'seek_to', position: ((e.clientX - r.left) / r.width) * pb.duration }); });
  $('vol').addEventListener('input', (e) => { volume = e.target.value / 100; localStorage.setItem('aniwatch:vol', volume); const v = video(); v.volume = volume; v.muted = false; });
  renderTimes();
}
function renderTimes() {
  const pb = R?.playback; if (!pb || !$('t-cur')) return;
  const v = video(); const pos = ready && v && !v.classList.contains('hidden') ? v.currentTime : expected(pb);
  const dur = pb.duration || v?.duration || 0;
  $('t-cur').textContent = fmt(pos);
  if (dur) { $('t-dur').textContent = fmt(dur); $('seekfill').style.width = Math.min(100, (pos / dur) * 100) + '%'; }
}
function onControlClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const v = video();
  switch (b.dataset.act) {
    case 'toggle': send({ type: 'toggle' }); break;
    case 'seek': send({ type: 'seek', delta: parseInt(b.dataset.v, 10) }); break;
    case 'next': send({ type: 'next' }); break;
    case 'stop': if (confirm('wiedergabe für alle stoppen?')) send({ type: 'stop' }); break;
    case 'lang': send({ type: 'lang', langKey: parseInt(b.dataset.v, 10) }); toast('wechsle sprache …'); break;
    case 'hoster': send({ type: 'hoster', hosterId: b.dataset.v }); toast('wechsle hoster …'); break;
    case 'mute': v.muted = !v.muted; renderControls(); break;
    case 'resync': applyPlayback(R.playback, true); toast('synchronisiert'); break;
    case 'fs': toggleFullscreen(); break;
  }
}

// ── search ──
let suggestTimer, suggestItems = [], suggestIdx = -1;
function bindSearch() {
  const q = $('q'), box = $('suggest');
  q.addEventListener('input', () => {
    clearTimeout(suggestTimer);
    const val = q.value.trim();
    if (/aniworld\.to\/anime\/stream\//i.test(val)) { box.classList.add('hidden'); return; }
    if (val.length < 2) { box.classList.add('hidden'); return; }
    suggestTimer = setTimeout(async () => {
      try {
        const { results } = await api(`/api/search?q=${encodeURIComponent(val)}`);
        if (q.value.trim() !== val) return;
        suggestItems = results.slice(0, 8); suggestIdx = -1;
        box.innerHTML = suggestItems.length ? suggestItems.map((r, i) => `<div class="item" data-i="${i}">${r.cover ? `<img src="${img(r.cover)}" alt="">` : ''}<div style="min-width:0"><div class="t truncate">${esc(r.title)}</div><div class="s truncate">${esc(r.year || '')}${r.description ? ' · ' + esc(r.description) : ''}</div></div></div>`).join('') : '<div class="item muted">nichts gefunden</div>';
        box.classList.remove('hidden');
      } catch (e) { toast(e.message); }
    }, 250);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!suggestItems.length) return; suggestIdx = (suggestIdx + (e.key === 'ArrowDown' ? 1 : -1) + suggestItems.length) % suggestItems.length; box.querySelectorAll('.item').forEach((el, i) => el.classList.toggle('active', i === suggestIdx)); }
    if (e.key === 'Enter') { e.preventDefault(); const val = q.value.trim(); if (/aniworld\.to\/anime\/stream\//i.test(val)) return openAnime(val.match(/stream\/([a-z0-9-]+)/i)[1]); const pick = suggestItems[suggestIdx >= 0 ? suggestIdx : 0]; if (pick) openAnime(pick.slug); }
    if (e.key === 'Escape') box.classList.add('hidden');
  });
  box.addEventListener('click', (e) => { const it = e.target.closest('[data-i]'); if (it) openAnime(suggestItems[+it.dataset.i].slug); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.search')) box.classList.add('hidden'); });
  $('anime-view').addEventListener('click', onAnimeClick);
  $('profile-view').addEventListener('click', onProfileClick);
  $('profile-view').addEventListener('submit', onProfileSubmit);
}

async function openAnime(slug, seasonHref) {
  $('suggest').classList.add('hidden'); $('q').blur();
  $('anime-view').classList.remove('hidden');
  $('anime-view').innerHTML = `<div class="empty-note"><span class="blink accent">▮</span> lade …</div>`;
  try {
    const { anime: a } = await api(`/api/anime/${encodeURIComponent(slug)}`);
    const season = (seasonHref && a.seasons.find((s) => s.href === seasonHref)) || a.seasons.find((s) => s.num > 0) || a.seasons[0];
    const { episodes } = await api(`/api/season?href=${encodeURIComponent(season.href)}`);
    anime = { ...a, seasonHref: season.href, episodes };
    renderAnime();
  } catch (e) { $('anime-view').innerHTML = `<div class="empty-note">✗ ${esc(e.message)}</div>`; }
}
function renderAnime() {
  const a = anime; if (!a) return;
  const seen = P?.watchedHrefs;
  const ctl = canControl();
  $('anime-view').innerHTML = `
    <div class="anime-head">${a.cover ? `<img src="${img(a.cover)}" alt="">` : ''}<div style="min-width:0;flex:1"><h2>${esc(a.title)}</h2><div class="row wrap xs">${a.year ? `<span class="chip">${esc(a.year)}</span>` : ''}${a.fsk ? `<span class="chip">fsk ${esc(a.fsk)}</span>` : ''}${(a.genres || []).filter((g) => !/^(ger|gersub|engsub|eng)$/i.test(g)).slice(0, 3).map((g) => `<span class="chip muted">${esc(g.toLowerCase())}</span>`).join('')}</div><p class="desc" onclick="this.classList.toggle('open')">${esc(a.description || '')}</p></div></div>
    <div class="row wrap" style="margin-top:8px">${a.seasons.map((s) => `<button class="chip ${s.href === a.seasonHref ? 'active' : ''}" data-season="${esc(s.href)}">${esc(s.label.toLowerCase())}</button>`).join('')}</div>
    <div class="row between" style="margin-top:8px"><span class="section-label" style="margin:0">episoden · ${a.episodes.length}</span><button class="btn" data-queue-season title="alle folgen dieser staffel einreihen">${icon('plus')} staffel</button></div>
    <ul class="list" style="margin-top:6px">${a.episodes.map((e) => {
      const playing = R?.current?.episode?.href === e.href;
      const queued = R?.queue.some((q) => q.episode.href === e.href);
      const isSeen = !playing && seen?.has(e.href);
      return `<li class="ep ${playing ? 'playing' : ''} ${isSeen ? 'seen' : ''}"><span class="num">${e.seasonNum === 0 ? 'F' : ''}${e.num}</span><span class="body"><span class="title">${esc(e.title)}</span><span class="sub">${e.titleEn ? esc(e.titleEn) + ' · ' : ''}${(e.langs || []).map((l) => `<span class="lang ${l === 1 ? 'de' : ''}">${LANG_SHORT[l] || l}</span>`).join(' ')}${isSeen ? ' · gesehen' : ''}</span></span>
        <span class="acts">${ctl ? `<button class="btn" data-play="${esc(e.href)}" title="jetzt abspielen">${icon('play')}</button>` : ''}<button class="btn" data-queue="${esc(e.href)}" title="in die warteschlange" ${queued ? 'disabled' : ''}>${queued ? icon('check') : icon('plus')}</button></span></li>`;
    }).join('')}</ul>`;
}
function qItem(e) { return { anime: { slug: anime.slug, title: anime.title, cover: anime.cover }, episode: { href: e.href, num: e.num, seasonNum: e.seasonNum, title: e.title } }; }
function onAnimeClick(e) {
  const s = e.target.closest('[data-season]'); if (s) return openAnime(anime.slug, s.dataset.season);
  const p = e.target.closest('[data-play]'); if (p) { send({ type: 'start', href: p.dataset.play }); toast('starte …'); return; }
  const q = e.target.closest('[data-queue]'); if (q) { const ep = anime.episodes.find((x) => x.href === q.dataset.queue); if (ep) send({ type: 'queue_add', items: [qItem(ep)] }); return; }
  if (e.target.closest('[data-queue-season]')) { const items = anime.episodes.filter((x) => x.href !== R?.current?.episode?.href).map(qItem); send({ type: 'queue_add', items }); toast(`${items.length} folgen eingereiht`); }
}

// ── profile ──
async function loadProfile() {
  const name = me()?.aniworld;
  renderProfileBox();
  if (!name) { P = null; return; }
  try {
    const { profile } = await api(`/api/profile/${encodeURIComponent(name)}`);
    P = { ...profile, watchedHrefs: new Set(profile.watchedHrefs || []) };
    renderProfileBox(); if (anime) renderAnime();
  } catch (e) { toast('profil: ' + e.message); }
}
function renderProfileBox() {
  const name = me()?.aniworld || '';
  const card = (a, badge) => `<li class="poster-card" data-slug="${esc(a.slug)}" ${a.href && /staffel|filme/.test(a.href) ? `data-season="${esc(a.href.match(/^(\/anime\/stream\/[^/]+\/(?:staffel-\d+|filme))/)?.[1] || '')}"` : ''} title="${esc(a.title)}"><div class="poster">${a.cover ? `<img src="${img(a.cover)}" alt="" loading="lazy">` : ''}${badge ? `<span class="badge">${esc(badge)}</span>` : ''}</div><div class="name">${esc(a.title)}</div></li>`;
  $('profile-view').innerHTML = `
    <div class="win win-dashed"><div class="win-title"><span class="dots"><i></i><i></i><i></i></span><span class="title">mein aniworld-profil</span><span class="right">${P?.episodes ? `${P.episodes} folgen` : ''}</span></div>
    <div class="win-body"><form class="row" id="profile-form"><input class="input" id="profile-name" placeholder="aniworld-name (optional)" value="${esc(name)}" autocapitalize="none" spellcheck="false"><button class="btn" type="submit">ok</button></form>
    <div class="xs muted" style="margin-top:4px">zeigt zuletzt geschaut, watchlist und abos; gesehene folgen werden markiert.</div></div></div>
    ${P ? `
    <div class="section-label">zuletzt geschaut</div><ul class="poster-grid">${P.recent.slice(0, 12).map((a) => card(a, a.episodeNum ? epLabel({ seasonNum: a.seasonNum ?? 1, num: a.episodeNum }) : '')).join('')}</ul>
    <div class="section-label">watchlist · ${P.watchlist.length}</div><ul class="poster-grid">${P.watchlist.slice(0, 12).map((a) => card(a)).join('')}</ul>
    <div class="section-label">abonniert · ${P.subscribed.length}</div><ul class="poster-grid">${P.subscribed.slice(0, 12).map((a) => card(a)).join('')}</ul>` : ''}`;
}
function onProfileClick(e) { const li = e.target.closest('[data-slug]'); if (li) openAnime(li.dataset.slug, li.dataset.season || undefined); }
async function onProfileSubmit(e) {
  e.preventDefault();
  const name = $('profile-name').value.trim();
  try { await api('/api/me/aniworld', { name }); conn.user.aniworld = name || null; toast(name ? `profil „${name}“ gespeichert` : 'profil entfernt'); loadProfile(); } catch (err) { toast('✗ ' + err.message); }
}

// ── queue ──
function renderQueue() {
  const ctl = canControl();
  $('panel-queue').innerHTML = `
    <div class="row between"><span class="section-label" style="margin:0">warteschlange · ${R.queue.length}</span>
      <span class="row"><span class="xs muted">autoplay</span><span class="switch ${R.settings.autoplay ? 'on' : ''}" data-act="autoplay" title="nächste folge automatisch"></span>${ctl ? `<button class="btn" data-act="next">${icon('next')} weiter</button>` : ''}</span></div>
    <div class="xs muted" style="margin:4px 0 8px">jeder darf einreihen. läuft die warteschlange leer, geht es mit der nächsten folge des aktuellen animes weiter.</div>
    ${R.queue.length ? `<div class="list">${R.queue.map((q, i) => `<div class="q-item"><span class="n">${i + 1}</span>${q.anime.cover ? `<img src="${img(q.anime.cover)}" alt="">` : ''}<div class="body"><div class="truncate">${esc(q.anime.title)}</div><div class="xs muted truncate">${esc(epLabel(q.episode))} · ${esc(q.episode.title)} · von ${esc(q.addedBy.name)}</div></div>
      <span class="acts">${ctl ? `<button class="btn" data-act="qplay" data-id="${q.id}" title="jetzt">${icon('play')}</button><button class="btn" data-act="qup" data-id="${q.id}">${icon('up')}</button><button class="btn" data-act="qdown" data-id="${q.id}">${icon('down')}</button>` : ''}${ctl || q.addedBy.id === me().id ? `<button class="btn" data-act="qdel" data-id="${q.id}">${icon('x')}</button>` : ''}</span></div>`).join('')}</div>
    ${ctl ? `<div style="margin-top:8px"><button class="btn" data-act="qclear">leeren</button></div>` : ''}` : `<div class="empty-note">leer. such rechts was raus und drück ${icon('plus')}</div>`}`;
}
function onQueueClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.dataset.id;
  switch (b.dataset.act) {
    case 'autoplay': send({ type: 'autoplay', value: !R.settings.autoplay }); break;
    case 'next': send({ type: 'next' }); break;
    case 'qplay': send({ type: 'queue_play', id }); break;
    case 'qup': send({ type: 'queue_move', id, dir: -1 }); break;
    case 'qdown': send({ type: 'queue_move', id, dir: 1 }); break;
    case 'qdel': send({ type: 'queue_remove', id }); break;
    case 'qclear': if (confirm('warteschlange leeren?')) send({ type: 'queue_clear' }); break;
  }
}

// ── people + chat ──
function renderPeople() {
  const host = isHost();
  $('panel-people').innerHTML = `
    <div class="section-label" style="margin-top:0">im raum · ${R.members.length}</div>
    <div class="list">${R.members.map((m) => `<div class="person">${avatar(m, m.id === R.hostId)}<span class="truncate" style="flex:1">${esc(m.name)}${m.id === me().id ? ' <span class="muted">(du)</span>' : ''}${m.aniworld ? ` <span class="xs muted">· aw: ${esc(m.aniworld)}</span>` : ''}</span>${m.id === R.hostId ? `<span class="chip accent">${icon('crown')} host</span>` : host ? `<button class="btn" data-act="host" data-id="${esc(m.id)}" title="zum host machen">${icon('crown')}</button>` : ''}</div>`).join('')}</div>
    ${host ? `<div class="row between" style="margin-top:8px"><span class="sm">alle dürfen steuern</span><span class="switch ${R.openControl ? 'on' : ''}" data-act="open"></span></div>` : ''}
    <hr class="dotted-hr">
    <div class="section-label">chat</div>
    <div class="chat-log" id="chat-log"></div>
    <form class="chat-form" id="chat-form"><input class="input" id="chat-input" placeholder="sag was …" maxlength="300" autocomplete="off"><button class="btn" type="submit">→</button></form>`;
  renderChat();
}
function renderChat() {
  const log = $('chat-log'); if (!log) return;
  log.innerHTML = (R.chat || []).map((m) => (m.type === 'system' ? `<div class="m sys">· ${esc(m.text)}</div>` : `<div class="m"><span class="who">${esc(m.user?.name || '?')}</span><span style="min-width:0;word-break:break-word">${esc(m.text)}</span></div>`)).join('');
  log.scrollTop = log.scrollHeight;
}
function onPeopleClick(e) {
  const b = e.target.closest('[data-act]'); if (!b) return;
  if (b.dataset.act === 'host' && confirm('host-rolle abgeben?')) send({ type: 'set_host', userId: b.dataset.id });
  if (b.dataset.act === 'open') send({ type: 'open_control', value: !R.openControl });
}

if (!insideDiscord()) document.title = 'aniwatch · dev';

// debugging hook (console): aniwatch.state, aniwatch.send({type:'ping'})
window.aniwatch = { get state() { return R; }, get me() { return me(); }, send, get video() { return video(); } };

/**
 * server/rooms.js – one Room per Discord activity instance.
 *
 * Roles: the first person in the room is the host. The host controls playback
 * (play/pause/seek/select/skip), can hand the host role over, and can set
 * "everyone may control". Everybody can add to the queue.
 *
 * Playback is server-authoritative: { playing, position, at }. Clients derive
 * the expected position from (position + (now - at)) and correct drift.
 *
 * When an episode ends: next from the queue; if the queue is empty and autoplay
 * is on, the next episode of the same anime (across seasons).
 */

const aw = require('../lib/aniworld');
const { resolveEpisode, resolveHoster, hosterOptions } = require('../lib/stream-resolve');
const db = require('./db');

const rooms = new Map();

class Room {
  constructor(id) {
    this.id = id;
    this.hostId = null;
    this.openControl = false; // everyone may control
    this.settings = { langKey: 1, autoplay: true };
    this.members = new Map(); // userId → { id, name, avatar, aniworld, sockets:Set }
    this.queue = []; // [{ id, anime:{slug,title,cover}, episode:{href,num,seasonNum,title}, addedBy:{id,name} }]
    this.current = null; // { anime, episode, stream, hosters, episodes, seasonHref }
    this.playback = { playing: false, position: 0, at: Date.now(), duration: 0 };
    this.busy = null;
    this.playSeq = 0;
    this.failedHosterIds = [];
    this.endedFor = null;
    this.lastProgressSave = 0;
    this.listeners = new Set(); // fn(type, payload)
    this.chat = []; // last 50 messages
    this.hostGrace = null;
    this.restore();
  }

  // ── persistence ──
  persist() {
    db.saveRoom(this.id, {
      hostId: this.hostId,
      openControl: this.openControl,
      settings: this.settings,
      queue: this.queue,
      current: this.current,
      playback: this.playback,
    });
  }
  restore() {
    const s = db.loadRoom(this.id);
    if (!s) return;
    this.hostId = s.hostId || null;
    this.openControl = !!s.openControl;
    this.settings = { ...this.settings, ...(s.settings || {}) };
    this.queue = s.queue || [];
    this.current = s.current || null;
    if (s.playback) this.playback = { ...s.playback, playing: false, at: Date.now() };
  }

  // ── members ──
  join(user, ws) {
    let m = this.members.get(user.id);
    if (!m) {
      m = { id: user.id, name: user.name, avatar: user.avatar || null, aniworld: user.aniworld || null, sockets: new Set() };
      this.members.set(user.id, m);
    }
    m.name = user.name;
    m.avatar = user.avatar || m.avatar;
    m.aniworld = user.aniworld ?? m.aniworld;
    m.sockets.add(ws);
    if (this.hostGrace && this.hostId === user.id) { clearTimeout(this.hostGrace); this.hostGrace = null; } // host is back (reload)
    if (!this.hostId || (!this.members.has(this.hostId) && !this.hostGrace)) this.hostId = user.id;
    this.emit('system', { text: `${user.name} ist dabei` });
    this.broadcast();
  }
  leave(user, ws) {
    const m = this.members.get(user.id);
    if (!m) return;
    m.sockets.delete(ws);
    if (m.sockets.size) return;
    this.members.delete(user.id);
    if (this.hostId === user.id && this.members.size) {
      // give the host 25 s to come back (page reload, short connection drop) before handing the role on
      clearTimeout(this.hostGrace);
      this.hostGrace = setTimeout(() => {
        this.hostGrace = null;
        if (this.members.has(this.hostId)) return;
        const next = this.members.keys().next().value || null;
        if (!next) return;
        this.hostId = next;
        this.emit('system', { text: `${this.members.get(next).name} ist jetzt host` });
        this.broadcast();
        this.persist();
      }, 25000);
    }
    this.emit('system', { text: `${user.name} ist weg` });
    this.broadcast();
    this.persist();
  }
  canControl(userId) {
    return this.openControl || userId === this.hostId;
  }
  isHost(userId) {
    return userId === this.hostId;
  }

  // ── messaging ──
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(type, payload = {}) {
    if (type === 'system' || type === 'chat') {
      const msg = { ...payload, type, at: Date.now() };
      this.chat.push(msg);
      if (this.chat.length > 50) this.chat.shift();
    }
    for (const fn of this.listeners) {
      try { fn(type, payload); } catch { /* ignore */ }
    }
  }
  broadcast() {
    this.emit('state', { state: this.snapshot() });
  }
  snapshot() {
    return {
      id: this.id,
      hostId: this.hostId,
      openControl: this.openControl,
      settings: this.settings,
      members: [...this.members.values()].map((m) => ({ id: m.id, name: m.name, avatar: m.avatar, aniworld: m.aniworld || null })),
      queue: this.queue,
      current: this.current && {
        anime: this.current.anime,
        episode: this.current.episode,
        seasonHref: this.current.seasonHref,
        episodes: this.current.episodes,
        hosters: hosterOptions(this.current.hosters || []),
        stream: this.current.stream && {
          url: this.current.stream.url,
          altUrl: this.current.stream.altUrl,
          altType: this.current.stream.altType,
          streamType: this.current.stream.streamType,
          embedUrl: this.current.stream.embedUrl,
          referer: this.current.stream.referer,
          hosterName: this.current.stream.hosterName,
          hosterId: this.current.stream.hosterId,
          langKey: this.current.stream.langKey,
          langLabel: this.current.stream.langLabel,
        },
      },
      playback: { ...this.playback, serverNow: Date.now() },
      busy: this.busy,
      chat: this.chat.slice(-30),
    };
  }
  setBusy(text) {
    this.busy = text || null;
    this.broadcast();
  }

  // ── playback bookkeeping ──
  expectedPosition() {
    const pb = this.playback;
    return pb.playing ? pb.position + (Date.now() - pb.at) / 1000 : pb.position;
  }
  setPlaying(playing, position) {
    this.playback = { ...this.playback, playing, position: position ?? this.expectedPosition(), at: Date.now() };
    this.emit('playback', { playback: { ...this.playback, serverNow: Date.now() } });
    this.persist();
  }
  seekTo(position) {
    this.playback = { ...this.playback, position: Math.max(0, position), at: Date.now() };
    this.emit('playback', { playback: { ...this.playback, serverNow: Date.now() } });
    this.persist();
  }
  /** a client reports where it really is (host only) – keeps the server clock honest */
  report(position, duration) {
    if (typeof duration === 'number' && duration > 0) this.playback.duration = duration;
    if (typeof position === 'number') {
      const drift = Math.abs(this.expectedPosition() - position);
      if (drift > 1.5) {
        this.playback = { ...this.playback, position, at: Date.now() };
        this.emit('playback', { playback: { ...this.playback, serverNow: Date.now() } });
      } else {
        this.playback.position = position;
        this.playback.at = Date.now();
      }
    }
    const now = Date.now();
    if (this.current?.episode && now - this.lastProgressSave > 5000) {
      this.lastProgressSave = now;
      db.saveProgress(this.id, this.current.episode.href, this.playback.position, this.playback.duration, false);
      this.persist();
    }
  }

  // ── content ──
  async play(href, opts = {}) {
    const seq = ++this.playSeq;
    this.setBusy('lade stream …');
    try {
      const ep = await aw.getEpisode(href);
      if (seq !== this.playSeq) return null;
      const slug = ep.href.split('/')[3];
      const seasonHref = ep.href.match(/^(\/anime\/stream\/[^/]+\/(?:staffel-\d+|filme))/)[1];
      const sameAnime = this.current?.anime?.slug === slug;
      const anime = sameAnime ? this.current.anime : await aw.getSeries(slug);
      const episodes = sameAnime && this.current.seasonHref === seasonHref ? this.current.episodes : await aw.getSeason(seasonHref);
      if (seq !== this.playSeq) return null;

      const langKey = opts.langKey || this.settings.langKey || 1;
      let stream;
      if (opts.hosterId) {
        const h = ep.hosters.find((x) => x.id === String(opts.hosterId));
        if (!h) throw new Error('Hoster nicht gefunden');
        stream = await resolveHoster(h, ep.url);
      } else {
        stream = await resolveEpisode(ep.hosters, ep.url, { langKey, exclude: opts.exclude || [] });
      }
      if (seq !== this.playSeq) return null;

      let position = 0;
      const prog = db.getProgress(this.id, ep.href);
      if (!opts.restart && opts.position == null && prog && !prog.finished && prog.position > 20 && (!prog.duration || prog.position < prog.duration * 0.93)) position = prog.position;
      if (opts.position != null) position = opts.position;

      this.current = {
        anime: { slug: anime.slug, title: anime.title, cover: anime.cover, url: anime.url, seasons: anime.seasons, description: anime.description, year: anime.year },
        episode: { href: ep.href, num: ep.num, seasonNum: ep.seasonNum, title: ep.title, titleEn: ep.titleEn },
        seasonHref,
        episodes,
        hosters: ep.hosters,
        stream,
      };
      this.failedHosterIds = opts.exclude ? [...opts.exclude] : [];
      this.endedFor = null;
      this.playback = { playing: true, position, at: Date.now() + 1500, duration: prog?.duration || 0 }; // small lead so everyone starts together
      if (opts.langKey && stream.langKey) this.settings.langKey = stream.langKey;
      this.emit('system', { text: `${opts.by ? opts.by + ' startet ' : ''}${anime.title} · ${label(this.current.episode)}` });
      this.emit('load', { current: this.snapshot().current, playback: { ...this.playback, serverNow: Date.now() } });
      this.persist();
      return this.current;
    } finally {
      if (seq === this.playSeq) this.setBusy(null);
    }
  }

  async switchHoster(hosterId) {
    if (!this.current) throw new Error('es läuft nichts');
    return this.play(this.current.episode.href, { hosterId, position: this.expectedPosition() });
  }

  async switchLang(langKey) {
    if (!this.current) throw new Error('es läuft nichts');
    return this.play(this.current.episode.href, { langKey, position: this.expectedPosition() });
  }

  /** the client that plays could not play this source → try another hoster */
  async playerError(message) {
    if (!this.current?.stream) return;
    if (this.failedHosterIds.length >= 4) {
      this.emit('toast', { text: 'kein hoster spielt diese folge (╥﹏╥)' });
      return;
    }
    const exclude = [...new Set([...this.failedHosterIds, this.current.stream.hosterId].filter(Boolean))];
    this.emit('toast', { text: `${this.current.stream.hosterName} spielt nicht – wechsle hoster …` });
    console.warn(`[Room ${this.id}] player error (${message || ''}) → fallback`);
    try {
      await this.play(this.current.episode.href, { exclude, position: this.expectedPosition(), langKey: this.current.stream.langKey });
    } catch (e) {
      this.emit('toast', { text: e.message.split('\n')[0] });
    }
  }

  nextEpisodeHref() {
    const cur = this.current;
    if (!cur) return null;
    const idx = cur.episodes.findIndex((e) => e.href === cur.episode.href);
    const next = cur.episodes[idx + 1];
    if (next) return next.href;
    const seasons = (cur.anime.seasons || []).filter((s) => s.num > 0).sort((a, b) => a.num - b.num);
    const si = seasons.findIndex((s) => s.href === cur.seasonHref);
    const target = seasons[si + 1];
    return target ? { seasonHref: target.href } : null;
  }

  /** episode finished: queue first, then autoplay */
  async ended() {
    const key = this.current?.episode?.href;
    if (!key || this.endedFor === key) return;
    this.endedFor = key;
    db.saveProgress(this.id, key, this.playback.duration, this.playback.duration, true);
    this.playback = { ...this.playback, playing: false, position: this.playback.duration || this.playback.position, at: Date.now() };
    this.broadcast();
    await this.advance();
  }

  async advance(by) {
    if (this.queue.length) {
      const item = this.queue.shift();
      this.broadcast();
      return this.play(item.episode.href, { restart: true, by });
    }
    if (!this.settings.autoplay && !by) return null;
    const n = this.nextEpisodeHref();
    if (!n) { this.emit('toast', { text: 'das war die letzte folge · warteschlange ist leer' }); return null; }
    if (typeof n === 'string') return this.play(n, { restart: true, by });
    const eps = await aw.getSeason(n.seasonHref);
    if (!eps.length) return null;
    return this.play(eps[0].href, { restart: true, by });
  }

  // ── queue ──
  addToQueue(items, user) {
    for (const it of items) {
      if (!it?.episode?.href || this.queue.some((q) => q.episode.href === it.episode.href)) continue;
      this.queue.push({ id: Math.random().toString(36).slice(2, 10), anime: it.anime, episode: it.episode, addedBy: { id: user.id, name: user.name } });
    }
    this.emit('system', { text: `${user.name} hat ${items.length === 1 ? label(items[0].episode) + ' von ' + items[0].anime.title : items.length + ' folgen'} in die warteschlange gelegt` });
    this.broadcast();
    this.persist();
  }
  removeFromQueue(id, user) {
    const i = this.queue.findIndex((q) => q.id === id);
    if (i === -1) return;
    const [it] = this.queue.splice(i, 1);
    if (it.addedBy.id !== user.id && !this.canControl(user.id)) { this.queue.splice(i, 0, it); throw new Error('nur host oder wer es eingereiht hat'); }
    this.broadcast();
    this.persist();
  }
  moveInQueue(id, dir) {
    const i = this.queue.findIndex((q) => q.id === id);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= this.queue.length) return;
    [this.queue[i], this.queue[j]] = [this.queue[j], this.queue[i]];
    this.broadcast();
    this.persist();
  }
  clearQueue() {
    this.queue = [];
    this.broadcast();
    this.persist();
  }

  stop() {
    this.playSeq++;
    this.current = null;
    this.playback = { playing: false, position: 0, at: Date.now(), duration: 0 };
    this.emit('stopped', {});
    this.broadcast();
    this.persist();
  }
}

function label(ep) {
  if (!ep) return '';
  return ep.seasonNum === 0 ? `Film ${ep.num}` : `S${ep.seasonNum}E${String(ep.num).padStart(2, '0')}`;
}

function getRoom(id) {
  let r = rooms.get(id);
  if (!r) {
    r = new Room(id);
    rooms.set(id, r);
  }
  return r;
}

// forget empty rooms after a while (state stays in sqlite)
setInterval(() => {
  for (const [id, r] of rooms) if (!r.members.size && !r.playback.playing) rooms.delete(id);
}, 10 * 60_000).unref();

module.exports = { getRoom, rooms, label };

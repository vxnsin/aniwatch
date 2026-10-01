/**
 * Discord Embedded App SDK glue.
 * Inside Discord: authorize → our /api/token → authenticate. Room = activity instance.
 * In a normal browser (no frame_id in the url, or ?dev=1): a dev session from the server, room from ?room=.
 */
import { DiscordSDK } from '@discord/embedded-app-sdk';

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || '';

export function insideDiscord() {
  const p = new URLSearchParams(location.search);
  return p.has('frame_id') && p.get('dev') !== '1';
}

export async function connect(onStatus = () => {}) {
  const p = new URLSearchParams(location.search);

  if (!insideDiscord()) {
    onStatus('dev-modus (ohne discord)');
    const name = p.get('name') || localStorage.getItem('aniwatch:devname') || `gast-${Math.random().toString(36).slice(2, 6)}`;
    localStorage.setItem('aniwatch:devname', name);
    const r = await fetch('/api/dev-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return { sdk: null, dev: true, user: j.user, session: j.session, roomId: p.get('room') || 'dev-room' };
  }

  if (!CLIENT_ID) throw new Error('VITE_DISCORD_CLIENT_ID fehlt – .env ausfüllen und neu bauen');
  const sdk = new DiscordSDK(CLIENT_ID);
  onStatus('warte auf discord …');
  await sdk.ready();
  onStatus('anmelden …');
  const { code } = await sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify', 'rpc.activities.write'],
  });
  const r = await fetch('/api/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || `token: HTTP ${r.status}`);
  await sdk.commands.authenticate({ access_token: j.access_token });
  return { sdk, dev: false, user: j.user, session: j.session, roomId: sdk.instanceId, channelId: sdk.channelId, guildId: sdk.guildId };
}

/** rich presence: "Schaut Solo Leveling – S1E01" (best effort) */
export async function setActivity(sdk, current) {
  if (!sdk) return;
  try {
    if (!current) return await sdk.commands.setActivity({ activity: { type: 3, details: 'aniwatch', state: 'sucht was zum schauen' } });
    const ep = current.episode;
    const label = ep.seasonNum === 0 ? `Film ${ep.num}` : `S${ep.seasonNum}E${String(ep.num).padStart(2, '0')}`;
    await sdk.commands.setActivity({
      activity: {
        type: 3,
        details: current.anime.title,
        state: `${label} · ${ep.title}`,
        timestamps: { start: Date.now() },
      },
    });
  } catch {
    /* presence is optional */
  }
}

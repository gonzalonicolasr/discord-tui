import { afterEach, expect, test } from "bun:test";

import { createVoiceActions } from "../../src/actions/voice";
import { createStore, emptyState } from "../../src/store/store";
import { createVoiceAdapterCreator } from "../../src/voice/adapter";
import { createOpusCodec } from "../../src/voice/opus";
import { createDjsVoiceSession } from "../../src/voice/session";
import { createVad } from "../../src/voice/vad";
import { rmsDbfs } from "../../src/voice/vad";
import { startFakeVoiceServer, type FakeVoiceServer } from "../fakes/fake-voice-server";
import { silence, sine440 } from "../helpers/pcm";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const GUILD = "100000000000000001";
const VOICE = "100000000000000003";
const ME = "100000000000000010";
const OTHER = "100000000000000011";

let server: FakeVoiceServer | null = null;
afterEach(() => {
  server?.stop();
  server = null;
});

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await Bun.sleep(10);
  }
}

test("mic → VAD → opus → voice server, and the other person's opus → mixer → playback", async () => {
  server = await startFakeVoiceServer();
  const srv = server;
  const store = createStore(emptyState());
  store.dispatch({
    type: "gw",
    t: "READY",
    d: { user: { id: ME, username: "gon" }, guilds: [{ id: GUILD, name: "g", channels: [{ id: VOICE, type: 2, name: "Voz" }] }] },
  });
  // Mic abierto al entrar (este test mide el pipeline, no la regla de "entrar silenciado").
  store.dispatch({ type: "settings/set", patch: { vadSensitivity: -40, joinMuted: false } });

  const listeners = new Set<(t: string, d: any) => void>();
  const gateway = {
    status: "ready" as const,
    on: (_ev: "dispatch", fn: (t: string, d: any) => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    send: (op: number, d: any) => {
      if (op !== 4) return;
      queueMicrotask(() => {
        const state = { guild_id: GUILD, channel_id: d.channel_id, user_id: ME, session_id: "s", self_mute: d.self_mute, self_deaf: d.self_deaf };
        store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: state });
        for (const fn of [...listeners]) {
          fn("VOICE_STATE_UPDATE", state);
          if (d.channel_id) fn("VOICE_SERVER_UPDATE", { guild_id: GUILD, endpoint: srv.endpoint, token: "t" });
        }
      });
    },
  };
  const session = createDjsVoiceSession({ adapterCreator: createVoiceAdapterCreator({ gateway, meId: () => ME }), meId: () => ME });

  const frameFns = new Set<(pcm: Uint8Array) => void>();
  const played: Uint8Array[] = [];
  const voice = createVoiceActions({
    store,
    session,
    media: {
      startCapture: async () => ({ onFrame: (fn) => (frameFns.add(fn), () => frameFns.delete(fn)), stop: async () => {} }),
      startPlayback: async () => ({ write: (pcm) => void played.push(pcm), stop: async () => {}, dropped: () => 0 }),
      createCodec: () => createOpusCodec(),
      createVad: (opts) => createVad(opts),
    },
  });

  await voice.toggleVoice(VOICE);
  await until(() => store.getState().voice.status === "connected" && frameFns.size > 0);

  // Yo hablo: 10 frames de tono y después silencio → ráfaga de Opus, 5 silencios y Speaking 0.
  const mic = (pcm: Uint8Array) => frameFns.forEach((fn) => fn(pcm));
  for (let i = 0; i < 10; i += 1) mic(sine440());
  expect(store.getState().voice.selfSpeaking).toBe(true);
  for (let i = 0; i < 20; i += 1) mic(silence());
  await until(() => srv.speaking.some((s) => s.speaking === 0));
  expect(store.getState().voice.selfSpeaking).toBe(false);
  expect(srv.received.length).toBeGreaterThanOrEqual(9 + 5);
  const decoder = createOpusCodec();
  const loudest = Math.max(...srv.received.filter((p) => p.length > 3).map((p) => rmsDbfs(decoder.decode(p))));
  expect(loudest).toBeGreaterThan(-20);

  // Muteado no sale nada.
  const before = srv.received.length;
  voice.toggleMute();
  for (let i = 0; i < 10; i += 1) mic(sine440());
  await Bun.sleep(50);
  expect(srv.received.length).toBe(before);

  // La otra persona habla: llega Opus cifrado, se decodifica, se mezcla y suena.
  const encoder = createOpusCodec();
  for (let i = 0; i < 15; i += 1) {
    srv.sendAudioFrom(OTHER, 777, encoder.encode(sine440()));
    await Bun.sleep(20);
  }
  await until(() => played.length >= 5);
  expect(Math.max(...played.map((p) => rmsDbfs(p)))).toBeGreaterThan(-25);
  expect(store.getState().voice.speaking[OTHER]).toBe(true);

  // Ensordecido: no suena nada nuevo.
  voice.toggleDeaf();
  const playedBefore = played.length;
  for (let i = 0; i < 10; i += 1) {
    srv.sendAudioFrom(OTHER, 777, encoder.encode(sine440()));
    await Bun.sleep(20);
  }
  await Bun.sleep(100);
  expect(played.length).toBe(playedBefore);

  await voice.leaveVoice();
  expect(store.getState().voice.channelId).toBeNull();
}, 20_000);

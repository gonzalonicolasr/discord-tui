import { describe, expect, test } from "bun:test";

import { createVoiceActions, type VoiceMedia } from "../../src/actions/voice";
import type { GoLive } from "../../src/golive/golive";
import { createStore, emptyState } from "../../src/store/store";
import type { VoiceSession, VoiceStatus } from "../../src/voice/session";

const GUILD = "100000000000000001";
const VOICE_A = "100000000000000003";
const VOICE_B = "100000000000000004";
const TEXT = "100000000000000002";
const ME = "100000000000000010";

function setup(opts: { micFails?: boolean; stream?: boolean; joinMuted?: boolean } = {}) {
  const store = createStore(emptyState());
  // Los tests de siempre corren con "entrar silenciado" apagado (= comportamiento de antes); los de esa regla lo prenden.
  store.dispatch({ type: "settings/set", patch: { joinMuted: opts.joinMuted ?? false } });
  store.dispatch({
    type: "gw",
    t: "READY",
    d: {
      user: { id: ME, username: "gon" },
      guilds: [
        {
          id: GUILD,
          name: "g",
          roles: [],
          channels: [
            { id: TEXT, type: 0, name: "general" },
            { id: VOICE_A, type: 2, name: "Voz" },
            { id: VOICE_B, type: 2, name: "Voz 2" },
          ],
        },
      ],
    },
  });
  const calls: string[] = [];
  const statusListeners = new Set<(s: VoiceStatus, e?: string) => void>();
  const emit = (s: VoiceStatus, e?: string) => statusListeners.forEach((fn) => fn(s, e));
  const session: VoiceSession = {
    async join(_g, channelId, flags) {
      calls.push(`join:${channelId}:${flags.selfMute}:${flags.selfDeaf}`);
      emit("joining");
      emit("connected");
    },
    setFlags(flags) {
      calls.push(`flags:${flags.selfMute}:${flags.selfDeaf}`);
    },
    async leave() {
      calls.push("leave");
      emit("idle");
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    sendOpus() {},
    setSpeaking() {},
    onSpeaking: () => () => {},
    onOpus: () => () => {},
    privacyCode: () => "123451234512345",
  };
  const stopped: string[] = [];
  const media: VoiceMedia = {
    async startCapture() {
      if (opts.micFails) throw new Error("no pude abrir el micrófono (pw-record: x)");
      return { onFrame: () => () => {}, stop: async () => void stopped.push("capture") };
    },
    async startPlayback() {
      return { write() {}, stop: async () => void stopped.push("playback"), dropped: () => 0 };
    },
    createCodec: () => ({ encode: (p) => p, decode: (o) => o }),
    createVad: () => ({ push: () => null, isOpen: false, thresholdDb: -45, levelDb: -96 }),
  };
  const stream: GoLive | undefined = opts.stream
    ? {
        start: async (monitor) => void calls.push(`stream:start:${monitor ?? ""}`),
        stop: async () => void calls.push("stream:stop"),
        toggle: async () => void calls.push("stream:toggle"),
        listMonitors: async () => [{ name: "DP-1", width: 1, height: 1, focused: true }],
        dispose() {},
      }
    : undefined;
  const voice = createVoiceActions({ store, session, media, stream });
  return { store, voice, calls, emit, stopped };
}

test("toggleVoice joins, and again leaves", async () => {
  const { store, voice, calls } = setup();
  await voice.toggleVoice(VOICE_A);
  expect(store.getState().voice).toMatchObject({ channelId: VOICE_A, guildId: GUILD, status: "connected" });
  await voice.toggleVoice(VOICE_A);
  expect(calls).toEqual([`join:${VOICE_A}:false:false`, "leave"]);
  expect(store.getState().voice.channelId).toBeNull();
});

test("toggleVoice on another channel of the same guild leaves first, then joins", async () => {
  const { voice, calls, store } = setup();
  await voice.toggleVoice(VOICE_A);
  await voice.toggleVoice(VOICE_B);
  expect(calls).toEqual([`join:${VOICE_A}:false:false`, "leave", `join:${VOICE_B}:false:false`]);
  expect(store.getState().voice.channelId).toBe(VOICE_B);
});

test("a text channel is not joined and shows a notice", async () => {
  const { voice, calls, store } = setup();
  await voice.toggleVoice(TEXT);
  expect(calls).toEqual([]);
  expect(Object.values(store.getState().notices)[0]?.text).toContain("canal de voz");
});

test("deafen also mutes; undeafen restores the previous mute; changes go out as setFlags", async () => {
  const { voice, store, calls } = setup();
  await voice.toggleVoice(VOICE_A);
  voice.toggleDeaf();
  expect(store.getState().voice).toMatchObject({ selfMute: true, selfDeaf: true });
  voice.toggleDeaf();
  expect(store.getState().voice).toMatchObject({ selfMute: false, selfDeaf: false });
  voice.toggleMute();
  voice.toggleDeaf();
  voice.toggleDeaf();
  expect(store.getState().voice).toMatchObject({ selfMute: true, selfDeaf: false });
  expect(calls.slice(1)).toEqual(["flags:true:true", "flags:false:false", "flags:true:false", "flags:true:true", "flags:true:false"]);
});

test("mute state carries into the next join", async () => {
  const { voice, calls } = setup();
  voice.toggleMute();
  await voice.toggleVoice(VOICE_A);
  expect(calls).toEqual([`join:${VOICE_A}:true:false`]);
});

describe("join muted", () => {
  test("on (the default), joining a channel by choice starts with the mic closed and Discord sees it", async () => {
    const store = createStore(emptyState());
    expect(store.getState().settings.joinMuted).toBe(true);
    const { voice, calls, store: s } = setup({ joinMuted: true });
    await voice.toggleVoice(VOICE_A);
    expect(calls).toEqual([`join:${VOICE_A}:true:false`]);
    expect(s.getState().voice).toMatchObject({ channelId: VOICE_A, selfMute: true, selfDeaf: false });
  });

  test("switching to another channel by choice also enters muted, even if the mic was open in the old one", async () => {
    const { voice, calls } = setup({ joinMuted: true });
    await voice.toggleVoice(VOICE_A);
    voice.toggleMute();
    await voice.toggleVoice(VOICE_B);
    expect(calls).toEqual([`join:${VOICE_A}:true:false`, "flags:false:false", "leave", `join:${VOICE_B}:true:false`]);
  });

  test("deafened stays deafened (and muted) on join, and undeafen still restores the mute from before", async () => {
    const { voice, store, calls } = setup({ joinMuted: true });
    voice.toggleDeaf();
    await voice.toggleVoice(VOICE_A);
    expect(calls).toEqual([`join:${VOICE_A}:true:true`]);
    voice.toggleDeaf();
    expect(store.getState().voice).toMatchObject({ selfMute: false, selfDeaf: false });
  });

  test("being moved by a moderator keeps the mic as it was (open)", async () => {
    const { voice, store, calls } = setup({ joinMuted: true });
    await voice.toggleVoice(VOICE_A);
    voice.toggleMute();
    store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A } });
    store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_B } });
    await Bun.sleep(5);
    expect(store.getState().voice).toMatchObject({ channelId: VOICE_B, selfMute: false });
    expect(calls).toContain(`join:${VOICE_B}:false:false`);
  });

  test("a reconnect of the session keeps the mic as it was (open)", async () => {
    const { voice, store, calls, emit } = setup({ joinMuted: true });
    await voice.toggleVoice(VOICE_A);
    voice.toggleMute();
    emit("reconnecting");
    emit("connected");
    await Bun.sleep(5);
    expect(store.getState().voice).toMatchObject({ channelId: VOICE_A, status: "connected", selfMute: false });
    expect(calls.filter((c) => c.startsWith("join:"))).toEqual([`join:${VOICE_A}:true:false`]);
  });

  test("a rejoin with saved flags (after a reload) keeps them, open mic included", async () => {
    const { voice, store, calls } = setup({ joinMuted: true });
    await voice.toggleVoice(VOICE_A, { flags: { selfMute: false, selfDeaf: false, muteBeforeDeaf: false } });
    expect(calls).toEqual([`join:${VOICE_A}:false:false`]);
    expect(store.getState().voice.selfMute).toBe(false);
  });

  test("a rejoin with saved flags restores mute/deaf too, so undeafen goes back to what it was", async () => {
    const { voice, store, calls } = setup({ joinMuted: false });
    await voice.toggleVoice(VOICE_A, { flags: { selfMute: true, selfDeaf: true, muteBeforeDeaf: false } });
    expect(calls).toEqual([`join:${VOICE_A}:true:true`]);
    voice.toggleDeaf();
    expect(store.getState().voice).toMatchObject({ selfMute: false, selfDeaf: false });
  });

  test("off, joining keeps whatever the mic was (today's behavior)", async () => {
    const { voice, calls } = setup({ joinMuted: false });
    await voice.toggleVoice(VOICE_A);
    expect(calls).toEqual([`join:${VOICE_A}:false:false`]);
  });
});

test("a session error leaves voice with the message and stops the audio", async () => {
  const { voice, store, emit, stopped } = setup();
  await voice.toggleVoice(VOICE_A);
  await Bun.sleep(5);
  emit("error", "Discord exige cifrado E2EE (DAVE) y no se pudo negociar");
  await Bun.sleep(5);
  expect(store.getState().voice).toMatchObject({ channelId: null, status: "error", error: "Discord exige cifrado E2EE (DAVE) y no se pudo negociar" });
  expect(stopped.sort()).toEqual(["capture", "playback"]);
});

test("without a mic it stays connected (listen only) and says why", async () => {
  const { voice, store } = setup({ micFails: true });
  await voice.toggleVoice(VOICE_A);
  await Bun.sleep(5);
  expect(store.getState().voice.status).toBe("connected");
  expect(store.getState().voice.micError).toContain("micrófono");
});

test("being removed from the channel by Discord leaves voice here too", async () => {
  const { voice, store, calls } = setup();
  await voice.toggleVoice(VOICE_A);
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A } });
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: null } });
  await Bun.sleep(5);
  expect(calls.at(-1)).toBe("leave");
  expect(store.getState().voice).toMatchObject({ channelId: null, error: "te desconectaron del canal" });
});

test("being moved to another voice channel rejoins the session there", async () => {
  const { voice, store, calls } = setup();
  await voice.toggleVoice(VOICE_A);
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A } });
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_B } });
  await Bun.sleep(5);
  expect(store.getState().voice).toMatchObject({ guildId: GUILD, channelId: VOICE_B, status: "connected" });
  expect(calls).toContain(`join:${VOICE_B}:false:false`);
});

test("leaving voice does not rejoin when our voice state still shows the old channel (regression)", async () => {
  const { voice, store, calls } = setup();
  await voice.toggleVoice(VOICE_A);
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A } });
  await voice.leaveVoice();
  // el channel_id null de Discord todavía no llegó: el estado sigue diciendo VOICE_A
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A, self_mute: true } });
  await Bun.sleep(5);
  expect(store.getState().voice.channelId).toBeNull();
  expect(calls.filter((c) => c.startsWith("join:"))).toEqual([`join:${VOICE_A}:false:false`]);
});

test("joining voice in another guild from another device does not pull this session there", async () => {
  const { voice, store, calls } = setup();
  await voice.toggleVoice(VOICE_A);
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A } });
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: "100000000000009999", user_id: ME, channel_id: "100000000000009998" } });
  await Bun.sleep(5);
  expect(calls.filter((c) => c.startsWith("join:"))).toEqual([`join:${VOICE_A}:false:false`]);
});

test("a move carries the current mute/deaf flags into the new join", async () => {
  const { voice, store, calls } = setup();
  voice.toggleMute();
  await voice.toggleVoice(VOICE_A);
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_A } });
  store.dispatch({ type: "gw", t: "VOICE_STATE_UPDATE", d: { guild_id: GUILD, user_id: ME, channel_id: VOICE_B } });
  await Bun.sleep(5);
  expect(store.getState().voice).toMatchObject({ guildId: GUILD, channelId: VOICE_B, selfMute: true });
  expect(calls).toContain(`join:${VOICE_B}:true:false`);
});

test("voice/moved updates guildId and channelId", () => {
  const { store } = setup();
  store.dispatch({ type: "voice/moved", guildId: GUILD, channelId: VOICE_B });
  expect(store.getState().voice).toMatchObject({ guildId: GUILD, channelId: VOICE_B, speaking: {} });
});

test("M toggles the input mode and pttKey only acts in push_to_talk", async () => {
  const { voice, store } = setup();
  voice.pttKey({ name: "space", eventType: "press" });
  expect(store.getState().settings.inputMode).toBe("voice_activity");
  voice.toggleInputMode();
  expect(store.getState().settings.inputMode).toBe("push_to_talk");
  voice.toggleInputMode();
  expect(store.getState().settings.inputMode).toBe("voice_activity");
});

test("privacy code is polled into the store while connected", async () => {
  const { voice, store } = setup();
  await voice.toggleVoice(VOICE_A);
  await Bun.sleep(1_100);
  expect(store.getState().voice.privacyCode).toBe("123451234512345");
  await voice.leaveVoice();
});

describe("output refresh for clock drift in long calls", () => {
  function refreshSetup(refresh: { checkMs: number; minUptimeMs: number; quietMs: number }) {
    const store = createStore(emptyState());
    store.dispatch({
      type: "gw",
      t: "READY",
      d: { user: { id: ME, username: "gon" }, guilds: [{ id: GUILD, name: "g", roles: [], channels: [{ id: VOICE_A, type: 2, name: "Voz" }] }] },
    });
    const statusListeners = new Set<(s: VoiceStatus, e?: string) => void>();
    const session: VoiceSession = {
      async join() {
        statusListeners.forEach((fn) => fn("connected"));
      },
      setFlags() {},
      async leave() {
        statusListeners.forEach((fn) => fn("idle"));
      },
      onStatus(fn) {
        statusListeners.add(fn);
        return () => statusListeners.delete(fn);
      },
      sendOpus() {},
      setSpeaking() {},
      onSpeaking: () => () => {},
      onOpus: () => () => {},
      privacyCode: () => null,
    };
    let opened = 0;
    let stopped = 0;
    const voice = createVoiceActions({
      store,
      session,
      refresh,
      media: {
        startCapture: async () => ({ onFrame: () => () => {}, stop: async () => {} }),
        startPlayback: async () => {
          opened += 1;
          return { write() {}, stop: async () => void (stopped += 1), dropped: () => 0 };
        },
        createCodec: () => ({ encode: (p) => p, decode: (o) => o }),
        createVad: () => ({ push: () => null, isOpen: false, thresholdDb: -45, levelDb: -96 }),
      },
    });
    return { voice, counts: () => ({ opened, stopped }) };
  }

  test("after the minimum uptime, during silence, a fresh pw-cat replaces the old one", async () => {
    const { voice, counts } = refreshSetup({ checkMs: 20, minUptimeMs: 40, quietMs: 0 });
    await voice.toggleVoice(VOICE_A);
    await Bun.sleep(200);
    expect(counts().opened).toBeGreaterThanOrEqual(2);
    expect(counts().stopped).toBe(counts().opened - 1);
    await voice.leaveVoice();
    expect(counts().stopped).toBe(counts().opened);
  });

  test("no refresh while someone talked recently", async () => {
    const { voice, counts } = refreshSetup({ checkMs: 20, minUptimeMs: 40, quietMs: 60_000 });
    await voice.toggleVoice(VOICE_A);
    await Bun.sleep(150);
    expect(counts().opened).toBe(1);
    await voice.leaveVoice();
  });
});

describe("Go Live", () => {
  test("without a stream controller there are no stream actions (the UI hides the button)", () => {
    expect(setup().voice.startStream).toBeUndefined();
  });

  test("start/stop/toggle/listMonitors delegate to the controller", async () => {
    const { voice, calls } = setup({ stream: true });
    await voice.startStream!("DP-1");
    await voice.toggleStream!();
    await voice.stopStream!();
    expect(calls).toEqual(["stream:start:DP-1", "stream:toggle", "stream:stop"]);
    expect((await voice.listMonitors!()).map((m) => m.name)).toEqual(["DP-1"]);
  });

  test("leaving voice or switching channel stops the stream before leaving the call", async () => {
    const { voice, calls } = setup({ stream: true });
    await voice.toggleVoice(VOICE_A);
    await voice.toggleVoice(VOICE_B);
    await voice.leaveVoice();
    expect(calls).toEqual([`join:${VOICE_A}:false:false`, "stream:stop", "leave", `join:${VOICE_B}:false:false`, "stream:stop", "leave"]);
  });
});

test("joining tells where the call audio goes, and setOutputDevice moves it live to another output", async () => {
  const store = createStore(emptyState());
  store.dispatch({
    type: "gw",
    t: "READY",
    d: { user: { id: ME, username: "gon" }, guilds: [{ id: GUILD, name: "g", roles: [], channels: [{ id: VOICE_A, type: 2, name: "Voz" }] }] },
  });
  const listeners = new Set<(s: VoiceStatus) => void>();
  const session: VoiceSession = {
    async join() {
      listeners.forEach((fn) => fn("connected"));
    },
    setFlags() {},
    async leave() {
      listeners.forEach((fn) => fn("idle"));
    },
    onStatus: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
    sendOpus() {},
    setSpeaking() {},
    onSpeaking: () => () => {},
    onOpus: () => () => {},
    privacyCode: () => null,
  };
  const targets: (string | undefined)[] = [];
  let stopped = 0;
  const voice = createVoiceActions({
    store,
    session,
    media: {
      startCapture: async () => ({ onFrame: () => () => {}, stop: async () => {} }),
      startPlayback: async (opts) => {
        targets.push(opts?.target);
        return { write() {}, stop: async () => void (stopped += 1), dropped: () => 0 };
      },
      createCodec: () => ({ encode: (p) => p, decode: (o) => o }),
      createVad: () => ({ push: () => null, isOpen: false, thresholdDb: -45, levelDb: -96 }),
      listAudioDevices: async () => ({
        outputs: [
          { name: "bluez_output.AE01", description: "AE01" },
          { name: "alsa_output.prox2", description: "PRO X 2" },
        ],
        defaultOutput: "bluez_output.AE01",
      }),
    },
  });
  await voice.toggleVoice(VOICE_A);
  await Bun.sleep(10);
  expect(Object.values(store.getState().notices).map((n) => n.text).join(" ")).toContain("sale por: AE01 (predeterminada del sistema)");
  expect(store.getState().voice.outputLabel).toBe("AE01");
  expect(targets).toEqual([undefined]);

  await voice.setOutputDevice!("alsa_output.prox2");
  expect(store.getState().settings.outputDevice).toBe("alsa_output.prox2");
  expect(targets).toEqual([undefined, "alsa_output.prox2"]);
  expect(stopped).toBe(1);
  expect(store.getState().voice.outputLabel).toBe("PRO X 2");
  expect((await voice.listOutputs!()).current).toBe("alsa_output.prox2");
  await voice.leaveVoice();
});

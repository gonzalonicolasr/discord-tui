import { describe, expect, test } from "bun:test";

import type { CaptureEnv, ProcLike } from "../../src/golive/capture";
import { STREAM_ERRORS } from "../../src/golive/errors";
import { createGoLive, goLiveAudioFromEnv } from "../../src/golive/golive";
import { createStore, emptyState } from "../../src/store/store";
import { fakeCapture, fakeGoLiveLib } from "../fakes/fake-golive";
import { fakeGateway } from "../fakes/fake-stream-server";

const GUILD = "100000000000000001";
const VOICE_A = "100000000000000003";
const VOICE_B = "100000000000000004";
const ME = "100000000000000010";
const KEY = `guild:${GUILD}:${VOICE_A}:${ME}`;

function textProc(text: string): ProcLike {
  return { pid: 1, stdout: new Response(text).body!, exited: Promise.resolve(0), kill() {} };
}

function setup(opts: { tools?: string[]; monitors?: unknown[]; inVoice?: boolean; session?: boolean; pwDumpExit?: number; failWithAudio?: boolean; audioReady?: Promise<boolean> | boolean; desktopAudio?: boolean | "silence"; statsFails?: "start" | "stop" } = {}) {
  /** Diagnóstico falso: con qué conexión arrancó y cómo terminó cada uno. */
  const statsRuns: Array<{ conn: unknown; stops: string[] }> = [];
  const stats = (conn: unknown) => {
    if (opts.statsFails === "start") throw new TypeError("odd library");
    const run = { conn, stops: [] as string[] };
    statsRuns.push(run);
    return {
      report() {},
      stop: (why: string) => {
        run.stops.push(why);
        if (opts.statsFails === "stop") throw new TypeError("odd library");
      },
    };
  };
  const store = createStore(emptyState());
  store.dispatch({
    type: "gw",
    t: "READY",
    d: {
      user: { id: ME, username: "gon" },
      guilds: [{ id: GUILD, name: "g", roles: [], channels: [{ id: VOICE_A, type: 2, name: "Voz" }, { id: VOICE_B, type: 2, name: "Voz 2" }] }],
    },
  });
  const gw = fakeGateway();
  const fake = fakeGoLiveLib();
  const capture = fakeCapture({ failWithAudio: opts.failWithAudio, audioReady: opts.audioReady });
  const tools = new Set(opts.tools ?? ["wf-recorder", "grim", "hyprctl"]);
  const spawned: string[][] = [];
  const env: CaptureEnv = {
    which: (bin) => tools.has(bin),
    exists: () => false,
    spawn: (cmd) => {
      spawned.push(cmd);
      if (cmd[0] === "pw-dump") return { ...textProc("[]"), exited: Promise.resolve(opts.pwDumpExit ?? 0) };
      return textProc(JSON.stringify(opts.monitors ?? [{ name: "DP-1", width: 1920, height: 1080, focused: false }, { name: "HDMI-A-1", width: 1920, height: 1080, focused: true }]));
    },
  };
  const golive = createGoLive({ store, gateway: gw, loadLib: async () => fake.lib, env, startCapture: capture.start, pickEncoder: async () => "nvenc", createTimeoutMs: 200, desktopAudio: opts.desktopAudio ?? true, stats });
  if (opts.inVoice !== false) {
    if (opts.session !== false) gw.dispatch("VOICE_STATE_UPDATE", { guild_id: GUILD, user_id: ME, channel_id: VOICE_A, session_id: "voice-session-1" });
    store.dispatch({ type: "voice/joining", guildId: GUILD, channelId: VOICE_A });
    store.dispatch({ type: "voice/status", status: "connected" });
  }
  const stream = () => store.getState().voice.stream;
  const notices = () => Object.values(store.getState().notices).map((n: any) => n.text);
  return { store, gw, fake, capture, golive, stream, notices, spawned, statsRuns };
}

async function goLive(s: ReturnType<typeof setup>, monitor?: string) {
  await s.golive.start(monitor);
  await s.fake.ready();
}

describe("start", () => {
  test("not in a voice channel: a notice, nothing sent", async () => {
    const s = setup({ inVoice: false });
    await s.golive.start();
    expect(s.notices()).toContain(STREAM_ERRORS.notInVoice);
    expect(s.gw.sent).toEqual([]);
    expect(s.stream().status).toBe("idle");
  });

  test("starting → live: op 18 + op 22 with our session, capture of the chosen monitor at 720p30", async () => {
    const s = setup();
    await s.golive.start("DP-1");
    expect(s.stream()).toMatchObject({ status: "starting", monitor: "DP-1" });
    expect(s.gw.sent.map((x) => x.op)).toEqual([18, 22]);
    expect(s.gw.sent[1]!.d).toEqual({ stream_key: KEY, paused: false });
    expect(s.fake.streamers[0]._voiceConnection.session_id).toBe("voice-session-1");
    expect(s.capture.started).toEqual([{ backend: "wf-recorder", encoder: "nvenc", monitor: "DP-1", quality: { width: 1280, height: 720, fps: 30, bitrateK: 2500, maxrateK: 3500 }, audio: false }]);
    expect(s.fake.plays[0]!.options).toEqual({ type: "go-live", format: "nut" });
    await s.fake.ready();
    expect(s.stream().status).toBe("live");
  });

  test("without a monitor it uses the saved one, else the focused one (never empty with several)", async () => {
    const s = setup();
    await s.golive.start();
    expect(s.capture.started[0]!.monitor).toBe("HDMI-A-1");
    expect(s.spawned[0]).toEqual(["hyprctl", "monitors", "-j"]);
    await s.golive.stop();
    s.store.dispatch({ type: "settings/set", patch: { streamMonitor: "DP-1" } });
    await s.golive.start();
    expect(s.capture.started[1]!.monitor).toBe("DP-1");
  });

  test("1080p30 quality from settings", async () => {
    const s = setup();
    s.store.dispatch({ type: "settings/set", patch: { streamQuality: "1080p30" } });
    await s.golive.start("DP-1");
    expect(s.capture.started[0]!.quality).toMatchObject({ width: 1920, height: 1080, fps: 30 });
  });

  test("one stream at a time: a second start while live does nothing", async () => {
    const s = setup();
    await goLive(s, "DP-1");
    await s.golive.start("HDMI-A-1");
    expect(s.capture.started.length).toBe(1);
    expect(s.gw.sent.filter((x) => x.op === 18).length).toBe(1);
  });

  test("no capture tool: clear error telling to install wf-recorder", async () => {
    const s = setup({ tools: ["hyprctl"] });
    await s.golive.start("DP-1");
    expect(s.stream()).toMatchObject({ status: "error", error: "no hay con qué capturar la pantalla; instalá wf-recorder: sudo pacman -S wf-recorder" });
    expect(s.gw.sent).toEqual([]);
  });

  test("grim only: streams with grim and warns it is slow", async () => {
    const s = setup({ tools: ["grim"] });
    await s.golive.start();
    expect(s.capture.started[0]!.backend).toBe("grim");
    expect(s.capture.started[0]!.monitor).toBe(""); // sin hyprctl: el predeterminado
    expect(s.notices().some((t) => t.includes("grim") && t.includes("sudo pacman -S wf-recorder"))).toBe(true);
  });

  test("no voice session id yet: error, nothing sent", async () => {
    const s = setup({ session: false });
    await s.golive.start("DP-1");
    expect(s.stream()).toMatchObject({ status: "error", error: STREAM_ERRORS.noSession });
    expect(s.gw.sent).toEqual([]);
  });

  test("Discord never answers: times out, sends op 19 and kills the capture", async () => {
    const s = setup();
    await s.golive.start("DP-1");
    await Bun.sleep(260);
    expect(s.stream()).toMatchObject({ status: "error", error: STREAM_ERRORS.noResponse });
    expect(s.gw.sent.map((x) => x.op)).toEqual([18, 22, 19]);
    expect(s.capture.stops()).toBe(1);
  });
});

describe("PC audio", () => {
  const PIPEWIRE = ["wf-recorder", "grim", "hyprctl", "pw-record", "pw-link", "pw-dump"];

  test("off by default (Discord drops a stream with audio after 30 s): video only, no probe, no notice", async () => {
    const s = setup({ tools: PIPEWIRE, desktopAudio: false });
    await s.golive.start("DP-1");
    expect(s.capture.started).toHaveLength(1);
    expect(s.capture.started[0]).toMatchObject({ backend: "wf-recorder", audio: false });
    expect(s.spawned).not.toContainEqual(["pw-dump"]);
    expect(s.notices().some((t) => t.includes("audio"))).toBe(false);
    await s.fake.ready();
    expect(s.stream()).toMatchObject({ status: "live", desktopAudio: false });
    await s.golive.stop();
  });

  test("with PipeWire the capture carries the PC audio, and no warning is shown", async () => {
    const s = setup({ tools: PIPEWIRE });
    await s.golive.start("DP-1");
    expect(s.capture.started[0]).toMatchObject({ backend: "wf-recorder", audio: true });
    expect(s.spawned).toContainEqual(["pw-dump"]);
    expect(s.notices().some((t) => t.includes("audio"))).toBe(false);
    await s.fake.ready();
    expect(s.stream()).toMatchObject({ status: "live", desktopAudio: true });
    await s.golive.stop();
    expect(s.stream().desktopAudio).toBeUndefined();
  });

  test("ZCORD_GOLIVE_AUDIO=silence: the capture carries silence, needs no PipeWire, and the bar does not claim PC audio", async () => {
    const s = setup({ desktopAudio: "silence" });
    await goLive(s, "DP-1");
    expect(s.capture.started[0]).toMatchObject({ backend: "wf-recorder", audio: true, audioSource: "silence" });
    expect(s.spawned).not.toContainEqual(["pw-dump"]);
    expect(s.notices().some((t) => t.includes("audio"))).toBe(false);
    expect(s.stream()).toMatchObject({ status: "live", desktopAudio: false });
    await s.golive.stop();
  });

  test("ZCORD_GOLIVE_AUDIO: 1 = PC audio, silence = silence, anything else = off", () => {
    expect(goLiveAudioFromEnv("1")).toBe(true);
    expect(goLiveAudioFromEnv("silence")).toBe("silence");
    expect(goLiveAudioFromEnv(undefined)).toBe(false);
    expect(goLiveAudioFromEnv("0")).toBe(false);
    expect(goLiveAudioFromEnv("yes")).toBe(false);
  });

  test("without the PipeWire tools: video only, as before, with a notice", async () => {
    const s = setup();
    await s.golive.start("DP-1");
    expect(s.capture.started[0]!.audio).toBe(false);
    expect(s.notices()).toContain(STREAM_ERRORS.noDesktopAudio);
    await s.fake.ready();
    expect(s.stream()).toMatchObject({ status: "live", desktopAudio: false });
  });

  test("PipeWire not answering (pw-dump fails): video only with a notice", async () => {
    const s = setup({ tools: PIPEWIRE, pwDumpExit: 255 });
    await s.golive.start("DP-1");
    expect(s.capture.started[0]!.audio).toBe(false);
    expect(s.notices()).toContain(STREAM_ERRORS.noDesktopAudio);
  });

  test("the audio capture cannot start: retries video only and keeps streaming", async () => {
    const s = setup({ tools: PIPEWIRE, failWithAudio: true });
    await s.golive.start("DP-1");
    expect(s.capture.started.map((c) => c.audio)).toEqual([true, false]);
    expect(s.notices()).toContain(STREAM_ERRORS.noDesktopAudio);
    await s.fake.ready();
    expect(s.stream().status).toBe("live");
  });

  test("the audio dies or no video comes out in the first seconds: restarts video only, without cutting the stream", async () => {
    const s = setup({ tools: PIPEWIRE, audioReady: false });
    await s.golive.start("DP-1");
    expect(s.capture.started.map((c) => c.audio)).toEqual([true, false]);
    expect(s.capture.stops()).toBe(1); // la captura con audio, no la de solo video
    expect(s.notices()).toContain(STREAM_ERRORS.noDesktopAudio);
    expect(s.fake.plays.length).toBe(1);
    await s.fake.ready();
    expect(s.stream()).toMatchObject({ status: "live", desktopAudio: false });
    expect(s.gw.sent.filter((x) => x.op === 18).length).toBe(1);
    expect(s.gw.sent.some((x) => x.op === 19)).toBe(false);
  });

  test("Discord is asked for the stream while the audio is on probation; the media starts after", async () => {
    let pass!: (ok: boolean) => void;
    const s = setup({ tools: PIPEWIRE, audioReady: new Promise<boolean>((resolve) => (pass = resolve)) });
    const starting = s.golive.start("DP-1");
    await Bun.sleep(5);
    expect(s.gw.sent.map((x) => x.op)).toEqual([18, 22]);
    expect(s.fake.plays.length).toBe(0);
    pass(true);
    await starting;
    expect(s.fake.plays.length).toBe(1);
    await s.fake.ready();
    expect(s.stream().status).toBe("live");
    expect(s.gw.sent.filter((x) => x.op === 18).length).toBe(1);
    expect(s.capture.started.map((c) => c.audio)).toEqual([true]);
  });

  test("stopping during the audio probation leaves nothing running", async () => {
    let pass!: (ok: boolean) => void;
    const s = setup({ tools: PIPEWIRE, audioReady: new Promise<boolean>((resolve) => (pass = resolve)) });
    const starting = s.golive.start("DP-1");
    await Bun.sleep(5);
    await s.golive.stop();
    pass(false);
    await starting;
    expect(s.capture.started.length).toBe(1);
    expect(s.capture.stops()).toBe(1);
    expect(s.fake.plays.length).toBe(0);
    expect(s.stream().status).toBe("idle");
  });

  test("grim (the slow fallback) goes without audio and says so", async () => {
    const s = setup({ tools: ["grim", "pw-record", "pw-link", "pw-dump"] });
    await s.golive.start();
    expect(s.capture.started[0]).toMatchObject({ backend: "grim", audio: false });
    expect(s.notices()).toContain(STREAM_ERRORS.noDesktopAudioGrim);
  });
});

describe("stop", () => {
  test("stop sends op 19 once, kills the capture and goes idle", async () => {
    const s = setup();
    await goLive(s, "DP-1");
    await s.golive.stop();
    await s.golive.stop();
    expect(s.gw.sent.map((x) => x.op)).toEqual([18, 22, 19]);
    expect(s.gw.sent[2]!.d).toEqual({ stream_key: KEY });
    expect(s.capture.stops()).toBe(1);
    expect(s.stream()).toMatchObject({ status: "idle", error: null });
  });

  test("toggle starts and stops", async () => {
    const s = setup();
    await s.golive.toggle();
    await s.fake.ready();
    expect(s.stream().status).toBe("live");
    await s.golive.toggle();
    expect(s.stream().status).toBe("idle");
  });

  test("a new stream after stopping reuses the voice session and opens a new streamer", async () => {
    const s = setup();
    await goLive(s, "DP-1");
    await s.golive.stop();
    await goLive(s, "DP-1");
    expect(s.fake.streamers.length).toBe(2);
    expect(s.fake.streamers[1]._voiceConnection.session_id).toBe("voice-session-1");
    expect(s.stream().status).toBe("live");
  });

  const autoStops: Array<[string, (s: ReturnType<typeof setup>) => void | Promise<void>, string | null]> = [
    ["you leave voice", (s) => s.store.dispatch({ type: "voice/left" }), STREAM_ERRORS.leftVoice],
    ["you switch channel", (s) => s.store.dispatch({ type: "voice/moved", guildId: GUILD, channelId: VOICE_B }), STREAM_ERRORS.leftVoice],
    ["voice errors out", (s) => s.store.dispatch({ type: "voice/left", error: "se cortó la voz" }), STREAM_ERRORS.leftVoice],
    ["the gateway disconnects", (s) => s.gw.status("disconnected"), STREAM_ERRORS.gatewayLost],
    ["the gateway comes back with a new session", (s) => s.gw.session("identified"), STREAM_ERRORS.newSession],
    ["the capture dies", (s) => s.capture.die(), STREAM_ERRORS.captureEnded],
    ["Discord deletes it (no permission)", (s) => s.gw.dispatch("STREAM_DELETE", { stream_key: KEY, reason: "unauthorized" }), "no tenés permiso de video (transmitir) en este canal"],
    ["the stream WS closes for good", (s) => s.fake.closeWs(4014), "Discord cortó la transmisión"],
  ];
  for (const [name, act, error] of autoStops) {
    test(`stops by itself when ${name}`, async () => {
      const s = setup();
      await goLive(s, "DP-1");
      await act(s);
      await Bun.sleep(1);
      expect(s.capture.stops()).toBe(1);
      expect(s.gw.sent.filter((x) => x.op === 19).length).toBe(1);
      expect(s.stream().status).toBe(error ? "error" : "idle");
      expect(s.stream().error).toBe(error);
    });
  }

  test("a resumed gateway or a resumable WS close keeps streaming", async () => {
    const s = setup();
    await goLive(s, "DP-1");
    s.gw.session("resumed");
    s.gw.status("resuming");
    s.fake.closeWs(1006);
    s.store.dispatch({ type: "voice/status", status: "reconnecting" });
    expect(s.stream().status).toBe("live");
    expect(s.capture.stops()).toBe(0);
  });

  test("Discord picks another video codec than the H264 we send: visible error and an error line in the log", async () => {
    const s = setup();
    await s.golive.start("DP-1");
    await s.fake.ready("AV1");
    expect(s.notices()).toContain(STREAM_ERRORS.codecMismatch("AV1"));
    expect(s.stream().status).toBe("live"); // no se corta: el aviso dice por qué no lo ven
  });

  test("H264 from Discord: no codec notice", async () => {
    const s = setup();
    await s.golive.start("DP-1");
    await s.fake.ready("H264");
    expect(s.notices().some((t) => t.includes("códec"))).toBe(false);
  });

  test("the stream diagnostics start once the stream is ready and end with the reason (WS close code first)", async () => {
    const s = setup();
    await s.golive.start("DP-1");
    expect(s.statsRuns).toEqual([]);
    await s.fake.ready();
    expect(s.statsRuns).toHaveLength(1);
    expect(s.statsRuns[0]!.conn).toHaveProperty("mediaConnection");
    s.fake.closeWs(4006);
    await Bun.sleep(1);
    expect(s.statsRuns[0]!.stops[0]).toBe("ws-4006");
  });

  test("the stream diagnostics also end when the stream is stopped by hand or by an error", async () => {
    const s = setup();
    await goLive(s, "DP-1");
    await s.golive.stop();
    expect(s.statsRuns[0]!.stops[0]).toBe("idle");
    await goLive(s, "DP-1");
    await s.capture.die();
    expect(s.statsRuns[1]!.stops[0]).toBe("error");
  });

  test("a resumable WS close keeps the diagnostics running (they hook the new WS); a final one ends them", async () => {
    const s = setup();
    await goLive(s, "DP-1");
    s.fake.closeWs(1006);
    await Bun.sleep(1);
    expect(s.stream().status).toBe("live");
    expect(s.statsRuns[0]!.stops).toEqual([]);
    s.fake.closeWs(4006);
    await Bun.sleep(1);
    expect(s.statsRuns[0]!.stops).toEqual(["ws-4006"]);
  });

  test("diagnostics that throw when starting: the stream still goes live and stops cleanly", async () => {
    const s = setup({ statsFails: "start" });
    await goLive(s, "DP-1");
    expect(s.stream().status).toBe("live");
    await s.golive.stop();
    expect(s.stream().status).toBe("idle");
    expect(s.capture.stops()).toBe(1);
    expect(s.gw.sent.filter((x) => x.op === 19)).toHaveLength(1);
  });

  test("diagnostics whose stop throws: stopping still cuts everything", async () => {
    const s = setup({ statsFails: "stop" });
    await goLive(s, "DP-1");
    await s.golive.stop();
    expect(s.stream().status).toBe("idle");
    expect(s.capture.stops()).toBe(1);
    expect(s.gw.sent.filter((x) => x.op === 19)).toHaveLength(1);
    await goLive(s, "DP-1");
    s.fake.closeWs(4006);
    await Bun.sleep(1);
    expect(s.stream().status).toBe("error");
    expect(s.capture.stops()).toBe(2);
  });

  test("with the PC audio the diagnostics watch the one stream asked for early, not a second one", async () => {
    const s = setup({ tools: ["wf-recorder", "grim", "hyprctl", "pw-record", "pw-link", "pw-dump"] });
    await goLive(s, "DP-1");
    expect(s.capture.started[0]).toMatchObject({ audio: true });
    expect(s.stream()).toMatchObject({ status: "live", desktopAudio: true });
    expect(s.statsRuns).toHaveLength(1);
  });

  test("STREAM_DELETE for someone else's stream is ignored", async () => {
    const s = setup();
    await goLive(s, "DP-1");
    s.gw.dispatch("STREAM_DELETE", { stream_key: `guild:${GUILD}:${VOICE_A}:999`, reason: "user_requested" });
    expect(s.stream().status).toBe("live");
  });
});

test("viewers come from STREAM_CREATE / STREAM_UPDATE viewer_ids", async () => {
  const s = setup();
  await goLive(s, "DP-1");
  s.gw.dispatch("STREAM_CREATE", { stream_key: KEY, rtc_server_id: "1", viewer_ids: [] });
  expect(s.stream().viewers).toBe(0);
  s.gw.dispatch("STREAM_UPDATE", { stream_key: KEY, viewer_ids: ["1", "2"], paused: false });
  expect(s.stream().viewers).toBe(2);
  expect(s.stream().viewerIds).toEqual(["1", "2"]);
  s.gw.dispatch("STREAM_UPDATE", { stream_key: KEY, viewer_ids: [ME, "3"], paused: false });
  expect(s.stream().viewerIds).toEqual(["3"]); // uno mismo no cuenta
});

test("the voice session id is dropped when you leave and replaced on rejoin", async () => {
  const s = setup();
  s.gw.dispatch("VOICE_STATE_UPDATE", { guild_id: GUILD, user_id: ME, channel_id: null, session_id: "voice-session-1" });
  await s.golive.start("DP-1");
  expect(s.stream().error).toBe(STREAM_ERRORS.noSession);
  s.gw.dispatch("VOICE_STATE_UPDATE", { guild_id: GUILD, user_id: ME, channel_id: VOICE_A, session_id: "voice-session-2" });
  await s.golive.start("DP-1");
  expect(s.fake.streamers[0]._voiceConnection.session_id).toBe("voice-session-2");
});

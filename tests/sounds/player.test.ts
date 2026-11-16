import { describe, expect, test } from "bun:test";

import { DEFAULT_SETTINGS, type SoundSettings } from "../../src/settings/settings";
import { createSoundPlayer } from "../../src/sounds/player";
import { cueFrames } from "../../src/sounds/library";
import type { Cue } from "../../src/sounds/synth";
import { startPlayback, type SpawnLike } from "../../src/voice/audio-io";
import { sampleAt } from "../helpers/pcm";

function fakeSpawn() {
  const calls: { cmd: string[]; writes: Uint8Array[]; ended: boolean }[] = [];
  const spawn: SpawnLike = (cmd) => {
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => (resolveExit = resolve));
    const call = { cmd, writes: [] as Uint8Array[], ended: false };
    calls.push(call);
    return {
      stdin: {
        write: (chunk: Uint8Array) => void call.writes.push(chunk),
        flush() {},
        end() {
          call.ended = true;
          resolveExit(0);
        },
      },
      stdout: null,
      stderr: new Response("").body,
      exited,
      killed: false,
      kill: () => resolveExit(0),
    };
  };
  return { spawn, calls };
}

function setup(opts: { sounds?: Partial<SoundSettings>; outputDevice?: string | null; inCall?: boolean } = {}) {
  let t = 10_000;
  let deaf = false;
  const sounds: SoundSettings = { ...DEFAULT_SETTINGS.sounds, ...opts.sounds };
  const settings = { sounds, outputDevice: opts.outputDevice ?? null };
  const mixed: Uint8Array[][] = [];
  const fake = fakeSpawn();
  let inCall = opts.inCall ?? false;
  const player = createSoundPlayer({
    getSettings: () => settings,
    isDeaf: () => deaf,
    mixerSink: () => (inCall ? { play: (frames) => void mixed.push(frames) } : null),
    startPlayback: (o) => startPlayback({ ...o, spawn: fake.spawn }),
    now: () => t,
    sleep: async () => {},
  });
  return {
    player,
    settings,
    mixed,
    fake,
    advance: (ms: number) => (t += ms),
    setDeaf: (d: boolean) => (deaf = d),
    setInCall: (v: boolean) => (inCall = v),
  };
}

const flush = () => Bun.sleep(60);

describe("sound player", () => {
  test("in a call, the cue goes to the call mixer and no pw-cat is spawned", async () => {
    const h = setup({ inCall: true });
    h.player.play("join");
    await flush();
    expect(h.mixed).toHaveLength(1);
    expect(h.mixed[0]!.length).toBe(cueFrames("join").length);
    expect(h.fake.calls).toHaveLength(0);
  });

  test("out of a call, a short pw-cat goes to settings.outputDevice, gets the whole cue and is closed", async () => {
    const h = setup({ outputDevice: "alsa_output.usb-headset", sounds: { volume: 100 } });
    h.player.play("leave");
    await flush();
    expect(h.fake.calls).toHaveLength(1);
    const call = h.fake.calls[0]!;
    expect(call.cmd.slice(0, 2)).toEqual(["pw-cat", "--playback"]);
    expect(call.cmd[call.cmd.indexOf("--target") + 1]).toBe("alsa_output.usb-headset");
    const total = call.writes.reduce((n, w) => n + w.byteLength, 0);
    expect(total).toBe(cueFrames("leave").length * 3840);
    expect(call.ended).toBe(true);
  });

  test("default output: no --target", async () => {
    const h = setup();
    h.player.play("message");
    await flush();
    expect(h.fake.calls[0]!.cmd).not.toContain("--target");
  });

  test("the same cue within 150 ms is dropped; a different cue or later one plays", async () => {
    const h = setup({ inCall: true });
    h.player.play("mute");
    h.advance(100);
    h.player.play("mute");
    h.player.play("unmute");
    h.advance(100);
    h.player.play("mute");
    expect(h.mixed).toHaveLength(3);
  });

  test("at most 3 one-shot pw-cats at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = 0;
    const player = createSoundPlayer({
      getSettings: () => ({ sounds: DEFAULT_SETTINGS.sounds, outputDevice: null }),
      isDeaf: () => false,
      startPlayback: async () => {
        started += 1;
        return { write() {}, stop: async () => {} };
      },
      sleep: () => gate,
    });
    for (const cue of ["join", "leave", "message", "mute", "unmute"] as Cue[]) player.play(cue);
    await flush();
    expect(started).toBe(3);
    release();
  });

  test("disabled, volume 0 or that event off → nothing", async () => {
    for (const sounds of [{ enabled: false }, { volume: 0 }, { events: { ...DEFAULT_SETTINGS.sounds.events, join: false } }]) {
      const h = setup({ inCall: true, sounds });
      h.player.play("join");
      expect(h.mixed).toHaveLength(0);
    }
    const h = setup({ inCall: true, sounds: { events: { ...DEFAULT_SETTINGS.sounds.events, join: false } } });
    h.player.play("leave");
    expect(h.mixed).toHaveLength(1);
  });

  test("volume scales the samples", () => {
    const full = setup({ inCall: true, sounds: { volume: 100 } });
    const half = setup({ inCall: true, sounds: { volume: 50 } });
    full.player.play("join");
    half.player.play("join");
    const a = sampleAt(full.mixed[0]![3]!, 100);
    const b = sampleAt(half.mixed[0]![3]!, 100);
    expect(a).not.toBe(0);
    expect(Math.abs(b - a / 2)).toBeLessThanOrEqual(1);
  });

  test("deafened: only mute/unmute/deafen/undeafen/leave play", () => {
    const h = setup({ inCall: true });
    h.setDeaf(true);
    const all: Cue[] = ["join", "userJoin", "userLeave", "message", "streamStart", "streamStop", "disconnect", "mute", "unmute", "deafen", "undeafen", "leave"];
    for (const cue of all) h.player.play(cue);
    expect(h.mixed).toHaveLength(5);
  });
});

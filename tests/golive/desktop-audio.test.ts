import { describe, expect, test } from "bun:test";

import type { CaptureEnv, ProcLike, SpawnOpts } from "../../src/golive/capture";
import { AUDIO_NODE, desktopAudioCommand, isZcordProcess, planLinks, probeDesktopAudio, startAudioLinker } from "../../src/golive/desktop-audio";

// Un pw-dump de juguete con la forma del real (PipeWire 1.6): clientes con su pid, nodos, puertos y enlaces.
const client = (id: number, pid: number, bin: string) => ({
  id,
  type: "PipeWire:Interface:Client",
  info: { props: { "application.process.id": pid, "application.process.binary": bin } },
});
const node = (id: number, clientId: number, cls: string | null, name: string) => ({
  id,
  type: "PipeWire:Interface:Node",
  info: { props: { "client.id": clientId, "node.name": name, ...(cls ? { "media.class": cls } : {}) } },
});
const port = (id: number, nodeId: number, direction: "input" | "output", channel?: string) => ({
  id,
  type: "PipeWire:Interface:Port",
  info: { direction, props: { "node.id": nodeId, ...(channel ? { "audio.channel": channel } : {}) } },
});
const link = (out: number, inp: number) => ({ id: 9000 + out, type: "PipeWire:Interface:Link", info: { "output-port-id": out, "input-port-id": inp } });

const RECORDER_PID = 5000;
const ZCORD_CHILD_PID = 8000;

function dump(): unknown[] {
  return [
    // nuestro pw-record (sin enlazar)
    client(10, RECORDER_PID, "pw-cat"),
    node(100, 10, "Stream/Input/Audio", AUDIO_NODE),
    port(101, 100, "input", "FL"),
    port(102, 100, "input", "FR"),
    // el de OTRA instancia de zcord: mismo nombre, otro pid
    client(11, 5555, "pw-cat"),
    node(110, 11, "Stream/Input/Audio", AUDIO_NODE),
    port(111, 110, "input", "FL"),
    // Chrome, estéreo, con el FL ya enlazado de una vuelta anterior
    client(20, 7000, "chrome"),
    node(200, 20, "Stream/Output/Audio", "Google Chrome"),
    port(201, 200, "output", "FL"),
    port(202, 200, "output", "FR"),
    link(201, 101),
    // la salida de voz de zcord (pw-cat hijo de zcord): NUNCA, si no hay eco
    client(30, ZCORD_CHILD_PID, "pw-cat"),
    node(300, 30, "Stream/Output/Audio", "pw-cat"),
    port(301, 300, "output", "FL"),
    port(302, 300, "output", "FR"),
    // una app mono: va a los dos canales
    client(40, 9000, "mpv"),
    node(400, 40, "Stream/Output/Audio", "mpv"),
    port(401, 400, "output", "MONO"),
    // EasyEffects y los loopbacks del propio PipeWire mezclan TODO (zcord incluido): afuera
    client(50, 1835803, "easyeffects"),
    node(500, 50, null, "ee_soe_output_level"),
    port(501, 500, "output", "FL"),
    node(510, 50, "Stream/Output/Audio", "easyeffects_out"),
    port(511, 510, "output", "FL"),
    client(60, 1470, "pipewire"),
    node(600, 60, "Stream/Output/Audio", "loopback-out"),
    port(601, 600, "output", "FL"),
    // un sink de hardware: no es una app
    node(700, 60, "Audio/Sink", "alsa_output.pci"),
    port(701, 700, "input", "FL"),
    port(702, 700, "output", "FL"),
    // canales de surround que no sabemos mezclar: se saltean
    client(80, 9100, "game"),
    node(800, 80, "Stream/Output/Audio", "game"),
    port(801, 800, "output", "FL"),
    port(802, 800, "output", "LFE"),
  ];
}

const isOwn = (pid: number) => pid === ZCORD_CHILD_PID;

describe("pw-record command", () => {
  test("a capture node of our own that PipeWire never links by itself, raw s16 48 kHz stereo to stdout", () => {
    expect(desktopAudioCommand()).toEqual([
      "pw-record",
      "--target",
      "0",
      "-P",
      `{ node.name = ${AUDIO_NODE} node.description = "zcord Go Live" application.name = zcord-golive media.name = "zcord Go Live" node.always-process = true }`,
      "--raw",
      "--format",
      "s16",
      "--rate",
      "48000",
      "--channels",
      "2",
      "--latency",
      "20ms",
      "-",
    ]);
  });
});

describe("planLinks", () => {
  test("links every other app's output to our recorder, skipping zcord's own playback, mixers and existing links", () => {
    const pairs = planLinks(dump(), { recorderPid: RECORDER_PID, isOwn });
    expect(pairs).toEqual([
      [202, 102],
      [401, 101],
      [401, 102],
      [801, 101],
    ]);
  });

  test("never links zcord's own playback (the call's voices) — that would be the echo", () => {
    const pairs = planLinks(dump(), { recorderPid: RECORDER_PID, isOwn });
    expect(pairs.some(([out]) => out === 301 || out === 302)).toBe(false);
  });

  test("nothing to do until our recorder shows up, or with a dump that is not a list", () => {
    expect(planLinks(dump(), { recorderPid: 4242, isOwn })).toEqual([]);
    expect(planLinks({ nope: true }, { recorderPid: RECORDER_PID, isOwn })).toEqual([]);
    expect(planLinks([null, 3, "x"], { recorderPid: RECORDER_PID, isOwn })).toEqual([]);
  });
});

describe("isZcordProcess", () => {
  test("zcord itself and its direct children (the pw-cat of the voice and of the audio player)", async () => {
    const child = Bun.spawn(["sleep", "5"], { stdout: "ignore", stderr: "ignore" });
    try {
      expect(isZcordProcess(process.pid)).toBe(true);
      expect(isZcordProcess(child.pid)).toBe(true);
      expect(isZcordProcess(1)).toBe(false);
      expect(isZcordProcess(999_999_999)).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });
});

function textProc(text: string, code = 0): ProcLike {
  return { pid: 1, stdout: new Response(text).body!, exited: Promise.resolve(code), kill() {} };
}

function fakeEnv(opts: { tools?: string[]; dump?: string; dumpExit?: number } = {}) {
  const tools = new Set(opts.tools ?? ["pw-record", "pw-link", "pw-dump"]);
  const spawned: Array<{ cmd: string[]; opts: SpawnOpts }> = [];
  const env: CaptureEnv = {
    which: (bin) => tools.has(bin),
    exists: () => false,
    spawn: (cmd, spawnOpts) => {
      spawned.push({ cmd, opts: spawnOpts });
      if (cmd[0] === "pw-dump") return textProc(opts.dump ?? JSON.stringify(dump()), opts.dumpExit ?? 0);
      return textProc("");
    },
  };
  return { env, spawned };
}

describe("probeDesktopAudio", () => {
  test("needs pw-record, pw-link and pw-dump installed (nothing is spawned otherwise)", async () => {
    for (const missing of ["pw-record", "pw-link", "pw-dump"]) {
      const { env, spawned } = fakeEnv({ tools: ["pw-record", "pw-link", "pw-dump"].filter((t) => t !== missing) });
      expect(await probeDesktopAudio(env)).toBe(false);
      expect(spawned).toEqual([]);
    }
  });

  test("PipeWire not running: pw-dump fails → false", async () => {
    expect(await probeDesktopAudio(fakeEnv({ dumpExit: 255, dump: "" }).env)).toBe(false);
    expect(await probeDesktopAudio(fakeEnv({ dump: "no es json" }).env)).toBe(false);
  });

  test("PipeWire answers → true", async () => {
    const { env, spawned } = fakeEnv();
    expect(await probeDesktopAudio(env)).toBe(true);
    expect(spawned.map((s) => s.cmd)).toEqual([["pw-dump"]]);
  });
});

describe("audio linker", () => {
  test("polls pw-dump and links what is missing by port id with pw-link; stop() ends the polling", async () => {
    const { env, spawned } = fakeEnv();
    const linker = startAudioLinker({ env, recorderPid: RECORDER_PID, isOwn, intervalMs: 20 });
    await Bun.sleep(70);
    await linker.stop();
    const links = spawned.filter((s) => s.cmd[0] === "pw-link").map((s) => s.cmd);
    expect(links.slice(0, 4)).toEqual([
      ["pw-link", "202", "102"],
      ["pw-link", "401", "101"],
      ["pw-link", "401", "102"],
      ["pw-link", "801", "101"],
    ]);
    expect(spawned.filter((s) => s.cmd[0] === "pw-dump").length).toBeGreaterThan(1);
    const count = spawned.length;
    await Bun.sleep(60);
    expect(spawned.length).toBe(count);
  });

  test("a broken pw-dump does not stop the polling nor throw", async () => {
    const { env, spawned } = fakeEnv({ dump: "basura", dumpExit: 1 });
    const linker = startAudioLinker({ env, recorderPid: RECORDER_PID, isOwn, intervalMs: 10 });
    await Bun.sleep(50);
    await linker.stop();
    expect(spawned.filter((s) => s.cmd[0] === "pw-dump").length).toBeGreaterThan(1);
    expect(spawned.some((s) => s.cmd[0] === "pw-link")).toBe(false);
  });
});

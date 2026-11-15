import { afterEach, describe, expect, test } from "bun:test";
import { fstatSync, readlinkSync } from "node:fs";
import { Readable } from "node:stream";

import {
  DEFAULT_MONITOR,
  QUALITY,
  defaultCaptureEnv,
  ffmpegArgs,
  grimCommand,
  listMonitors,
  parseHyprMonitors,
  pickBackend,
  pickEncoder,
  probeArgs,
  startCapture,
  wfRecorderCommand,
  type CaptureEnv,
  type ProcLike,
  type SpawnOpts,
} from "../../src/golive/capture";
import { fakeToken } from "../helpers/fake-token";

const has = (...bins: string[]) => (bin: string) => bins.includes(bin);

describe("capture backend", () => {
  test("wf-recorder preferred, grim as fallback, none when neither is installed", () => {
    expect(pickBackend(has("wf-recorder", "grim"))).toBe("wf-recorder");
    expect(pickBackend(has("wf-recorder"))).toBe("wf-recorder");
    expect(pickBackend(has("grim"))).toBe("grim");
    expect(pickBackend(has("ffmpeg"))).toBeNull();
  });
});

describe("monitors", () => {
  test("parses hyprctl monitors -j and drops disabled or odd names", () => {
    const raw = [
      { name: "HDMI-A-1", width: 1920, height: 1080, focused: false },
      { name: "DP-1", width: 1920, height: 1080, focused: true },
      { name: "DP-2", width: 1920, height: 1080, disabled: true },
      { name: "bad name; rm", width: 1, height: 1 },
    ];
    expect(parseHyprMonitors(raw)).toEqual([
      { name: "HDMI-A-1", width: 1920, height: 1080, focused: false },
      { name: "DP-1", width: 1920, height: 1080, focused: true },
    ]);
    expect(parseHyprMonitors({})).toEqual([]);
  });

  function envWith(stdout: string, tools = ["hyprctl"]): CaptureEnv {
    return {
      which: has(...tools),
      exists: () => false,
      spawn: () => ({ pid: 1, stdout: new Response(stdout).body!, exited: Promise.resolve(0), kill() {} }),
    };
  }

  test("lists Hyprland monitors; falls back to a single default one", async () => {
    expect((await listMonitors(envWith(JSON.stringify([{ name: "DP-1", width: 1, height: 1 }])))).map((m) => m.name)).toEqual(["DP-1"]);
    expect(await listMonitors(envWith("no es json"))).toEqual([DEFAULT_MONITOR]);
    expect(await listMonitors(envWith("[]"))).toEqual([DEFAULT_MONITOR]);
    expect(await listMonitors(envWith("[]", []))).toEqual([DEFAULT_MONITOR]);
  });
});

describe("commands", () => {
  test("wf-recorder: chosen output, raw yuv420p at 30 fps in NUT to stdout (pipe:1)", () => {
    expect(wfRecorderCommand("DP-1", QUALITY["720p30"])).toEqual(["wf-recorder", "-y", "-o", "DP-1", "-c", "rawvideo", "-m", "nut", "-x", "yuv420p", "-r", "30", "-f", "pipe:1"]);
    expect(wfRecorderCommand("", QUALITY["720p30"])).not.toContain("-o");
  });

  test("grim: one PPM frame of the chosen output to stdout", () => {
    expect(grimCommand("DP-1")).toEqual(["grim", "-t", "ppm", "-o", "DP-1", "-"]);
    expect(grimCommand("")).toEqual(["grim", "-t", "ppm", "-"]);
  });

  function flag(args: string[], name: string): string | undefined {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  }

  test("ffmpeg 720p30: scales down keeping aspect, 30 fps, no B-frames, keyframe every 2 s, NUT to stdout", () => {
    const args = ffmpegArgs({ backend: "wf-recorder", encoder: "x264", quality: QUALITY["720p30"] });
    expect(args[0]).toBe("ffmpeg");
    expect(flag(args, "-f")).toBe("nut");
    // el video crudo de wf-recorder entra por el fd 4 (de proceso a proceso, sin pasar por JS)
    expect(flag(args, "-i")).toBe("pipe:4");
    expect(flag(args, "-vf")).toBe("scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30,format=yuv420p");
    expect(flag(args, "-c:v")).toBe("libx264");
    expect(flag(args, "-tune")).toBe("zerolatency");
    expect(flag(args, "-forced-idr")).toBe("1");
    expect(flag(args, "-bf")).toBe("0");
    expect(flag(args, "-g")).toBe("60");
    expect(flag(args, "-keyint_min")).toBe("60");
    expect(flag(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*2)");
    expect(flag(args, "-b:v")).toBe("2500k");
    expect(args).toContain("-an");
    expect(args.at(-1)).toBe("pipe:1");
    expect(args.at(-2)).toBe("nut");
  });

  test("NVENC also forces IDR (the library preset does not) and uses low-latency tuning", () => {
    const args = ffmpegArgs({ backend: "wf-recorder", encoder: "nvenc", quality: QUALITY["720p30"] });
    expect(flag(args, "-c:v")).toBe("h264_nvenc");
    expect(flag(args, "-forced-idr")).toBe("1");
    expect(flag(args, "-zerolatency")).toBe("1");
    expect(flag(args, "-force_key_frames")).toBe("expr:gte(t,n_forced*2)");
  });

  test("VAAPI uploads to the GPU device; 1080p30 changes the box and bitrate", () => {
    const args = ffmpegArgs({ backend: "wf-recorder", encoder: "vaapi", quality: QUALITY["1080p30"] });
    expect(flag(args, "-vaapi_device")).toBe("/dev/dri/renderD128");
    expect(flag(args, "-c:v")).toBe("h264_vaapi");
    expect(flag(args, "-vf")).toContain("min(1920,iw)':'min(1080,ih)'");
    expect(flag(args, "-vf")).toEndWith("format=nv12,hwupload");
    expect(flag(args, "-b:v")).toBe("4500k");
  });

  test("wf-recorder with the PC audio records every frame (-D): a still screen must not stall the audio", () => {
    expect(wfRecorderCommand("DP-1", QUALITY["720p30"], { noDamage: true })).toEqual(["wf-recorder", "-y", "-o", "DP-1", "-D", "-c", "rawvideo", "-m", "nut", "-x", "yuv420p", "-r", "30", "-f", "pipe:1"]);
    expect(wfRecorderCommand("DP-1", QUALITY["720p30"])).not.toContain("-D");
  });

  test("ffmpeg with the PC audio: raw s16 48 kHz stereo from fd 3, Opus 48 kHz stereo in the same NUT, no -an", () => {
    const args = ffmpegArgs({ backend: "wf-recorder", encoder: "nvenc", quality: QUALITY["720p30"], audio: true });
    const inputs = args.flatMap((a, i) => (a === "-i" ? [args[i + 1]] : []));
    expect(inputs).toEqual(["pipe:4", "pipe:3"]);
    const audioIn = args.indexOf("pipe:3");
    expect(args.slice(audioIn - 7, audioIn + 1)).toEqual(["-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:3"]);
    expect(args).not.toContain("-an");
    expect(args.join(" ")).toContain("-map 0:v:0 -map 1:a:0");
    expect(flag(args, "-c:a")).toBe("libopus");
    expect(flag(args, "-b:a")).toBe("128k");
    expect(flag(args, "-ar")).toBe("48000");
    expect(args.lastIndexOf("-ar")).toBeGreaterThan(audioIn);
    expect(args[args.lastIndexOf("-ac") + 1]).toBe("2");
    // El Opus arranca con pts negativo (pre-skip) y el muxer NUT lo rechaza: se corre a 0.
    expect(flag(args, "-bsf:a")).toBe("setts=ts=TS-STARTPTS");
    // Que el muxer no retenga el audio esperando video (por defecto hasta 10 s).
    expect(flag(args, "-max_interleave_delta")).toBe("50000");
    // el video sigue igual
    expect(flag(args, "-c:v")).toBe("h264_nvenc");
    expect(args.at(-1)).toBe("pipe:1");
    expect(args.at(-2)).toBe("nut");
  });

  test("ffmpeg without audio stays video only, as before", () => {
    const args = ffmpegArgs({ backend: "wf-recorder", encoder: "x264", quality: QUALITY["720p30"], audio: false });
    expect(args).toEqual(ffmpegArgs({ backend: "wf-recorder", encoder: "x264", quality: QUALITY["720p30"] }));
    expect(args).toContain("-an");
    expect(args).not.toContain("pipe:3");
    expect(args).not.toContain("-c:a");
  });

  test("grim input is a PPM image pipe at ~10 fps, output still 30 fps", () => {
    const args = ffmpegArgs({ backend: "grim", encoder: "x264", quality: QUALITY["720p30"] });
    expect(flag(args, "-f")).toBe("image2pipe");
    expect(flag(args, "-c:v")).toBe("ppm");
    expect(flag(args, "-framerate")).toBe("10");
    expect(flag(args, "-vf")).toContain("fps=30");
    // grim: los frames los escribe JS por stdin
    expect(flag(args, "-i")).toBe("pipe:0");
    expect(ffmpegArgs({ backend: "grim", encoder: "x264", quality: QUALITY["720p30"], audio: true }).flatMap((a, i, all) => (a === "-i" ? [all[i + 1]] : []))).toEqual(["pipe:0", "pipe:3"]);
  });
});

describe("encoder pick", () => {
  function probeEnv(ok: string[], dri = true) {
    const tried: string[] = [];
    const env: CaptureEnv = {
      which: () => true,
      exists: () => dri,
      spawn: (cmd) => {
        const codec = cmd[cmd.indexOf("-c:v") + 1]!;
        tried.push(codec);
        return { pid: 1, stdout: null, exited: Promise.resolve(ok.includes(codec) ? 0 : 1), kill() {} };
      },
    };
    return { env, tried };
  }

  test("NVENC → VAAPI → x264, probing with one synthetic frame", async () => {
    expect(await pickEncoder(probeEnv(["h264_nvenc", "h264_vaapi"]).env, { cache: false })).toBe("nvenc");
    const vaapi = probeEnv(["h264_vaapi"]);
    expect(await pickEncoder(vaapi.env, { cache: false })).toBe("vaapi");
    expect(vaapi.tried).toEqual(["h264_nvenc", "h264_vaapi"]);
    expect(await pickEncoder(probeEnv([], true).env, { cache: false })).toBe("x264");
    const noDri = probeEnv(["h264_vaapi"], false);
    expect(await pickEncoder(noDri.env, { cache: false })).toBe("x264");
    expect(noDri.tried).toEqual(["h264_nvenc"]);
  });

  test("the probe never captures the screen (lavfi color source)", () => {
    expect(probeArgs("nvenc")).toContain("color=c=black:s=256x144:d=0.1");
    expect(probeArgs("nvenc")).not.toContain("pipe:0");
  });
});

describe("clean env", () => {
  const before = process.env.DISCORD_TOKEN_FAKE;
  afterEach(() => {
    if (before === undefined) delete process.env.DISCORD_TOKEN_FAKE;
    else process.env.DISCORD_TOKEN_FAKE = before;
  });

  test("capture processes get the allowlisted env only, never a token", async () => {
    const token = fakeToken("golive");
    process.env.DISCORD_TOKEN_FAKE = token;
    const proc = defaultCaptureEnv.spawn(["env"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout as ReadableStream).text();
    await proc.exited;
    expect(out).not.toContain(token);
    expect(out).not.toContain("DISCORD_TOKEN_FAKE");
    for (const line of out.trim().split("\n").filter(Boolean)) {
      expect(["PATH", "HOME", "LANG", "LC_ALL", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "WAYLAND_DISPLAY", "PIPEWIRE_RUNTIME_DIR", "PULSE_SERVER", "HYPRLAND_INSTANCE_SIGNATURE"]).toContain(line.split("=")[0]!);
    }
  });
});

describe("process cleanup (real processes standing in for wf-recorder / grim / ffmpeg)", () => {
  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /** Corre comandos inofensivos en lugar de los reales: nada captura la pantalla. */
  function standIns(map: (cmd: string[]) => string[]) {
    const spawned: Array<{ cmd: string[]; pid: number }> = [];
    const env: CaptureEnv = {
      which: () => true,
      exists: () => false,
      spawn: (cmd: string[], opts: SpawnOpts): ProcLike => {
        const proc = defaultCaptureEnv.spawn(map(cmd), opts);
        spawned.push({ cmd, pid: proc.pid });
        return proc;
      },
    };
    return { env, spawned };
  }

  /** Un "ffmpeg" que pasa a su stdout lo que le llega por el fd 4 (por donde entra el video de wf-recorder). */
  const FFMPEG_FD4 = ["sh", "-c", "exec cat <&4"];

  /** Los fds abiertos de cada stand-in, de las líneas de `ls -l /proc/$$/fd` que van después de su marca. */
  function fdsByMarker(text: string): Record<string, number[]> {
    const out: Record<string, number[]> = {};
    let current = "";
    for (const line of text.split("\n")) {
      const marker = /^== (\w+)$/.exec(line);
      if (marker) current = marker[1]!;
      const fd = / (\d+) -> /.exec(line);
      if (fd && current) (out[current] ??= []).push(Number(fd[1]));
    }
    return out;
  }

  /** `ls -l` de los fds del shell; el `; true` evita que sh haga exec de ls (si no, se listaría ls a sí mismo). */
  const listFds = (marker: string) => `echo "== ${marker}"; ls -l /proc/$$/fd; true`;

  test("wf-recorder → ffmpeg: stop kills both, nothing left alive", async () => {
    const { env, spawned } = standIns((cmd) => (cmd[0] === "wf-recorder" ? ["sh", "-c", "exec sleep 30"] : FFMPEG_FD4));
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "DP-1", quality: QUALITY["720p30"], env });
    expect(spawned.map((s) => s.cmd[0])).toEqual(["ffmpeg", "wf-recorder"]);
    expect(handle.pids().length).toBe(2);
    await Bun.sleep(50);
    expect(spawned.every((s) => alive(s.pid))).toBe(true);
    await handle.stop();
    await handle.stop();
    expect(spawned.filter((s) => alive(s.pid))).toEqual([]);
    expect(handle.pids()).toEqual([]);
  });

  test("grim loop → ffmpeg: frames flow through stdin; stop leaves no grim or ffmpeg behind", async () => {
    const { env, spawned } = standIns((cmd) => (cmd[0] === "grim" ? ["printf", "P6 frame"] : ["cat"]));
    const handle = startCapture({ backend: "grim", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
    let bytes = 0;
    handle.output.on("data", (chunk: Buffer) => (bytes += chunk.length));
    await Bun.sleep(300);
    expect(bytes).toBeGreaterThan(0);
    expect(spawned.filter((s) => s.cmd[0] === "grim").length).toBeGreaterThan(1);
    await handle.stop();
    await Bun.sleep(20);
    expect(spawned.filter((s) => alive(s.pid))).toEqual([]);
  });

  test("wf-recorder writes straight into ffmpeg's fd 4: the raw video never goes through JS", async () => {
    const opts: Record<string, SpawnOpts> = {};
    const { env } = standIns((cmd) => (cmd[0] === "wf-recorder" ? ["head", "-c", "3000000", "/dev/zero"] : ["sh", "-c", "exec wc -c <&4"]));
    const spawn = env.spawn;
    env.spawn = (cmd, o) => {
      opts[cmd[0]!] = o;
      return spawn(cmd, o);
    };
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
    expect(opts.ffmpeg!.stdin).toBe("ignore");
    expect(opts.ffmpeg!.fd4).toBe("pipe");
    expect(typeof opts["wf-recorder"]!.stdout).toBe("number");
    let text = "";
    handle.output.on("data", (chunk: Buffer) => (text += chunk.toString()));
    // wf-recorder termina → ffmpeg ve el fin (nadie más tiene abierto el extremo de escritura) → `ended`
    const ended = await Promise.race([handle.ended.then(() => "ended"), Bun.sleep(3000).then(() => "timeout")]);
    expect(ended).toBe("ended");
    await Bun.sleep(20);
    expect(text.trim()).toBe("3000000");
    await handle.stop();
  });

  test("no stray fds: wf-recorder has only 0-2, ffmpeg 0-2 + 4 (+ 3 with audio), pw-record 0-2; ours get closed", async () => {
    for (const audio of [false, true]) {
      const passed: Array<{ fd: number; link: string }> = [];
      const { env, spawned } = standIns((cmd) => {
        // sigue vivo pero suelta su stdout: ffmpeg ve el fin del video (si saliera, con audio se cortaría todo)
        if (cmd[0] === "wf-recorder") return ["sh", "-c", `${listFds("wf")}; exec sleep 30 >&-`];
        if (cmd[0] === "pw-record") return ["sh", "-c", `${listFds("pw")}; exec sleep 30`];
        if (cmd[0] === "pw-dump") return ["echo", "[]"];
        if (cmd[0] === "pw-link") return ["true"];
        // "ffmpeg": sus fds, lo que mandó wf-recorder por el fd 4 y (con audio) lo de pw-record por el fd 3
        return ["sh", "-c", `${listFds("ff")}; cat <&4; ${audio ? "exec cat <&3" : "exec sleep 30"}`];
      });
      const spawn = env.spawn;
      env.spawn = (cmd, o) => {
        if (typeof o.stdout === "number") passed.push({ fd: o.stdout, link: readlinkSync(`/proc/self/fd/${o.stdout}`) });
        return spawn(cmd, o);
      };
      const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio, audioGraceMs: 50 });
      // nuestra copia de cada extremo que se le pasó a un hijo ya está cerrada (el fd no existe o es otro)
      expect(passed.length).toBe(audio ? 2 : 1);
      for (const { fd, link } of passed) {
        let now: string | null = null;
        try {
          now = readlinkSync(`/proc/self/fd/${fd}`);
        } catch {
          // cerrado
        }
        expect(now).not.toBe(link);
      }
      let text = "";
      handle.output.on("data", (chunk: Buffer) => (text += chunk.toString()));
      const want = audio ? ["ff", "wf", "pw"] : ["ff", "wf"];
      for (let i = 0; i < 100 && Object.keys(fdsByMarker(text)).length < want.length; i++) await Bun.sleep(20);
      const fds = fdsByMarker(text);
      expect(fds.ff).toEqual(audio ? [0, 1, 2, 3, 4] : [0, 1, 2, 4]);
      expect(fds.wf).toEqual([0, 1, 2]);
      if (audio) expect(fds.pw).toEqual([0, 1, 2]);
      await handle.stop();
      expect(spawned.filter((s) => alive(s.pid))).toEqual([]);
    }
  });

  test("if wf-recorder cannot start, startCapture throws and leaves nothing alive (and no fd of ours open)", async () => {
    for (const audio of [false, true]) {
      const { env, spawned } = standIns((cmd) => (cmd[0] === "pw-dump" ? ["echo", "[]"] : ["sh", "-c", "exec sleep 30"]));
      const spawn = env.spawn;
      const passed: number[] = [];
      env.spawn = (cmd, o) => {
        if (typeof o.stdout === "number") passed.push(o.stdout);
        if (cmd[0] === "wf-recorder") throw new Error("no arranca");
        return spawn(cmd, o);
      };
      expect(() => startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio })).toThrow("no arranca");
      expect(spawned.length).toBeGreaterThan(0);
      for (const fd of passed) expect(() => fstatSync(fd)).toThrow();
      await Bun.sleep(50);
      expect(spawned.filter((s) => alive(s.pid))).toEqual([]);
    }
  });

  test("a capture that dies on its own resolves `ended`", async () => {
    const { env } = standIns((cmd) => (cmd[0] === "wf-recorder" ? ["true"] : FFMPEG_FD4));
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
    const ended = await Promise.race([handle.ended.then(() => "ended"), Bun.sleep(3000).then(() => "timeout")]);
    expect(ended).toBe("ended");
    await handle.stop();
  });

  /** Stand-ins con audio: nada graba pantalla ni audio (sleep/cat/true/echo). */
  function audioStandIns(recorder: string[], wf: string[] = ["sh", "-c", "exec sleep 30"]) {
    const opts: Record<string, SpawnOpts> = {};
    const { env, spawned } = standIns((cmd) => {
      if (cmd[0] === "wf-recorder") return wf;
      if (cmd[0] === "pw-record") return recorder;
      if (cmd[0] === "pw-dump") return ["echo", "[]"];
      if (cmd[0] === "pw-link") return ["true"];
      return FFMPEG_FD4;
    });
    const spawn = env.spawn;
    env.spawn = (cmd, o) => {
      opts[cmd[0]!] = o;
      return spawn(cmd, o);
    };
    return { env, spawned, opts };
  }

  test("with the PC audio: wf-recorder (-D) → ffmpeg fd 4, pw-record → ffmpeg fd 3; stop kills all three", async () => {
    const { env, spawned, opts } = audioStandIns(["sh", "-c", "exec sleep 30"]);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "DP-1", quality: QUALITY["720p30"], env, audio: true });
    expect(spawned.map((s) => s.cmd[0]).slice(0, 3)).toEqual(["ffmpeg", "wf-recorder", "pw-record"]);
    expect(spawned[1]!.cmd).toContain("-D");
    expect(spawned[0]!.cmd).toContain("pipe:3");
    expect(opts.ffmpeg!.fd3).toBe("pipe");
    expect(opts.ffmpeg!.fd4).toBe("pipe");
    expect(typeof opts["wf-recorder"]!.stdout).toBe("number");
    expect(typeof opts["pw-record"]!.stdout).toBe("number");
    expect(opts["wf-recorder"]!.stdout).not.toBe(opts["pw-record"]!.stdout);
    await Bun.sleep(80);
    expect(spawned.filter((s) => ["wf-recorder", "ffmpeg", "pw-record"].includes(s.cmd[0]!)).every((s) => alive(s.pid))).toBe(true);
    expect(spawned.some((s) => s.cmd[0] === "pw-dump")).toBe(true);
    await handle.stop();
    await handle.stop();
    await Bun.sleep(20);
    expect(spawned.filter((s) => alive(s.pid))).toEqual([]);
    const after = spawned.length;
    await Bun.sleep(1_200);
    expect(spawned.length).toBe(after); // el enlazador también paró
  });

  test("if pw-record dies mid-stream the capture ends (a stuck audio clock would freeze the video)", async () => {
    const { env, spawned } = audioStandIns(["true"]);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true });
    const ended = await Promise.race([handle.ended.then(() => "ended"), Bun.sleep(3000).then(() => "timeout")]);
    expect(ended).toBe("ended");
    await handle.stop();
    await Bun.sleep(20);
    expect(spawned.filter((s) => alive(s.pid))).toEqual([]);
  });

  const PRINTS = ["sh", "-c", "printf hola; exec sleep 30"];
  /**
   * Un "ffmpeg" con audio como el de verdad: saca un dato, lee el video del fd 4 hasta el fin y después sigue
   * esperando el audio del fd 3 (no termina solo cuando se corta el video).
   */
  const FFMPEG_WAITS_AUDIO = ["sh", "-c", "printf x; cat <&4 >/dev/null; exec cat <&3"];

  test("with audio, a wf-recorder that dies mid-stream cuts ffmpeg and pw-record: `ended` resolves, nothing left alive", async () => {
    const { env, spawned } = standIns((cmd) => {
      if (cmd[0] === "wf-recorder") return ["sh", "-c", "exec sleep 0.4"];
      if (cmd[0] === "pw-record") return ["sh", "-c", "exec sleep 30"];
      if (cmd[0] === "pw-dump") return ["echo", "[]"];
      if (cmd[0] === "pw-link") return ["true"];
      return FFMPEG_WAITS_AUDIO;
    });
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true, audioGraceMs: 50, audioTimeoutMs: 2_000 });
    expect(await handle.audioReady).toBe(true);
    const ended = await Promise.race([handle.ended.then(() => "ended"), Bun.sleep(3000).then(() => "timeout")]);
    expect(ended).toBe("ended");
    await Bun.sleep(50);
    // sin llamar a stop(): ninguno quedó vivo
    expect(spawned.filter((s) => ["wf-recorder", "ffmpeg", "pw-record"].includes(s.cmd[0]!) && alive(s.pid))).toEqual([]);
    await handle.stop();
  });

  test("with audio, a wf-recorder that dies during the audio probation makes audioReady false right away", async () => {
    const { env } = standIns((cmd) => {
      if (cmd[0] === "wf-recorder") return ["sh", "-c", "exec sleep 0.05"];
      if (cmd[0] === "pw-record") return ["sh", "-c", "exec sleep 30"];
      if (cmd[0] === "pw-dump") return ["echo", "[]"];
      if (cmd[0] === "pw-link") return ["true"];
      return FFMPEG_WAITS_AUDIO;
    });
    const t0 = performance.now();
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true, audioGraceMs: 1_500, audioTimeoutMs: 4_000 });
    expect(await handle.audioReady).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1_000);
    await handle.stop();
  });


  test("audioReady: true once ffmpeg has output and pw-record lived through the grace period; the bytes still reach the output", async () => {
    const { env } = audioStandIns(["sh", "-c", "exec sleep 30"], PRINTS);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true, audioGraceMs: 100, audioTimeoutMs: 2_000 });
    expect(await handle.audioReady).toBe(true);
    let text = "";
    handle.output.on("data", (chunk: Buffer) => (text += chunk.toString()));
    await Bun.sleep(30);
    expect(text).toBe("hola");
    await handle.stop();
  });

  test("audioReady: false when pw-record dies in the first seconds", async () => {
    const { env } = audioStandIns(["sh", "-c", "sleep 0.05"], PRINTS);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true, audioGraceMs: 300, audioTimeoutMs: 2_000 });
    expect(await handle.audioReady).toBe(false);
    await handle.stop();
  });

  test("audioReady: false when no video comes out in time", async () => {
    const { env } = audioStandIns(["sh", "-c", "exec sleep 30"]);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true, audioGraceMs: 50, audioTimeoutMs: 200 });
    expect(await handle.audioReady).toBe(false);
    await handle.stop();
  });

  test("audioReady: false when ffmpeg with audio dies in the first seconds", async () => {
    const { env } = standIns((cmd) => (cmd[0] === "ffmpeg" ? ["sh", "-c", "exit 1"] : cmd[0] === "pw-dump" ? ["echo", "[]"] : ["sh", "-c", "exec sleep 30"]));
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true, audioGraceMs: 300, audioTimeoutMs: 2_000 });
    expect(await handle.audioReady).toBe(false);
    await handle.stop();
  });

  test("video only: audioReady is true right away", async () => {
    const { env } = audioStandIns(["sh", "-c", "exec sleep 30"]);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
    expect(await Promise.race([handle.audioReady, Bun.sleep(20).then(() => "late")])).toBe(true);
    await handle.stop();
  });

  test("without audio nothing PipeWire is spawned and ffmpeg gets no fd 3", async () => {
    const { env, spawned, opts } = audioStandIns(["sh", "-c", "exec sleep 30"]);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
    await Bun.sleep(30);
    expect(spawned.map((s) => s.cmd[0])).toEqual(["ffmpeg", "wf-recorder"]);
    expect(opts.ffmpeg!.fd3).toBeUndefined();
    expect(opts.ffmpeg!.fd4).toBe("pipe");
    await handle.stop();
  });

  test("rejects a monitor name that is not a Wayland output name", () => {
    expect(() => startCapture({ backend: "grim", encoder: "x264", monitor: "-o; rm", quality: QUALITY["720p30"], env: standIns((c) => c).env })).toThrow();
  });
});

// Con el ffmpeg real del sistema y una fuente SINTÉTICA (lavfi, nada de pantalla): los keyframes caen cada 2 s.
const ffmpegReady = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;
// La fuente hace de wf-recorder (escribe en el fd 4 de ffmpeg, como en la captura de verdad).
test.skipIf(!ffmpegReady)("real ffmpeg with our args emits an IDR keyframe every 2 s", async () => {
  const env: CaptureEnv = {
    which: () => true,
    exists: () => false,
    spawn: (cmd, opts) =>
      defaultCaptureEnv.spawn(
        cmd[0] === "wf-recorder"
          ? ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "5", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-f", "nut", "pipe:1"]
          : cmd,
        opts,
      ),
  };
  const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
  const probe = defaultCaptureEnv.spawn(
    ["ffprobe", "-v", "error", "-f", "nut", "-i", "pipe:0", "-select_streams", "v", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"],
    { stdin: Readable.toWeb(handle.output) as unknown as ReadableStream<Uint8Array>, stdout: "pipe", stderr: "ignore" },
  );
  const csv = await new Response(probe.stdout as ReadableStream).text();
  await probe.exited;
  await handle.stop();
  const keyTimes = csv
    .trim()
    .split("\n")
    .map((line) => line.split(","))
    .filter(([, flags]) => flags?.startsWith("K"))
    .map(([pts]) => Math.round(Number(pts)));
  expect(keyTimes).toEqual([0, 2, 4]);
}, 20_000);

// Con el ffmpeg real y fuentes SINTÉTICAS (lavfi; un tono en lugar de pw-record, nada de PipeWire ni pantalla):
// el audio entra por el fd 3 de Bun y sale Opus junto al H264 en el NUT, sin pts negativos (NUT los rechaza).
test.skipIf(!ffmpegReady)("real ffmpeg with audio on fd 3 muxes H264 + Opus with no negative pts", async () => {
  const env: CaptureEnv = {
    which: () => true,
    exists: () => false,
    spawn: (cmd, opts) => {
      const real =
        cmd[0] === "wf-recorder"
          ? ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "1", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-f", "nut", "pipe:1"]
          : cmd[0] === "pw-record"
            ? // el audio llega después que el video: ahí el pre-skip del Opus daba pts negativo
              ["sh", "-c", "sleep 0.3; exec ffmpeg -hide_banner -nostdin -loglevel error -f lavfi -i sine=frequency=440:sample_rate=48000 -t 1.2 -ac 2 -f s16le pipe:1"]
            : cmd[0] === "pw-dump"
              ? ["echo", "[]"]
              : cmd[0] === "pw-link"
                ? ["true"]
                : cmd;
      return defaultCaptureEnv.spawn(real, opts);
    },
  };
  const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true });
  const probe = defaultCaptureEnv.spawn(
    ["ffprobe", "-v", "error", "-f", "nut", "-i", "pipe:0", "-show_entries", "stream=index,codec_name,sample_rate,channels:packet=stream_index,pts", "-of", "json"],
    { stdin: Readable.toWeb(handle.output) as unknown as ReadableStream<Uint8Array>, stdout: "pipe", stderr: "ignore" },
  );
  const json = JSON.parse(await new Response(probe.stdout as ReadableStream).text());
  await probe.exited;
  await handle.stop();
  const streams = json.streams as Array<{ index: number; codec_name: string; sample_rate?: string; channels?: number }>;
  expect(streams.map((s) => s.codec_name).sort()).toEqual(["h264", "opus"]);
  const opus = streams.find((s) => s.codec_name === "opus")!;
  expect(opus).toMatchObject({ sample_rate: "48000", channels: 2 });
  const packets = json.packets as Array<{ stream_index: number; pts: number }>;
  expect(packets.some((p) => p.stream_index === opus.index)).toBe(true);
  expect(packets.some((p) => p.stream_index !== opus.index)).toBe(true);
  expect(packets.every((p) => p.pts >= 0)).toBe(true);
}, 20_000);

// Con el ffmpeg real y fuentes SINTÉTICAS: la "captura" dura 1,5 s y el "audio" es silencio sin fin. Con audio,
// ffmpeg no termina solo al cortarse el video (sigue esperando el audio): hay que cortarlo para que `ended` llegue.
test.skipIf(!ffmpegReady)("real ffmpeg with audio: when the capture stops on its own, `ended` resolves and nothing is left alive", async () => {
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const spawned: Array<{ name: string; pid: number }> = [];
  const env: CaptureEnv = {
    which: () => true,
    exists: () => false,
    spawn: (cmd, opts) => {
      const real =
        cmd[0] === "wf-recorder"
          ? ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "1.5", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-f", "nut", "pipe:1"]
          : cmd[0] === "pw-record"
            ? ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-re", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-f", "s16le", "pipe:1"]
            : cmd[0] === "pw-dump"
              ? ["echo", "[]"]
              : cmd[0] === "pw-link"
                ? ["true"]
                : cmd;
      const proc = defaultCaptureEnv.spawn(real, opts);
      spawned.push({ name: cmd[0]!, pid: proc.pid });
      return proc;
    },
  };
  const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env, audio: true, audioGraceMs: 50 });
  handle.output.resume();
  expect(await handle.audioReady).toBe(true);
  const ended = await Promise.race([handle.ended.then(() => "ended"), Bun.sleep(8_000).then(() => "timeout")]);
  expect(ended).toBe("ended");
  await Bun.sleep(100);
  expect(spawned.filter((s) => ["wf-recorder", "ffmpeg", "pw-record"].includes(s.name) && alive(s.pid))).toEqual([]);
  await handle.stop();
}, 20_000);

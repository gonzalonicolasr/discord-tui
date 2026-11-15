import { afterEach, describe, expect, test } from "bun:test";

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
    expect(flag(args, "-i")).toBe("pipe:0");
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
    expect(inputs).toEqual(["pipe:0", "pipe:3"]);
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

  test("wf-recorder → ffmpeg: stop kills both, nothing left alive", async () => {
    const { env, spawned } = standIns((cmd) => (cmd[0] === "wf-recorder" ? ["sh", "-c", "exec sleep 30"] : ["cat"]));
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "DP-1", quality: QUALITY["720p30"], env });
    expect(spawned.map((s) => s.cmd[0])).toEqual(["wf-recorder", "ffmpeg"]);
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

  test("a capture that dies on its own resolves `ended`", async () => {
    const { env } = standIns((cmd) => (cmd[0] === "wf-recorder" ? ["true"] : ["cat"]));
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
    const ended = await Promise.race([handle.ended.then(() => "ended"), Bun.sleep(3000).then(() => "timeout")]);
    expect(ended).toBe("ended");
    await handle.stop();
  });

  /** Stand-ins con audio: nada graba pantalla ni audio (sleep/cat/true/echo). */
  function audioStandIns(recorder: string[]) {
    const opts: Record<string, SpawnOpts> = {};
    const { env, spawned } = standIns((cmd) => {
      if (cmd[0] === "wf-recorder") return ["sh", "-c", "exec sleep 30"];
      if (cmd[0] === "pw-record") return recorder;
      if (cmd[0] === "pw-dump") return ["echo", "[]"];
      if (cmd[0] === "pw-link") return ["true"];
      return ["cat"];
    });
    const spawn = env.spawn;
    env.spawn = (cmd, o) => {
      opts[cmd[0]!] = o;
      return spawn(cmd, o);
    };
    return { env, spawned, opts };
  }

  test("with the PC audio: wf-recorder (-D) → ffmpeg ← pw-record on fd 3; stop kills all three", async () => {
    const { env, spawned, opts } = audioStandIns(["sh", "-c", "exec sleep 30"]);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "DP-1", quality: QUALITY["720p30"], env, audio: true });
    expect(spawned.map((s) => s.cmd[0]).slice(0, 3)).toEqual(["wf-recorder", "ffmpeg", "pw-record"]);
    expect(spawned[0]!.cmd).toContain("-D");
    expect(spawned[1]!.cmd).toContain("pipe:3");
    expect(opts.ffmpeg!.fd3).toBe("pipe");
    expect(typeof opts["pw-record"]!.stdout).toBe("number");
    expect(spawned[2]!.cmd).toEqual(["pw-record", ...spawned[2]!.cmd.slice(1)]);
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

  test("without audio nothing PipeWire is spawned and ffmpeg gets no fd 3", async () => {
    const { env, spawned, opts } = audioStandIns(["sh", "-c", "exec sleep 30"]);
    const handle = startCapture({ backend: "wf-recorder", encoder: "x264", monitor: "", quality: QUALITY["720p30"], env });
    await Bun.sleep(30);
    expect(spawned.map((s) => s.cmd[0])).toEqual(["wf-recorder", "ffmpeg"]);
    expect(opts.ffmpeg!.fd3).toBeUndefined();
    await handle.stop();
  });

  test("rejects a monitor name that is not a Wayland output name", () => {
    expect(() => startCapture({ backend: "grim", encoder: "x264", monitor: "-o; rm", quality: QUALITY["720p30"], env: standIns((c) => c).env })).toThrow();
  });
});

// Con el ffmpeg real del sistema y una fuente SINTÉTICA (lavfi, nada de pantalla): los keyframes caen cada 2 s.
const ffmpegReady = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;
test.skipIf(!ffmpegReady)("real ffmpeg with our args emits an IDR keyframe every 2 s", async () => {
  const source = Bun.spawn(
    ["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30", "-t", "5", "-c:v", "rawvideo", "-pix_fmt", "yuv420p", "-f", "nut", "pipe:1"],
    { stdout: "pipe", stderr: "ignore", env: {} },
  );
  const encode = defaultCaptureEnv.spawn(ffmpegArgs({ backend: "wf-recorder", encoder: "x264", quality: QUALITY["720p30"] }), {
    stdin: source.stdout as ReadableStream<Uint8Array>,
    stdout: "pipe",
    stderr: "ignore",
  });
  const probe = defaultCaptureEnv.spawn(
    ["ffprobe", "-v", "error", "-f", "nut", "-i", "pipe:0", "-select_streams", "v", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"],
    { stdin: encode.stdout as ReadableStream<Uint8Array>, stdout: "pipe", stderr: "ignore" },
  );
  const csv = await new Response(probe.stdout as ReadableStream).text();
  await Promise.all([source.exited, encode.exited, probe.exited]);
  const keyTimes = csv
    .trim()
    .split("\n")
    .map((line) => line.split(","))
    .filter(([, flags]) => flags?.startsWith("K"))
    .map(([pts]) => Math.round(Number(pts)));
  expect(keyTimes).toEqual([0, 2, 4]);
}, 20_000);

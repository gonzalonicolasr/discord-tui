import { describe, expect, test } from "bun:test";

import {
  AudioDeviceError,
  startCapture,
  startPlayback,
  type SpawnLike,
} from "../../src/voice/audio-io";
import { FRAME_BYTES } from "../helpers/pcm";

interface FakeProc {
  cmd: string[];
  stdin: { writes: Uint8Array[]; log: string[]; write(chunk: Uint8Array): void; flush(): void; end(): void } | null;
  killed: boolean;
  kill(): void;
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  emit(chunk: Uint8Array): void;
  finish(code: number): void;
}

function fakeSpawn(opts: { exitImmediately?: number; stderrText?: string } = {}) {
  const calls: FakeProc[] = [];
  const spawn: SpawnLike = (cmd) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    const writes: Uint8Array[] = [];
    const log: string[] = [];
    const proc: FakeProc = {
      cmd,
      stdin: {
        writes,
        log,
        write(chunk: Uint8Array) {
          writes.push(chunk);
          log.push("write");
        },
        flush() {
          log.push("flush");
        },
        // Como pw-cat: al cerrarle la entrada termina solo.
        end() {
          log.push("end");
          resolveExit(0);
        },
      },
      killed: false,
      kill() {
        this.killed = true;
        resolveExit(0);
      },
      exited,
      stdout,
      stderr: opts.stderrText
        ? new Response(opts.stderrText).body
        : new Response("").body,
      emit(chunk: Uint8Array) {
        controller.enqueue(chunk);
      },
      finish(code: number) {
        try {
          controller.close();
        } catch {}
        resolveExit(code);
      },
    };
    calls.push(proc);
    if (opts.exitImmediately !== undefined) {
      setTimeout(() => proc.finish(opts.exitImmediately!), 0);
    }
    return proc as never;
  };
  return { spawn, calls };
}

const CAPTURE_BASE = ["pw-record", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2", "--latency", "20ms"];
const CAPTURE_ARGS = [...CAPTURE_BASE, "-"];
const PLAYBACK_BASE = ["pw-cat", "--playback", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2"];
const PLAYBACK_ARGS = [...PLAYBACK_BASE, "-"];

describe("startCapture", () => {
  test("spawns pw-record with the exact args", async () => {
    const fake = fakeSpawn();
    const capture = await startCapture({ spawn: fake.spawn });
    expect(fake.calls[0]?.cmd).toEqual(CAPTURE_ARGS);
    await capture.stop();
  });

  test("target adds --target", async () => {
    const fake = fakeSpawn();
    const capture = await startCapture({ spawn: fake.spawn, target: "alsa_output.usb.headset" });
    expect(fake.calls[0]?.cmd).toEqual([...CAPTURE_BASE, "--target", "alsa_output.usb.headset", "-"]);
    await capture.stop();
  });

  test("emits 3840-byte frames from arbitrary chunks", async () => {
    const fake = fakeSpawn();
    const capture = await startCapture({ spawn: fake.spawn });
    const frames: Uint8Array[] = [];
    capture.onFrame((frame) => frames.push(frame));
    fake.calls[0]!.emit(new Uint8Array(1000));
    fake.calls[0]!.emit(new Uint8Array(7000));
    await Bun.sleep(1);
    expect(frames).toHaveLength(2);
    expect(frames.every((frame) => frame.length === FRAME_BYTES)).toBe(true);
    await capture.stop();
  });

  test("process that exits immediately rejects with AudioDeviceError", async () => {
    const fake = fakeSpawn({ exitImmediately: 1, stderrText: "no such device" });
    await expect(startCapture({ spawn: fake.spawn })).rejects.toThrow(AudioDeviceError);
  });

  test("missing binary rejects with the message from the plan", async () => {
    const spawn: SpawnLike = () => {
      throw new Error("ENOENT");
    };
    await expect(startCapture({ spawn })).rejects.toThrow(/no pude abrir el micrófono \(pw-record: ENOENT\)/);
  });

  test("a listener that throws doesn't kill the mic: the other listeners keep getting frames", async () => {
    const fake = fakeSpawn();
    const capture = await startCapture({ spawn: fake.spawn });
    const frames: Uint8Array[] = [];
    capture.onFrame(() => {
      throw new Error("opus encoder choked");
    });
    capture.onFrame((frame) => frames.push(frame));
    fake.calls[0]!.emit(new Uint8Array(FRAME_BYTES));
    await Bun.sleep(1);
    fake.calls[0]!.emit(new Uint8Array(FRAME_BYTES));
    await Bun.sleep(1);
    expect(frames).toHaveLength(2);
    await capture.stop();
  });

  test("a mic read that fails never leaves an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let exit: (code: number) => void = () => {};
      const spawn: SpawnLike = () => ({
        stdin: null,
        stdout: new ReadableStream<Uint8Array>({ pull: (c) => c.error(new Error("EIO")) }),
        stderr: null,
        exited: new Promise<number>((resolve) => (exit = resolve)),
        killed: false,
        kill: () => exit(0),
      });
      const capture = await startCapture({ spawn });
      await Bun.sleep(5);
      await capture.stop();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("stop kills the process and resolves", async () => {
    const fake = fakeSpawn();
    const capture = await startCapture({ spawn: fake.spawn });
    await capture.stop();
    expect(fake.calls[0]?.killed).toBe(true);
  });
});

describe("startPlayback", () => {
  test("a pw-cat that died (EPIPE) never leaves an unhandled rejection, and nothing is written after it exits", async () => {
    let exit: (code: number) => void = () => {};
    const writes: Uint8Array[] = [];
    const epipe = () => Promise.reject(Object.assign(new Error("EPIPE: broken pipe, write"), { code: "EPIPE" }));
    const spawn: SpawnLike = () => ({
      stdin: { write: (chunk: Uint8Array) => (writes.push(chunk), epipe()), flush: epipe, end: epipe },
      stdout: null,
      stderr: null,
      exited: new Promise<number>((resolve) => (exit = resolve)),
      killed: false,
      kill: () => exit(0),
    });
    const playback = await startPlayback({ spawn });
    playback.write(new Uint8Array(FRAME_BYTES));
    await Bun.sleep(5);
    expect(writes).toHaveLength(1);
    exit(1); // pw-cat se cerró (cambio de salida / recambio por el reloj)
    await Bun.sleep(5);
    playback.write(new Uint8Array(FRAME_BYTES));
    await Bun.sleep(5);
    expect(writes).toHaveLength(1);
    await playback.stop();
    await Bun.sleep(5);
  });

  test("spawns pw-cat with the exact args", async () => {
    const fake = fakeSpawn();
    const playback = await startPlayback({ spawn: fake.spawn });
    expect(fake.calls[0]?.cmd).toEqual(PLAYBACK_ARGS);
    await playback.stop();
  });

  test("write() forwards frames to stdin", async () => {
    const fake = fakeSpawn();
    const playback = await startPlayback({ spawn: fake.spawn });
    playback.write(new Uint8Array(FRAME_BYTES));
    await Bun.sleep(1);
    expect(fake.calls[0]?.stdin?.writes).toHaveLength(1);
    await playback.stop();
  });

  test("every frame is flushed to pw-cat right away (Bun's FileSink buffers writes)", async () => {
    const fake = fakeSpawn();
    const playback = await startPlayback({ spawn: fake.spawn });
    playback.write(new Uint8Array(FRAME_BYTES));
    playback.write(new Uint8Array(FRAME_BYTES));
    await Bun.sleep(1);
    expect(fake.calls[0]?.stdin?.log).toEqual(["write", "flush", "write", "flush"]);
    await playback.stop();
  });

  test("stop closes pw-cat's input (it ignores SIGTERM while stdin is open)", async () => {
    const fake = fakeSpawn();
    const playback = await startPlayback({ spawn: fake.spawn });
    const started = Date.now();
    await playback.stop();
    expect(fake.calls[0]?.stdin?.log).toContain("end");
    expect(fake.calls[0]?.killed).toBe(false);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test("a full stdin queue drops the oldest frame instead of growing", async () => {
    const fake = fakeSpawn();
    const playback = await startPlayback({ spawn: fake.spawn, queuedFrames: 2 });
    for (let i = 0; i < 5; i += 1) playback.write(new Uint8Array(FRAME_BYTES).fill(i));
    expect(playback.dropped()).toBe(3);
    await playback.stop();
  });

  test("process that exits immediately rejects with AudioDeviceError", async () => {
    const fake = fakeSpawn({ exitImmediately: 1 });
    await expect(startPlayback({ spawn: fake.spawn })).rejects.toThrow(AudioDeviceError);
  });

  test("target adds --target before the trailing dash", async () => {
    const fake = fakeSpawn();
    const playback = await startPlayback({ spawn: fake.spawn, target: "iec958" });
    expect(fake.calls[0]?.cmd).toEqual([...PLAYBACK_BASE, "--target", "iec958", "-"]);
    await playback.stop();
  });
});

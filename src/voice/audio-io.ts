import { log } from "../log/logger";
import { cleanEnv } from "../proc/spawn";
import { createFramer } from "./pcm-framer";

export interface ProcLike {
  /** En Bun es un FileSink: `write` acumula en buffer y hace falta `flush` para que llegue al proceso. */
  stdin: { write(chunk: Uint8Array): unknown; flush?(): unknown; end?(): unknown } | null;
  stdout: ReadableStream<Uint8Array> | null;
  stderr: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  killed: boolean;
  kill(signal?: number): void;
}

export type SpawnLike = (cmd: string[], opts: { stdin: "pipe" | "ignore"; stdout: "pipe" | "ignore" }) => ProcLike;

export class AudioDeviceError extends Error {}

function defaultSpawn(): SpawnLike {
  return (cmd, opts) =>
    Bun.spawn(cmd, {
      env: cleanEnv(),
      stdin: opts.stdin,
      stdout: opts.stdout,
      stderr: "pipe",
    }) as unknown as ProcLike;
}

async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

async function waitForEarlyExit(proc: ProcLike, label: string, binary: string): Promise<void> {
  const early = await Promise.race([
    proc.exited.then((code) => ({ exited: true as const, code })),
    Bun.sleep(30).then(() => ({ exited: false as const, code: 0 })),
  ]);
  if (early.exited && early.code !== 0) {
    const stderr = await readAll(proc.stderr);
    throw new AudioDeviceError(`${label} (${binary}: ${stderr.trim() || `salió con código ${early.code}`})`);
  }
}

export interface AudioCapture {
  onFrame(fn: (pcm: Uint8Array) => void): () => void;
  stop(): Promise<void>;
}

export async function startCapture(opts?: { target?: string; spawn?: SpawnLike }): Promise<AudioCapture> {
  const spawn = opts?.spawn ?? defaultSpawn();
  const cmd = ["pw-record", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2", "--latency", "20ms"];
  if (opts?.target) cmd.push("--target", opts.target);
  cmd.push("-");

  let proc: ProcLike;
  try {
    proc = spawn(cmd, { stdin: "ignore", stdout: "pipe" });
  } catch (error) {
    throw new AudioDeviceError(
      `no pude abrir el micrófono (pw-record: ${error instanceof Error ? error.message : String(error)})`,
    );
  }

  await waitForEarlyExit(proc, "no pude abrir el micrófono", "pw-record");

  const framer = createFramer();
  const listeners = new Set<(pcm: Uint8Array) => void>();
  /** Oyentes que ya tiraron: se loguea una vez por oyente, no en cada cuadro (~50 por segundo). */
  const failed = new WeakSet<(pcm: Uint8Array) => void>();

  void (async () => {
    const stdout = proc.stdout;
    if (!stdout) return;
    const reader = stdout.getReader();
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        log.warn("voice.capture-read-failed", { error_name: error instanceof Error ? error.name : "error" });
        break;
      }
      const { done, value } = chunk;
      if (done) break;
      if (!value) continue;
      for (const frame of framer.push(value)) {
        for (const listener of listeners) {
          // Un oyente que tira (p. ej. el encoder con un cuadro raro) no corta el micrófono de los demás.
          try {
            listener(frame);
          } catch (error) {
            if (failed.has(listener)) continue;
            failed.add(listener);
            log.warn("voice.capture-listener-failed", { error_name: error instanceof Error ? error.name : "error" });
          }
        }
      }
    }
  })();

  return {
    onFrame(fn: (pcm: Uint8Array) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async stop(): Promise<void> {
      proc.kill();
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
      if (!exited) {
        proc.kill(9);
        await Promise.race([proc.exited, Bun.sleep(500)]);
      }
    },
  };
}

export interface AudioPlayback {
  write(pcm: Uint8Array): void;
  stop(): Promise<void>;
  dropped(): number;
}

/** Si la escritura devuelve una promesa (FileSink de Bun), sus rechazos (EPIPE) se tragan acá. */
function quiet(result: unknown): void {
  if (result && typeof (result as Promise<unknown>).then === "function") (result as Promise<unknown>).catch(() => {});
}

export async function startPlayback(opts?: {
  target?: string;
  spawn?: SpawnLike;
  queuedFrames?: number;
}): Promise<AudioPlayback> {
  const spawn = opts?.spawn ?? defaultSpawn();
  const cmd = ["pw-cat", "--playback", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2"];
  if (opts?.target) cmd.push("--target", opts.target);
  cmd.push("-");

  let proc: ProcLike;
  try {
    proc = spawn(cmd, { stdin: "pipe", stdout: "ignore" });
  } catch (error) {
    throw new AudioDeviceError(
      `no pude abrir la salida de audio (pw-cat: ${error instanceof Error ? error.message : String(error)})`,
    );
  }

  await waitForEarlyExit(proc, "no pude abrir la salida de audio", "pw-cat");

  const maxQueued = opts?.queuedFrames ?? 10;
  const queue: Uint8Array[] = [];
  let droppedCount = 0;
  let pumping = false;
  let closed = false;
  // Si pw-cat ya salió (se cambia cada tanto por el reloj, o se cerró la salida), write/flush/end fallan con
  // EPIPE de forma asíncrona: sin esto el rechazo queda suelto y OpenTUI abre su consola con el error.
  proc.exited.then(() => (closed = true), () => (closed = true));

  // El drenaje corre en el próximo tick, imitando que `pw-cat` consume a su propio ritmo:
  // si entran frames más rápido de lo que se vacía la cola, se descarta el más viejo.
  function pump(): void {
    if (pumping) return;
    pumping = true;
    queueMicrotask(() => {
      pumping = false;
      if (closed) {
        queue.length = 0;
        return;
      }
      const frame = queue.shift();
      if (frame) {
        try {
          quiet(proc.stdin?.write(frame));
          quiet(proc.stdin?.flush?.());
        } catch {
          // pw-cat ya no está
        }
      }
      if (queue.length > 0) pump();
    });
  }

  return {
    write(pcm: Uint8Array): void {
      if (closed) return;
      if (queue.length >= maxQueued) {
        queue.shift();
        droppedCount += 1;
      }
      queue.push(pcm);
      pump();
    },
    dropped(): number {
      return droppedCount;
    },
    async stop(): Promise<void> {
      // pw-cat ignora SIGTERM mientras tiene la entrada abierta: se cierra stdin y, si no sale, SIGKILL.
      closed = true;
      queue.length = 0;
      try {
        quiet(proc.stdin?.end?.());
      } catch {
        // ya cerrado
      }
      const exited = await Promise.race([proc.exited.then(() => true), Bun.sleep(500).then(() => false)]);
      if (!exited) {
        proc.kill(9);
        await Promise.race([proc.exited, Bun.sleep(500)]);
      }
    },
  };
}

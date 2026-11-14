import { createSignal, type Accessor } from "solid-js";

import { isAllowedImageHost } from "../images/cdn";
import { log } from "../log/logger";
import { spawnClean } from "../proc/spawn";

/** Qué está sonando (un audio a la vez, como Discord). */
export interface AudioPlayerState {
  /** Id del adjunto que suena (o carga); null = nada. */
  key: string | null;
  status: "idle" | "loading" | "playing" | "error";
  startedAt: number;
  error: string | null;
}

interface Proc {
  stdout?: ReadableStream<Uint8Array> | null;
  exited: Promise<number>;
  kill(signal?: number): void;
}

export interface AudioPlayerDeps {
  spawn?: (cmd: string[], opts: { stdin?: "ignore" | ReadableStream<Uint8Array>; stdout?: "pipe" | "ignore" }) => Proc;
  /** Salida de audio elegida en settings (PipeWire target), o null = la predeterminada. */
  target?: () => string | null;
  now?: () => number;
}

export interface AudioPlayer {
  state: Accessor<AudioPlayerState>;
  /** Reproduce el audio (o lo corta si ya es el que suena). */
  toggle(key: string, url: string): void;
  stop(): void;
}

const IDLE: AudioPlayerState = { key: null, status: "idle", startedAt: 0, error: null };

/**
 * Mensajes de voz y audios adjuntos: ffmpeg los lee del CDN de Discord y los pasa a PCM, y pw-cat los
 * reproduce a su ritmo por la misma salida que las llamadas. Solo URLs del CDN de Discord (nada de otros hosts).
 */
export function createAudioPlayer(deps: AudioPlayerDeps = {}): AudioPlayer {
  const spawn = deps.spawn ?? ((cmd, opts) => spawnClean(cmd, opts) as unknown as Proc);
  const now = deps.now ?? Date.now;
  const [state, setState] = createSignal<AudioPlayerState>(IDLE);
  let procs: Proc[] = [];
  let generation = 0;

  function killAll(): void {
    for (const proc of procs) {
      try {
        proc.kill();
      } catch {
        // ya terminó
      }
    }
    procs = [];
  }

  function stop(): void {
    generation++;
    killAll();
    setState(IDLE);
  }

  function play(key: string, url: string): void {
    stop();
    const mine = generation;
    if (!isAllowedImageHost(url)) {
      setState({ ...IDLE, key, status: "error", error: "ese audio no viene del CDN de Discord" });
      return;
    }
    setState({ key, status: "loading", startedAt: 0, error: null });
    try {
      const decoder = spawn(
        // -rw_timeout (µs): si el CDN deja de mandar, ffmpeg corta en vez de dejar el reproductor "sonando" en silencio.
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-rw_timeout", "15000000", "-i", url, "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1"],
        { stdin: "ignore", stdout: "pipe" },
      );
      procs = [decoder];
      const target = deps.target?.() ?? null;
      const cmd = ["pw-cat", "--playback", "--raw", "--format", "s16", "--rate", "48000", "--channels", "2"];
      if (target) cmd.push("--target", target);
      cmd.push("-");
      const out = spawn(cmd, { stdin: decoder.stdout ?? "ignore", stdout: "ignore" });
      procs.push(out);
      setState({ key, status: "playing", startedAt: now(), error: null });
      void Promise.all([decoder.exited, out.exited]).then(([decoded]) => {
        if (mine !== generation) return;
        procs = [];
        if (decoded !== 0) {
          log.warn("audio.decode-failed", { code: decoded });
          setState({ ...IDLE, key, status: "error", error: "no se pudo reproducir ese audio" });
        } else setState(IDLE);
      });
    } catch (error) {
      killAll();
      setState({ ...IDLE, key, status: "error", error: "para escuchar audios hace falta ffmpeg (y pw-cat)" });
      log.warn("audio.spawn-failed", { error_name: error instanceof Error ? error.name : "error" });
    }
  }

  return {
    state,
    stop,
    toggle(key, url) {
      const current = state();
      if (current.key === key && (current.status === "playing" || current.status === "loading")) return stop();
      play(key, url);
    },
  };
}

/** Lo que muestra la barra: la forma de onda de Discord (base64, un byte 0-255 por muestra) en bloques. */
export function waveformBars(waveform: string | undefined | null, width: number): string {
  const BARS = "▁▂▃▄▅▆▇█";
  if (!waveform) return BARS[2]!.repeat(width);
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(waveform), (c) => c.charCodeAt(0));
  } catch {
    return BARS[2]!.repeat(width);
  }
  if (bytes.length === 0) return BARS[2]!.repeat(width);
  let out = "";
  for (let i = 0; i < width; i++) {
    const from = Math.floor((i * bytes.length) / width);
    const to = Math.max(from + 1, Math.floor(((i + 1) * bytes.length) / width));
    let peak = 0;
    for (let j = from; j < to && j < bytes.length; j++) peak = Math.max(peak, bytes[j]!);
    out += BARS[Math.min(BARS.length - 1, Math.floor((peak / 256) * BARS.length))];
  }
  return out;
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** ¿El adjunto es audio? (mensaje de voz de Discord, o un ogg/mp3/wav/m4a/opus/flac). */
export function isAudioAttachment(a: { content_type?: string; filename?: string }): boolean {
  if ((a.content_type ?? "").startsWith("audio/")) return true;
  return /\.(ogg|oga|opus|mp3|wav|m4a|aac|flac)$/i.test(a.filename ?? "");
}

let shared: AudioPlayer | null = null;
/** Un solo reproductor para toda la app (si arrancás otro audio, el anterior se corta). */
export function audioPlayer(target?: () => string | null): AudioPlayer {
  shared ??= createAudioPlayer({ target });
  return shared;
}

/**
 * De dónde sale cada sonido de evento: el WAV del repo (src/sounds/wav/<cue>.wav, ver CREDITS.md ahí) y, si
 * falta o está roto, el tono sintetizado de synth.ts. Nunca tira: a lo sumo deja una línea en el log.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { log } from "../log/logger";
import { FRAME_MS } from "../voice/constants";
import { renderCue, type Cue } from "./synth";
import { MAX_WAV_BYTES, WavError, parseWav, wavFrames } from "./wav";

/**
 * Carpeta de los WAV. Desde el código fuente (`bun run dev`, tests) está al lado de este módulo; compilado, el
 * bundle vive en dist/src/ (o dist/scripts/) y los archivos se leen del src/ del repo, que viaja con él.
 */
export function defaultSoundsDir(moduleDir: string = import.meta.dir): string {
  const beside = join(moduleDir, "wav");
  if (existsSync(beside)) return beside;
  return join(moduleDir, "..", "..", "src", "sounds", "wav");
}

export interface CueLibrary {
  /** Frames de 20 ms (3840 bytes, s16le estéreo 48 kHz) del cue. */
  frames(cue: Cue): Uint8Array[];
  durationMs(cue: Cue): number;
}

function readLimited(path: string): Uint8Array {
  if (statSync(path).size > MAX_WAV_BYTES) throw new WavError("too-long");
  return readFileSync(path);
}

export function createCueLibrary(opts: {
  dir: string;
  readFile?: (path: string) => Uint8Array;
  warn?: (cue: Cue, reason: string) => void;
}): CueLibrary {
  const read = opts.readFile ?? readLimited;
  const warn =
    opts.warn ?? ((cue: Cue, reason: string): void => log.warn("sounds.wav-fallback", { msg: cue, error_name: reason }));
  const cache = new Map<Cue, Uint8Array[]>();

  function load(cue: Cue): Uint8Array[] {
    const path = join(opts.dir, `${cue}.wav`);
    try {
      return wavFrames(parseWav(read(path)).data);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      warn(cue, error instanceof WavError ? error.reason : code === "ENOENT" ? "missing" : "unreadable");
      return renderCue(cue);
    }
  }

  function frames(cue: Cue): Uint8Array[] {
    let out = cache.get(cue);
    if (!out) {
      out = load(cue);
      cache.set(cue, out);
    }
    return out;
  }

  return { frames, durationMs: (cue) => frames(cue).length * FRAME_MS };
}

let shared: CueLibrary | null = null;

function library(): CueLibrary {
  shared ??= createCueLibrary({ dir: defaultSoundsDir() });
  return shared;
}

/** Lo que suena de verdad (lo usa el reproductor). */
export function cueFrames(cue: Cue): Uint8Array[] {
  return library().frames(cue);
}

export function cueDurationMs(cue: Cue): number {
  return library().durationMs(cue);
}

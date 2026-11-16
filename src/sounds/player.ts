/**
 * Reproduce los sonidos de eventos sin trabar la UI. En llamada se suman al mixer (misma salida y mismo pw-cat
 * que la voz); fuera de llamada se abre un pw-cat corto hacia `settings.outputDevice` (o la predeterminada).
 */
import { log } from "../log/logger";
import type { SoundSettings } from "../settings/settings";
import { applyGain } from "../voice/gain";
import { cueDurationMs, cueFrames } from "./library";
import type { Cue } from "./synth";

export interface SoundSink {
  play(frames: Uint8Array[]): void;
}

export interface SoundPlayer {
  play(cue: Cue): void;
}

/** Ensordecido, como el oficial: solo suenan los avisos de tus propios botones y el de salir. */
export const DEAF_ALLOWED: ReadonlySet<Cue> = new Set<Cue>(["mute", "unmute", "deafen", "undeafen", "leave"]);

const DEDUPE_MS = 150;
const MAX_ONE_SHOTS = 3;
/** Margen después del sonido antes de cerrar pw-cat (cerrar stdin antes de que suene lo corta). */
const TAIL_MS = 150;

export function createSoundPlayer(deps: {
  getSettings(): { sounds: SoundSettings; outputDevice: string | null };
  isDeaf(): boolean;
  /** El mixer de la llamada, si estás en una. */
  mixerSink?: () => SoundSink | null;
  startPlayback(opts: { target?: string }): Promise<{ write(pcm: Uint8Array): void; stop(): Promise<void> }>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): SoundPlayer {
  const now = deps.now ?? ((): number => performance.now());
  const sleep = deps.sleep ?? ((ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)));
  const lastPlayed = new Map<Cue, number>();
  let inFlight = 0;

  async function oneShot(cue: Cue, frames: Uint8Array[], target: string | undefined): Promise<void> {
    inFlight += 1;
    try {
      const out = await deps.startPlayback({ target });
      // Todo de una (una sola escritura): la cola de startPlayback no descarta nada.
      out.write(concat(frames));
      await sleep(cueDurationMs(cue) + TAIL_MS);
      await out.stop();
    } catch (error) {
      log.warn("sounds.play-failed", { error_name: error instanceof Error ? error.name : "unknown" });
    } finally {
      inFlight -= 1;
    }
  }

  return {
    play(cue: Cue): void {
      const { sounds, outputDevice } = deps.getSettings();
      if (!sounds.enabled || sounds.volume <= 0 || sounds.events[cue] === false) return;
      if (deps.isDeaf() && !DEAF_ALLOWED.has(cue)) return;
      const t = now();
      const last = lastPlayed.get(cue);
      if (last !== undefined && t - last < DEDUPE_MS) return;

      const base = cueFrames(cue);
      const frames = sounds.volume === 100 ? base : base.map((frame) => applyGain(frame, sounds.volume));
      const sink = deps.mixerSink?.() ?? null;
      if (sink) {
        lastPlayed.set(cue, t);
        sink.play(frames);
        return;
      }
      if (inFlight >= MAX_ONE_SHOTS) return;
      lastPlayed.set(cue, t);
      void oneShot(cue, frames, outputDevice ?? undefined);
    },
  };
}

function concat(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + f.byteLength, 0));
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.byteLength;
  }
  return out;
}

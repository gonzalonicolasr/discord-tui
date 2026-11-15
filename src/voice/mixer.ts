import { FRAME_BYTES, FRAME_MS } from "./constants";
import { applyGain } from "./gain";
import { createJitterBuffer, type JitterBuffer } from "./jitter";

/** Diagnóstico de una ventana (sin ids de usuario). */
export interface MixerStats {
  /** Jitter buffers que se vaciaron a mitad de una frase. */
  underruns: number;
  /** Frames tirados porque el jitter buffer estaba lleno. */
  jitterDrops: number;
  /** El mayor colchón aprendido por un jitter buffer en la ventana, en ms. */
  jitterMsMax: number;
  /** Ticks que llegaron con 2 o más slots de atraso. */
  lateTicks: number;
  /** Slots salteados tras una pausa larga del event loop. */
  skippedFrames: number;
  /** El mayor atraso de un tick respecto de su slot (≈ atraso del event loop), en ms. */
  loopLagMaxMs: number;
}

const MAX_CATCH_UP_FRAMES = 5;

/** Suma frames s16le saturando a [-32768, 32767]. Sin frames → silencio de FRAME_BYTES. */
export function mixFrames(frames: Uint8Array[]): Uint8Array {
  const length = frames.length === 0 ? FRAME_BYTES : Math.max(...frames.map((f) => f.byteLength));
  const out = new Uint8Array(length);
  if (frames.length === 0) return out;
  const output = new DataView(out.buffer);
  const views = frames.map((f) => new DataView(f.buffer, f.byteOffset, f.byteLength));
  for (let offset = 0; offset + 1 < length; offset += 2) {
    let sum = 0;
    for (const view of views) {
      if (offset + 1 < view.byteLength) sum += view.getInt16(offset, true);
    }
    output.setInt16(offset, Math.max(-32768, Math.min(32767, sum)), true);
  }
  return out;
}

export interface Mixer {
  buffer(userId: string): JitterBuffer;
  remove(userId: string): void;
  start(): void;
  stop(): void;
  setMuted(m: boolean): void;
  activeUsers(): string[];
  /** Cambia la salida (pw-cat nuevo) sin cortar el reloj del mixer; le pone su colchón. */
  setPlayback(playback: { write(pcm: Uint8Array): void }): void;
  /** Milisegundos desde el último frame con audio de alguien (para renovar la salida en un silencio). */
  idleMs(): number;
  /**
   * Suma un sonido corto (frames de 20 ms) a los próximos slots, por la misma salida que la llamada. Suena
   * aunque estés ensordecido (los avisos de mute/deafen tienen que oírse).
   */
  play(frames: Uint8Array[]): void;
  /** Contadores desde la última lectura (y los pone en cero). */
  stats(): MixerStats;
}

function emptyStats(): MixerStats {
  return { underruns: 0, jitterDrops: 0, jitterMsMax: 0, lateTicks: 0, skippedFrames: 0, loopLagMaxMs: 0 };
}

function addJitterStats(into: MixerStats, jb: JitterBuffer): void {
  const s = jb.takeStats?.();
  if (!s) return;
  into.underruns += s.underruns;
  into.jitterDrops += s.drops;
  into.jitterMsMax = Math.max(into.jitterMsMax, s.targetFrames * FRAME_MS);
}

export function createMixer(deps: {
  playback: { write(pcm: Uint8Array): void };
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  gainFor?: (userId: string) => number;
  /**
   * Flujo continuo: escribe un frame en cada slot (silencio si nadie habla) y arranca con `prerollFrames`
   * de silencio, así pw-cat siempre tiene un colchón. Sin colchón, cualquier demora del timer (el audio
   * comparte el event loop con la UI) o un paquete que llega tarde deja a PipeWire sin datos: chasquidos.
   */
  continuous?: boolean;
  prerollFrames?: number;
}): Mixer {
  const now = deps.now ?? ((): number => performance.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearTimer =
    deps.clearTimer ?? ((h: unknown): void => clearInterval(h as ReturnType<typeof setInterval>));
  const buffers = new Map<string, JitterBuffer>();
  let playback = deps.playback;
  let lastAudioAt = now();
  let muted = false;
  let timer: unknown = null;
  let clock = 0;
  let tally: MixerStats = emptyStats();

  const continuous = deps.continuous === true;
  const preroll = deps.prerollFrames ?? 4;
  const SILENCE = new Uint8Array(FRAME_BYTES);
  /** Sonidos sueltos en curso: cada uno con su próximo frame. */
  let oneShots: { frames: Uint8Array[]; next: number }[] = [];

  function popOneShots(): Uint8Array[] {
    if (oneShots.length === 0) return [];
    const out: Uint8Array[] = [];
    for (const shot of oneShots) {
      const frame = shot.frames[shot.next];
      shot.next += 1;
      if (frame) out.push(frame);
    }
    oneShots = oneShots.filter((shot) => shot.next < shot.frames.length);
    return out;
  }

  function cushion(): void {
    if (!continuous || muted) return;
    for (let i = 0; i < preroll; i += 1) playback.write(SILENCE);
  }

  function mixSlot(): void {
    const frames: Uint8Array[] = [];
    for (const [userId, jb] of buffers) {
      const frame = jb.pop();
      if (!frame) continue;
      const gain = deps.gainFor?.(userId);
      frames.push(gain !== undefined && gain !== 100 ? applyGain(frame, gain) : frame);
    }
    const cues = popOneShots();
    if (muted) {
      // Ensordecido: no se escucha a nadie, pero los sonidos de la app sí.
      if (cues.length > 0) playback.write(mixFrames(cues));
      return;
    }
    if (cues.length > 0) {
      frames.push(...cues);
      lastAudioAt = now();
    }
    if (frames.length === 0) {
      if (continuous) playback.write(SILENCE);
      return;
    }
    lastAudioAt = now();
    playback.write(mixFrames(frames));
  }

  function tick(): void {
    const t = now();
    const due = Math.floor((t - clock) / FRAME_MS);
    if (due <= 0) return;
    tally.loopLagMaxMs = Math.max(tally.loopLagMaxMs, Math.round(t - clock - FRAME_MS));
    if (due >= 2) tally.lateTicks += 1;
    // Después de una pausa larga pw-cat se quedó sin colchón: se repone con los slots mezclados (la voz que estaba
    // esperando), sin silencio extra. Meter silencio acá cortaba la frase 100 ms y dejaba 100 ms más de latencia.
    const catchUp = continuous ? Math.max(MAX_CATCH_UP_FRAMES, preroll) : MAX_CATCH_UP_FRAMES;
    if (due > catchUp) {
      tally.skippedFrames += due - catchUp;
      for (let i = 0; i < catchUp; i += 1) mixSlot();
      clock = t;
      return;
    }
    for (let i = 0; i < due; i += 1) mixSlot();
    clock += due * FRAME_MS;
  }

  return {
    buffer(userId: string): JitterBuffer {
      let jb = buffers.get(userId);
      if (!jb) {
        jb = createJitterBuffer(continuous ? { rebufferFrames: 2 } : undefined);
        buffers.set(userId, jb);
      }
      return jb;
    },
    remove(userId: string): void {
      const jb = buffers.get(userId);
      if (jb) addJitterStats(tally, jb);
      buffers.delete(userId);
    },
    start(): void {
      if (timer !== null) return;
      clock = now();
      cushion();
      timer = setTimer(tick, FRAME_MS);
    },
    stop(): void {
      if (timer === null) return;
      clearTimer(timer);
      timer = null;
    },
    setMuted(m: boolean): void {
      const wasMuted = muted;
      muted = m;
      // Al dejar de estar ensordecido, pw-cat estuvo sin datos: se repone el colchón.
      if (wasMuted && !m) cushion();
    },
    activeUsers(): string[] {
      return [...buffers.keys()];
    },
    setPlayback(next): void {
      playback = next;
      cushion();
    },
    idleMs(): number {
      return now() - lastAudioAt;
    },
    stats(): MixerStats {
      for (const jb of buffers.values()) addJitterStats(tally, jb);
      const out = tally;
      tally = emptyStats();
      return out;
    },
    play(frames: Uint8Array[]): void {
      if (frames.length === 0) return;
      // Ensordecido, pw-cat estaba sin datos: un colchón corto antes del sonido para que no arranque cortado.
      if (muted && oneShots.length === 0) for (let i = 0; i < 2; i += 1) playback.write(SILENCE);
      oneShots.push({ frames, next: 0 });
    },
  };
}

export interface JitterStats {
  /** Veces que se vació a mitad de una frase (no al terminar de hablar). */
  underruns: number;
  /** Frames tirados por buffer lleno. */
  drops: number;
}

export interface JitterBuffer {
  push(pcm: Uint8Array): void;
  pop(): Uint8Array | null;
  readonly size: number;
  reset(): void;
  /** El que habla terminó la frase (mandó silencio o dejó de hablar): vaciarse ahora no es un corte. */
  end?(): void;
  /** Contadores desde la última lectura (y los pone en cero). */
  takeStats?(): JitterStats;
}

/** Si el audio vuelve dentro de este rato (en slots de 20 ms) después de vaciarse, se cuenta como corte. */
const UNDERRUN_SLOTS = 25;

/**
 * Buffer FIFO de frames PCM. Junta `prebufferFrames` antes de entregar; si se vacía
 * vuelve a prebufferear (nunca repite el último frame). Lleno → tira el más viejo.
 */
export function createJitterBuffer(opts?: {
  prebufferFrames?: number;
  maxFrames?: number;
  /** Frames para volver a entregar después de vaciarse a mitad de una frase (menos que el prebuffer inicial). */
  rebufferFrames?: number;
}): JitterBuffer {
  const prebufferFrames = opts?.prebufferFrames ?? 3;
  const rebufferFrames = opts?.rebufferFrames ?? prebufferFrames;
  let threshold = prebufferFrames;
  const maxFrames = opts?.maxFrames ?? 10;
  let frames: Uint8Array[] = [];
  let primed = false;
  /** Llegó audio y todavía no terminó la frase. */
  let talking = false;
  /** Entregó audio en el slot anterior. */
  let playing = false;
  /** Slots desde que se vació hablando; si vuelve audio antes de UNDERRUN_SLOTS, fue un corte. */
  let starvedFor: number | null = null;
  let underruns = 0;
  let drops = 0;

  return {
    push(pcm: Uint8Array): void {
      talking = true;
      if (starvedFor !== null) {
        underruns += 1;
        starvedFor = null;
      }
      frames.push(pcm);
      while (frames.length > maxFrames) {
        frames.shift();
        drops += 1;
      }
      if (frames.length >= threshold) primed = true;
    },
    pop(): Uint8Array | null {
      if (!primed) {
        if (playing && talking) starvedFor = 0;
        else if (starvedFor !== null && ++starvedFor >= UNDERRUN_SLOTS) starvedFor = null;
        playing = false;
        return null;
      }
      const frame = frames.shift();
      playing = true;
      if (frames.length === 0) {
        primed = false;
        threshold = rebufferFrames;
      }
      return frame ?? null;
    },
    get size(): number {
      return frames.length;
    },
    reset(): void {
      frames = [];
      primed = false;
      talking = false;
      playing = false;
      starvedFor = null;
      threshold = prebufferFrames;
    },
    end(): void {
      talking = false;
      starvedFor = null;
    },
    takeStats(): JitterStats {
      const out = { underruns, drops };
      underruns = 0;
      drops = 0;
      return out;
    },
  };
}

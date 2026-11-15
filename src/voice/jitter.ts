import { FRAME_BYTES } from "./constants";

export interface JitterStats {
  /** Veces que se vació a mitad de una frase (no al terminar de hablar). */
  underruns: number;
  /** Frames tirados por buffer lleno. */
  drops: number;
  /** Colchón aprendido para arrancar cada frase, en frames de 20 ms. */
  targetFrames: number;
  /** Frames que faltaban a mitad de una frase y se taparon con el PLC de Opus en vez de un hueco. */
  concealed: number;
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
  /**
   * PLC: de dónde sacar audio para tapar un frame que falta a mitad de una frase (el decoder de esa persona; puede
   * devolver varios frames juntos, p. ej. los 120 ms del WASM). null = sin PLC: el hueco queda en silencio.
   */
  setConcealer?(fn: (() => Uint8Array | null) | null): void;
}

/** Si el audio vuelve dentro de este rato (en slots de 20 ms) después de vaciarse, se cuenta como corte. */
const UNDERRUN_SLOTS = 25;
/** Tope del colchón aprendido: 200 ms. */
const MAX_TARGET_FRAMES = 10;
/** Como mucho se tapan 60 ms seguidos con PLC; más que eso es un corte de verdad (y el PLC ya se apagó). */
const MAX_CONCEALED_FRAMES = 3;
/**
 * Slots vacíos que se esperan antes de pedir PLC. Pedirlo avanza el decoder 120 ms: si el paquete solo venía tarde
 * (lo más común con jitter), al llegar se decodificaría muy mal (~3 dB de SNR en vez de > 60). Si aparece en este
 * rato, el decoder no se tocó. También evita una "cola" de PLC cuando el aviso de fin de frase llega un poco tarde.
 */
const PLC_WAIT_SLOTS = 2;

/** Si en este rato de voz (500 × 20 ms = 10 s) no hizo falta tanto colchón, baja un frame. */
const STABLE_POPS = 500;

/**
 * Buffer FIFO de frames PCM. Junta `prebufferFrames` antes de entregar; si se vacía
 * vuelve a prebufferear (nunca repite el último frame). Lleno → tira el más viejo.
 *
 * Adaptativo: cada frase nueva arranca con el colchón aprendido (de entrada `rebufferFrames`, como siempre). El
 * mixer llama a `pop()` una vez por slot de 20 ms, así que el buffer mide solo cuántos slots pasan sin paquetes a
 * mitad de una frase (la red los retuvo y los soltó juntos, o el event loop se trabó): ese hueco más un frame es el
 * colchón que hace falta, hasta 200 ms, aunque todavía no se haya vaciado. Si en 10 s de voz no hizo falta tanto,
 * baja de a un frame. Con la red pareja el hueco es de un slot: no suma latencia.
 */
export function createJitterBuffer(opts?: {
  prebufferFrames?: number;
  maxFrames?: number;
  /** Frames para volver a entregar después de vaciarse a mitad de una frase (menos que el prebuffer inicial). */
  rebufferFrames?: number;
}): JitterBuffer {
  const prebufferFrames = opts?.prebufferFrames ?? 3;
  const rebufferFrames = opts?.rebufferFrames ?? prebufferFrames;
  const maxFrames = opts?.maxFrames ?? 10;
  let threshold = prebufferFrames;
  /** Colchón aprendido para arrancar una frase. */
  let target = rebufferFrames;
  let frames: Uint8Array[] = [];
  let primed = false;
  /** Llegó audio y todavía no terminó la frase. */
  let talking = false;
  /** Entregó audio en el slot anterior. */
  let playing = false;
  /** Slots desde que se vació hablando; si vuelve audio antes de UNDERRUN_SLOTS, fue un corte. */
  let starvedFor: number | null = null;
  /** Slots desde el último paquete de esta frase (null = no hay frase en curso). */
  let sincePush: number | null = null;
  /** El mayor colchón que hizo falta en la ventana actual de STABLE_POPS. */
  let neededInWindow = 0;
  let stablePops = 0;
  let underruns = 0;
  let drops = 0;
  let concealed = 0;
  let targetMax = target;
  let concealer: (() => Uint8Array | null) | null = null;
  /** Frames de PLC de este hueco que todavía no se usaron, y cuántos se usaron. */
  let plc: Uint8Array[] = [];
  let concealRun = 0;

  /** Un frame de PLC para el slot actual, o null si no hay PLC o ya se tapó todo lo que se puede. */
  function concealFrame(): Uint8Array | null {
    if (!concealer || concealRun >= MAX_CONCEALED_FRAMES) return null;
    if (concealRun === 0) {
      let pcm: Uint8Array | null = null;
      try {
        pcm = concealer();
      } catch {
        pcm = null;
      }
      plc = [];
      for (let offset = 0; pcm && offset + FRAME_BYTES <= pcm.byteLength; offset += FRAME_BYTES)
        plc.push(pcm.subarray(offset, offset + FRAME_BYTES));
    }
    const frame = plc[concealRun];
    if (!frame) return null;
    concealRun += 1;
    concealed += 1;
    return frame;
  }

  const phraseThreshold = (): number => Math.max(rebufferFrames, target);

  return {
    push(pcm: Uint8Array): void {
      talking = true;
      if (starvedFor !== null) {
        underruns += 1;
        starvedFor = null;
      }
      if (sincePush !== null && sincePush < UNDERRUN_SLOTS) {
        // Pasaron `sincePush` slots sin audio: para no cortarse hace falta ese colchón y uno más.
        const needed = Math.min(MAX_TARGET_FRAMES, sincePush + 1);
        neededInWindow = Math.max(neededInWindow, needed);
        if (needed > target) {
          target = needed;
          targetMax = Math.max(targetMax, target);
        }
      }
      sincePush = 0;
      frames.push(pcm);
      // Volvió el audio mientras se tapaba el hueco con PLC: se sigue enseguida, sin esperar a rebufferear.
      if (concealRun > 0) {
        primed = true;
        concealRun = 0;
        plc = [];
      }
      // El tope crece lo mismo que creció el colchón aprendido.
      const cap = maxFrames + (target - rebufferFrames);
      while (frames.length > cap) {
        frames.shift();
        drops += 1;
      }
      if (frames.length >= threshold) primed = true;
    },
    pop(): Uint8Array | null {
      if (sincePush !== null) sincePush += 1;
      if (!primed) {
        if (playing && talking) starvedFor = 0;
        else if (starvedFor !== null && ++starvedFor >= UNDERRUN_SLOTS) starvedFor = null;
        playing = false;
        // A mitad de una frase, mejor el audio que Opus estima que un hueco de silencio.
        return talking && starvedFor !== null && starvedFor >= PLC_WAIT_SLOTS ? concealFrame() : null;
      }
      const frame = frames.shift();
      playing = true;
      stablePops += 1;
      if (stablePops >= STABLE_POPS) {
        if (neededInWindow < target && target > rebufferFrames) target -= 1;
        stablePops = 0;
        neededInWindow = 0;
      }
      if (frames.length === 0) {
        primed = false;
        // A mitad de frase se retoma enseguida; una frase nueva arranca con el colchón aprendido.
        threshold = talking ? rebufferFrames : phraseThreshold();
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
      sincePush = null;
      neededInWindow = 0;
      stablePops = 0;
      concealRun = 0;
      plc = [];
      target = rebufferFrames;
      threshold = prebufferFrames;
    },
    end(): void {
      talking = false;
      starvedFor = null;
      sincePush = null;
      // No viene más audio de esta frase: lo que espera para juntar el colchón suena ya, no al empezar la próxima.
      concealRun = 0;
      plc = [];
      if (frames.length > 0) primed = true;
      else if (!primed) threshold = Math.max(threshold, phraseThreshold());
    },
    setConcealer(fn): void {
      concealer = fn;
    },
    takeStats(): JitterStats {
      const out = { underruns, drops, targetFrames: targetMax, concealed };
      underruns = 0;
      drops = 0;
      concealed = 0;
      targetMax = target;
      return out;
    },
  };
}

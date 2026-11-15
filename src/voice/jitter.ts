export interface JitterStats {
  /** Veces que se vació a mitad de una frase (no al terminar de hablar). */
  underruns: number;
  /** Frames tirados por buffer lleno. */
  drops: number;
  /** Colchón aprendido para arrancar cada frase, en frames de 20 ms. */
  targetFrames: number;
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
/** Tope del colchón aprendido: 200 ms. */
const MAX_TARGET_FRAMES = 10;
/** Si en este rato de voz (500 × 20 ms = 10 s) no hizo falta tanto colchón, baja un frame. */
const STABLE_POPS = 500;

/**
 * Buffer FIFO de frames PCM. Junta `prebufferFrames` antes de entregar; si se vacía
 * vuelve a prebufferear (nunca repite el último frame). Lleno → tira el más viejo.
 *
 * Adaptativo: cada frase nueva arranca con el colchón aprendido (de entrada `rebufferFrames`, como siempre). El
 * mixer llama a `pop()` una vez por slot de 20 ms, así que el buffer mide solo cuántos slots pasan sin paquetes a
 * mitad de una frase (la red los retuvo y los soltó juntos, o el event loop se trabó): ese hueco es el colchón que
 * hace falta, hasta 200 ms, aunque todavía no se haya vaciado. Si en 10 s de voz no hizo falta tanto, baja de a un
 * frame. Con la red pareja el hueco es de 1 o 2 slots (el cruce de un borde de tick): no sube del colchón de base.
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
  let targetMax = target;

  const phraseThreshold = (): number => Math.max(rebufferFrames, target);

  return {
    push(pcm: Uint8Array): void {
      talking = true;
      if (starvedFor !== null) {
        underruns += 1;
        starvedFor = null;
      }
      if (sincePush !== null && sincePush < UNDERRUN_SLOTS) {
        // Hubo `sincePush` pops entre este paquete y el anterior: para no cortarse hacen falta esos frames guardados.
        // Con la red pareja da 1, y 2 cuando un paquete cruza el borde de un tick (±1 ms de jitter): eso no es jitter
        // de verdad y no sube el colchón. Un hueco de verdad (3 o más) lleva un frame de margen, por si el próximo
        // es un poco más largo.
        const needed = Math.min(MAX_TARGET_FRAMES, sincePush >= 3 ? sincePush + 1 : sincePush);
        neededInWindow = Math.max(neededInWindow, needed);
        if (needed > target) {
          target = needed;
          targetMax = Math.max(targetMax, target);
        }
      }
      sincePush = 0;
      frames.push(pcm);
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
      if (primed && frames.length === 0) {
        // Recién ahora falta audio (sacar el último frame no es vaciarse: el próximo paquete puede llegar antes del
        // pop siguiente). A mitad de frase se retoma enseguida; una frase nueva arranca con el colchón aprendido.
        primed = false;
        threshold = talking ? rebufferFrames : phraseThreshold();
      }
      if (!primed) {
        if (playing && talking) starvedFor = 0;
        else if (starvedFor !== null && ++starvedFor >= UNDERRUN_SLOTS) starvedFor = null;
        playing = false;
        return null;
      }
      const frame = frames.shift()!;
      playing = true;
      stablePops += 1;
      if (stablePops >= STABLE_POPS) {
        if (neededInWindow < target && target > rebufferFrames) target -= 1;
        stablePops = 0;
        neededInWindow = 0;
      }
      if (frames.length === 0 && !talking) {
        // Terminó la frase: la próxima arranca con el colchón aprendido.
        primed = false;
        threshold = phraseThreshold();
      }
      return frame;
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
      target = rebufferFrames;
      threshold = prebufferFrames;
    },
    end(): void {
      talking = false;
      starvedFor = null;
      sincePush = null;
      // No viene más audio de esta frase: lo que espera para juntar el colchón suena ya, no al empezar la próxima.
      if (frames.length > 0) primed = true;
      else {
        threshold = primed ? phraseThreshold() : Math.max(threshold, phraseThreshold());
        primed = false;
      }
    },
    takeStats(): JitterStats {
      const out = { underruns, drops, targetFrames: targetMax };
      underruns = 0;
      drops = 0;
      targetMax = target;
      return out;
    },
  };
}

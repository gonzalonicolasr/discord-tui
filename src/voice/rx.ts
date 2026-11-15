import { SILENCE_FRAME } from "./constants";
import { rmsDbfs } from "./vad";
import type { Mixer } from "./mixer";
import type { VoiceSession } from "./session";

export interface Receiver {
  /**
   * `arrivalP95Ms`/`arrivalMaxMs`: intervalo entre paquetes de voz seguidos de una misma persona en la ventana
   * (20 ms si la red viene pareja; la sesión no expone el número de secuencia RTP).
   */
  stats(): { packets: number; decodeErrors: number; usersActive: number; peakDb: number; arrivalP95Ms: number; arrivalMaxMs: number };
  removeUser(userId: string): void;
  stop(): void;
}

function isSilence(opus: Uint8Array): boolean {
  return (
    opus.byteLength === SILENCE_FRAME.byteLength &&
    opus[0] === SILENCE_FRAME[0] &&
    opus[1] === SILENCE_FRAME[1] &&
    opus[2] === SILENCE_FRAME[2]
  );
}

const SILENCE_END = 5;
const SPEAKING_TIMEOUT_MS = 300;
/** Sin hablar este rato (o se fue del canal): se libera su decoder; si vuelve se crea otro. */
const IDLE_DECODER_MS = 2 * 60_000;
const IDLE_SWEEP_MS = 10_000;
const DECODER_RETRY_MS = 5_000;
const DECODER_ERROR_LOG_MS = 60_000;
/** Intervalos entre llegadas: histograma de a 5 ms hasta 1 s (más que eso es una pausa, no jitter). */
const ARRIVAL_BUCKET_MS = 5;
const ARRIVAL_MAX_MS = 1_000;

/**
 * Opus de cada participante → un decoder por usuario → jitter buffer del mixer.
 * Los frames de silencio no se decodifican; 5 seguidos o 300 ms sin paquetes = dejó de hablar.
 * Ensordecido: no se decodifica ni se reproduce, pero los indicadores siguen.
 */
export function createReceiver(deps: {
  session: Pick<VoiceSession, "onOpus" | "onSpeaking">;
  mixer: Pick<Mixer, "buffer" | "remove">;
  makeDecoder: () => { decode(opus: Uint8Array): Uint8Array; destroy?(): void };
  /** Si no se pudo crear un decoder (para loguear el motivo): a lo sumo una vez por minuto, con cuántos fallaron. */
  onDecoderError?(error: unknown, failures: number): void;
  /**
   * Diagnóstico: los primeros paquetes de cada persona se decodifican también con un decoder de referencia y se
   * reporta el nivel de los dos (nunca audio), para comparar con paquetes reales de Discord.
   */
  referenceDecoder?: () => { decode(opus: Uint8Array): Uint8Array; destroy?(): void };
  onDecoderCheck?(userId: string, oursDb: number, referenceDb: number, packets: number): void;
  now?: () => number;
  isDeaf: () => boolean;
  onSpeaking(userId: string, on: boolean): void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}): Receiver {
  const setTimer = deps.setTimer ?? setTimeout;
  const clearTimer = deps.clearTimer ?? clearTimeout;
  const now = deps.now ?? Date.now;
  const decoders = new Map<string, { decode(opus: Uint8Array): Uint8Array; destroy?(): void }>();
  /** userId → hasta cuándo no reintentar crear su decoder (no reintentar en cada paquete). */
  const failedUntil = new Map<string, number>();
  /** userId → último paquete con voz (para liberar los decoders de los que ya no hablan). */
  const lastHeard = new Map<string, number>();
  let lastSweep = now();
  let lastErrorReport = -Infinity;
  let unreportedFailures = 0;
  /** userId → llegada del último paquete de voz (se borra con el silencio: la pausa no es jitter). */
  const lastArrival = new Map<string, number>();
  let arrivals = new Uint32Array(ARRIVAL_MAX_MS / ARRIVAL_BUCKET_MS + 1);
  let arrivalCount = 0;
  let arrivalMaxMs = 0;
  const silenceRun = new Map<string, number>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const speaking = new Set<string>();
  let packets = 0;
  let decodeErrors = 0;
  let peakDb = -96;
  const checks = new Map<string, { ref: { decode(opus: Uint8Array): Uint8Array; destroy?(): void }; ours: number; refPeak: number; n: number }>();
  const CHECK_PACKETS = 50;

  function setSpeaking(userId: string, on: boolean): void {
    if (on === speaking.has(userId)) return;
    if (on) speaking.add(userId);
    else speaking.delete(userId);
    deps.onSpeaking(userId, on);
  }

  /** Terminó la frase: que el jitter buffer no lo cuente como corte cuando se vacíe. */
  function endTalk(userId: string): void {
    lastArrival.delete(userId);
    if (decoders.has(userId)) deps.mixer.buffer(userId).end?.();
  }

  function recordArrival(userId: string, at: number): void {
    const last = lastArrival.get(userId);
    lastArrival.set(userId, at);
    if (last === undefined) return;
    const gap = at - last;
    if (gap < 0 || gap > ARRIVAL_MAX_MS) return;
    arrivals[Math.floor(gap / ARRIVAL_BUCKET_MS)]! += 1;
    arrivalCount += 1;
    if (gap > arrivalMaxMs) arrivalMaxMs = gap;
  }

  function arrivalP95(): number {
    if (arrivalCount === 0) return 0;
    const rank = Math.ceil(arrivalCount * 0.95);
    let seen = 0;
    for (let i = 0; i < arrivals.length; i += 1) {
      seen += arrivals[i]!;
      if (seen >= rank) return (i + 1) * ARRIVAL_BUCKET_MS;
    }
    return ARRIVAL_MAX_MS;
  }

  function armTimeout(userId: string): void {
    const previous = timers.get(userId);
    if (previous !== undefined) clearTimer(previous);
    timers.set(
      userId,
      setTimer(() => {
        timers.delete(userId);
        endTalk(userId);
        setSpeaking(userId, false);
      }, SPEAKING_TIMEOUT_MS),
    );
  }

  function freeIdleDecoders(at: number): void {
    if (at - lastSweep < IDLE_SWEEP_MS) return;
    lastSweep = at;
    for (const [userId, heard] of lastHeard) if (at - heard >= IDLE_DECODER_MS) removeUser(userId);
  }

  function decoderFailed(error: unknown, at: number): void {
    unreportedFailures += 1;
    if (at - lastErrorReport < DECODER_ERROR_LOG_MS) return;
    lastErrorReport = at;
    const failures = unreportedFailures;
    unreportedFailures = 0;
    deps.onDecoderError?.(error, failures);
  }

  const offOpus = deps.session.onOpus((userId, opus) => {
    packets += 1;
    // Vacío no es audio: el decoder WASM lo tomaría como "paquete perdido" y devolvería 120 ms de relleno.
    if (opus.byteLength === 0) return;
    const at = now();
    freeIdleDecoders(at);
    if (isSilence(opus)) {
      const run = (silenceRun.get(userId) ?? 0) + 1;
      silenceRun.set(userId, run);
      if (run === 1) endTalk(userId);
      if (run >= SILENCE_END) setSpeaking(userId, false);
      return;
    }
    silenceRun.set(userId, 0);
    recordArrival(userId, at);
    setSpeaking(userId, true);
    armTimeout(userId);
    if (deps.isDeaf()) {
      // Sigue hablando aunque no se lo decodifique: que el barrido no le libere el decoder (y apague su indicador).
      if (decoders.has(userId)) lastHeard.set(userId, at);
      return;
    }

    let decoder = decoders.get(userId);
    if (!decoder) {
      if ((failedUntil.get(userId) ?? 0) > at) return;
      try {
        decoder = deps.makeDecoder();
      } catch (error) {
        decodeErrors += 1;
        failedUntil.set(userId, at + DECODER_RETRY_MS);
        decoderFailed(error, at);
        return;
      }
      failedUntil.delete(userId);
      decoders.set(userId, decoder);
    }
    lastHeard.set(userId, at);
    try {
      const pcm = decoder.decode(opus);
      deps.mixer.buffer(userId).push(pcm);
      // Solo diagnóstico: medir nunca puede cortar el audio.
      if (pcm.byteLength >= 4 && pcm.byteLength % 2 === 0) {
        const level = rmsDbfs(pcm);
        if (level > peakDb) peakDb = level;
        checkAgainstReference(userId, opus, level);
      }
    } catch {
      decodeErrors += 1;
    }
  });

  function checkAgainstReference(userId: string, opus: Uint8Array, oursDb: number): void {
    if (!deps.referenceDecoder || !deps.onDecoderCheck) return;
    let check = checks.get(userId);
    if (check === undefined) {
      if (checks.size >= 2) return; // el decoder de referencia (opusscript) no aguanta muchas instancias
      try {
        check = { ref: deps.referenceDecoder(), ours: -96, refPeak: -96, n: 0 };
      } catch {
        return;
      }
      checks.set(userId, check);
    }
    if (check.n >= CHECK_PACKETS) return;
    try {
      check.refPeak = Math.max(check.refPeak, rmsDbfs(check.ref.decode(opus)));
    } catch {
      // paquete que el de referencia no entiende
    }
    check.ours = Math.max(check.ours, oursDb);
    check.n += 1;
    if (check.n === CHECK_PACKETS) {
      deps.onDecoderCheck(userId, check.ours, check.refPeak, check.n);
      try {
        check.ref.destroy?.();
      } catch {
        // ya liberado
      }
    }
  }

  const offSpeaking = deps.session.onSpeaking((userId, on) => {
    if (on) {
      setSpeaking(userId, true);
      armTimeout(userId);
    } else {
      endTalk(userId);
      setSpeaking(userId, false);
    }
  });

  function removeUser(userId: string): void {
    try {
      decoders.get(userId)?.destroy?.();
    } catch {
      // ya liberado
    }
    decoders.delete(userId);
    lastHeard.delete(userId);
    lastArrival.delete(userId);
    failedUntil.delete(userId);
    silenceRun.delete(userId);
    const timer = timers.get(userId);
    if (timer !== undefined) clearTimer(timer);
    timers.delete(userId);
    deps.mixer.remove(userId);
    setSpeaking(userId, false);
  }

  return {
    stats() {
      const out = { packets, decodeErrors, usersActive: decoders.size, peakDb, arrivalP95Ms: arrivalP95(), arrivalMaxMs: Math.round(arrivalMaxMs) };
      peakDb = -96;
      arrivals = new Uint32Array(arrivals.length);
      arrivalCount = 0;
      arrivalMaxMs = 0;
      return out;
    },
    removeUser,
    stop(): void {
      offOpus();
      offSpeaking();
      for (const userId of [...decoders.keys(), ...speaking]) removeUser(userId);
      for (const check of checks.values()) {
        if (check.n >= CHECK_PACKETS) continue; // ese ya se liberó al terminar la comparación
        try {
          check.ref.destroy?.();
        } catch {
          // ya liberado
        }
      }
      checks.clear();
      for (const timer of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
}

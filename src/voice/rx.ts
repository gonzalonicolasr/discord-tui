import { SILENCE_FRAME } from "./constants";
import { rmsDbfs } from "./vad";
import type { Mixer } from "./mixer";
import type { VoiceSession } from "./session";

export interface Receiver {
  stats(): { packets: number; decodeErrors: number; usersActive: number; peakDb: number };
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

/**
 * Opus de cada participante → un decoder por usuario → jitter buffer del mixer.
 * Los frames de silencio no se decodifican; 5 seguidos o 300 ms sin paquetes = dejó de hablar.
 * Ensordecido: no se decodifica ni se reproduce, pero los indicadores siguen.
 */
export function createReceiver(deps: {
  session: Pick<VoiceSession, "onOpus" | "onSpeaking">;
  mixer: Pick<Mixer, "buffer" | "remove">;
  makeDecoder: () => { decode(opus: Uint8Array): Uint8Array; destroy?(): void };
  /** Si no se pudo crear un decoder (para loguear el motivo). */
  onDecoderError?(error: unknown): void;
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

  function armTimeout(userId: string): void {
    const previous = timers.get(userId);
    if (previous !== undefined) clearTimer(previous);
    timers.set(
      userId,
      setTimer(() => {
        timers.delete(userId);
        setSpeaking(userId, false);
      }, SPEAKING_TIMEOUT_MS),
    );
  }

  function freeIdleDecoders(at: number): void {
    if (at - lastSweep < IDLE_SWEEP_MS) return;
    lastSweep = at;
    for (const [userId, heard] of lastHeard) if (at - heard >= IDLE_DECODER_MS) removeUser(userId);
  }

  const offOpus = deps.session.onOpus((userId, opus) => {
    packets += 1;
    const at = now();
    freeIdleDecoders(at);
    if (isSilence(opus)) {
      const run = (silenceRun.get(userId) ?? 0) + 1;
      silenceRun.set(userId, run);
      if (run >= SILENCE_END) setSpeaking(userId, false);
      return;
    }
    silenceRun.set(userId, 0);
    setSpeaking(userId, true);
    armTimeout(userId);
    if (deps.isDeaf()) return;

    let decoder = decoders.get(userId);
    if (!decoder) {
      if ((failedUntil.get(userId) ?? 0) > at) return;
      try {
        decoder = deps.makeDecoder();
      } catch (error) {
        decodeErrors += 1;
        failedUntil.set(userId, at + 5_000);
        deps.onDecoderError?.(error);
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
    } else setSpeaking(userId, false);
  });

  function removeUser(userId: string): void {
    try {
      decoders.get(userId)?.destroy?.();
    } catch {
      // ya liberado
    }
    decoders.delete(userId);
    lastHeard.delete(userId);
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
      const out = { packets, decodeErrors, usersActive: decoders.size, peakDb };
      peakDb = -96;
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

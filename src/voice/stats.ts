import type { AllowedField, Logger } from "../log/logger";

/** Diagnóstico de cortes por ventana: contadores agregados, nunca ids de usuarios. */
export interface VoiceDiagnostics {
  underruns?: number;
  jitterDrops?: number;
  jitterMsMax?: number;
  arrivalP95Ms?: number;
  arrivalMaxMs?: number;
  lateTicks?: number;
  skippedFrames?: number;
  loopLagMaxMs?: number;
  playbackPending?: number;
  playbackDropped?: number;
}

const DIAGNOSTIC_FIELDS: Record<keyof VoiceDiagnostics, AllowedField> = {
  underruns: "underruns",
  jitterDrops: "jitter_drops",
  jitterMsMax: "jitter_ms_max",
  arrivalP95Ms: "arrival_p95_ms",
  arrivalMaxMs: "arrival_max_ms",
  lateTicks: "late_ticks",
  skippedFrames: "skipped_frames",
  loopLagMaxMs: "loop_lag_max_ms",
  playbackPending: "playback_pending",
  playbackDropped: "playback_dropped",
};

/** Cada 60 s loguea paquetes recibidos, errores de decodificación y el diagnóstico de cortes (sin ids de usuarios). */
export function createVoiceStats(deps: {
  log: Pick<Logger, "info">;
  read(): { packets: number; decodeErrors: number; state: string; peakDb?: number } & VoiceDiagnostics;
  every?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): { stop(): void } {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setInterval(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle: unknown): void => clearInterval(handle as ReturnType<typeof setInterval>));
  const handle = setTimer(() => {
    const read = deps.read();
    const { packets, decodeErrors, state, peakDb } = read;
    const diagnostics: Partial<Record<AllowedField, number>> = {};
    for (const [key, field] of Object.entries(DIAGNOSTIC_FIELDS) as [keyof VoiceDiagnostics, AllowedField][]) {
      const value = read[key];
      if (value !== undefined) diagnostics[field] = Math.round(value);
    }
    deps.log.info("voice.stats", {
      packets,
      decode_errors: decodeErrors,
      state,
      ...(peakDb !== undefined ? { peak_db: Math.round(peakDb) } : {}),
      ...diagnostics,
    });
  }, deps.every ?? 60_000);
  (handle as { unref?: () => void } | null)?.unref?.();
  return { stop: () => clearTimer(handle) };
}

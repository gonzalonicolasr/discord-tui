import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateDir } from "../config/paths";
import type { AppState } from "../store/types";

/** Sin teclas ni clicks durante este rato: recién ahí zcord se recarga solo. */
export const AUTO_RELOAD_QUIET_MS = 10_000;
/** Cambios seguidos (un git pull, un merge) dentro de este rato cuentan como uno solo. */
export const AUTO_RELOAD_DEBOUNCE_MS = 2_000;
/** Si no se puede recargar todavía, se vuelve a probar cada tanto. */
export const AUTO_RELOAD_RETRY_MS = 5_000;

export interface ReloadSafetyInput {
  /** Lo que una recarga tira (borrador, adjuntos, tu transmisión): lo mismo que pide confirmar Ctrl+R. */
  losses: string[];
  /** Editando un mensaje o con el PATCH de la edición esperando a Discord. */
  editing: boolean;
  state: AppState;
  /** Última tecla o click. */
  lastInputAt: number;
  now: number;
}

/** Por qué zcord no se puede recargar solo ahora mismo; vacío = es seguro. */
export function autoReloadBlockers(input: ReloadSafetyInput): string[] {
  const reasons = [...input.losses];
  if (input.editing) reasons.push("la edición");
  if (Object.values(input.state.outbox).some((item) => item.state === "pending")) reasons.push("un envío en curso");
  const voice = input.state.voice;
  // Solo una llamada activa: "error" (llamada cortada, join fallido) queda hasta el próximo join y no es una llamada.
  const inCall = voice.status === "joining" || voice.status === "connected" || voice.status === "reconnecting";
  if (voice.channelId !== null || inCall) reasons.push("la llamada");
  if (voice.watch.status === "watching" || voice.watch.status === "connecting") reasons.push("la transmisión que mirás");
  if (input.now - input.lastInputAt < AUTO_RELOAD_QUIET_MS) reasons.push("lo que estás tocando");
  return reasons;
}

/**
 * Última recarga automática, en disco (sobrevive a la recarga): cuándo fue y por qué versión de GitHub (SHA de
 * FETCH_HEAD). Es el tope contra los bucles; no se confía en la marca update-available, que bin/zcord borra aunque
 * el pull no haya traído nada (clon en otra rama, por ejemplo).
 */
export interface AutoReloadRecord {
  at: number;
  updateSha: string | null;
}

export function autoReloadRecordPath(): string {
  return join(stateDir(), "auto-reload.json");
}

export function loadAutoReloadRecord(path = autoReloadRecordPath()): AutoReloadRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<AutoReloadRecord>;
    if (typeof raw.at !== "number") return null;
    const sha = raw.updateSha;
    if (sha !== null && !(typeof sha === "string" && /^[0-9a-f]{40}$/.test(sha))) return null;
    return { at: raw.at, updateSha: sha };
  } catch {
    return null;
  }
}

/** false si no se pudo guardar: entonces no hay tope y zcord no se tiene que recargar solo. */
export function saveAutoReloadRecord(record: AutoReloadRecord, path = autoReloadRecordPath()): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/** ¿Esta versión de GitHub justifica recargar solo? Una sola vez por versión, y nunca sin saber cuál es. */
export function autoReloadForUpdate(sha: string | null, record: AutoReloadRecord | null): boolean {
  return sha !== null && sha !== record?.updateSha;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Recarga sola cuando cambia el código: espera a que pase la tanda de cambios y, si es seguro, recarga (una sola
 * vez); si no, avisa por qué y vuelve a probar cada `retryMs` hasta que lo sea.
 */
export function createAutoReloader(opts: {
  blockers: () => string[];
  reload: () => void;
  waiting: (reasons: string[]) => void;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  debounceMs?: number;
  retryMs?: number;
}): { changed(): void; stop(): void } {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((timer) => clearTimeout(timer));
  let timer: Timer | null = null;
  let done = false;
  const schedule = (ms: number): void => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(attempt, ms);
    (timer as { unref?: () => void }).unref?.();
  };
  function attempt(): void {
    timer = null;
    if (done) return;
    const reasons = opts.blockers();
    if (reasons.length > 0) {
      opts.waiting(reasons);
      schedule(opts.retryMs ?? AUTO_RELOAD_RETRY_MS);
      return;
    }
    done = true;
    opts.reload();
  }
  return {
    changed(): void {
      if (!done) schedule(opts.debounceMs ?? AUTO_RELOAD_DEBOUNCE_MS);
    },
    stop(): void {
      done = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

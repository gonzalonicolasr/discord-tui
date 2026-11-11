import { existsSync, mkdirSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stateDir } from "../config/paths";
import { log } from "../log/logger";
import type { Store } from "../store/store";

/** Código de salida de "recargar" (Ctrl+R): bin/zcord recompila si hace falta y vuelve a abrir zcord. */
export const RELOAD_EXIT_CODE = 75;

/** Dónde estabas al recargar, para volver ahí (vale un par de minutos). */
export interface ReloadState {
  guildId: string | null;
  channelId: string | null;
  voiceChannelId: string | null;
  at: number;
}

const MAX_AGE_MS = 2 * 60_000;

export function reloadStatePath(): string {
  return join(stateDir(), "reload.json");
}

export function captureReloadState(store: Store, now = Date.now()): ReloadState {
  const state = store.getState();
  return {
    guildId: state.ui.selectedGuildId,
    channelId: state.ui.selectedChannelId,
    voiceChannelId: state.voice.channelId,
    at: now,
  };
}

export function saveReloadState(state: ReloadState, path = reloadStatePath()): void {
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(path, JSON.stringify(state));
  } catch {
    // sin estado: recarga igual, solo que arranca en el lugar de siempre
  }
}

/** Lee y borra el estado de la recarga; null si no hay o si es viejo. */
export function takeReloadState(path = reloadStatePath(), now = Date.now()): ReloadState | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ReloadState>;
    rmSync(path, { force: true });
    if (typeof raw.at !== "number" || now - raw.at > MAX_AGE_MS) return null;
    const id = (value: unknown): string | null => (typeof value === "string" && /^\d{17,20}$/.test(value) ? value : value === "@dms" ? "@dms" : null);
    return { guildId: id(raw.guildId), channelId: id(raw.channelId), voiceChannelId: id(raw.voiceChannelId), at: raw.at };
  } catch {
    rmSync(path, { force: true });
    return null;
  }
}

/**
 * Después de recargar: cuando el gateway está listo y el canal existe, vuelve al servidor y canal donde estabas
 * y, si estabas en una llamada, entra de nuevo.
 */
export function restoreAfterReload(
  store: Store,
  actions: {
    selectGuild(id: string): void;
    openChannel(id: string): Promise<void>;
    voice?: { toggleVoice(id: string): Promise<void> };
  },
  saved: ReloadState,
): () => void {
  let done = false;
  const tryRestore = (): void => {
    if (done) return;
    const state = store.getState();
    if (state.connection !== "ready") return;
    done = true;
    off();
    if (saved.guildId && (saved.guildId === "@dms" || state.guilds[saved.guildId])) actions.selectGuild(saved.guildId);
    if (saved.channelId && state.channels[saved.channelId]) void actions.openChannel(saved.channelId).catch(() => {});
    if (saved.voiceChannelId && state.channels[saved.voiceChannelId] && state.voice.channelId === null) {
      void actions.voice?.toggleVoice(saved.voiceChannelId).catch(() => {});
    }
    log.info("app.reload-restored", { state: saved.voiceChannelId ? "voice" : "ui" });
  };
  const off = store.subscribe(tryRestore);
  tryRestore();
  return off;
}

/**
 * Avisa cuando cambia el código de zcord (lo que se está desarrollando o una actualización que bajó): así se
 * puede recargar con Ctrl+R en vez de salir y volver a entrar. Solo si corre desde un clon (ZCORD_HOME).
 */
export function watchForCodeChanges(onChange: () => void, repoDir = process.env.ZCORD_HOME): () => void {
  if (!repoDir || !existsSync(join(repoDir, "src"))) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const watcher = watch(join(repoDir, "src"), { recursive: true }, () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 1500);
      (timer as { unref?: () => void }).unref?.();
    });
    (watcher as { unref?: () => void }).unref?.();
    return () => {
      if (timer) clearTimeout(timer);
      watcher.close();
    };
  } catch {
    return () => {};
  }
}

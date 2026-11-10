import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { settingsPath } from "../config/paths";
import { CUES, type Cue } from "../sounds/synth";

const VERSION = 1;

export type InputMode = "voice_activity" | "push_to_talk";
export type VadSensitivity = "auto" | number;
/** Nombre de un tema incluido (dark, light, gruvbox…) o propio (~/.config/zcord/themes/<nombre>.json). */
export type ThemeName = string;
/** Estado propio elegido a mano (el "ausente" automático por inactividad no se guarda acá). */
export type OwnStatus = "online" | "idle" | "dnd" | "invisible";
export const OWN_STATUSES: OwnStatus[] = ["online", "idle", "dnd", "invisible"];
/** Calidad de Go Live. Sin Nitro el cliente oficial limita a 720p30; 1080p30 puede necesitar Nitro. */
export type StreamQuality = "720p30" | "1080p30";
export const STREAM_QUALITIES: StreamQuality[] = ["720p30", "1080p30"];

/** Sonidos de eventos (entrar/salir de voz, mute, menciones…). */
export interface SoundSettings {
  enabled: boolean;
  /** 0–100. */
  volume: number;
  events: Record<Cue, boolean>;
}

export interface Settings {
  version: typeof VERSION;
  inputMode: InputMode;
  vadSensitivity: VadSensitivity;
  inputDevice: string | null;
  outputDevice: string | null;
  userVolumes: Record<string, number>;
  theme: ThemeName;
  idleAfterMinutes: number | null;
  inlineImages: boolean;
  /** GIFs, stickers y emojis animados se mueven; con false se ve el primer cuadro. */
  animateImages: boolean;
  /** Avatares chiquitos (2 celdas) en mensajes, miembros, voz, DMs y menciones. */
  showAvatars: boolean;
  status: OwnStatus;
  /** Monitor a transmitir (nombre de `hyprctl monitors`); null = preguntar si hay más de uno. */
  streamMonitor: string | null;
  streamQuality: StreamQuality;
  sounds: SoundSettings;
}

export const DEFAULT_SETTINGS: Settings = {
  version: VERSION,
  inputMode: "voice_activity",
  vadSensitivity: "auto",
  inputDevice: null,
  outputDevice: null,
  userVolumes: {},
  theme: "dark",
  idleAfterMinutes: 10,
  inlineImages: true,
  animateImages: true,
  showAvatars: true,
  status: "online",
  streamMonitor: null,
  streamQuality: "720p30",
  sounds: { enabled: true, volume: 60, events: allCues(true) },
};

function allCues(on: boolean): Record<Cue, boolean> {
  return Object.fromEntries(CUES.map((cue) => [cue, on])) as Record<Cue, boolean>;
}

const MIN_SENSITIVITY = -60;
const MAX_SENSITIVITY = -20;
const MIN_VOLUME = 0;
const MAX_VOLUME = 200;

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseSensitivity(value: unknown): VadSensitivity {
  if (value === "auto") return "auto";
  if (typeof value === "number" && Number.isFinite(value)) return clamp(value, MIN_SENSITIVITY, MAX_SENSITIVITY);
  return DEFAULT_SETTINGS.vadSensitivity;
}

function parseVolumes(value: unknown): Record<string, number> {
  const record = asRecord(value);
  if (!record) return { ...DEFAULT_SETTINGS.userVolumes };
  const out: Record<string, number> = {};
  for (const [userId, raw] of Object.entries(record)) {
    if (typeof raw !== "number" || !Number.isFinite(raw)) continue;
    const volume = Math.round(clamp(raw, MIN_VOLUME, MAX_VOLUME));
    out[userId] = volume;
  }
  return out;
}

function parseDevice(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseIdle(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  return DEFAULT_SETTINGS.idleAfterMinutes;
}

function parseSounds(value: unknown): SoundSettings {
  const record = asRecord(value);
  const events = allCues(true);
  const rawEvents = asRecord(record?.events);
  for (const cue of CUES) if (typeof rawEvents?.[cue] === "boolean") events[cue] = rawEvents[cue] as boolean;
  const volume = record?.volume;
  return {
    enabled: typeof record?.enabled === "boolean" ? record.enabled : true,
    volume: typeof volume === "number" && Number.isFinite(volume) ? Math.round(clamp(volume, 0, 100)) : 60,
    events,
  };
}

/** Normaliza un objeto arbitrario a `Settings`, campo por campo (un campo inválido no tumba al resto). */
export function normalizeSettings(raw: unknown): Settings {
  const record = asRecord(raw);
  if (!record) return { ...DEFAULT_SETTINGS };

  return {
    version: VERSION,
    inputMode:
      record.inputMode === "push_to_talk" || record.inputMode === "voice_activity"
        ? record.inputMode
        : DEFAULT_SETTINGS.inputMode,
    vadSensitivity: parseSensitivity(record.vadSensitivity),
    inputDevice: parseDevice(record.inputDevice),
    outputDevice: parseDevice(record.outputDevice),
    userVolumes: parseVolumes(record.userVolumes),
    theme: typeof record.theme === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(record.theme) ? record.theme : DEFAULT_SETTINGS.theme,
    idleAfterMinutes: parseIdle(record.idleAfterMinutes),
    inlineImages: typeof record.inlineImages === "boolean" ? record.inlineImages : DEFAULT_SETTINGS.inlineImages,
    animateImages: typeof record.animateImages === "boolean" ? record.animateImages : DEFAULT_SETTINGS.animateImages,
    showAvatars: typeof record.showAvatars === "boolean" ? record.showAvatars : DEFAULT_SETTINGS.showAvatars,
    status: OWN_STATUSES.includes(record.status as OwnStatus) ? (record.status as OwnStatus) : DEFAULT_SETTINGS.status,
    streamMonitor: parseDevice(record.streamMonitor),
    streamQuality: STREAM_QUALITIES.includes(record.streamQuality as StreamQuality)
      ? (record.streamQuality as StreamQuality)
      : DEFAULT_SETTINGS.streamQuality,
    sounds: parseSounds(record.sounds),
  };
}

export async function loadSettings(opts?: { path?: string }): Promise<Settings> {
  const path = opts?.path ?? settingsPath();
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isEnoent(error)) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings, opts?: { path?: string }): Promise<void> {
  const path = opts?.path ?? settingsPath();
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const tmp = join(dir, `.settings.${process.pid}.${Date.now()}.tmp`);
  const fd = await open(tmp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify(settings, null, 2) + "\n");
    await fd.sync();
    await fd.close();
  } catch (error) {
    await fd.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

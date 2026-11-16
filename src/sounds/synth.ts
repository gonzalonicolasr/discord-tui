/**
 * Sonidos de eventos, sintetizados acá (no son los archivos de Discord): tonos senoidales/triangulares cortos
 * con envolvente suave, en el espíritu de los avisos del cliente oficial pero propios. Todo es PCM s16le
 * estéreo a 48 kHz, cortado en frames de 20 ms (3840 bytes) para poder sumarse al mixer de la llamada.
 * Lo que suena de verdad son los WAV de src/sounds/wav (library.ts); estos tonos quedan de respaldo.
 */
import { CHANNELS, FRAME_BYTES, FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE } from "../voice/constants";

export const CUES = [
  "join",
  "leave",
  "userJoin",
  "userLeave",
  "mute",
  "unmute",
  "deafen",
  "undeafen",
  "message",
  "streamStart",
  "streamStop",
  "disconnect",
] as const;
export type Cue = (typeof CUES)[number];

/** Pico de referencia: −12 dBFS. */
export const PEAK = Math.round(32767 * 10 ** (-12 / 20));

type Wave = "sine" | "triangle";
interface Note {
  /** Hz al principio y al final (glide lineal). */
  from: number;
  to?: number;
  startMs: number;
  durMs: number;
  wave?: Wave;
  /** Nivel relativo a PEAK (0–1). */
  level?: number;
}

const ATTACK_MS = 6;

const SCORES: Record<Cue, Note[]> = {
  // Entraste: dos notas que suben (quinta).
  join: [
    { from: 587.33, startMs: 0, durMs: 120 },
    { from: 880, startMs: 110, durMs: 200 },
  ],
  // Saliste: dos notas que bajan.
  leave: [
    { from: 880, startMs: 0, durMs: 120 },
    { from: 587.33, startMs: 110, durMs: 200 },
  ],
  // Alguien entró/salió de tu canal: un blip más suave, con glide.
  userJoin: [{ from: 660, to: 880, startMs: 0, durMs: 140, level: 0.7 }],
  userLeave: [{ from: 880, to: 620, startMs: 0, durMs: 140, level: 0.7 }],
  mute: [{ from: 520, to: 440, startMs: 0, durMs: 90, wave: "triangle", level: 0.8 }],
  unmute: [{ from: 440, to: 520, startMs: 0, durMs: 90, wave: "triangle", level: 0.8 }],
  deafen: [
    { from: 520, startMs: 0, durMs: 80, wave: "triangle", level: 0.8 },
    { from: 390, startMs: 80, durMs: 120, wave: "triangle", level: 0.8 },
  ],
  undeafen: [
    { from: 390, startMs: 0, durMs: 80, wave: "triangle", level: 0.8 },
    { from: 520, startMs: 80, durMs: 120, wave: "triangle", level: 0.8 },
  ],
  // Mención/DM: dos notas agudas y rápidas, tipo campanita.
  message: [
    { from: 1046.5, startMs: 0, durMs: 110 },
    { from: 1318.5, startMs: 70, durMs: 220 },
  ],
  streamStart: [
    { from: 523.25, startMs: 0, durMs: 90 },
    { from: 659.25, startMs: 80, durMs: 90 },
    { from: 783.99, startMs: 160, durMs: 200 },
  ],
  streamStop: [
    { from: 783.99, startMs: 0, durMs: 90 },
    { from: 659.25, startMs: 80, durMs: 90 },
    { from: 523.25, startMs: 160, durMs: 200 },
  ],
  // Se cortó la voz: glide grave hacia abajo.
  disconnect: [{ from: 440, to: 220, startMs: 0, durMs: 360, wave: "triangle" }],
};

function oscillator(wave: Wave, phase: number): number {
  if (wave === "sine") return Math.sin(2 * Math.PI * phase);
  const p = phase - Math.floor(phase);
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}

/** Ataque corto (medio coseno) y caída exponencial que cierra en cero justo al final de la nota: sin chasquidos. */
function envelope(t: number, dur: number): number {
  if (t < 0 || t >= dur) return 0;
  const attack = Math.min(ATTACK_MS / 1000, dur / 4);
  if (t < attack) return 0.5 - 0.5 * Math.cos((Math.PI * t) / attack);
  const rest = (t - attack) / (dur - attack);
  return Math.exp(-3 * rest) * (0.5 + 0.5 * Math.cos(Math.PI * rest));
}

/** Muestras mono (−1..1, relativas a PEAK) de un cue. */
function renderMono(cue: Cue): Float64Array {
  const notes = SCORES[cue];
  const endMs = Math.max(...notes.map((n) => n.startMs + n.durMs));
  const out = new Float64Array(Math.ceil((endMs / 1000) * SAMPLE_RATE));
  for (const note of notes) {
    const start = Math.round((note.startMs / 1000) * SAMPLE_RATE);
    const length = Math.round((note.durMs / 1000) * SAMPLE_RATE);
    const dur = length / SAMPLE_RATE;
    const to = note.to ?? note.from;
    const level = note.level ?? 1;
    let phase = 0;
    for (let i = 0; i < length && start + i < out.length; i += 1) {
      const freq = note.from + ((to - note.from) * i) / length;
      out[start + i]! += level * envelope(i / SAMPLE_RATE, dur) * oscillator(note.wave ?? "sine", phase);
      phase += freq / SAMPLE_RATE;
    }
  }
  // Si dos notas se pisan, se normaliza para que el pico no pase de PEAK.
  let max = 0;
  for (const v of out) max = Math.max(max, Math.abs(v));
  if (max > 1) for (let i = 0; i < out.length; i += 1) out[i] = out[i]! / max;
  return out;
}

const cache = new Map<Cue, Uint8Array[]>();

/** Frames de 20 ms (3840 bytes, s16le estéreo) del cue; el último se completa con silencio. */
export function renderCue(cue: Cue): Uint8Array[] {
  const cached = cache.get(cue);
  if (cached) return cached;
  const mono = renderMono(cue);
  const frames: Uint8Array[] = [];
  for (let f = 0; f * FRAME_SAMPLES < mono.length; f += 1) {
    const frame = new Uint8Array(FRAME_BYTES);
    const view = new DataView(frame.buffer);
    for (let i = 0; i < FRAME_SAMPLES; i += 1) {
      const sample = Math.round((mono[f * FRAME_SAMPLES + i] ?? 0) * PEAK);
      for (let c = 0; c < CHANNELS; c += 1) view.setInt16((i * CHANNELS + c) * 2, sample, true);
    }
    frames.push(frame);
  }
  cache.set(cue, frames);
  return frames;
}

export function cueDurationMs(cue: Cue): number {
  return renderCue(cue).length * FRAME_MS;
}

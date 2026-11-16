/**
 * Lector de WAV mínimo para los sonidos de eventos: solo acepta lo que guarda el repo (PCM s16le estéreo a
 * 48 kHz, el mismo formato que el mixer) y rechaza todo lo demás en vez de convertirlo. Sin ffmpeg en ejecución.
 */
import { CHANNELS, FRAME_BYTES, SAMPLE_RATE } from "../voice/constants";

/** Tope de duración de un sonido de evento. */
export const MAX_WAV_MS = 1000;
const BYTES_PER_MS = (SAMPLE_RATE / 1000) * CHANNELS * 2;
/** Tope de tamaño del archivo: el audio más largo permitido y un margen para chunks extra (LIST y similares). */
export const MAX_WAV_BYTES = MAX_WAV_MS * BYTES_PER_MS + 4096;

export type WavProblem = "not-wav" | "truncated" | "format" | "empty" | "too-long";

export class WavError extends Error {
  constructor(readonly reason: WavProblem) {
    super(`wav: ${reason}`);
    this.name = "WavError";
  }
}

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

/** Valida el archivo y devuelve el audio crudo (s16le estéreo 48 kHz intercalado). */
export function parseWav(bytes: Uint8Array): { data: Uint8Array; durationMs: number } {
  if (bytes.byteLength > MAX_WAV_BYTES) throw new WavError("too-long");
  if (bytes.byteLength < 12) throw new WavError("truncated");
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") throw new WavError("not-wav");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let fmtOk: boolean | null = null;
  let data: Uint8Array | null = null;
  let offset = 12;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new WavError("truncated");
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.byteLength) throw new WavError("truncated");
    if (id === "fmt ") {
      if (size < 16) throw new WavError("format");
      fmtOk =
        view.getUint16(body, true) === 1 &&
        view.getUint16(body + 2, true) === CHANNELS &&
        view.getUint32(body + 4, true) === SAMPLE_RATE &&
        view.getUint16(body + 12, true) === CHANNELS * 2 &&
        view.getUint16(body + 14, true) === 16;
    } else if (id === "data") {
      data = bytes.subarray(body, body + size);
    }
    // Los chunks de tamaño impar llevan un byte de relleno.
    offset = body + size + (size % 2);
  }

  if (fmtOk !== true || data === null) throw new WavError("format");
  if (data.byteLength % (CHANNELS * 2) !== 0) throw new WavError("truncated");
  if (data.byteLength === 0) throw new WavError("empty");
  const durationMs = data.byteLength / BYTES_PER_MS;
  if (durationMs > MAX_WAV_MS) throw new WavError("too-long");
  return { data, durationMs };
}

/** Corta el audio en frames de 20 ms (3840 bytes); el último se completa con silencio. */
export function wavFrames(data: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += FRAME_BYTES) {
    const frame = new Uint8Array(FRAME_BYTES);
    frame.set(data.subarray(offset, offset + FRAME_BYTES));
    frames.push(frame);
  }
  return frames;
}

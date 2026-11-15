import { FRAME_SAMPLES } from "./constants";
import { log } from "../log/logger";
import { createWasmOpus, isWasmTrap } from "./opus-wasm";

export interface OpusCodec {
  encode(pcm: Uint8Array): Uint8Array;
  decode(opus: Uint8Array): Uint8Array;
  /** PLC: hasta 120 ms de audio para tapar un paquete que falta (solo WASM; el nativo no lo tiene). */
  conceal?(): Uint8Array;
  /** Libera la memoria del códec (en WASM no la junta el GC). */
  destroy(): void;
  backend: "native" | "wasm";
}

let lastLoadError = "";
// El nativo no tiene prebuild para Bun 1.4.3: se prueba una sola vez y no en cada códec.
let nativeAvailable: boolean | null = null;

interface NativeOpus {
  encode(buffer: Buffer, frameSize: number): Buffer;
  decode(buffer: Buffer, frameSize: number): Buffer;
}

interface WasmOpus {
  encode(buffer: Buffer, frameSize: number): Buffer;
  decode(buffer: Buffer): Buffer;
  conceal(): Buffer;
  delete(): void;
  stale(): boolean;
}

function loadNative(): NativeOpus | null {
  if (nativeAvailable === false) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("@discordjs/opus");
    const Ctor = mod.Opus ?? mod.default?.Opus ?? mod;
    const instance = new Ctor(48_000, 2) as NativeOpus;
    // Forzar la carga del binario nativo acá; si falta el prebuild tira al construir o al usar.
    instance.encode(Buffer.alloc(3840), FRAME_SAMPLES);
    nativeAvailable = true;
    return new Ctor(48_000, 2) as NativeOpus;
  } catch {
    nativeAvailable = false;
    return null;
  }
}

/** WASM con nuestro wrapper (src/voice/opus-wasm.ts): el de opusscript rompe con varias instancias. */
function loadWasm(): WasmOpus | null {
  try {
    const codec = createWasmOpus(2);
    return {
      encode: (buffer, frameSize) => Buffer.from(codec.encode(buffer, frameSize)),
      decode: (buffer) => Buffer.from(codec.decode(buffer)),
      conceal: () => Buffer.from(codec.conceal()),
      delete: () => codec.delete(),
      stale: () => codec.stale(),
    };
  } catch (error) {
    lastLoadError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return null;
  }
}

export function createOpusCodec(opts?: { prefer?: "native" | "wasm" }): OpusCodec {
  const prefer = opts?.prefer ?? "native";
  const order = prefer === "wasm" ? [loadWasm, loadNative] : [loadNative, loadWasm];

  let backend: "native" | "wasm" | null = null;
  let engine: NativeOpus | WasmOpus | null = null;

  for (const load of order) {
    const loaded = load();
    if (loaded) {
      engine = loaded;
      backend = load === loadNative ? "native" : "wasm";
      break;
    }
  }

  if (!engine || !backend) {
    throw new Error(`no pude cargar Opus (ni @discordjs/opus ni opusscript${lastLoadError ? `: ${lastLoadError.slice(0, 120)}` : ""})`);
  }

  let opus = engine;
  const which = backend;

  /**
   * El módulo WASM es uno para todos los códecs: si trapea queda roto (y los decoders de todos y el encoder del mic
   * fallarían hasta cerrar zcord). Ese paquete se pierde, pero el códec sigue en un módulo nuevo (estado de cero).
   */
  function moveToFreshModule(): void {
    const fresh = loadWasm();
    log.warn("voice.codec-reset", { error_name: "RuntimeError", state: fresh ? "recreated" : "failed" });
    if (fresh) opus = fresh;
  }

  function recover(error: unknown): never {
    if (which === "wasm" && isWasmTrap(error)) moveToFreshModule();
    throw error;
  }

  /** Un módulo con el heap pisado no siempre trapea (puede devolver errores): si otro códec lo descartó, mudarse ya. */
  function checkModule(): void {
    if (which === "wasm" && (opus as WasmOpus).stale()) moveToFreshModule();
  }

  const conceal =
    which === "wasm"
      ? {
          conceal(): Uint8Array {
            checkModule();
            try {
              return new Uint8Array((opus as WasmOpus).conceal());
            } catch (error) {
              return recover(error);
            }
          },
        }
      : {};

  return {
    backend: which,
    ...conceal,
    encode(pcm: Uint8Array): Uint8Array {
      checkModule();
      try {
        const out = opus.encode(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), FRAME_SAMPLES);
        return new Uint8Array(out);
      } catch (error) {
        return recover(error);
      }
    },
    destroy(): void {
      if (which === "wasm") (opus as WasmOpus).delete();
    },
    decode(opusPacket: Uint8Array): Uint8Array {
      const input = Buffer.from(opusPacket.buffer, opusPacket.byteOffset, opusPacket.byteLength);
      checkModule();
      try {
        const out = which === "native" ? (opus as NativeOpus).decode(input, FRAME_SAMPLES) : (opus as WasmOpus).decode(input);
        return new Uint8Array(out);
      } catch (error) {
        return recover(error);
      }
    },
  };
}

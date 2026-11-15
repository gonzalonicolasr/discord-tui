/**
 * Opus en WASM con el módulo compilado de opusscript 0.1.1, sin su wrapper JS.
 *
 * El C++ de opusscript espera los buffers de PCM como "un byte por cada elemento u16" (el JS ensancha cada
 * byte a un u16 y el C++ los vuelve a juntar). El wrapper original arma esa vista con
 * `HEAPU16.subarray(punteroEnBytes, …)`, o sea en la dirección `2 × puntero`: memoria que nunca reservó.
 * Con una o dos instancias no se nota; desde la quinta instancia viva esa zona pisa el estado de otro
 * códec y el decoder aborta (`Aborted()` en opus_decoder.c). En una llamada hay un decoder por persona que
 * habla, así que rompía con el tercer o cuarto que hablaba.
 *
 * Acá se reserva el doble para el PCM (un u16 por byte), se usa ese puntero real y se lee/escribe siempre con
 * las vistas actuales del heap (`HEAPU8`/`HEAPU16` se reemplazan cuando el heap crece).
 */
interface NativeModule {
  HEAPU8: Uint8Array;
  HEAPU16: Uint16Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  OpusScriptHandler: {
    new (rate: number, channels: number, application: number): NativeHandler;
    destroy_handler(handler: NativeHandler): void;
  };
}

interface NativeHandler {
  _encode(inPtr: number, bytes: number, outPtr: number, frameSize: number): number;
  _decode(inPtr: number, length: number, outPtr: number): number;
}

const APPLICATION_AUDIO = 2049;
// El C++ decodifica paquetes de hasta 120 ms (el máximo de Opus, varios frames en un paquete "code 3"), aunque
// el wrapper de opusscript reserve para 60 ms. Con 60 ms, un paquete más largo (o basura que parsea como uno)
// escribía hasta 23 KB más allá del buffer y pisaba los otros códecs del heap compartido.
const MAX_FRAME_SAMPLES = 5760; // 120 ms a 48 kHz
const MAX_PACKET_BYTES = 1276 * 3;
/**
 * Lo que el encoder acepta: de 2,5 a 60 ms. Más largo no sirve acá (con 100 ms el C++ se cuelga y con 120 ms trapea),
 * aunque el decoder sí entregue hasta 120 ms.
 */
const ENCODER_FRAME_SAMPLES = new Set([120, 240, 480, 960, 1920, 2880]);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const opusscriptModule = (): NativeModule => require("opusscript/build/opusscript_native_wasm.js")() as NativeModule;
let factory: () => NativeModule = opusscriptModule;
let native: NativeModule | null = null;

function load(): NativeModule {
  native ??= factory();
  return native;
}

/** Un trap de WASM (heap pisado, `Aborted()`): ese módulo ya no es confiable para nadie. */
export function isWasmTrap(error: unknown): boolean {
  return error instanceof WebAssembly.RuntimeError;
}

/** Los códecs que se creen después usan un módulo nuevo; los del roto se mudan solos (ver opus.ts). */
function discard(m: NativeModule): void {
  if (native === m) native = null;
}

/** Solo tests: cómo se crea el módulo WASM (null = el de opusscript). Descarta el módulo actual. */
export function setWasmModuleFactoryForTests(fn: (() => NativeModule) | null): void {
  factory = fn ?? opusscriptModule;
  native = null;
}

export interface WasmOpus {
  encode(pcm: Uint8Array, frameSize: number): Uint8Array;
  decode(packet: Uint8Array): Uint8Array;
  /**
   * PLC de Opus: el audio que "sigue" cuando falta un paquete (decodificar sin datos). El C++ siempre entrega 120 ms
   * (5760 muestras, entra justo en el buffer de salida); quien lo usa toma lo que necesita del principio.
   */
  conceal(): Uint8Array;
  delete(): void;
  /** Su módulo se descartó por un trap (de este códec o de otro): hay que pasarse a uno nuevo. */
  stale(): boolean;
}

export function createWasmOpus(channels = 2): WasmOpus {
  const m = load();
  const pcmBytes = MAX_FRAME_SAMPLES * channels * 2;
  let handler: NativeHandler;
  let inPcm: number;
  let outPcm: number;
  let inPacket: number;
  let outPacket: number;
  try {
    handler = new m.OpusScriptHandler(48_000, channels, APPLICATION_AUDIO);
    // Un u16 por cada byte de PCM: el doble de memoria, alineada a 2 (malloc alinea a 8).
    inPcm = m._malloc(pcmBytes * 2);
    outPcm = m._malloc(pcmBytes * 2);
    inPacket = m._malloc(MAX_PACKET_BYTES);
    outPacket = m._malloc(MAX_PACKET_BYTES);
  } catch (error) {
    if (isWasmTrap(error)) discard(m);
    throw error;
  }
  let alive = true;

  function pcmOut(samples: number): Uint8Array {
    if (samples < 0) throw new Error(`Decode error: ${samples}`);
    const bytes = samples * channels * 2;
    return Uint8Array.from(m.HEAPU16.subarray(outPcm >> 1, (outPcm >> 1) + bytes));
  }

  /** Llama al C++; si trapea, este códec y su módulo quedan descartados (no se vuelve a entrar al módulo roto). */
  function call<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (isWasmTrap(error)) {
        alive = false;
        discard(m);
      }
      throw error;
    }
  }

  return {
    encode(pcm: Uint8Array, frameSize: number): Uint8Array {
      if (!alive) throw new Error("códec liberado");
      if (!ENCODER_FRAME_SAMPLES.has(frameSize)) throw new RangeError(`frameSize ${frameSize} no válido para el encoder`);
      if (pcm.byteLength !== frameSize * channels * 2) throw new RangeError("el PCM no coincide con el frameSize");
      m.HEAPU16.set(pcm, inPcm >> 1);
      const length = call(() => handler._encode(inPcm, pcm.byteLength, outPacket, frameSize));
      if (length < 0) throw new Error(`Encode error: ${length}`);
      return m.HEAPU8.slice(outPacket, outPacket + length);
    },
    decode(packet: Uint8Array): Uint8Array {
      if (!alive) throw new Error("códec liberado");
      if (packet.byteLength > MAX_PACKET_BYTES) throw new RangeError("paquete Opus demasiado grande");
      m.HEAPU8.set(packet, inPacket);
      return pcmOut(call(() => handler._decode(inPacket, packet.byteLength, outPcm)));
    },
    conceal(): Uint8Array {
      if (!alive) throw new Error("códec liberado");
      return pcmOut(call(() => handler._decode(inPacket, 0, outPcm)));
    },
    stale(): boolean {
      return native !== m;
    },
    delete(): void {
      if (!alive) return;
      alive = false;
      call(() => {
        m.OpusScriptHandler.destroy_handler(handler);
        for (const ptr of [inPcm, outPcm, inPacket, outPacket]) m._free(ptr);
      });
    },
  };
}

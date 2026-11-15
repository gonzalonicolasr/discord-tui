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

let native: NativeModule | null = null;

function load(): NativeModule {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  native ??= require("opusscript/build/opusscript_native_wasm.js")() as NativeModule;
  return native;
}

export interface WasmOpus {
  encode(pcm: Uint8Array, frameSize: number): Uint8Array;
  decode(packet: Uint8Array): Uint8Array;
  delete(): void;
}

export function createWasmOpus(channels = 2): WasmOpus {
  const m = load();
  const handler = new m.OpusScriptHandler(48_000, channels, APPLICATION_AUDIO);
  const pcmBytes = MAX_FRAME_SAMPLES * channels * 2;
  // Un u16 por cada byte de PCM: el doble de memoria, alineada a 2 (malloc alinea a 8).
  const inPcm = m._malloc(pcmBytes * 2);
  const outPcm = m._malloc(pcmBytes * 2);
  const inPacket = m._malloc(MAX_PACKET_BYTES);
  const outPacket = m._malloc(MAX_PACKET_BYTES);
  let alive = true;

  return {
    encode(pcm: Uint8Array, frameSize: number): Uint8Array {
      if (!alive) throw new Error("códec liberado");
      if (pcm.byteLength > pcmBytes) throw new RangeError("frame PCM demasiado grande");
      m.HEAPU16.set(pcm, inPcm >> 1);
      const length = handler._encode(inPcm, pcm.byteLength, outPacket, frameSize);
      if (length < 0) throw new Error(`Encode error: ${length}`);
      return m.HEAPU8.slice(outPacket, outPacket + length);
    },
    decode(packet: Uint8Array): Uint8Array {
      if (!alive) throw new Error("códec liberado");
      if (packet.byteLength > MAX_PACKET_BYTES) throw new RangeError("paquete Opus demasiado grande");
      m.HEAPU8.set(packet, inPacket);
      const samples = handler._decode(inPacket, packet.byteLength, outPcm);
      if (samples < 0) throw new Error(`Decode error: ${samples}`);
      const bytes = samples * channels * 2;
      return Uint8Array.from(m.HEAPU16.subarray(outPcm >> 1, (outPcm >> 1) + bytes));
    },
    delete(): void {
      if (!alive) return;
      alive = false;
      m.OpusScriptHandler.destroy_handler(handler);
      for (const ptr of [inPcm, outPcm, inPacket, outPacket]) m._free(ptr);
    },
  };
}

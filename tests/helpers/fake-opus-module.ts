/**
 * Módulo "opusscript WASM" de mentira para probar qué pasa cuando el de verdad trapea: el paquete `trapOn` hace
 * tirar un `WebAssembly.RuntimeError` y desde ahí todo el módulo queda roto (como uno real con el heap pisado).
 * Decodifica cualquier otro paquete a 20 ms de PCM con todos los bytes en 0x11.
 */
export function fakeOpusModule(opts: { trapOn: number }) {
  const memory = new ArrayBuffer(1 << 20);
  let next = 8;
  let broken = false;
  const trap = (): never => {
    broken = true;
    throw new WebAssembly.RuntimeError("Out of bounds memory access");
  };
  const guard = (): void => {
    if (broken) trap();
  };
  const m = {
    HEAPU8: new Uint8Array(memory),
    HEAPU16: new Uint16Array(memory),
    _malloc(size: number): number {
      guard();
      const ptr = next;
      next += (size + 7) & ~7;
      return ptr;
    },
    _free(): void {},
    OpusScriptHandler: class {
      static destroy_handler(): void {
        guard();
      }
      constructor() {
        guard();
      }
      _encode(_in: number, _bytes: number, outPtr: number): number {
        guard();
        m.HEAPU8[outPtr] = 1;
        return 1;
      }
      _decode(inPtr: number, _length: number, outPtr: number): number {
        guard();
        if (m.HEAPU8[inPtr] === opts.trapOn) trap();
        for (let i = 0; i < 960 * 2 * 2; i += 1) m.HEAPU16[(outPtr >> 1) + i] = 0x11;
        return 960;
      }
    },
  };
  return m;
}

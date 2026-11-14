import { constants, inflateRawSync, inflateSync } from "node:zlib";

const SUFFIX = Buffer.from([0x00, 0x00, 0xff, 0xff]);
/** Ventana máxima de deflate: lo único del pasado que un mensaje nuevo puede referenciar. */
const WINDOW = 32 * 1024;

export interface ZlibStreamInflater {
  push(chunk: Uint8Array): string | null;
  reset(): void;
}

/**
 * Cada mensaje de zlib-stream termina en un Z_SYNC_FLUSH (alineado a byte, sin bloques a medias), así que se
 * infla solo el mensaje nuevo, en crudo, con los últimos 32 KB de salida como diccionario. Antes se re-inflaba
 * todo el historial en cada mensaje (CPU y memoria crecían con la sesión). `createInflate` no sirve acá: en Bun
 * no tiene camino síncrono y `push` lo es.
 */
export function createZlibStreamInflater(): ZlibStreamInflater {
  let pending: Buffer[] = [];
  let pendingLength = 0;
  let window: Buffer | null = null;

  return {
    push(chunk: Uint8Array): string | null {
      pending.push(Buffer.from(chunk));
      pendingLength += chunk.length;
      const message = pending.length === 1 ? pending[0]! : Buffer.concat(pending, pendingLength);
      if (message.length < 4 || !message.subarray(-4).equals(SUFFIX)) return null;
      pending = [];
      pendingLength = 0;

      // El primero trae el encabezado zlib (y lo valida); los siguientes son deflate crudo sobre la ventana.
      const out =
        window === null
          ? inflateSync(message, { finishFlush: constants.Z_SYNC_FLUSH })
          : inflateRawSync(message, { finishFlush: constants.Z_SYNC_FLUSH, ...(window.length > 0 ? { dictionary: window } : {}) });
      const joined = window === null ? out : Buffer.concat([window, out]);
      window = Buffer.from(joined.subarray(Math.max(0, joined.length - WINDOW)));
      return out.toString("utf8");
    },
    reset(): void {
      pending = [];
      pendingLength = 0;
      window = null;
    },
  };
}

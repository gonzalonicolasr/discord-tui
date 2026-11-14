import type { KittyImageTransport, KittyImageTransportStatus, KittyKeyboardOptions } from "@opentui/core";
import type { Logger } from "../log/logger";

/**
 * Kitty keyboard protocol (Ghostty y Kitty). `allKeysAsEscapes` hace falta para el push-to-talk:
 * sin ese modo las teclas que producen texto (como Espacio) se mandan como texto plano y la
 * terminal no avisa cuándo se sueltan (docs del protocolo de Kitty, "Report all keys as escape codes").
 * `reportText` pide además el texto que produce cada tecla según tu distribución: sin eso, con el teclado
 * latinoamericano la ñ llegaba como `;` (la tecla física equivalente en uno en inglés) y las teclas muertas
 * (´ + a = á) no armaban el acento.
 */
export const KITTY_KEYBOARD: KittyKeyboardOptions = { events: true, allKeysAsEscapes: true, reportText: true };

/**
 * Las imágenes se pasan por un archivo temporal (`t=f`) en vez de mandar los píxeles en base64 por la terminal.
 * Cada cuadro de video borra la imagen anterior y coloca la nueva; en "raw" entre las dos van ~2,7 MB (960×540)
 * y herdr, que redibuja a mitad de camino, mostraba el recuadro vacío (parpadeo negro). Por archivo, borrar,
 * transmitir y colocar entran en una escritura de ~250 bytes. OpenTUI primero prueba si la terminal lee el
 * archivo (por SSH no puede): si no, sigue con "raw".
 */
export const KITTY_IMAGE_TRANSPORT: KittyImageTransport = "file";

/** Lo mínimo del renderer que hace falta para el diagnóstico (así se prueba sin terminal). */
interface TransportSource {
  readonly kittyImageTransportStatus: KittyImageTransportStatus;
  readonly capabilities: { kitty_graphics?: boolean } | null;
  readonly isDestroyed?: boolean;
}

/**
 * Variables que hacen que OpenTUI no use el archivo (sesión remota, multiplexor) o lo escriba en otro lado, y dónde
 * corre: `HC_TERMINAL_SOCKET` es una terminal de herdr-core (`hc`), que no contesta las consultas de gráficos si no
 * hay un cliente que las reenvíe; `HERDR_PANE_ID`, un pane del server de herdr. Solo si están, nunca su valor.
 */
const TRANSPORT_ENV = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "MOSH_CONNECTION", "TMUX", "ZELLIJ", "STY", "TMPDIR", "HC_TERMINAL_SOCKET", "HERDR_PANE_ID"] as const;

/**
 * Diagnóstico del transporte de imágenes de kitty (`file` o `raw`) en el log, sin datos sensibles: al arrancar, cada
 * vez que cambia (se mira cada segundo, es una lectura barata del nativo) y cada minuto. Si el video parpadea en
 * herdr, `effective` dice si de verdad se está usando el archivo y `fileState`/`fallback`, por qué no.
 */
export function logKittyTransport(
  renderer: TransportSource,
  logger: Pick<Logger, "info">,
  opts: { env?: Record<string, string | undefined>; everyMs?: number; periodicMs?: number } = {},
): () => void {
  const env = opts.env ?? process.env;
  const present = TRANSPORT_ENV.filter((key) => env[key] !== undefined && env[key] !== "");
  const snapshot = (): { key: string; msg: string } => {
    const s = renderer.kittyImageTransportStatus;
    const key = `${s.requested}/${s.effective}/${s.fileState}/${s.fallback}/${renderer.capabilities?.kitty_graphics ?? null}`;
    const msg = JSON.stringify({ ...s, kitty_graphics: renderer.capabilities?.kitty_graphics ?? null, term_program: env.TERM_PROGRAM ?? null, env: present });
    return { key, msg };
  };
  let last = snapshot();
  logger.info("kitty.transport", { state: "start", msg: last.msg });
  // Con la sesión nativa cerrándose, leer el estado tira: el diagnóstico nunca tiene que romper la salida.
  const poll = setInterval(() => {
    try {
      if (renderer.isDestroyed) return;
      const now = snapshot();
      if (now.key !== last.key) logger.info("kitty.transport", { state: "change", msg: now.msg });
      last = now;
    } catch {}
  }, opts.everyMs ?? 1_000);
  const periodic = setInterval(() => {
    try {
      if (!renderer.isDestroyed) logger.info("kitty.transport", { state: "periodic", msg: snapshot().msg });
    } catch {}
  }, opts.periodicMs ?? 60_000);
  (poll as { unref?: () => void }).unref?.();
  (periodic as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(poll);
    clearInterval(periodic);
  };
}

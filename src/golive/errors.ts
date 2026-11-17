/** Mensajes en castellano para los cortes de Go Live (como src/voice/close-codes.ts para la voz). */

export const INSTALL_HINT = "instalá wf-recorder: sudo pacman -S wf-recorder";

export const STREAM_ERRORS = {
  notInVoice: "entrá a un canal de voz para transmitir",
  noCapture: `no hay con qué capturar la pantalla; ${INSTALL_HINT}`,
  noSession: "todavía no tengo la sesión de voz: esperá a que conecte y probá de nuevo",
  noResponse: "Discord no respondió al pedido de transmitir (tardó demasiado)",
  captureEnded: "se cortó la captura de pantalla",
  libFailed: "no pude cargar la librería de transmisión",
  leftVoice: "saliste de la voz: se cortó la transmisión",
  gatewayLost: "se perdió la conexión con Discord: se cortó la transmisión",
  newSession: "Discord abrió una sesión nueva: se cortó la transmisión",
  noDesktopAudio: "transmitiendo sin el audio de la PC (no pude capturarlo con PipeWire: hacen falta pw-record, pw-link y pw-dump)",
  noDesktopAudioGrim: "con grim la transmisión va sin el audio de la PC",
  /** El servidor eligió para nuestro stream otro códec de video que el H264 que mandamos (op 4 / op 14). */
  codecMismatch: (codec: string) => `Discord pidió el video en ${codec.slice(0, 16)} y zcord manda H264: los que miran no lo van a poder ver`,
} as const;

/** Aviso para el camino lento (grim en loop, ~10 fps). */
export const GRIM_SLOW = `transmitiendo con grim (~10 fps, se ve trabado); para que vaya fluido ${INSTALL_HINT}`;

/**
 * `reason` de un STREAM_DELETE nuestro. null = corte normal (lo pedimos nosotros).
 * [sin verificar] la lista completa de razones: solo vimos nombres en clientes de terceros.
 */
export function streamDeleteMessage(reason: unknown): string | null {
  if (reason === undefined || reason === null || reason === "user_requested") return null;
  switch (reason) {
    case "unauthorized":
      return "no tenés permiso de video (transmitir) en este canal";
    case "stream_full":
      return "el canal ya tiene el máximo de transmisiones";
    case "safety_guild_rate_limited":
      return "Discord limitó las transmisiones en este servidor; probá más tarde";
    default:
      return `Discord cortó la transmisión (${typeof reason === "string" ? reason.slice(0, 40) : "sin motivo"})`;
  }
}

/** Cierre del WebSocket del stream (mismos códigos que el de voz). null = se puede reanudar solo. */
export function streamCloseMessage(code: number): string | null {
  if (code === 4015 || code < 4000) return null;
  switch (code) {
    case 4004:
      return "Discord rechazó la autenticación de la transmisión";
    case 4006:
      return "la sesión de la transmisión ya no es válida";
    case 4011:
      return "Discord no encontró un servidor para la transmisión";
    case 4014:
      return "Discord cortó la transmisión";
    case 4016:
      return "modo de cifrado de la transmisión no soportado";
    case 4017:
      return "Discord exige cifrado E2EE (DAVE) para la transmisión y no se pudo negociar";
    case 4022:
      return "terminó la llamada: se cortó la transmisión";
    default:
      return `se cortó la transmisión (código ${code})`;
  }
}

/**
 * El motivo de cierre del WS del stream es texto libre del servidor: al log va solo lo imprimible (letras, números,
 * espacio y `.,:'()_/-`), sin saltos de línea ni caracteres de control o bidi, y 80 caracteres como mucho.
 */
export function closeReasonForLog(reason: unknown): string {
  if (typeof reason !== "string") return "";
  return reason
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^A-Za-z0-9 .,:'()_/-]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, 80);
}

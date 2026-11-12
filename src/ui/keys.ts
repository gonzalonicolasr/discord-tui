export interface KeyEntry {
  key: string;
  desc: string;
  group: "Navegación" | "Mensajes" | "Composer" | "Voz" | "App";
}

// Tabla de la spec 7.5 + las nuestras (R, gm, gs, x) — docs/superpowers/plans/2026-11-06-discord-tui-e5.md.
export const SPEC_KEYS: KeyEntry[] = [
  { key: "j", desc: "bajar", group: "Navegación" },
  { key: "k", desc: "subir (arriba: carga historial)", group: "Navegación" },
  { key: "h", desc: "panel anterior", group: "Navegación" },
  { key: "l", desc: "panel siguiente / abrir", group: "Navegación" },
  { key: "Enter", desc: "abrir canal, hilo, post o chat de voz", group: "Navegación" },
  { key: "gg", desc: "ir al principio", group: "Navegación" },
  { key: "G", desc: "ir al final", group: "Navegación" },
  { key: "gn", desc: "primer mensaje nuevo del canal", group: "Navegación" },
  { key: "gu", desc: "siguiente canal no leído", group: "Navegación" },
  { key: "gm", desc: "mostrar u ocultar miembros", group: "Navegación" },
  { key: "Ctrl-k", desc: "quick switcher (en modo normal)", group: "Navegación" },
  { key: "Esc", desc: "modo normal / soltar selección (al final)", group: "Navegación" },
  { key: "i", desc: "escribir en el composer", group: "Mensajes" },
  { key: "Enter", desc: "mandar (Shift-Enter: nueva línea)", group: "Mensajes" },
  { key: "@ + Tab", desc: "mencionar con autocompletado", group: "Mensajes" },
  { key: "r", desc: "responder al mensaje seleccionado", group: "Mensajes" },
  { key: "e", desc: "editar mensaje propio", group: "Mensajes" },
  { key: "dd", desc: "borrar mensaje propio (pide y/n)", group: "Mensajes" },
  { key: "+", desc: "reaccionar con emoji", group: "Mensajes" },
  { key: "1-9", desc: "votar en la encuesta seleccionada", group: "Mensajes" },
  { key: "R", desc: "reintentar el envío fallido", group: "Mensajes" },
  { key: "Ctrl-v", desc: "pegar del portapapeles: archivos copiados, imagen o texto (Ctrl+Shift+V también)", group: "Mensajes" },
  { key: "a", desc: "adjuntar archivo por path (en un foro: traer posts archivados)", group: "Mensajes" },
  { key: "x", desc: "quitar el último adjunto", group: "Mensajes" },
  // En modo insert (escribiendo). Ctrl-k acá borra hasta el fin de línea; en modo normal abre el switcher.
  { key: "← →", desc: "cursor (Ctrl/Alt: por palabra)", group: "Composer" },
  { key: "Home End", desc: "inicio/fin de línea (Ctrl-a/e)", group: "Composer" },
  { key: "↑ ↓", desc: "línea anterior / siguiente", group: "Composer" },
  { key: "Ctrl-w", desc: "borrar la palabra anterior", group: "Composer" },
  { key: "Ctrl-u/k", desc: "borrar a inicio / fin de línea", group: "Composer" },
  { key: "v", desc: "entrar / salir de la llamada", group: "Voz" },
  { key: "m", desc: "mutear micrófono (🔇)", group: "Voz" },
  { key: "D", desc: "ensordecer (🙉: no escuchás a nadie)", group: "Voz" },
  { key: "M", desc: "modo VAD o Push-to-Talk", group: "Voz" },
  { key: "Espacio", desc: "push-to-talk (mantener)", group: "Voz" },
  { key: "S", desc: "transmitir pantalla (Go Live) / detener", group: "Voz" },
  { key: "w", desc: "ver la transmisión (📺) de alguien de tu canal / dejar de ver (Esc)", group: "Voz" },
  { key: "j + / -", desc: "volumen de un participante (±10 %)", group: "Voz" },
  { key: "gs", desc: "settings (audio, tema, imágenes)", group: "App" },
  { key: "gp", desc: "estado propio (en línea, ausente, no molestar, invisible)", group: "App" },
  { key: "p", desc: "escuchar o parar el audio / mensaje de voz del mensaje seleccionado", group: "Mensajes" },
  { key: "@", desc: "bandeja de menciones: quién te mencionó y dónde; Enter va al mensaje (también 🔔 abajo)", group: "App" },
  { key: "Ctrl-r", desc: "recargar zcord (código nuevo) sin salir: vuelve al canal y a la llamada", group: "App" },
  { key: "arrastrar", desc: "seleccionar texto con el mouse lo copia al soltar", group: "App" },
  { key: "mouse", desc: "click en canales, 🔊, mensajes y botones", group: "App" },
  { key: "?", desc: "mostrar esta ayuda", group: "App" },
  { key: "q", desc: "salir", group: "App" },
];

export function keysByGroup(): Map<KeyEntry["group"], KeyEntry[]> {
  const groups = new Map<KeyEntry["group"], KeyEntry[]>();
  for (const entry of SPEC_KEYS) {
    const list = groups.get(entry.group) ?? [];
    list.push(entry);
    groups.set(entry.group, list);
  }
  return groups;
}

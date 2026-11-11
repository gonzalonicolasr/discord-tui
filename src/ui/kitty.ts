import type { KittyKeyboardOptions } from "@opentui/core";

/**
 * Kitty keyboard protocol (Ghostty y Kitty). `allKeysAsEscapes` hace falta para el push-to-talk:
 * sin ese modo las teclas que producen texto (como Espacio) se mandan como texto plano y la
 * terminal no avisa cuándo se sueltan (docs del protocolo de Kitty, "Report all keys as escape codes").
 * `reportText` pide además el texto que produce cada tecla según tu distribución: sin eso, con el teclado
 * latinoamericano la ñ llegaba como `;` (la tecla física equivalente en uno en inglés) y las teclas muertas
 * (´ + a = á) no armaban el acento.
 */
export const KITTY_KEYBOARD: KittyKeyboardOptions = { events: true, allKeysAsEscapes: true, reportText: true };

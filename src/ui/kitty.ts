import type { KittyImageTransport, KittyKeyboardOptions } from "@opentui/core";

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

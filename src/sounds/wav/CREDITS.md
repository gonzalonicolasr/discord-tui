# Sonidos de eventos: origen y licencia

Todos los sonidos de esta carpeta son de **Kenney** (www.kenney.nl) y están bajo
**Creative Commons Zero (CC0 1.0, dominio público)**:
https://creativecommons.org/publicdomain/zero/1.0/ . No hace falta dar crédito; lo damos igual.
Ninguno viene de Discord ni de otra app.

| Pack | Página | Versión (License.txt del zip) |
|---|---|---|
| Interface Sounds | https://kenney.nl/assets/interface-sounds | 1.0, creado 11-02-2020 |
| Digital Audio | https://kenney.nl/assets/digital-audio | "Digital Audio by Kenney Vleugels" |

Bajados el 2026-11-16 de esas páginas (botón Download). Cada archivo del zip está en `Audio/`.

## Qué archivo es cada sonido

| Archivo | Evento | Original (pack → archivo) | Licencia |
|---|---|---|---|
| `join.wav` | entraste a la voz | Interface Sounds → `Audio/confirmation_001.ogg` | CC0 1.0 |
| `leave.wav` | saliste de la voz | Interface Sounds → `Audio/question_002.ogg` | CC0 1.0 |
| `userJoin.wav` | alguien entró a tu canal | Interface Sounds → `Audio/maximize_007.ogg` | CC0 1.0 |
| `userLeave.wav` | alguien salió de tu canal | Interface Sounds → `Audio/minimize_007.ogg` | CC0 1.0 |
| `mute.wav` | te silenciaste | Interface Sounds → `Audio/minimize_009.ogg` | CC0 1.0 |
| `unmute.wav` | volviste a hablar | Interface Sounds → `Audio/maximize_009.ogg` | CC0 1.0 |
| `deafen.wav` | te ensordeciste | Interface Sounds → `Audio/minimize_006.ogg` | CC0 1.0 |
| `undeafen.wav` | dejaste de estar ensordecido | Interface Sounds → `Audio/maximize_006.ogg` | CC0 1.0 |
| `message.wav` | mención o mensaje directo | Interface Sounds → `Audio/glass_001.ogg` | CC0 1.0 |
| `streamStart.wav` | empezó tu transmisión | Digital Audio → `Audio/highUp.ogg` | CC0 1.0 |
| `streamStop.wav` | terminó tu transmisión | Digital Audio → `Audio/highDown.ogg` | CC0 1.0 |
| `disconnect.wav` | se cortó la voz | Digital Audio → `Audio/phaserDown3.ogg` | CC0 1.0 |

### Alternativos (`alt/`, no se cargan)

| Archivo | Evento | Original (pack → archivo) | Licencia |
|---|---|---|---|
| `alt/join.wav` | entraste a la voz | Interface Sounds → `Audio/confirmation_004.ogg` | CC0 1.0 |
| `alt/leave.wav` | saliste de la voz | Interface Sounds → `Audio/question_001.ogg` | CC0 1.0 |
| `alt/userJoin.wav` | alguien entró a tu canal | Interface Sounds → `Audio/maximize_008.ogg` | CC0 1.0 |
| `alt/userLeave.wav` | alguien salió de tu canal | Interface Sounds → `Audio/minimize_008.ogg` | CC0 1.0 |
| `alt/disconnect.wav` | se cortó la voz | Digital Audio → `Audio/phaserDown1.ogg` | CC0 1.0 |

Para probar uno: copiarlo encima del principal (`cp alt/join.wav join.wav`) y escucharlo con
`bun scripts/sounds-preview.ts join`.

## Cambios sobre el original

Los originales son Ogg Vorbis a 44,1 kHz, mono salvo `phaserDown3.ogg` (estéreo, se pasó a mono). Con ffmpeg
(solo al convertir, no en ejecución) se pasaron a WAV PCM s16 estéreo a 48 kHz (el formato del mixer de la
llamada; los dos canales iguales) y además:

- recorte del silencio de los bordes (todo lo que está 45 dB por debajo del pico);
- fundido de entrada de 4 ms y de salida de 12 ms (medio coseno), para que no hagan click al mezclarse;
- misma sonoridad para todos: −21,7 LUFS medidos con el filtro K de BS.1770 (máximo en ventanas de 100 ms),
  el nivel más alto en el que todos quedan con el pico en −12 dBFS o menos; `userJoin` y `userLeave` van
  3 dB más bajos (más discretos que los tuyos). Con la misma medida, los tonos sintetizados de antes
  andaban en −21 LUFS (join, leave, stream), así que el volumen general no cambia.

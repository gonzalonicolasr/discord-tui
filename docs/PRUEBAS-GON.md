# Pruebas de Gon con la cuenta real

Todo lo que el agente pudo probar sin tu cuenta ya está cubierto por `bun test` (415+ tests, incluido un
servidor de voz falso local). Lo que queda acá necesita tu cuenta, tus ojos o tus oídos. Hacelo en Ghostty, sin
tmux. Si algo falla, pasale al agente qué viste y las últimas líneas de `~/.local/state/discord-tui/discord-tui.log`
(el log ya sale redactado; corré `bun run leak-check` antes de pasarlo).

Antes de empezar: `cd ~/projects/discord-tui && git pull && bun install`.

Todo se maneja con el mouse o con el teclado, lo que prefieras. No hace falta ningún id ni script aparte:
lo único que corrés es `bun run dev` (o `bun run demo` para mirar sin conectarte).

## 0. Mirar la UI sin conectarte (2 min)

- [ ] `bun run demo` → se ven servidores, canales con categorías, mensajes con colores, miembros a la derecha.
- [ ] Con el mouse: click en un servidor, en un canal de texto (lo abre), en una categoría (se pliega), en `🔊 Sala 1` (entrás a la voz simulada). Abajo aparecen los botones `🎙 mic`, `🎧 audio`, `🎚 VAD` y `✕ salir`: probalos.
- [ ] Click en un mensaje → aparece `↩ responder · ✎ editar · 🗑 borrar · 😀 reaccionar` (editar y borrar solo en los tuyos). Click en una reacción la pone o la saca. Click en un miembro de la derecha lo menciona en el composer.
- [ ] Abajo a la derecha: `⌕ Ctrl-k saltar`, `⚙ settings`, `? ayuda`. Click afuera de un cartel lo cierra.
- [ ] `?` abre la ayuda; `Esc` la cierra. `Ctrl-k`, escribí `mem`, Enter → abre `#memes`.
- [ ] `h` hasta la lista de canales, bajá con `j` hasta `🔊 Sala 1`, `v` → abajo aparece la barra de voz verde (es simulada). `m`, `D`, `M` cambian los indicadores. `v` sale. `q` sale de la demo.

## 1. Login y lectura (E1 + E2)

- [ ] `bun run dev` → entra solo (ya tenés sesión). El borde azul marca el panel activo.
- [ ] `j`/`k` en servidores, `l` para pasar a canales, `l` otra vez abre el canal. `Ctrl-k` + parte de un nombre + Enter abre otro canal o DM.
- [ ] En un canal con historia: `k` sube por los mensajes; al llegar arriba carga mensajes viejos sin saltos. `gg` va al principio, `G` o `Esc` vuelve abajo.
- [ ] Mandate un mensaje desde el teléfono: aparece en menos de 1 s.
- [ ] Menciones `<@…>` ahora se ven como `@nombre` resaltado (antes salían los números, como en tu captura).
- [ ] Un mensaje con imagen se ve inline (protocolo Kitty). Si ves bloques de colores o nada, decile al agente (o apagalo en `gs` → imágenes).
- [ ] `gu` salta al próximo canal no leído; `gm` muestra/oculta miembros con su punto de presencia (necesita la terminal de 110+ columnas).
- [ ] Wifi: `nmcli radio wifi off; sleep 30; nmcli radio wifi on` → la barra dice `reconectando…` y vuelve a `conectado`; no faltan mensajes.

## 2. Escribir (E3) — en tu servidor de prueba, `#pruebas`

- [ ] `i`, "hola desde discord-tui", Enter → llega al teléfono.
- [ ] `k` para elegir un mensaje, `r`, escribí, Enter → en el teléfono se ve como respuesta.
- [ ] `i`, `@` + parte de un nombre → aparece el cartel de menciones; `Tab` elige; Enter → en el teléfono es una mención real (azul).
- [ ] Sobre un mensaje tuyo: `e`, cambiá el texto, Enter → "(editado)". `dd`, `y` → se borra.
- [ ] `+`, escribí `fire`, Enter → reacción 🔥; repetilo → se va.
- [ ] Captura al portapapeles (Print de Omarchy), en el canal `Ctrl-v` → aparece `📎 captura-….png`; Enter → llega. Lo mismo con `Ctrl+Shift+V` (pegado de Ghostty). Copiá 2 archivos en el gestor de archivos (Ctrl-c) → `Ctrl-v` en el canal → aparecen los dos `📎`; Enter → llegan. Arrastrar/pegar una ruta `file://…` también adjunta. `a`, un path a un archivo chico, Enter, Enter → llega.
- [ ] Arrastrá con el mouse sobre un mensaje → al soltar aparece `📋 copiado (N caracteres)`; pegalo en otra app y es el texto exacto, sin espacios de más.
- [ ] Wifi cortado, mandá "sin red" → queda `✗ no se envió · R reintenta`. Volvé el wifi, `R` → llega una sola vez.
- [ ] Abrí un canal con no leídos, esperá 2 s → en el teléfono deja de figurar no leído.
- [ ] [2ª] Mientras escribís, la otra cuenta ve "está escribiendo…"; una mención desde la otra cuenta (estando vos en otro canal) dispara la notificación de escritorio.

## 3. Voz solo (E4b) — lo más importante

Con auriculares y el teléfono mirando el canal de voz **sin entrar** (el teléfono no puede estar en voz con la misma cuenta).

- [ ] `bun run dev`, click en un canal 🔊 de tu servidor de prueba (o el botón grande `🔊 Entrar a voz`, o `v`). En menos de 15 s la barra de abajo dice `🔊 canal · servidor · 🔒 E2EE <código> · VAD · ○ vos`, sin `conectando…` ni error. En el teléfono aparecés en el canal. Si sale `✗ voz: Discord exige cifrado E2EE (DAVE)…` (código 4017) o se queda conectando, frená y pasale al agente esa línea y el final del log: hay plan B.
- [ ] Al entrar aparece `🔈 el audio de la llamada sale por: …`. Si no escuchás a nadie, click en `🔈 …` en la barra de voz y elegí tus auriculares (se cambia al instante y queda guardado). La app usa la salida predeterminada del sistema hasta que elijas una.
- [ ] Hablá → `● vos` se prende (y tu nombre en verde debajo del canal); en el teléfono el anillo verde. Callado, se apaga.
- [ ] `M` → `PTT`. Mantené `Espacio` y hablá → prende; soltá → se apaga al toque. Si aparece un aviso amarillo de "interruptor", contáselo al agente.
- [ ] `🎙 mic` (o `m`) → mic tachado en el teléfono. `🎧 audio` (o `D`) → auriculares tachados; otra vez → vuelve el mute que tenías.
- [ ] Click en una persona dentro del canal → aparece `vol − 100 % +`; `−`/`+` cambian su volumen (también con `j` y `+`/`-` desde el teclado). Se guarda.
- [ ] `✕ salir` (o `v`) → salís; en el teléfono ya no estás. Entrá de nuevo y salí con `q` → también te libera del canal.
- [ ] `bun run leak-check` → `OK`.

## 4. Voz con otra persona (E4c) [2ª]

- [ ] Antes, desde el cliente oficial con la otra persona: ¿muestra algún código de verificación de la llamada (tocando el candado 🔒)? ¿Cuántos dígitos y cómo agrupados? Contale al agente.
- [ ] Los dos se escuchan apenas entran. Cuando la otra persona habla, su `●` se prende debajo del canal y en la barra (`hablando: …`).
- [ ] 10 minutos de charla (o música de un lado): sin cortes ni voz robótica sostenida.
- [ ] `D` → dejás de escuchar y la otra persona te ve ensordecido; `D` otra vez → vuelve.
- [ ] Si el cliente oficial muestra código: coincide con el `🔒` de la barra.
- [ ] Salí con `✕ salir`; pasale al agente las líneas `voice.stats` del log.

## 5. Settings y día de uso (E5)

- [ ] `⚙ settings` (o `gs`) → elegir micrófono y salida con `◀ ▶`, mover la sensibilidad mirando el medidor, "probar mic" (eco), tema claro/oscuro, imágenes sí/no.
- [ ] Sonidos: `bun run dev`, entrá y salí de un canal de voz, mutear/ensordecer (`m`/`D`), que entre y salga un amigo, y que te mencione en otro canal: ¿suenan, a buen volumen y por la salida elegida? En `gs` → "Sonidos" apagalos, bajá el volumen y silenciá uno: ¿se respeta? Ensordecido solo deberían sonar mute/deafen/salir.
- [ ] Un día de laburo usando solo discord-tui; anotá todo lo que te hizo abrir la app oficial o te molestó y pasáselo al agente.

## 6. Transmitir pantalla (Go Live) [2ª]

Necesita a un amigo en el canal de voz (desde el cliente oficial). Usa tu cuenta: la librería avisa que automatizar puede
terminar en ban (ver `docs/protocol-notes.md`, "Transmitir pantalla").

- [ ] Una vez: `sudo pacman -S wf-recorder` (ya está instalado en tu PC). Sin él usa grim a ~10 fps y te avisa.
- [ ] `bun run demo` primero: en `🔊 Sala 1` Ramiro figura con `📺 en vivo`; entrá a la sala, click en `📺 transmitir` → aparece
      `¿Qué pantalla transmitir?` con tus monitores → elegí uno → `⏳ iniciando…` → `🔴 EN VIVO · detener` y `📺 en vivo` al lado
      tuyo. Click otra vez lo corta. `S` hace lo mismo con el teclado.
- [ ] `bun run dev`, entrá al canal de voz donde está tu amigo, click en `📺 transmitir` (o `S`), elegí el monitor (en `gs` →
      "Transmitir pantalla" podés dejar uno fijo y la calidad, 720p30 por defecto). En menos de 15 s la barra dice
      `🔴 EN VIVO · detener`. Si sale `✗ transmisión: …`, copiá esa línea y el final del log.
- [ ] Tu amigo hace click en "LIVE" en tu nombre y te cuenta: ¿ve la pantalla? ¿fluido o trabado? ¿tarda en arrancar (debería
      verse en ≤ 2 s, hay keyframe cada 2 s)? ¿se oye el audio de tu PC (poné algo a sonar) y NO se escuchan a sí mismos (sin eco de la llamada)? En su cliente, ¿el stream
      muestra el candado / código de privacidad E2EE? Cuando entra, la barra pasa a `👁 1`.
- [ ] Mientras transmitís, en la lista de la izquierda vos (y cualquiera que transmita) figura con `📺 en vivo`.
- [ ] `🔴 EN VIVO · detener` → tu amigo deja de verla. Probá también salir de la voz transmitiendo (`✕ salir`): corta solo.
- [ ] Con la TUI todavía abierta y sin transmitir: `pgrep -a "wf-recorder|ffmpeg|grim"` no muestra nada, y `pw-link -l | grep zcord-golive`
      tampoco (no quedan enlaces de audio). Y después de `q`, tampoco.
- [ ] `bun run leak-check` → `OK`.

### 6b. Audio de la PC: ¿por qué Discord corta a los 30 s? (`ZCORD_GOLIVE_AUDIO=1` / `=silence`)

Con el audio de la PC, Discord cerraba la transmisión a los 30 s (`golive.ws-closed` 4006). Desde el 2026-11-16, mientras transmitís,
el log anota cada 5 s una línea `golive.stats` (solo cantidades, estados y números de op; nada de la cuenta). Tres pruebas seguidas,
en el mismo canal, con algo sonando en la PC (si hay un amigo mirando, mejor, pero no hace falta):

- [ ] **A, sin audio:** `bun run dev` → transmití ~60 s → `🔴 EN VIVO · detener`.
- [ ] **B, con audio:** salí con `q`, `ZCORD_GOLIVE_AUDIO=1 bun run dev` → transmití y esperá 45 s (si corta, va a ser a los ~30 s).
- [ ] **C, con silencio:** salí con `q`, `ZCORD_GOLIVE_AUDIO=silence bun run dev` → transmití y esperá 45 s. Va por el mismo camino
      que B (Opus junto al video, la librería sincroniza el video contra el audio), pero manda silencio en vez de lo que suena: no
      captura nada de la PC ni usa PipeWire, y la barra no dice `🔊 con audio de la PC`. En el log, `golive.start` dice `+silence`.
      Si C también corta a los 30 s, el problema es mandar audio en sí (protocolo); si C aguanta y B no, es algo de lo capturado
      (contenido o ritmo de pw-record).
- [ ] Pegame la salida de `grep '"golive\.' ~/.local/state/discord-tui/discord-tui.log | tail -60`.

Qué miro yo en B y C (las 2 últimas `golive.stats` antes de `golive.ws-closed`, y la última, con `"state":"ws-4006"`):
`v` sube según los fps de la calidad (a 30 fps, ~150 por línea; a 60, ~300) y `waiting` es `"no"` → el video salía bien; `vd`/`ad` mayores a 0 o
`rtc` distinto de `"connected"` → WebRTC no conectó o la librería tiraba cuadros y a Discord no le llegaba nada; `waiting: "video"` →
la librería frenaba el video esperando al audio; `in` de las últimas líneas → qué op mandó Discord justo antes de cortar (`"?"` = un
mensaje que no empieza con su op); `msg` de `golive.ws-closed` → el motivo que dio Discord; `dave`/`dave_v` y `out` → comparar con A.
Si aparece `golive.stats` con `"state":"off"`, el diagnóstico se apagó solo (algo raro de la librería) y la transmisión siguió igual.

## 7. Ver la transmisión de otro [2ª]

Necesita a un amigo que transmita pantalla (Go Live) desde el cliente oficial en un canal de voz donde estés vos. Usa tu
cuenta, como Go Live (ver `docs/protocol-notes.md`, "Ver transmisiones"). Sin audio de la transmisión por ahora.

- [ ] `bun run demo` primero: entrá a `🔊 Sala 1` → debajo de Ramiro (`📺`) aparece `▶ ver`; click → `⏳ conectando…` → barras de
      colores en lugar de los mensajes, arriba `📺 Ramiro · en vivo · N fps` y `✕ dejar de ver`. `Esc` o `w` la cierra; `w` de
      nuevo la abre. En el chat del canal de voz también está `▶ ver Ramiro`.
- [ ] `bun run dev`, entrá al canal de voz de tu amigo y que él empiece a transmitir. Click en `▶ ver` debajo de su nombre (o `w`).
      En ≤ 5 s tiene que verse su pantalla. Si queda en `⏳ conectando…` o sale un error, copiá esa línea y el final del log
      (`watch.*`, sin datos privados).
- [ ] Lo importante: ¿se ve la imagen? (si queda negro o "esperando el primer cuadro…" con DAVE activo, el log dice si fue el
      descifrado: es lo único que no se pudo probar sin la cuenta). ¿Cuántos fps dice arriba (debería rondar 10–12)? ¿Parpadea
      en Ghostty? ¿Cuánta CPU usa la app (`top`, debería estar < 15 % de un núcleo)?
- [ ] Tu amigo ve en su cliente que estás mirando (`👁 1` / tu avatar en el stream).
- [ ] Que tu amigo corte la transmisión → la vista se cierra sola con `<nombre> dejó de transmitir`. Probá también salir de la voz
      mirando: se cierra sola.
- [ ] Achicá y agrandá la ventana de la terminal mientras mirás: el video se re-ajusta a la caja.
- [ ] `bun run leak-check` → `OK`.

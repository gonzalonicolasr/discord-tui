# Notas de protocolo

Datos que el agente resuelve y documenta mientras construye. Sin tokens ni ids reales.

## client_build_number

- Fecha: 2026-11-06.
- Método que anduvo: el número viene en el propio HTML de `https://discord.com/app`, dentro del objeto inline `window.GLOBAL_ENV` (`"BUILD_NUMBER":"663810"`). Un solo GET alcanza; no hace falta bajar los assets `.js`.
- Spike: `bun scripts/spike-build-number.ts` imprime `663810` en ~0,3 s (límite: 10 s). Pass.
- Regex: `build(?:Number|_number)["']?\s*[:=]\s*["']?(\d{5,7})` (case-insensitive), aplicado al HTML y, de respaldo, a los `/assets/*.js`.
- Plan B: si el HTML deja de traerlo, se escanean los `<script src="/assets/…js">`; si tampoco, se usa el `cached` de `session.json` y al final `FALLBACK_BUILD_NUMBER`.
- `FALLBACK_BUILD_NUMBER`: 663810. En E1.5 se reemplaza por el número de la captura de Gon si difiere.
- Nota: el plan original hablaba de buscar solo en los assets; en la realidad el dato está en el HTML. Por eso el spike mira el HTML primero y los assets como respaldo (spec 6.4 deja el método exacto a cargo del builder).

## Fixtures de E1.5 (sintéticas)

- Gon no tenía tiempo para hacer las capturas del navegador (E1.5 Tasks 3-5), así que las fixtures de `fixtures/` se generaron **sin tocar la cuenta** a partir de dos fuentes públicas: el bundle JS del cliente web oficial (`/assets/*.js` de `discord.com/app`, consultado 2026-11-06) y `discord-api-types` 0.38.57.
- Todos los ids, nombres, hashes y el token son falsos (ids `100000000000000001…`, `user1`/`user2`, `guild1`, `channel1`/`channel2`).
- Lo que no se pudo verificar queda marcado abajo. Cuando haya una captura real, se reemplazan estos archivos y se corrigen las diferencias.
- `scripts/redact.ts` sigue siendo el camino para redactar capturas reales cuando existan.

## Respuestas a los [sin verificar] de la spec

- **capabilities**: el cliente web manda `1734653`; con el experimento `useChannelObfuscation` activo, `1767421` (bundle, `handleIdentify`). Nuestro cliente usa `1734653`.
- **Identify**: `{ token, capabilities, properties, presence, compress, client_state, qos_token }`; **sin** `intents` (bundle, `[IDENTIFY]`). `client_state` es `{ guild_versions: {} }` y `qos_token` va `null` en esta fixture.
- **READY**: trae `private_channels` (el cliente web hace `hydrateReady({ users, private_channels, merged_members, guilds, … })`), así que los DMs vienen ahí. `READY_SUPPLEMENTAL` trae `lazy_private_channels` y `presences`.
- **op 37** (`GUILD_SUBSCRIPTIONS_BULK`): `{ subscriptions: { <guild_id>: { typing, threads, activities, members, member_updates, channels, thread_member_lists } } }`. `channels` es un objeto `{ <channel_id>: [[desde, hasta]] }` (bundle, `updateGuildSubscriptions` + `get()`). **Corrección 2026-11-07 (primera prueba real de Gon):** la fixture sintética decía que `members` también eran rangos; con `members: [[0, 99]]` Discord cerraba el gateway justo después de READY. Según discord.food `members` es una lista de ids de usuario y `thread_member_lists` una lista de ids de hilos; ahora no se mandan y la lista de miembros sale de los rangos de `channels`.
- **Ack**: `POST /channels/<channel_id>/messages/<message_id>/ack` con body `{ token, last_viewed, flags }`; la respuesta devuelve un `token` nuevo que se reusa en el próximo ack (bundle, `MESSAGE_ACK`).
- **X-Discord-Timezone**: sí existe; el cliente web manda el header cuando tiene la zona (bundle, `e.set("X-Discord-Timezone", c)`).
- **Subida de archivos**: `POST /channels/<channel_id>/attachments` → respuesta `{ attachments: [{ upload_url, upload_filename }] }` → `PUT` al `upload_url` → `POST` del mensaje con `attachments: [{ filename, uploaded_filename, … }]` (bundle, request de upload URL + `uploaded_filename`).
- **GUILD_MEMBER_LIST_UPDATE**: `{ guild_id, id: "everyone", member_count, online_count, ops: [{ op: "SYNC", range: [a, b], items: [{ member }] }], groups: [{ id, count }] }`; los `op` son `SYNC`/`INSERT`/`UPDATE`/`DELETE`/`INVALIDATE`.

## Imágenes en Ghostty

- Spike: `bun scripts/spike-image.tsx` (PNG 64x64 + GIF de 3 frames) corre sin stack trace; con `timeout 3` sale 124 porque queda vivo esperando `q`. Probado también bajo una PTY, mismo resultado.
- Falta la confirmación visual de Gon (Task 1, Step 2). `resolveImageRenderProtocol` depende de las capabilities que reporta la terminal; en la PTY del spike no hay respuesta, así que el protocolo que elige ahí no es representativo de Ghostty.
- `IMAGE_MODE = "kitty"` por la doc de Ghostty (spec 6.1). Si la confirmación visual muestra bloques, se cambia a `"blocks"`; si no hay protocolo gráfico, a `"links"`.
- GIF: si no anima, se muestra el primer frame (decisión [nuestra] del plan).

## Voz: dependencias y DAVE local (E4a Task 1)

- `generateDependencyReport()` de `@discordjs/voice` 0.19.2: `@discordjs/opus` 0.11.0 presente, `@snazzah/davey` 0.1.12 presente, `aes-256-gcm` nativo: sí. `opusscript` 0.1.1 también instalado como fallback. `sodium-native`/`sodium`/`libsodium-wrappers`/`@stablelib/xchacha20poly1305`/`@noble/ciphers`: ninguno instalado (no hacen falta para `aead_aes256_gcm_rtpsize`).
- `bun pm ls --all | grep -c "@snazzah/davey@"` → `1` (una sola copia, 0.1.12, fijada con `overrides`).
- `scripts/spike-dave-local.ts`: el intento (a) con dos sesiones falla al procesar el `welcome` (`CreatingStagedWelcomeFailed(NoMatchingKeyPackage)`) porque los vectores de `davey-node/test/session.test.ts` vienen de una captura real donde el `welcome` referencia el key package que el servidor vio en ese momento, no uno que generemos nosotros en una segunda sesión local; sin servidor que arme el `welcome` a medida no hay forma de que calce. El intento (b) (una sesión, hasta `ready` con su propio commit) **sale**: `DAVE local: b`.
- **Fallback (decisión nuestra):** como salió (b), no se prueba el handshake MLS de dos sesiones en local con la API pública de davey 0.1.12. Lo que queda probado acá: una sesión llega a `ready`, tiene `voicePrivacyCode` no vacío, `getSerializedKeyPackage()` no se repite entre llamadas, `setPassthroughMode(true)` dejapasar el Opus, y protocolo inválido (`0`) tira. El handshake real de dos sesiones se verifica en E4b (DAVE activo, sin cierre 4017) y en E4c (`voicePrivacyCode` igual al del otro cliente).
- `@discordjs/opus` 0.11.0 figura en el reporte pero su prebuild nativo no carga con Bun 1.4.3 (`prebuild/node-v147-napi-v3-linux-x64-glibc-2.44/opus.node` no existe para esta versión de Node ABI). `createOpusCodec()` cae a `opusscript` (WASM) y lo reporta en `backend`. Anotado como el fallback que el plan permite; si en la máquina de Gon el nativo carga, se usa ese.
- Opus tiene delay algorítmico y normaliza ganancia: los tests comparan forma de onda con correlación a mejor desfasaje (`bestCorrelation` en `tests/helpers/pcm.ts`), no fase ni nivel exactos.

## Voz real (E4b/E4c) — verificación local, 2026-11-07

- **Plan A** (`@discordjs/voice` 0.19.2 con adapter propio), sin rama B por ahora. Falta el spike de Gon contra Discord real (`bun run voice-spike <guild> <canal>`): es lo único que confirma DAVE con cuenta de usuario.
- Probado en Bun 1.4.3 contra un **servidor de voz falso local** (`tests/fakes/fake-voice-server.ts`: WS TLS `?v=8` + UDP): identify con `max_dave_protocol_version >= 1`, IP discovery, `aead_aes256_gcm_rtpsize`, Speaking 1/0, envío y recepción de Opus, op 4 de mute/deaf, cierre 4017 sin loop de reintentos (`tests/voice/session-e2e.test.ts`). El server falso responde `dave_protocol_version: 0`, así que el handshake MLS no se ejercita acá.
- Pipeline completo (`tests/voice/pipeline-e2e.test.ts`): tono sintético → VAD → Opus real (opusscript) → servidor; audio de otro usuario → descifrado → decoder por usuario → jitter → mixer → salida; mute no transmite, deafen no reproduce.
- **Desvío del plan:** el plan decía transmitir con `AudioPlayer` + `AudioResource` por ráfaga. Se usa `connection.playOpusPacket()` por cada frame capturado + `setSpeaking()`, porque el `AudioPlayer` corta Speaking si en un tick de 20 ms no hay frame (con mic en vivo pasa seguido). Los 5 silencios `F8 FF FE` los manda `voice/tx.ts` (davey no cifra los silencios).
- **Gotchas de la librería:** arma `wss://${endpoint}?v=8` fijo; ante cualquier cierre que no sea 4014 hace rejoin sola, así que `voice/session.ts` escucha `networking.once("close")` y destruye la conexión en los códigos fatales (4014, 4016, 4017, 4004, 4011) o después de 3 rejoins. Los mensajes de debug pasan por `sanitizeVoiceDebug` (nada con `{`, `token`, `session_id` o `secret`).
- Mensajes de cierre en español: `src/voice/close-codes.ts`.
- Revisión (2026-11-07), arreglado con tests en `tests/voice/session-e2e.test.ts`: salir mientras la librería carga o mientras espera a Discord ya no deja una conexión viva; `rejoin()` para mute/deaf solo se usa con la conexión lista y el gateway listo (si no, los flags se mandan al quedar lista); 4014 espera 5 s por si es un "te movieron" antes de rendirse; si la voz se cae con el gateway principal caído, reintenta cuando vuelve (`gatewayReady`); `v`/`m`/`D`/`M` ignoran la autorepetición de teclas.

## Código de privacidad

- Pendiente E4c Task 1 (Gon + [2ª]): no se sabe todavía si el cliente oficial lo muestra ni con qué formato. Mientras tanto la barra de voz lo muestra en grupos de 5 dígitos **[nuestra]** (`src/voice/privacy-code.ts`).

## Push-to-Talk y el protocolo de teclado de Kitty

- El plan daba por hecho que `useKittyKeyboard: { events: true }` alcanzaba para el PTT. No alcanza: OpenTUI arma los flags `7` (disambiguate + alternate keys + event types) y, sin "report all keys as escape codes" (flag 8), las teclas que producen texto (Espacio incluido) se mandan como texto plano y la terminal **no avisa cuándo se sueltan** (docs del protocolo de Kitty). El PTT habría caído siempre en modo interruptor.
- Ahora `src/ui/kitty.ts` pide `{ events: true, allKeysAsEscapes: true }` (flags 15). Probado con `parseKeypress`: Enter, Backspace, Esc, Tab, flechas, Ctrl-letra, `ñ`/`Ñ`, Shift+letras (`D`, `M`, `G`, `R`) y `?`/`+` se siguen decodificando bien, y Espacio trae press/repeat/release.
- Falta la confirmación de Gon en Ghostty (E4b Task 6, punto 3).

## Mouse (2026-11-07)

- OpenTUI 0.8.2 entrega `onMouseDown`, `onMouseOver`, `onMouseOut` y `onMouseScroll` en `<box>` y `<text>`; los `<span>` dentro de un `<text>` **no** reciben eventos, así que cada botón es su propio `<text>` (`src/ui/components/Button.tsx`) y hace `stopPropagation()` para no disparar la fila de atrás.
- La barra de acciones de un mensaje aparece solo en el mensaje **seleccionado** (click o j/k), no en el que tiene el mouse encima: mostrarla al pasar el mouse cambia el alto del mensaje, corre todo lo de abajo y el mouse queda sobre otro mensaje (parpadeo). El hover solo resalta el fondo.
- Los links dentro del texto de un mensaje son hipervínculos OSC 8 (en Ghostty se abren con Ctrl+click o el click que tengas configurado). Adjuntos y títulos de embeds sí se abren con click normal vía `xdg-open` (`src/proc/open-url.ts`, solo https, sin shell).
- La rueda arriba de todo de un canal pide historial (`actions.loadOlder`).

## Primera llamada real (2026-11-07, Gon)

- **Funciona con la cuenta de usuario y DAVE**: entra en ~2 s, se ve el código de privacidad, se escucha a los demás y se ve quién habla. El plan A (`@discordjs/voice` + adapter) queda confirmado; no hace falta la rama B.
- **opusscript 0.1.1 rompe con varias instancias.** Su wrapper JS arma los buffers de PCM con `HEAPU16.subarray(punteroEnBytes, …)`, o sea en `2 × puntero`, memoria que nunca reservó (el C++ espera un byte por cada elemento u16). Desde la 5.ª instancia viva esa zona pisa el estado de otro códec y el decoder aborta (`Aborted()` en opus_decoder.c); en una llamada hay un decoder por persona, así que rompía con el 3.º/4.º que hablaba. Reproducido con opusscript puro (`N=4 decoders + 1 encoder → aborta en el primer decode del 4.º`). Arreglo: `src/voice/opus-wasm.ts` usa el mismo módulo WASM con buffers bien reservados (encode idéntico byte a byte al original; probado con 90 decoders vivos). Además el receptor no reintenta crear un decoder en cada paquete si falla (antes llenaba la consola) y los códecs se liberan al salir.
- **Participantes de voz:** en cuentas de usuario el READY trae los guilds `lazy` sin `voice_states`; llegan en `READY_SUPPLEMENTAL.guilds[].voice_states` (mismo orden que READY) junto con `merged_members`. Antes solo se veía a uno mismo.

## DMs (2026-11-07)

- READY de usuario manda `private_channels` con `recipient_ids` (los usuarios van deduplicados en `users`), no con `recipients`: antes todos los DMs se llamaban "DM". `toPrivateChannel` (src/store/reducers/ready.ts) acepta las dos formas; los grupos usan su `name` si lo tienen.
- La lista se ordena por `last_message_id` (actividad) como el cliente oficial; un mensaje nuevo sube el DM.
- `CHANNEL_CREATE` agrega DMs nuevos; además, el primer mensaje de alguien que no estaba en la lista crea el DM (`ensureDmForMessage`). `CHANNEL_UPDATE`/`DELETE`, `CHANNEL_RECIPIENT_ADD`/`REMOVE` y `GUILD_MEMBER_UPDATE` ahora se aplican.
- Presencia de los DMs: `READY_SUPPLEMENTAL.merged_presences.friends`.
- Bug arreglado de paso: un autor de mensaje sin `global_name` pisaba el nombre ya conocido (los DMs mostraban el username).

## Interferencia al escuchar (2026-11-08, Gon)

- **Sin colchón en pw-cat.** El mixer escribía exactamente un frame por slot de 20 ms y nada cuando no había audio: cualquier demora del timer (el audio comparte el event loop con la UI de OpenTUI) o un paquete tardío dejaba a PipeWire sin datos → chasquidos. Ahora el mixer de la llamada es continuo (silencio cuando nadie habla) con un colchón inicial de 100 ms (`prerollFrames: 5`) que se repone tras una pausa larga del event loop o al sacar el deafen. Simulación de 60 s con jitter de red y pausas de 40–120 ms del event loop: 23 huecos → 2. Costo: ~100 ms más de latencia de escucha.
- El jitter buffer, si se vaciaba a mitad de frase, esperaba 3 frames otra vez (cortes de 60 ms); ahora vuelve con 2.
- **Ciphertext de DAVE al decoder.** `@discordjs/voice` (`DAVESession.decrypt`) devuelve el paquete sin descifrar cuando la sesión DAVE no está lista (al entrar o en una transición de época). Decodificarlo como Opus suena a ruido; se descartan los frames que terminan con el marcador 0xFAFA.
- El decoder WASM propio da salida idéntica byte a byte a opusscript (50/50 paquetes): no era la fuente del ruido.
## Encuestas y stickers

Fuentes (consultadas 2026-11-07): docs.discord.food → Messages (Poll Object, "Create Poll Vote"), Gateway Events ("Message Poll Vote Add/Remove") y Stickers. Probado solo con fixtures y la demo; falta la prueba de Gon contra la cuenta real.

- **`message.poll`**: `{ question: { text }, answers: [{ answer_id, poll_media: { text, emoji? } }], expiry, allow_multiselect, layout_type, results? }`. `results = { is_finalized, answer_counts: [{ id, count, me_voted }] }`; una respuesta que no figura en `answer_counts` tiene 0 votos. Si falta `results`, los resultados son desconocidos: un `MESSAGE_UPDATE` con la encuesta sin `results` conserva los que ya teníamos (`updateMessage`).
- **Votos en vivo**: `MESSAGE_POLL_VOTE_ADD` / `MESSAGE_POLL_VOTE_REMOVE` con `{ user_id, channel_id, message_id, guild_id?, answer_id }` (`answer_id` es entero, los demás snowflakes); en multiselección llega uno por respuesta. `me_voted` cambia solo si `user_id` soy yo (`src/store/reducers/polls.ts`).
- **Votar**: `PUT /channels/{channel_id}/polls/{message_id}/answers/@me` con `{ answer_ids: [...] }` (array de enteros; vacío saca el voto), responde 204 y Discord dispara los eventos de voto, también por los propios: por eso no hay cambio optimista. Multiselección alterna la respuesta tocada sobre mis votos actuales; selección única la reemplaza y tocar la misma saca el voto. Encuestas vencidas (`expiry` pasado) o con `is_finalized` no mandan nada.
- **[sin verificar]** si el cliente web manda los `answer_ids` como strings (`["1"]`) en vez de enteros; discord.food dice `array[integer]` y seguimos eso. Tampoco se probó el voto contra la cuenta real.
- Terminar una encuesta (`POST /channels/{c}/polls/{m}/expire`, solo el autor) no está implementado.
- **Stickers**: `message.sticker_items = [{ id, name, format_type }]`, `format_type` 1 PNG, 2 APNG, 3 Lottie, 4 GIF. Se muestran como imagen desde `https://media.discordapp.net/stickers/{id}.png?size=160` (o `.gif`; discord.food aclara que los GIF no están en el CDN y van por `media.discordapp.net`). El host ya estaba en la lista permitida; no se tocó. Lottie y "imágenes apagadas" muestran `🏷 nombre`. **[sin verificar]** el parámetro `size=160` (lo pidió el plan; discord.food no lo menciona) y que `<image>` anime APNG/GIF (se espera el primer frame).
## Mensajes nuevos (2026-11-07)

- Al **seleccionar** un canal (`ui/selectChannel` con un id distinto al actual) el reducer guarda `ui.unreadMarker = { channelId, afterId: readState.lastAckedId }`, antes de que el ack con debounce de 1,5 s (`actions.viewing`) mueva `lastAckedId`. El marcador no cambia mientras sigas en el canal (ni con nuestro ack ni con `MESSAGE_ACK`/`CHANNEL_UNREAD_UPDATE` de otro cliente) y se recalcula al volver a abrirlo. Lógica en `src/store/unread.ts`.
- Sin read state del canal no hay divisor (no se sabe desde dónde). Si el último mensaje del canal no es más nuevo que `lastAckedId`, tampoco: los que lleguen mientras mirás no cuentan como nuevos (para eso está el chip "↓ ir al final").
- El divisor rojo `──── mensajes nuevos ────` va antes del primer mensaje cargado más nuevo que `afterId` que **no sea propio**.
- Si hay sin leer más viejos que lo cargado (`hasMoreBefore` y el más viejo cargado > `afterId`) se muestra la barra `↑ N+ mensajes nuevos desde … · click o gn para saltar`. La hora sale del snowflake de `afterId`. Recién con el click o `gn` se piden páginas `before` (las mismas de `loadOlder`), como máximo 9 (los 500 mensajes que guarda el canal), y se selecciona el primero sin leer. La API también acepta `around`/`after`, pero dejarían huecos en el slice; no se usan.
- Al abrir, si el divisor está cargado la vista lo pone arriba (si todo lo nuevo entra, queda al final). `Esc`/`G` siempre bajan al final; el chip "↓ ir al final" aparece si llegaron mensajes estando arriba o con un mensaje seleccionado.

## Composer

Cursor real en el composer (2026-11-07). Cada canal guarda su borrador, sus menciones elegidas y la posición del cursor. La lógica pura está en `src/ui/text-edit.ts` (grafemas con `Intl.Segmenter`: un emoji o una letra con tilde combinada es un paso). En modo insert:

| Tecla | Hace |
|---|---|
| ← / → | un grafema |
| Ctrl-← / Ctrl-→, Alt-b / Alt-f | una palabra (letras, números y `_`) |
| Home / End, Ctrl-a / Ctrl-e | principio / fin de la línea |
| ↑ / ↓ | línea anterior / siguiente del borrador, misma columna (en la primera/última línea va al principio/final). Con el popup de @ abierto, ↑/↓ y Tab/Enter siguen siendo del popup |
| Backspace / Delete | el grafema antes / después del cursor (con Ctrl o Alt: la palabra) |
| Ctrl-w | la tira sin espacios antes del cursor (como la shell) |
| Ctrl-u | hasta el principio de la línea (antes borraba todo el borrador) |
| Ctrl-k | hasta el fin de la línea; al final de una línea junta la siguiente. **Solo en insert**: en modo normal Ctrl-k sigue abriendo el quick switcher |
| click en el texto | pone el cursor ahí (usa `lineInfo` del `<text>` de OpenTUI; ojo: `lineStartCols` cuenta columnas desde el principio de todo el texto, no de la línea lógica) |

- Escribir, pegar (Ctrl-v y bracketed paste), elegir una mención del popup y el click en un miembro insertan en el cursor. Las menciones de después se corren (`replaceMentions`); una mención cuyo rango se edita se descarta y queda como texto plano.
- El popup de @ mira el texto antes del cursor.
- `e` (editar) deja el cursor al final. Esc y Enter siguen igual.
- Dibujo: el grafema bajo el cursor va invertido (fondo `modeInsert`); al final de una línea o del texto, un `█`.
- ↑/↓ se mueven por líneas lógicas (separadas por Shift-Enter), no por las filas que parte el ancho de la terminal.

## Hilos y foros (2026-11-07)

Fuente de las formas: https://docs.discord.food (Gateway Events y Channel, leídas el 2026-11-07). Nada de esto se probó todavía contra la cuenta real: todo sale de la docs y de fixtures armados a mano.

- **Hilo** = canal con `type` 10 (anuncios), 11 (público) o 12 (privado), `guild_id`, `parent_id` (el canal de texto o el foro), `name`, `owner_id`, `last_message_id`, `message_count`, `member_count` (los dos cortan en 50) y `thread_metadata { archived, locked, auto_archive_duration, archive_timestamp, invitable?, create_timestamp? }`. Se guarda como `ChannelState` con `thread: { archived, locked, ownerId, messageCount, memberCount }` (`src/store/reducers/threads.ts`).
- **Fuentes:** `READY.guilds[].threads` (en cuentas de usuario, según la docs, solo los hilos que seguís), `THREAD_CREATE` (canal completo + `newly_created`, y `member` si te agregan a uno privado), `THREAD_UPDATE` (canal; **no** se manda cuando cambia `last_message_id`, por eso se conserva el que había y lo mueve `MESSAGE_CREATE`), `THREAD_DELETE` (solo `id`, `guild_id`, `parent_id`, `type`) y `CHANNEL_CREATE`/`CHANNEL_UPDATE` si el `type` es de hilo.
- **`THREAD_LIST_SYNC { guild_id, channel_ids?, threads, members }`:** reemplaza los hilos activos de los canales de `channel_ids` (puede traer canales sin hilos para que los borres); sin `channel_ids`, de todo el guild. Según la docs, en cuentas de usuario la lista completa llega acá después de suscribirse al guild (op 37 con `threads: true`, que ya mandamos). Decisión nuestra: no se borran los archivados que ya estaban ni el hilo abierto.
- **Payloads rotos** (sin `id`, sin `parent_id`, `type` que no es de hilo, `threads` que no es lista) dejan el estado igual; tests en `tests/store/threads.test.ts`.
- **Lista de canales:** los hilos activos van debajo de su canal de texto con `└`, el de actividad más reciente arriba (`last_message_id`, o el id si no tiene), y se colapsan con la categoría de su canal. Un hilo se ve si se ve su canal. **[nuestra]** Un hilo cuenta como no leído solo si tiene read state (los que seguís), como hace el cliente oficial; si no, cualquier hilo con mensajes prendería el servidor.
- **Foros (15) y medios (16)** aparecen en la lista (`💬`/`🖼`). Al abrirlos no se piden mensajes (no tienen) y no se manda op 37 para el foro: el panel muestra los posts (sus hilos) que ya están en el store. Abrir un post hace `GET /channels/{post}/messages` como cualquier canal, y el op 37 de un hilo usa el id de su canal de texto **[sin verificar]** (falta ver qué canal suscribe el cliente oficial al abrir un hilo).
- **Posts archivados**, solo con click o `a` (spec 7.8): `GET /channels/{foro}/threads/search?archived=true&sort_by=last_message_time&sort_order=desc&limit=25&offset=N` → `{ threads, members, has_more, total_results, first_messages? }`. Si el índice no está listo responde 202 con `code` 110000 y `retry_after` (sin `threads`): mostramos un aviso. **[sin verificar]** que una cuenta de usuario pueda usarlo sin más (la docs no lo marca como "not usable by user accounts", a diferencia de List Active Threads).
- **Sin verificar con la cuenta real:** que `READY.guilds[].threads` venga en guilds `lazy`, qué trae exactamente el `THREAD_LIST_SYNC` que llega al suscribirse (y si incluye los posts activos de los foros), y si mandar mensajes, typing, ack y reacciones en un hilo archivado lo desarchiva o da error.

## Estado propio y lista de miembros

Fuentes: discord.food (`topics/gateway-events`, `resources/presence`, `resources/user-settings-proto`, consultado 2026-11-07). Nada de esto se probó todavía contra la cuenta real (**🧍 Paso de Gon**).

**Estado propio (op 3).**
- Se manda `{ status, since, activities: [], afk: false }` (forma de discord.food, `DOCUMENTED_OP3`). `since` = ms epoch desde que está ausente, `0` si no; `afk` siempre `false` (según la doc solo decide si llegan push al celular).
- Valores: `online`, `idle`, `dnd`, `invisible` (`invisible` solo se envía; nunca llega). Se guarda en `settings.status`.
- El identify lleva el estado elegido en `presence` (y también el re-identify después de una reconexión). Ojo: discord.food dice que una cuenta de usuario debería mandar `status: "unknown"` en el primer identify y dejar que el gateway lo asigne, y usar `presence` solo para "la última presencia conocida" al re-identificar. Mandamos el estado elegido igual, porque si no el gateway pone el que tenga la cuenta y no el de discord-tui. **[sin verificar]** cómo lo combina con otras sesiones abiertas.
- Después de un RESUME se manda op 3 solo si el estado cambió mientras no había conexión (la sesión conserva la presencia). Antes del READY no se manda op 3 (no hay sesión todavía).
- El "ausente" automático por inactividad solo corre con el estado manual `online`; `dnd` e `invisible` no se pisan ni por inactividad ni por actividad.
- **Diferencia conocida con el cliente oficial:** la presencia del gateway es por sesión (discord.food, Session Object: la sesión `all` es la que ven los demás). El cliente oficial además sincroniza el estado entre dispositivos con `PreloadedUserSettings.status` en `PATCH /users/@me/settings-proto/1` (protobuf en base64). Ahora lo hacemos también: ver "Estado sincronizado (settings-proto)".
- Rate limit de la doc: 5 op 3 cada 20 s. Solo se manda por acción del usuario (menú, settings, `gp`) o por el ausente automático, y nunca dos veces seguidas el mismo estado.

**Lista de miembros más allá de 100.**
- discord.food no documenta todavía el payload de op 37 ni GUILD_MEMBER_LIST_UPDATE (las entradas "Update Guild Subscriptions" y "Guild Member List Update" no tienen sección). Lo que sigue sale del bundle web (ver arriba) y de cómo se comportan los clientes de terceros; **[sin verificar]** contra una captura real.
- `channels: { <channel_id>: [[0,99], [100,199], …] }`: ventanas de 100 filas; siempre `[0,99]` y como mucho otras dos que se corren (`[[0,99],[200,299],[300,399]]`). Máximo 3 rangos por canal **[nuestra]**; no sabemos el máximo real que acepta Discord.
- Se pide la ventana siguiente solo cuando la rueda llega cerca del final de lo cargado, solo para el canal abierto, como mucho un op 37 cada 500 ms (si se sigue scrolleando, uno al final de esa ventana), y solo si el último rango pedido volvió lleno (si no, la lista ya terminó). Abrir otro canal vuelve a `[[0,99]]`. Una sesión nueva (no resume) borra las suscripciones guardadas para que se vuelvan a mandar.
- Los índices de `SYNC`/`INSERT`/`UPDATE`/`DELETE`/`INVALIDATE` se toman como posiciones absolutas que cuentan los encabezados de grupo, así que la lista guarda cada fila en su posición (`null` = sin cargar o invalidada) en vez de compactarla. **[sin verificar]** si al sacar un rango Discord manda `INVALIDATE` de esa ventana; las filas de una ventana que ya no está suscripta quedan como estaban (pueden quedar viejas) y el selector no repite a nadie.
- `member_count` / `online_count` se guardan por guild y el panel muestra `Miembros · 14.814`. La lista sigue siendo una por guild (no por `id` de lista), como antes.

## Desfase de relojes en llamadas largas (2026-11-08)

- El mixer marca el ritmo con el reloj de la PC (`performance.now`); la placa de audio consume con el suyo. Se separan ~50–100 ppm (3–6 ms por minuto): con el colchón fijo de 100 ms, en 15–30 min se agotaba (vuelven los chasquidos) o crecía (más delay). No hay forma de leer cuánto audio tiene acumulado pw-cat.
- Arreglo: `src/actions/voice.ts` renueva la salida en un silencio: cada 5 min como mínimo, si nadie habló en los últimos 2 s, abre un pw-cat nuevo (`mixer.setPlayback`, que le pone el colchón) y cierra el viejo. Se loguea `voice.output` `state: "refreshed"`. Una charla o música sin pausas de 2 s durante mucho tiempo no se renueva hasta la próxima pausa.
- CPU de Opus WASM medido (2026-11-08): encode 0,16 ms y decode 0,05 ms por frame → 10 personas hablando + el mic ≈ 3,3 % de un núcleo. El Opus nativo no hace falta.

## Emojis custom

Fuentes: discord.food y docs de Discord (`reference#image-formatting`, consultado 2026-11-08) para las URLs; el resto se midió con OpenTUI 0.8.2 en `node_modules/@opentui/core` (2026-11-08).

- **Formato en el contenido:** `<:nombre:id>` y `<a:nombre:id>` (animado). Imagen: `https://cdn.discordapp.com/emojis/{id}.webp?size=48&quality=lossless`; los animados como `https://cdn.discordapp.com/emojis/{id}.gif?size=48` (`emojiUrl` en `src/images/cdn.ts`). Pasan por el cache de imágenes (allowlist del CDN, GET sin Authorization).
- **Jumbo:** si el mensaje es solo emojis (custom y/o unicode RGI, sin contar espacios ni saltos) y son entre 1 y 27, como el cliente oficial, y hay al menos uno custom, la fila se dibuja con cada custom como imagen de 4x2 celdas y los unicode como texto en la misma fila (`src/markdown/jumbo.ts`, `JumboRow` en `MessageItem.tsx`). Cualquier texto, markdown o mención lo vuelve un mensaje normal. Mientras carga o si falla la imagen se ve `:nombre:`. Con las imágenes apagadas (o en `render-frame`/demo) queda el texto `:nombre:` de siempre. **[nuestra]** El cliente oficial también agranda los unicode; en la terminal no podemos cambiar el tamaño del texto.
- **Reacciones custom:** con imágenes, el chip pasa de `<text>` a una fila de renderables (`" "`, imagen de 2x1, `" N "`) con el click en la caja, que sigue alternando la reacción. Se guarda `emoji.animated` de la reacción (REST y `MESSAGE_REACTION_ADD`) para pedir el GIF; al toggle se manda solo `{ id, name }`.
- **Animados:** `ImageRenderable` no anima (no hay API de cuadros; `VideoRenderable` es solo MP4). El decoder nativo **rechaza el WebP animado** (`ImageError: unsupported image feature`, probado con un WebP de 2 cuadros) y del GIF animado decodifica el primer cuadro. Por eso los animados se piden como `.gif`; la animación la hacemos nosotros (ver "GIFs animados").
- **Límite de OpenTUI 0.8.2: no hay imágenes dentro de una línea de texto.** Un `<text>` (`TextRenderable`) solo acepta `TextNodeRenderable`, `StyledText` o strings como hijos; `TextNodeRenderable.children` es `(string | TextNodeRenderable)[]` y lo que llega al buffer son `TextChunk` (`text`, `fg`, `bg`, `attributes`, `link`), sin lugar para una imagen ni para reservar un hueco de ancho fijo. Poner un `<image>` dentro de `<text>` tira `TextNodeRenderable only accepts strings, TextNodeRenderable instances, or StyledText instances` (probado con `testRender`). Por eso un emoji custom en medio de una frase sigue como `:nombre:`. La única salida sería dejar espacios en el texto y superponer imágenes con posición absoluta calculando dónde cayeron con `TextBufferRenderable.lineInfo` (`lineStartCols`/`lineWidthCols`) después de cada layout; se descartó: el ancho de un emoji (2 celdas) no coincide con el de los espacios cuando el wrap corta, y cada resize o scroll obliga a recalcular. Partir la frase en una fila de `<text>` + `<image>` rompe el wrap por palabras.

## Estado sincronizado (settings-proto)

Fuentes (consultadas 2026-11-08): docs.discord.food `resources/user-settings-proto` (endpoint, partial updates, rate limit), `topics/gateway-events` (READY `user_settings_proto`, User Settings Proto Update), `topics/gateway` (capability `USER_SETTINGS_PROTO = 1 << 9`, incluida en nuestro `GATEWAY_CAPABILITIES` 1734653). La doc no trae números de campo; salen del repo que enlaza: `github.com/discord-userdoccers/discord-protos`, `discord_protos/discord_users/v1/PreloadedUserSettings.proto` (commit `921d792`, 2026-11-07). Código: `src/proto/settings.ts`, `src/actions/status-sync.ts`. Nada de esto se probó contra la cuenta real (**🧍 Paso de Gon**).

**Campos usados (proto3).**

| Mensaje | Campo | Nº | Tipo | Wire type |
|---|---|---|---|---|
| `PreloadedUserSettings` | `status` | 11 | `StatusSettings` | 2 (tag `0x5a`) |
| `StatusSettings` | `status` | 1 | `google.protobuf.StringValue` | 2 (tag `0x0a`) |
| `StatusSettings` | `custom_status` | 2 | `CustomStatus` | 2 (se copia, no se interpreta) |
| `StatusSettings` | `show_current_game` | 3 | `BoolValue` | 2 (se copia) |
| `StatusSettings` | `status_expires_at_ms` | 4 | `fixed64` | 1 (se saca al escribir) |
| `StatusSettings` | `status_created_at_ms` | 5 | `UInt64Value` | 2 (se copia) |
| `StringValue` | `value` | 1 | `string` | 2 |

Ejemplo: `dnd` = `5a 07 0a 05 0a 03 64 6e 64` = `WgcKBQoDZG5k`.

**Lectura.**
- READY `user_settings_proto` (string base64; si falta, defaults) y `USER_SETTINGS_PROTO_UPDATE` `{ settings: { type, proto }, partial }` (solo `type: 1`, PRELOADED). El decoder saltea cualquier campo desconocido (wire 0, 1, 2, 5); grupos (3/4), wire 6/7, campo 0, largos que se pasan, varints cortados o de más de 10 bytes, base64 inválido o UTF-8 inválido → null, nunca tira.
- Varias apariciones del campo 11 (o del 1) se concatenan: en protobuf eso es mergear. Un update `partial: true` se concatena al StatusSettings cacheado; uno no parcial lo reemplaza.
- Solo se adoptan `online`/`idle`/`dnd`/`invisible`; `unknown` (el default de la doc) o ausente no cambia nada. Si el de la cuenta difiere del guardado se adopta (es la fuente de verdad entre dispositivos): `settings.status` se actualiza y se manda op 3 para que esta sesión coincida. Adoptar nunca hace PATCH.

**Escritura.**
- Solo cuando el usuario elige un estado (`actions.setStatus`): primero op 3 (como antes), después `PATCH /users/@me/settings-proto/1` con `{ settings: <base64> }` por la cola del RestClient. Respuesta `{ settings, out_of_date? }`; si trae settings legibles con campo 11 se usan como nuevo cache.
- La doc dice que un campo de primer nivel se manda entero: lo que falte vuelve al default. Por eso el PATCH lleva el StatusSettings conocido completo con `status` reemplazado (así no se borra el estado personalizado). Si no conocemos el StatusSettings (READY con proto ilegible, o antes del READY) no se manda nada y sale el aviso.
- Si el PATCH falla: queda el estado local y el op 3, y aviso warn "no se pudo sincronizar el estado con tus otros dispositivos" (clave `status-sync`). No se reintenta solo.
- Mientras hay un PATCH propio en vuelo y hasta 5 s después no se adopta lo que llegue por USER_SETTINGS_PROTO_UPDATE (puede ser el eco de un estado anterior si se eligieron dos seguidos) **[nuestra]**.

**Sin verificar.**
- Que el PATCH parcial con solo el campo 11 sea lo que manda el cliente oficial y que el server lo mergee como dice la doc.
- Sacar `status_expires_at_ms` al elegir un estado: suponemos que el cliente oficial lo pone en 0 para un estado sin vencimiento; si quedara uno viejo, Discord podría volver el estado al vencer. No mantenemos `status_created_at_ms` (se copia el que había).
- No leemos el vencimiento: si en el celular elegiste "no molestar por 1 hora", al vencer dependemos de que llegue un USER_SETTINGS_PROTO_UPDATE.
- No mandamos `required_data_version`, así que un PATCH puede pisar un cambio más nuevo hecho en otro dispositivo (la doc lo describe solo para ediciones offline).
- Rate limit: la doc dice "ratelimited heavily" y que el cliente oficial agrupa los cambios frecuentes (~10 s). Nosotros mandamos un PATCH por elección; elegir muchos estados seguidos puede dar 429 (la cola los espera).
- Qué hace el gateway con la presencia de las sesiones cuando cambia `StatusSettings.status` (si propaga solo o hace falta el op 3 de cada sesión).

## Chat de los canales de voz (2026-11-08, pedido de Gon)

- Los canales de voz (tipo 2) tienen su propio chat ("Text in Voice"): es el mismo `GET/POST /channels/{id}/messages` con el id del canal de voz, y los `MESSAGE_CREATE` llegan con ese `channel_id`. `isMessageChannelType` ya no excluye el tipo 2, así que abrir, leer, escribir, typing, ack, reacciones y adjuntos funcionan igual que en un canal de texto.
- Click (o Enter en la lista) en un canal 🔊 entra a la llamada y abre su chat, como Discord; con Ctrl-k se puede leer el chat sin entrar. Arriba del chat hay una franja con el estado de la llamada y el botón entrar/salir.

## Transmitir pantalla (Go Live)

Producto desde el 2026-11-08 (`src/golive/`). Sin probar todavía contra Discord: todo verificado contra fakes y la captura real
de esta máquina a `/dev/null`; el primer stream real es el 🧍 Paso de Gon (`docs/PRUEBAS-GON.md`, sección 6).

**Qué hace:** botón `📺 transmitir` en la barra de voz o `S` → si hay más de un monitor y no hay uno guardado en settings que siga
conectado, un picker → `⏳ iniciando…` → `🔴 EN VIVO · detener` (+ `👁 N` espectadores). Una transmisión a la vez, video + el
audio de la PC sin el de zcord (APAGADO por defecto desde el 2026-11-16: con audio Discord corta el stream a los 30 s con 4006; `ZCORD_GOLIVE_AUDIO=1` lo prende para probar; ver "Audio de la PC" abajo; con grim o sin PipeWire, solo video), 720p30 por defecto (1080p30 en settings, puede necesitar Nitro **[sin verificar]**).

**Audio de la PC** (`src/golive/desktop-audio.ts`, 2026-11-15): un `pw-record --target 0` propio (nodo `zcord-golive-audio`,
`node.always-process` para que mande silencio aunque no suene nada) escribe PCM s16 48 kHz estéreo directo en el fd 3 de ffmpeg,
que lo pasa a Opus 128k en el mismo NUT (la librería solo acepta Opus). Cada 1 s se lee `pw-dump` y se enlazan con `pw-link` las
salidas (`Stream/Output/Audio`) de las demás apps a ese nodo: no se mueve ningún stream. Sin eco, a prueba de fallos: se saltean
zcord y sus descendientes (el `pw-cat` de la voz y el de los audios, subiendo por los padres desde el pid del cliente en
`/proc/<pid>/stat`), los que mezclan todo (EasyEffects, loopbacks de pipewire/pipewire-pulse/wireplumber) y lo que no se puede
identificar (nodo sin cliente o cliente sin pid); en cada vuelta se deshacen con `pw-link -d` los enlaces a nuestro nodo que no
deberían estar. Un par que pw-link rechaza se prueba 3 veces y se deja. No se usa el monitor del sink: ahí ya está mezclada la voz
de la llamada. Los enlaces mueren con el nodo, y el nodo con pw-record (stop, o EPIPE si zcord se cae). Período de prueba: hasta
que ffmpeg saque el primer dato y pasen 1,5 s con pw-record y ffmpeg vivos (4 s como mucho) no se llama a `playStream`; si falla,
se reinicia la captura solo con video (`golive.no-audio`). Mientras tanto ya se le pide el stream a Discord (`createStream` una
sola vez por transmisión). Mientras va el audio, la barra de voz dice `🔊 con audio de la PC`. Gotchas: el planificador de
ffmpeg ≥7 no deja que una entrada se adelante más de 100 ms a otra, y wf-recorder sin `-D` no manda frames con la pantalla quieta
(medido): con audio se usa `-D`. El primer paquete de Opus trae pts negativo y NUT lo rechaza: `-bsf:a setts=ts=TS-STARTPTS`. Si
pw-record se muere después del período de prueba, se corta la transmisión (la librería sincroniza el video contra el audio y se congelaría).

**El corte a los 30 s con audio (4006, 2026-11-16), sin resolver:** en el log real, las 6 transmisiones con audio cierran a 30,15–30,18 s
de `golive.live` (el WS del stream listo), aunque `playStream` arrancó entre 0,26 s antes y 0,75 s después: el reloj de 30 s va con la
sesión del stream, no con el primer paquete. Descartado sin Discord: (1) que el video espere al audio: `playStream` real con conexión
falsa y fuentes sintéticas (lavfi + tono por el fd 3, también con el audio 2 s atrasado o en ráfaga) saca 30 cuadros/s y 50 paquetes
de audio/s parejos durante 40 s; con el servidor de stream falso y WebRTC real llegan ~580 RTP/s de video y 50/s de audio (SSRC del
READY, Opus PT 120, +960 de timestamp cada 20 ms); (2) el orden nuevo (`createStream` temprano): con o sin audio se mandan los mismos
ops (0, 12 vacío, 1, 5 `speaking: 2` con el SSRC de audio, 12 con el video), y la transmisión de las 21:02 arrancó `playStream`
antes de que el stream estuviera listo (como sin audio) y cortó igual. El audio usa la conexión del stream (`new AudioStream(conn)`),
no la principal, y pasa por DAVE (`encryptOpus`) como el video. Lo único distinto que ve Discord son los paquetes Opus. Para la
próxima prueba, `src/golive/stats.ts` anota cada 5 s `golive.stats` (ver `docs/PRUEBAS-GON.md`, 6b), y `ZCORD_GOLIVE_AUDIO=silence`
manda silencio (ffmpeg `anullsrc` a ritmo real por el fd 3, sin pw-record ni el enlazador) para separar "mandar audio" de "lo que se
captura". El diagnóstico nunca tira (si algo falla se apaga solo: `state: "off"`), saca el op con una expresión anclada sobre el
principio del mensaje sin parsearlo (el identify lleva el token) y sigue en los cierres reanudables del WS.

**Protocolo** (`src/golive/shim.ts`, `golive.ts`): el `Streamer` de `@dank074/discord-video-stream` 7.0.0 sobre NUESTRO gateway;
solo pasan los ops 18 `STREAM_CREATE {type, guild_id, channel_id, preferred_region:null}`, 22 `STREAM_SET_PAUSED {stream_key,
paused:false}` y 19 `STREAM_DELETE {stream_key}`; el op 4 queda bloqueado (la voz es de `@discordjs/voice`). Se le inyecta un
`VoiceConnection` dormido con el `session_id` de nuestro VOICE_STATE_UPDATE propio (se guarda por guild; se borra al salir y con
cada sesión nueva del gateway), nunca `joinVoice()`. La librería abre UN solo WS: el del stream (`server_id = rtc_server_id`).
De los dispatches, la librería ve solo `STREAM_*`; nosotros además usamos `STREAM_CREATE`/`STREAM_UPDATE` `viewer_ids` (cantidad
de espectadores) y `STREAM_DELETE` con `reason` (`unauthorized` = sin permiso de video, `stream_full`, …; lista **[sin verificar]**).
Los demás que transmiten salen de `self_stream` del VOICE_STATE_UPDATE (READY/READY_SUPPLEMENTAL y updates): `📺 en vivo` en la
lista de participantes. **[sin verificar]** si Discord manda un VOICE_SERVER_UPDATE extra al crear el stream (nuestro adapter de
voz se lo pasaría a `@discordjs/voice`).

**Se corta solo** si: salís de la voz o cambiás de canal (las acciones de voz cortan el stream antes de salir), la voz da error, el
gateway queda `disconnected` o vuelve con sesión nueva (`identified`; un resume no corta), llega un STREAM_DELETE nuestro, el WS
del stream cierra con código no reanudable (4004/4006/4011/4014/4016/4017/4022…), Discord no contesta en 15 s, o se muere la
captura. Siempre manda el op 19 si mandó el 18. Mensajes en castellano en `src/golive/errors.ts`.

**Captura** (`src/golive/capture.ts`): `wf-recorder` (wlr-screencopy, sin portal) → si no, `grim` en loop (un proceso por frame,
~10 fps; avisa que va trabado y sugiere instalar wf-recorder) → si no, error "instalá wf-recorder: sudo pacman -S wf-recorder".
Monitores de `hyprctl monitors -j` (hace falta `HYPRLAND_INSTANCE_SIGNATURE` en el env limpio); sin hyprctl, uno predeterminado.
- `wf-recorder -y -o MON -c rawvideo -m nut -x yuv420p -r 30 -f pipe:1` → stdin de ffmpeg directo (Bun conecta los procesos sin
  pasar por JS). Gotchas (2026-11-08, wf-recorder 0.6.0): con `-f /dev/stdout` falla "avio_open failed" (los pipes de Bun no se
  reabren por path); con `-F scale=…` sobre video crudo saca solo el encabezado NUT, así que achica ffmpeg.
- ffmpeg: `scale` a la caja 1280×720 (o 1920×1080) sin agrandar y manteniendo aspecto, `fps=30`, `-bf 0`, `-g 60 -keyint_min 60
  -force_key_frames expr:gte(t,n_forced*2)` y `-forced-idr 1` (también en NVENC, que el preset de la librería no trae), 2500k/3500k
  (720p) o 4500k/6000k (1080p), `-flush_packets 1`, NUT por stdout → `playStream(…, {type:"go-live", format:"nut"})`. Encoder:
  se prueba una vez con 1 frame sintético (lavfi) `h264_nvenc` → `h264_vaapi` (si hay `/dev/dri/renderD128`) → `libx264
  ultrafast zerolatency`. Con ffmpeg real y fuente sintética, ffprobe ve keyframes en 0, 2 y 4 s (test).
- Medido acá (2 s, todo descartado): wf-recorder+NVENC 574 KB NUT, +x264 334 KB, grim+NVENC 2,6 MB; el demux de la librería lo
  lee como H264 1280×720 30 fps. Después de `stop()` no queda ningún proceso (`pgrep` vacío; también hay test con procesos reales).
- Todo con env limpio (`spawnClean`), sin token; nada a disco.

**Bun:** el import de la librería es a pedido (arrastra node-av y sharp); antes se pone `DEBUG_LEVEL=OFF` porque su logger
(`debug-level`) escribe INFO a stderr y ensucia la TUI. El `Streamer`, la conexión y la captura quedan referenciados mientras dura
el stream (el GC de Bun junta Tracks sin referencia). `zeromq` nunca se importa bajo Bun.

**Fuera de alcance:** audio del sistema, la miniatura (`setStreamPreview`, pediría el token). Mirar streams de otros: ver "Ver
transmisiones".

### Spike (2026-11-08)

Spike del 2026-11-08, sin la cuenta (todo contra fakes locales). Scripts en `scripts/spike-golive/`. Lo que sigue es el registro del spike; el producto está arriba.

**Librería candidata:** `@dank074/discord-video-stream` 7.0.0 (npm, publicada 2026-09-13; repo `Discord-RE/Discord-video-stream`, último push 2026-11-03, 324 ★, consultado con `gh api` el 2026-11-08). Licencia ISC. Desde el issue #196 (2025-11) usa **WebRTC** (libdatachannel vía `@lng2004/node-datachannel`) en vez de UDP propio, y desde #195 implementa **DAVE** con `@snazzah/davey`.

**1. Instala y carga en Bun 1.4.3** (`bun scripts/spike-golive/load-deps.ts`, cada import en un proceso aparte):
- `bun add --exact @dank074/discord-video-stream@7.0.0`: instala bien; bloquea solo los scripts de `node-av` (el postinstall baja un binario de ffmpeg de GitHub; **no hace falta**, usa el `ffmpeg` del sistema). No hizo falta `bun pm trust`. Bun instala sola la peer `@lng2004/discord.js-selfbot-v13` 3.7.2, pero `dist/` no la importa en ningún lado (solo `import type`). `@snazzah/davey` sigue con una sola copia (0.1.12, por el `overrides`).
- Cargan: `@snazzah/davey`, `@lng2004/node-datachannel`, `sharp` 0.35.5, `node-av` 6.2.0 (prebuild de 168 MB con libav adentro), y el paquete entero.
- **`zeromq` 6.8.0 tira abajo Bun** al importarlo: `panic(main thread): unsupported uv function: uv_async_init` (oven-sh/bun#18546). No afecta: la librería solo lo importa si `!isBun() && !isDeno()` (`src/media/newApi.ts`, control de volumen en vivo con `azmq`). En Bun no hay control de volumen en vivo y no hace falta un ffmpeg con libzmq.

**2. Se puede usar sin el Client selfbot y sin abrir otra conexión de voz** (hoy `src/golive/shim.ts` + `tests/golive/shim.test.ts`, que reemplazaron a `streamer-shim.ts` y `shim-fake.ts`):
- `Streamer` (`src/client/Streamer.ts`) le pide al client solo `on("raw", {t,d})`, `ws.broadcast({op,d})`, `user.id`; `token` y `guilds.fetch` solo para `setStreamPreview` (miniatura, opcional). El shim lo arma sobre nuestro `Gateway` y deja pasar solo los ops 18/19/22.
- **No hay que llamar a `joinVoice()`**: abriría una 2.ª conexión de voz (al llegar VOICE_SERVER_UPDATE) y mandaría un op 4 con `self_deaf: true`. `createStream()` solo lee de `voiceConnection` `guildId`, `channelId`, `session_id`, `type`, `botId`. El shim inyecta un `VoiceConnection` "dormido" con el `session_id` de **nuestra** voz (el del VOICE_STATE_UPDATE propio) sin `setTokens()`, así que nunca conecta. La voz sigue siendo la de `@discordjs/voice`; la librería abre solo el WS del stream.
- Flujo verificado contra el fake: op 18 `STREAM_CREATE {type, guild_id, channel_id, preferred_region:null}` + op 22 `STREAM_SET_PAUSED {stream_key, paused:false}` → el gateway manda `STREAM_CREATE {stream_key, rtc_server_id}` y `STREAM_SERVER_UPDATE {stream_key, endpoint, token}` → WS `wss://{endpoint}/?v=8` → identify con `server_id = rtc_server_id`, nuestro `session_id`, `video: true`, `streams: [{type:"screen", rid:"100"}]`, `max_dave_protocol_version` → op 1 `protocol: "webrtc"` con SDP de libdatachannel → op 4 con `sdp` → key package MLS (binario 26) → op 12 VIDEO. Al cortar, op 19 `STREAM_DELETE {stream_key}`. `stream_key` = `guild:{guild}:{canal}:{user}` (`call:{canal}:{user}` en DMs). El canal DAVE del stream es `rtc_server_id - 1` (`StreamConnection.daveChannelId`).
- Gotcha de tipos: `exports` del paquete es solo `./dist/index.js`, así que importar `Streamer` arrastra `node-av` y `sharp` aunque no se usen.

**3. Transporte y DAVE:** WebRTC (ICE-lite + DTLS-SRTP de libdatachannel, packetizer H264/H265/VP8/VP9/AV1, NACK, pacing), no UDP crudo. DAVE para video (`daveSession.encrypt(VIDEO, codec, frame)`) y para el audio del stream (`encryptOpus`) en `WebRtcWrapper.ts`. En Bun:
- `webrtc-loopback.ts`: dos PeerConnection locales conectan en ~4 ms y pasan 60 frames H264 (1250 KiB, FU-A) → 1151 paquetes RTP, igual que en Node 26.
- **Gotcha Bun:** si no se guarda una referencia JS al `Track` recibido, el GC de Bun lo junta y dejan de llegar los `onMessage` (Node no lo junta: 1151 vs ~700 paquetes, y con más tiempo entre frames peor), y al cerrar después hay **segfault** (`--no-keep --close`, 3/3). La librería guarda sus tracks/PeerConnection en campos, así que en el camino de envío no pega, pero al integrar: mantener vivo el `Streamer`/conexión mientras dure el stream.
- `pipeline-local.ts`: `prepareStream()` (ffmpeg lavfi → libx264 o `h264_nvenc` → NUT por pipe) → `demux()` de node-av → `encrypt(VIDEO, H264)` con una sesión davey local en `ready`: 61 paquetes en 2 s, OK con x264, NVENC y con audio Opus. Con NVENC no se detectaron keyframes en 2 s (el preset nvenc de la librería no pasa `-forced-idr 1`) **[sin verificar]** si el que mira arranca bien; con x264 sí.

**4. Captura en esta máquina** (Hyprland 0.56.2, Wayland, RTX 3090, `bash scripts/spike-golive/capture-check.sh`, todo a `/dev/null`, ≤ 2 s):
- `ffmpeg` n9.0.2: libx264, libx265, nvenc, vaapi, vulkan, libdrm, libopus, **libzmq**. Captura propia: solo `kmsgrab` (necesita CAP_SYS_ADMIN y no va bien con NVIDIA) y `x11grab` (solo XWayland). **No tiene entrada pipewire ni wayland.**
- `grim` (wlr-screencopy, **sin portal**): anda, ~10 fps a resolución completa (20 frames en 2 s, los dos monitores). `grim | ffmpeg libx264 → H264 por stdout` produjo 2,4 MB en 2 s (descartados): **camino que anda hoy sin instalar nada**, pero lento.
- `gpu-screen-recorder` 5.12.3 instalado pero **roto**: linkeado a `libavcodec.so.62` y el sistema tiene `.so.63` (ffmpeg 9). `gsr-kms-server` tiene `cap_sys_admin=ep`.
- `wf-recorder` y `wl-screenrec`: no instalados. `wf-recorder` 0.6.0 está en `extra` (wlr-screencopy, sin portal); que escriba NUT a stdout con los flags de `golive-spike.ts` es **[sin verificar]** (no está instalado).
- Camino portal: `xdg-desktop-portal-hyprland` 1.4.1 y gstreamer `pipewiresrc` están, pero hay que negociar el ScreenCast por D-Bus (diálogo de selección); sin implementar. OBS 32.2.2 está pero no sirve para un pipe.

**Lo que tendría que instalar Gon:** `sudo pacman -S wf-recorder` (recomendado) y/o reinstalar `gpu-screen-recorder` para que linkee contra ffmpeg 9 (NVENC + KMS). Nada más: ffmpeg y los módulos nativos ya están.

**5. Alternativa (hacerlo a mano):** sobre nuestra voz + davey: ops 18/22/19 y STREAM_* (~80 líneas), un 2.º WS de voz con `video: true` y DAVE (reusar `voice/own` + la lógica MLS de `@discordjs/voice`, ~400), y transporte de video. Por UDP crudo (como hacía esta librería antes de 2025-11, `MediaUdp.ts.bak`) son packetizer H264 FU-A + RTX/NACK + RTCP SR (~600–900) y los autores lo abandonaron por inmantenible y sin NACK; por WebRTC igual dependeríamos de libdatachannel. Estimado ~1.500–2.000 líneas: no conviene mientras la librería ande.

**Riesgo de cuenta:** la librería lo dice (README: "Using any kind of automation programs on your account can result in your account getting permanently banned"). El identify del stream no es idéntico al del cliente oficial (campos de `streams`, sin op 20 PLATFORM) **[sin verificar]** si Discord lo mira. Sin Nitro, el cliente oficial limita Go Live a 720p30 **[sin verificar]** (no consultado hoy): transmitir a 720p30 como máximo **[nuestra]**. Hace falta el permiso "Video" en el canal.

**🧍 Paso de Gon:** ya no hay script aparte (`golive-spike.ts` se borró): se prueba desde la app, `docs/PRUEBAS-GON.md` sección 6.

## Go Live y ver: RTCP, códecs y diagnóstico (2026-11-17, Error 2012)

Medido en local (fakes, loopback de libdatachannel y video sintético; sin Discord):
- **RTCP al que transmite:** con dos m-lines (audio mid 0 + video mid 1) y sin `a=ssrc` en la SDP local, libdatachannel no
  sabe a qué track va el RTCP que llega y lo tira: el `RtcpNackResponder` de la librería nunca veía un NACK (loopback: 0 de
  4 paquetes RTCP sin `a=ssrc`, 4 de 4 con). El shim agrega `a=ssrc:<video_ssrc del op 2>` a la oferta
  (`declareVideoSsrc`). **[sin verificar]** que Discord lo acepte (es lo que hace un navegador).
- **Retransmisión** (medido con un proxy UDP entre dos PeerConnection locales, que tira un paquete de video elegido antes de
  que llegue; el encabezado RTP de SRTP va en claro): con el NACK ruteado (`a=ssrc` local), el `RtcpNackResponder` reenvía
  el paquete perdido (mismo SSRC y número de secuencia) y **el receptor lo acepta** (0 → 1, con una m-line y con audio +
  video). Si el paquete ya había llegado, el reenvío sale igual pero el receptor lo descarta (replay de SRTP): por eso la
  primera medición, que pedía uno ya recibido, parecía decir que no servía. Sin `a=ssrc` el NACK no llega al track y no hay
  reenvío. **[sin verificar]** cómo lo trata el SFU de Discord (los clientes oficiales retransmiten por RTX).
- **Pacing:** un IDR de 1080p con mucho detalle (77-88 paquetes, ~90 KB) sale en ~70 ms, ~1,07 ms entre paquetes (máx. 11
  paquetes en 5 ms); `UdpSndbufErrors` no se movió. Payload RTP máximo: 1220 bytes.
- **Tamaño de los IDR** (ffmpeg con los mismos argumentos de capture.ts, nvenc CBR): 1080p ruido 83-220 KB (el primero es el
  más grande), 1080p testsrc2 36-43 KB; 720p ruido 86-118 KB, 720p testsrc2 25-31 KB. El VBV (`-bufsize` = bitrate/2) acota.
- **Códecs:** la librería ofrecía H264, H265, VP8, VP9 y AV1 con la misma prioridad y nunca lee el `video_codec` del op 4
  ni el op 14. El shim deja solo H264 + opus en el op 1 (`onlyH264`) y avisa si el servidor elige otro
  (`golive.codec-mismatch`). La oferta declara `profile-level-id=42e01f` (nivel 3.1) y a 1080p mandamos High 4.0.
- **Zombi al cortar:** el manejador de cierre de la librería reanudaba (op 7 RESUME) también el cierre 1000 de su propio
  `stop()`: al terminar de transmitir o de mirar, reabría el WS del stream. Arreglado (`noResumeAfterStop`).
- **Feedback del que mira** (viewer.ts): RR (uno por SR), FIR (eso manda `Track.requestKeyframe()` de libdatachannel) y
  nuestro PLI con nuestro SSRC. No manda REMB, transport-cc ni NACK, y descarta el RTX (PT 102).
- **Diagnóstico nuevo:** watch.diag `neg`, `pt`, `rx` (histograma de NAL, marker, tamaños, padding, bit F, saltos y huecos) y
  `win` (saltos y paquetes faltantes desde el diag anterior); golive.stats `neg`, `upd`/`upd_n` (op 14), `codec`, `kf`,
  `kfs` y `rtcp` (PLI, FIR, NACK, RR con pérdida, REMB). Campos en src/golive/stats.ts y src/watch/h264.ts.

## Ver transmisiones

Producto desde el 2026-11-08 (`src/watch/`), sin probar contra Discord: todo verificado contra fakes, un loopback local (nuestro
emisor → server falso → nuestro espectador) y video sintético. La primera vez real es el 🧍 Paso de Gon (`docs/PRUEBAS-GON.md`,
sección 7). Medidas y gotchas en "Ver transmisiones (spike)" abajo.

**Qué hace:** estando conectado a un canal de voz, debajo de cada participante que transmite (📺) aparece `▶ ver` (en la lista de
canales y en la franja del chat del canal de voz: `▶ ver <nombre>`), y `w` mira al participante elegido o al primero que
transmita. La transmisión reemplaza el panel de mensajes: `📺 <nombre> · en vivo · N fps`, `✕ dejar de ver`, `Esc` o `w` la
cierran. Una a la vez. **Sin audio de la transmisión** (el track de audio se recibe y se descarta; falta Opus + DAVE + mezclarlo al
mixer de la llamada).

**Protocolo** (`src/watch/watch.ts`, `viewer.ts`): op 20 `{stream_key}` (`guild:{guild}:{canal}:{quien transmite}`) → con
`STREAM_CREATE` (`rtc_server_id`) + `STREAM_SERVER_UPDATE` (`endpoint`, `token`) se abre UN WS al server del stream con el
`session_id` de nuestra voz; para dejar de ver, op 19 `{stream_key}` (salvo que Discord ya la haya borrado o la sesión del gateway
sea nueva). `endpoint: null` = se suelta la conexión y se espera el próximo server. La conexión es la `StreamConnection` de
`@dank074/discord-video-stream` 7.0.0 subclaseada (su MLS/DAVE, heartbeat y resume) con nuestra SDP: `a=sendonly`, y al llegar el
op 12 VIDEO del que transmite se renegocia solo localmente con sus `a=ssrc:` y se manda op 15 `{any:100, <ssrc>:100}`. El que
mira no manda op 12 ni speaking.

**Video** (`h264.ts`, `decode.ts`): RTP (sin SRTP, de libdatachannel) → depacketizer H264 propio (NAL simple, STAP-A, FU-A;
reordena dentro del cuadro; si falta un paquete descarta el cuadro, pide keyframe con PLI y espera el próximo IDR; sin NACK) →
access unit Annex-B con start codes de 4 bytes → `davey.decrypt(quien transmite, VIDEO, au)` si termina en `0xFAFA` (en claro solo
sin DAVE o con passthrough) → node-av (libavcodec en el proceso, 2 hilos por slice, `AV_LOG_QUIET`) → RGBA achicado a la caja
(10×20 px por celda, tope 960×540) → `NativeImagePool` + `source` del `<image>` (como los GIFs). Se decodifican todas las access
units, se escalan como mucho 12 por segundo; con más de 30 en cola se tira todo y se pide keyframe. Sin la vista montada no se
decodifica nada; al volver, keyframe. Solo H264: si el op 4 dice otro `video_codec` (VP8/VP9/AV1/H265) se corta con aviso.

**Se corta solo** si: salís de la voz o cambiás de canal, el que transmite corta (`STREAM_DELETE` o su `self_stream: false` / se
va del canal), el gateway queda `disconnected` o vuelve con sesión nueva, el WS del stream cierra con un código no reanudable,
Discord no contesta en 15 s, o `STREAM_DELETE` con razón (`unauthorized` → "no tenés permiso para ver esta transmisión",
`stream_full` → "la transmisión está llena", …). Los errores quedan en el panel con `✕ cerrar`; los cortes normales, como aviso.

**[sin verificar]:** el descifrado DAVE de video de otra persona (ver spike); que el server de Discord acepte nuestra oferta de
espectador (es la misma forma que la del emisor, que tampoco se probó todavía); si Discord manda el op 12 del que transmite sin
pedirlo o hace falta el op 15 antes; cuánto tarda el primer keyframe (el cliente oficial responde al PLI); cómo se ve y cuánto
aguanta Ghostty a ~12 fps.

## Ver transmisiones (spike)

Spike del 2026-11-08, sin la cuenta (todo local: fakes, loopback y video sintético). Scripts en `scripts/spike-watch/`.
Veredicto: **se puede**, con esfuerzo razonable. Lo único que no se puede verificar acá es el descifrado DAVE de video de
OTRA persona (hace falta un grupo MLS de dos miembros reales): es un 🧍 Paso de Gon.

**¿La librería sabe mirar?** No. `@dank074/discord-video-stream` 7.0.0 solo transmite: `WebRtcWrapper.ts` arma los tracks
`SendRecv` pero nunca lee `onMessage`, la SDP remota que arma `handleProtocolAck` es `a=inactive` en audio y video, y no hay
depacketizer ni `decrypt` (solo `encrypt`/`encryptOpus`). `@lng2004/node-datachannel` 0.33.2 no expone depacketizers
(solo packetizers, `RtcpReceivingSession`, `RtcpNackResponder`, `RtcpSrReporter`, `PacingHandler`). Sí reusamos su
`StreamConnection` (WS, heartbeat, resume y todo el MLS/DAVE) subclaseándola (`src/watch/viewer.ts`).

**Protocolo del que mira** (docs.discord.food, Gateway Events y Voice Connections, consultado el 2026-11-08):
- Gateway op 20 `WATCH_STREAM {stream_key}` (hay que estar en ese canal de voz) → `STREAM_CREATE {stream_key, rtc_server_id,
  rtc_channel_id, region, viewer_ids, paused}` + `STREAM_SERVER_UPDATE {stream_key, endpoint, token}` (`endpoint: null` = se
  está reasignando el server), o `STREAM_DELETE {stream_key, reason, unavailable?}`. Razones: `user_requested`,
  `stream_ended`, `stream_full`, `unauthorized`, `safety_guild_rate_limited`, `parse_failed`, `invalid_channel`.
- Para dejar de mirar: op 19 `STREAM_DELETE {stream_key}` (si no sos el dueño, solo te desconecta).
- WS `wss://{endpoint}/?v=8`, identify con `server_id = rtc_server_id`, el `session_id` de NUESTRA voz, `video: true`.
  El grupo MLS/DAVE es `rtc_server_id - 1` (igual que al transmitir). "Solo el dueño del stream manda media."
- El server manda op 12 VIDEO `{user_id, audio_ssrc, video_ssrc, streams:[{ssrc, rtx_ssrc, rid, quality, max_resolution,
  max_framerate, active}]}` (RTX = ssrc + 1 si no viene). El que mira pide el video con op 15 MEDIA_SINK_WANTS
  `{any: 100, "<ssrc>": 100}`. El audio del stream es Opus con el flag de speaking `SOUNDSHARE` (1 << 1).

**(a) op 20 y los STREAM_* por nuestro gateway:** es lo mismo que el op 18 del emisor; nuestro gateway ya deja mandar
cualquier op y recibir cualquier dispatch. Probado con el gateway falso (`tests/watch/watch.test.ts`).

**(b) conexión al server de stream como espectador y recibir el video** (`rtp-routing.ts`, `loopback.ts`):
- Gotcha central: con dos m-lines (audio mid 0 + video mid 1, como la librería), **libdatachannel tira el RTP de un SSRC que
  no está en la SDP remota** (0 paquetes; con `a=sendonly` igual). Con `a=ssrc:` en la SDP remota llegan todos (120/120), y
  con un solo m-line también. Como el SSRC llega después (op 12), se **renegocia solo localmente**: `setLocalDescription()`
  (oferta nueva, mismas credenciales ICE/DTLS) + `setRemoteDescription(answer con a=ssrc)`; la conexión sigue `connected` y el
  server de Discord no se entera (la SDP "del server" la armamos nosotros, como hace la librería). Probado: 120/120.
- El op 1 se manda una sola vez; las ofertas de las renegociaciones no salen por el WS.
- El fake de stream (`tests/fakes/fake-stream-server.ts`) ahora tiene modo `relay`: el primero que manda un op 12 activo
  transmite y su RTP se reenvía a los demás con un op 12 como el de Discord. Para que conecte de verdad: contesta con los
  candidatos ya juntados y fuerza el rol DTLS (`a=setup:active` en la oferta), porque la librería escribe `a=setup:passive`
  en la SDP del server. **Hasta hoy el emisor contra el fake nunca llegaba a `connected`** (los tests solo miraban ops).
- Punta a punta local (`bun scripts/spike-watch/loopback.ts 6 0`): nuestro emisor (shim + `playStream`, lavfi 1280×720 30 fps,
  x264) → relay → nuestro espectador: 3514 paquetes, 179 access units en 6 s (30 fps), 0 descartadas, primer cuadro
  decodificado a ~1,1 s.
- Pérdidas: sin NACK (libdatachannel 0.33 no trae NACK requester); si falta un paquete se descarta el cuadro y se pide un
  keyframe (PLI con `Track.requestKeyframe()` vía `RtcpReceivingSession`). **Gotcha:** `requestKeyframe()` con el track
  todavía no abierto tira `std::runtime_error` desde el hilo de libdatachannel y **aborta el proceso** (core dump): solo con
  `isOpen()`.

**(c) DAVE de video** (`dave-video.ts`): `davey.encrypt(VIDEO, H264, frame)` **normaliza los start codes a 4 bytes**
(`00 00 01` → `00 00 00 01`) y deja los encabezados de NAL en claro; el frame cifrado termina en `0xFAFA`. Así que el que mira
tiene que rearmar la access unit Annex-B con start codes de 4 bytes (como WebRTC) antes de `decrypt(userId, VIDEO, au)`.
`decrypt` de otro usuario necesita su decryptor en el grupo MLS: con los vectores de davey (un solo miembro local) da
`NoDecryptorForUser`, así que **el descifrado real queda [sin verificar]**; es la misma API que usa `@discordjs/voice` para
el audio que ya escuchamos. En claro (DAVE versión 0 o en transición) pasa si `canPassthrough(userId)`.

**(d) decodificar con node-av** (`decode-bench.ts`, libx264 ultrafast, `-bf 0`, keyframe cada 2 s, 3 Mbps, 10 s, esta PC):
- 720p30 → 640×360 RGBA, mostrando 1 de cada 2 (15 fps): 1,09 ms por cuadro, **4,5 % de un núcleo**.
- 1080p30 → 640×360: 1,72 ms/cuadro, 8,8 %. 720p30 → 1200×674 (1 de 3): 1,67 ms, 6,4 %.
- En el loopback: decode + escala ~1 ms por access unit. H264 no deja saltear cuadros al decodificar (saltear rompe las
  referencias: "non-existing PPS"); se decodifican todos y se escalan solo los que se muestran.
- `CodecContext` + `SoftwareScaleContext` (SWS_FAST_BILINEAR) + `Frame.toBuffer(out)` (copia empaquetada). libav escribe a
  stderr: `Log.setLevel(AV_LOG_QUIET)` o ensucia la TUI. Se agregaron como dependencias directas, con la MISMA versión que ya
  estaba instalada por la librería: `node-av` 6.2.0 y `@lng2004/node-datachannel` 0.33.2-20260825 (`bun add --exact`; no
  baja nada nuevo).

**(e) dibujar en la TUI** (`render-bench.tsx`, renderer de test): `NativeImagePool.publishRgba` + cambiar `source` 0,10 ms
(640×360) / 0,23 ms (1200×674), `renderOnce` ~0,23 ms. La subida a la terminal: OpenTUI usa el protocolo de kitty, por
archivo temporal (`t=f`, `/opentui-kitty-…`) o directo (`t=d`, base64, `o=z`) según lo que detecte. 640×360 RGBA son 900 KB
por cuadro: a 12 fps ~11 MB/s. **[sin verificar]** si Ghostty lo aguanta sin parpadeo (🧍 Paso de Gon); por eso 12 fps y una
caja chica por defecto.

**Estimado del MVP:** 1–2 días; quedó hecho (sección "Ver transmisiones", arriba).

## Salida de audio de la llamada (2026-11-08, Gon no escuchaba)

- Diagnóstico: la voz llegaba bien (miles de paquetes, 0 errores) y el pw-cat de la app estaba conectado y "running", pero sin `outputDevice` elegido sale por la salida predeterminada del sistema, que en ese momento era un dispositivo Bluetooth (`AE01`, vía EasyEffects) y no los auriculares puestos. El cliente oficial usa su propia salida configurada.
- Ahora: al entrar a una llamada se avisa por dónde sale el audio; la barra de voz tiene `🔈 <dispositivo>` y al hacer click se elige la salida (o "predeterminada del sistema"). El cambio es en caliente: se abre un pw-cat nuevo con `--target` y se cierra el viejo, sin salir de la llamada. La predeterminada se lee de la metadata "default" de PipeWire (`default.audio.sink`).

## Sonidos (2026-11-08)

- Los sonidos de eventos son **propios**: tonos senoidales/triangulares sintetizados en `src/sounds/synth.ts` (48 kHz s16le estéreo, frames de 20 ms, pico −12 dBFS, ataque de 6 ms y caída que cierra en cero, ≤ 400 ms). No se copian ni descargan los archivos de Discord (copyright): solo imitan la idea (dos notas que suben al entrar, bajan al salir, blip suave cuando alguien entra/sale de tu canal, campanita para menciones/DM).
- **Desde 2026-11-16 suenan archivos CC0** (packs de Kenney *Interface Sounds* y *Digital Audio*; origen exacto de cada uno en `src/sounds/wav/CREDITS.md`), convertidos a WAV PCM s16 estéreo 48 kHz y normalizados a la sonoridad de los tonos de antes (−21,7 LUFS con K-weighting, pico ≤ −12 dBFS, `userJoin`/`userLeave` 3 dB abajo, fundidos de 4/12 ms). Se leen sin ffmpeg (`src/sounds/wav.ts`: solo ese formato, ≤ 1 s) desde `src/sounds/wav/`, también compilado (`dist/src` → `../../src/sounds/wav`). Si un archivo falta o está roto, ese cue usa el tono sintetizado y queda `sounds.wav-fallback` en el log. Siguen sin usarse ni imitarse los de Discord. Prueba de oído: `bun scripts/sounds-preview.ts [cue] [--compare | --synth | --alt]`.
- Cues: `join`, `leave`, `userJoin`, `userLeave`, `mute`/`unmute`, `deafen`/`undeafen`, `message`, `streamStart`/`streamStop`, `disconnect`.
- Dónde suenan: en llamada se suman al mixer (`mixer.play`), así salen por el mismo pw-cat y la misma salida que la voz y no compiten dos procesos por el dispositivo; ensordecido, el mixer descarta a la gente pero los sonidos sí se escriben. Fuera de llamada se abre un pw-cat corto con `--target` = `settings.outputDevice` (o la predeterminada), se le escribe todo el sonido de una y se cierra al terminar. Como mucho 3 pw-cat sueltos a la vez; el mismo sonido dentro de 150 ms se descarta.
- Cuándo: los de tu voz salen de comparar el estado (`joining → connected` = join; salir sin error = leave, con error = disconnect; cambio de deafen = deafen/undeafen y si no, de mute = mute/unmute; Go Live a `live` y de vuelta). `userJoin`/`userLeave` solo comparan antes/después de un `VOICE_STATE_UPDATE` (nunca READY/READY_SUPPLEMENTAL), solo de tu canal estando conectado, nunca por vos. `message` usa la misma decisión que la notificación de escritorio (`shouldNotify`: DM o mención/reply a vos, canal no silenciado, no lo estás mirando).
- Ensordecido, como el oficial **[nuestra]**: solo suenan mute/unmute/deafen/undeafen y leave.
- Settings: `sounds: { enabled, volume 0–100 (60), events: { <cue>: bool } }`; en `gs` → "Sonidos". La demo no reproduce nada (no usa el runtime).

## GIFs animados

Medido con OpenTUI 0.8.2 (`node_modules/@opentui/core`), sharp 0.35.5 y Bun 1.4.3, 2026-11-08. Nada probado en Ghostty contra la cuenta real (**🧍 Paso de Gon**: abrir un canal con un GIF, un sticker GIF y un emoji animado).

**Qué puede y qué no OpenTUI.**
- `ImageRenderable` no anima: el decoder nativo solo da el primer cuadro del GIF y no hay API de cuadros. Sí acepta como `source` un `NativeImage` (lo retiene con refcount, cambio sincrónico más un microtask) y `NativeImagePool` (`publishRgba`) reusa hasta 8 buffers nativos del mismo tamaño, pensado para cuadros de video. Esa es la vía: decodificamos nosotros y cambiamos el `source`.
- `VideoRenderable` existe pero su `source` es **la ruta de un archivo MP4** (H.264/AAC) en disco. Para un gifv habría que bajar el MP4 a un temporal, y el `video.proxy_url` de Tenor/Giphy está en `images-ext-N.discordapp.net` (fuera de la allowlist) o en el host del proveedor. No se usa.
- El renderer emite `focus`/`blur` (secuencias `CSI I`/`CSI O` del modo 1004); `App.tsx` frena todas las animaciones con `blur`.

**Cómo funciona.**
- `src/images/gif.ts`: sharp (`animated: true`, `resize` `fit: inside` al tamaño de la caja con 10×20 px por celda, `raw` RGBA) → cuadros + demoras de `metadata().delay`. Demora 0–10 ms = 100 ms (como los navegadores) y mínimo 40 ms (≤ 25 fps). Topes por GIF: 10 s (se corta y vuelve a empezar), 150 cuadros y 24 MB; si se pasa, uno de cada N cuadros sumando las demoras. También decodifica WebP animado (el de OpenTUI lo rechaza). sharp se importa dinámico: si el nativo no carga, o el archivo no es GIF/WebP, tiene un solo cuadro o está roto → null y se ve la imagen quieta de siempre.
- `src/images/frames.ts`: LRU por URL + tamaño, tope 64 MB de RGBA; los "no animado" se recuerdan sin costo, las fallas de red no.
- `src/images/animation.ts`: **un solo timer** para todas las animaciones, programado al próximo cuadro que vence; sin animaciones o en pausa no queda timer vivo. Una imagen fuera de la terminal o del viewport de su scrollbox no avanza (se vuelve a mirar a su ritmo). Si el proceso estuvo dormido no repone los cuadros perdidos.
- `AnimatedImage.tsx`: cambia el `source` del `<image>` imperativamente desde el scheduler (no pasa por Solid: la lista de mensajes no se re-dibuja por cuadro). Al desmontar se saca del scheduler y libera el pool.
- Dónde anima: adjuntos GIF, stickers formato 4, emojis animados (jumbo y reacciones) y embeds `gifv` cuya imagen o miniatura sea un `.gif` (o `content_type: image/gif`) en un host permitido. Un gifv sin variante GIF (Tenor: miniatura PNG en `images-ext-1`) muestra `▶ GIF · click para verlo`, que abre el link con `xdg-open`.
- Setting `animateImages` (default sí), en Settings → Apariencia junto a "imágenes inline": con no, primer cuadro como antes.

**Medido** (GIF sintético de 498×280, 60 cuadros, 3,4 MB): decodificar y achicar a 40×12 celdas (400×225) tarda ~135 ms y deja 20,6 MB de RGBA; el mismo GIF para un emoji jumbo (40×22 px) son 206 KB. `publishRgba` de un cuadro de 400×225: ~0,05 ms. El fixture `sample.gif` (64×64, 3 cuadros de 100 ms) da 3 cuadros distintos.

**Sin verificar.**
- Que `media.discordapp.net` devuelva el GIF animado (y no un WebP o un cuadro) cuando se le piden `width`/`height` en un adjunto `.gif` (`sizedUrl`). Si devuelve WebP animado, igual anima por sharp.
- Qué variante GIF traen de verdad los embeds gifv de Giphy/Tenor (el caso "miniatura `.gif`" sale de suponer, no de un payload real).
- Cómo se ve en Ghostty: cada cuadro se re-sube por el protocolo de kitty; si parpadea habrá que bajar los fps.

## Avatares

Medido con OpenTUI 0.8.2, sharp 0.35.5 y Bun 1.4.3, 2026-11-08, solo con tests y la demo. Nada probado en Ghostty contra la cuenta real (**🧍 Paso de Gon**: ver avatares en mensajes, miembros, voz y DMs, y uno animado).

**URLs** (`src/images/avatar.ts`, docs.discord.food → CDN):
- Propio: `https://cdn.discordapp.com/avatars/{user_id}/{hash}.{ext}?size=32`. Hash `a_…` = animado: `.gif` con `animateImages`, `.png` (primer cuadro) sin.
- De server (`member.avatar`, gana sobre el propio): `/guilds/{guild_id}/users/{user_id}/avatars/{hash}.{ext}?size=32`. `MemberState.avatar` se llena desde READY, READY_SUPPLEMENTAL (`merged_members`), GUILD_MEMBER_LIST_UPDATE, GUILD_MEMBER_UPDATE y los `voice_states[].member`, solo si el campo vino.
- Sin avatar: `https://cdn.discordapp.com/embed/avatars/{n}.png` con n = `(id >> 22) % 6` (nombres nuevos) o `discriminator % 5` si la cuenta tiene un discriminador distinto de `"0"` (`UserState.discriminator`, solo se guarda en ese caso: bots viejos).
- Ids que no son snowflake o hashes con caracteres raros caen al avatar por defecto (no se arma ninguna ruta con eso). Todo pasa por la allowlist de `cache.ts`, GET pelado sin Authorization.

**Cómo se ve.** `Avatar.tsx`: caja de **2×1 celdas** (≈ un cuadrado, la celda mide ~1:2). sharp decodifica a 32×32 RGBA (`fit: fill`) y se recorta en **círculo** con borde suavizado de 1 px tocando el alfa; se muestra con `AnimatedImage` (un cuadro = imagen quieta; varios = el scheduler compartido de los GIFs). Sin sharp, los bytes tal cual en un `<image>`. Mientras carga, con imágenes apagadas o si falla: la inicial (`G ` o un emoji de 2 celdas) con `modeFg` sobre `theme.names[hash(userId)]`. El mismo ancho en los tres estados: no salta nada.

**Dónde.** Antes del nombre en el encabezado de los mensajes no agrupados; en la lista de miembros después del punto de presencia (`● G  Gon`); en los participantes de voz después del ● de hablando (el anillo sigue siendo el punto); en los DM 1 a 1 después del punto de presencia; en el popup de `@`. Los anchos de truncado restan las 3 celdas (avatar + espacio). De paso: un `<text>` vacío en OpenTUI ocupa 1 celda, así que el badge de menciones vacío y los íconos de voz vacíos ahora no se montan (antes se comían una celda y el `…` del nombre quedaba cortado).

**Rendimiento.**
- Lazy: el avatar pide la imagen la primera vez que se dibuja y `onScreen` confirma que está en la terminal y en el viewport de su scrollbox. Medido: un scrollbox con 30 filas y 5 visibles llama `renderBefore` solo en esas 5 (las de afuera no se dibujan). Pedida la imagen, el gancho se saca.
- Cola de 6 bajadas a la vez (`src/images/queue.ts`); al tocarle el turno, si ninguna fila que la pidió sigue montada, no se baja. Test: 300 avatares a la vez → como mucho 6 en vuelo; una lista de 119 miembros pide solo los de pantalla (el test pide entre 10 y 50).
- LRU propio de **8 MB** de lo decodificado (un avatar quieto son 4 KB); sin LRU de bytes crudos. Pedidos de la misma URL se juntan. Una URL que falló no se vuelve a pedir por 60 s (las filas de la lista de miembros se re-montan con cada cambio). `peek` sincrónico: una fila que se vuelve a montar muestra la imagen sin parpadear.
- Cada avatar tiene su propia señal: cargar uno no vuelve a dibujar la lista de mensajes.

**Setting** `showAvatars` (default sí), en Settings → Apariencia debajo de "animar GIFs y emojis". Con no, todo vuelve al layout de antes.

**Sin verificar.** Cómo se ve el 2×1 en Ghostty (si el círculo queda chico o desalineado con el texto); que `?size=32` del CDN devuelva el GIF animado para hashes `a_`; payloads reales con `member.avatar` en GUILD_MEMBER_LIST_UPDATE.

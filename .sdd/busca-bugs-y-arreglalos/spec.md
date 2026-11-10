# Spec — busca bugs y arreglalos

Los bugs B7 y B18 ya están corregidos y quedan explícitamente fuera de esta spec. Los demás se agregan como requisitos nuevos.

## ADDED

### REQ: ready-versioned-read-state
`applyReady` debe interpretar `read_state`, `user_guild_settings` y los `channel_overrides` de cada guild en sus dos formas: la lista/mapa legacy y el sobre versionado `{ entries, partial, version }`. Se agrega un helper `entriesOf()` que desenvuelve `value.entries` cuando existe y cae al comportamiento actual (`asList`) cuando no. Además, `merged_members` de READY se mezcla con los `members` ya parseados de cada guild, sin pisar los que ya estaban.

Acceptance criteria:
- Un READY con `read_state = { entries: [...], partial: false, version: n }` produce el mismo `state.readState` que un READY con `read_state = [...entries]`.
- Un READY con `user_guild_settings = { entries: [...] }` y `channel_overrides` versionadas llena `guildSettings.mutedGuilds` y `guildSettings.mutedChannels`.
- El fixture sintético array-shaped (`fixtures/gateway/READY-1.json`) sigue pasando sin cambios de comportamiento.
- Se agrega un fixture versionado redactado y pasa el chequeo de fixtures (sin strings tipo token, claves secretas `[redacted]`).
- `merged_members` de READY aporta miembros por guild cuando vienen, sin borrar los de `guild.members`.

### REQ: http-timeout-and-ratelimit
Toda request REST usa un `AbortSignal.timeout(30_000)`; un timeout o abort se convierte en `NetworkError` para que la cola de la ruta continúe. `RateLimitedError.global` se calcula como `parsed.global === true || x-ratelimit-global === "true" || scope === "global"`. El `Map` de colas del cliente REST borra la entrada cuando la promesa de cola termina.

Acceptance criteria:
- Un `fetch` que nunca resuelve termina en `NetworkError` (con timer stub) y la siguiente request del mismo route puede ejecutarse.
- Un 429 con header `x-ratelimit-global: true` y sin body `global` produce `RateLimitedError.global === true`.
- Un 429 con `scope: "global"` también produce `global === true`.
- Después de completar N requests de rutas distintas, `queues` no retiene entradas terminadas (verificable por identidad/size).
- `bun run typecheck` sigue limpio.

### REQ: unauthorized-saved-session
El arranque con sesión guardada (`boot` devuelve `main` u `offline`) debe registrar el handler de `onUnauthorized` igual que el camino de login. Cuando REST/gateway avisa 401, el runtime se detiene y la UI vuelve a la pantalla de login (o sale de forma controlada con aviso), en vez de quedar con REST cerrado y sin feedback.

Acceptance criteria:
- Existe un punto único (componente/helper) que registra `runtime.onUnauthorized` en ambos caminos de `main()`.
- Al dispararse el handler: se llama a `runtime.stop()` y se vuelve a renderizar `LoginScreen` (o se invoca el `quit` controlado con aviso).
- Los tests de `boot()` siguen pasando y no cambian los resultados `main`/`login`/`offline`.
- No se duplica el handler en el camino de login existente.

### REQ: settings-flush-and-notify-guard
`attachSettingsPersistence` devuelve (además del detach) una función `flush()` que escribe inmediatamente el último cambio pendiente si el timer de debounce sigue vivo. `runtime.stop()` espera ese flush antes de cerrar. `notify()` envuelve el spawn de `notify-send` en try/catch para que un error síncrono no escape al callback del gateway.

Acceptance criteria:
- Cambiar settings y llamar `flush()` antes de que venza el debounce persiste el último valor.
- `runtime.stop()` no pierde el cambio hecho en los últimos `< debounceMs` ms.
- Un `spawn` que lanza una excepción síncrona no propaga el error fuera de `notify()`.
- El log del fallo usa solo campos allowlisted (se agregan a `ALLOWED_FIELDS` si hace falta) y no filtra tokens.

### REQ: read-state-automations
MESSAGE_CREATE actualiza el read-state en el store sin esperar al ack del server: un mensaje propio marca el canal como leído (`lastAckedId = id`, `mentionCount = 0`) y un mensaje con mención para el usuario incrementa `mentionCount` en su canal.

Acceptance criteria:
- Despachar MESSAGE_CREATE con `author.id === me.id` deja `isChannelUnread(channel) === false` para ese canal.
- Despachar MESSAGE_CREATE con mención en un canal distinto al abierto incrementa `mentionCount` en 1 y deja el canal unread.
- Los tests de divider/unread existentes (`tests/store/unread.test.ts`) siguen pasando.

### REQ: ack-token-and-last-viewed
`postAck` deja de mandar `{ token: null, last_viewed: 0 }` fijo. Envía el token de ack que se tenga (null la primera vez) y calcula `last_viewed` como días desde la época de Discord (`Date.now() - 1420070400000` sobre `86400000`). La respuesta del endpoint (si trae `token`) se guarda para el próximo ack del canal.

Acceptance criteria:
- El primer ack envía `token: null` y `last_viewed` = días desde 2015-01-01, no 0.
- Si la respuesta trae `token`, el segundo ack para ese canal lo envía.
- La verificación del formato real contra la cuenta es 🧍 Paso de Gon (queda anotado en el código/test, no se valida acá).

### REQ: select-guild-no-history-fetch
Moverse entre servidores (`selectGuild`) no dispara un GET de historial. Solo la selección inicial (cuando no había ningún guild seleccionado) abre el primer canal y pide su historial; los `j`/`k` posteriores solo cambian la selección.

Acceptance criteria:
- Con `selectedGuildId === null`, `selectGuild(id)` abre el primer canal openable y hace exactamente un GET.
- Con un guild ya seleccionado, `selectGuild(otroId)` no hace ningún GET y deja `selectedChannelId` apuntando al primer canal openable del nuevo guild.
- `goToChannel`/switcher siguen abriendo el canal explícitamente (no se rompe el click/enter).

### REQ: voice-move-follows
Cuando Discord mueve al usuario de canal de voz (VOICE_STATE_UPDATE propio con otro `channel_id`, incluyendo cross-guild), el cliente no se limita a parchear la UI: llama a `session.join` con el guild y canal nuevos y los flags actuales. La operación se serializa y respeta la carrera con el estado `joining`.

Acceptance criteria:
- Moverme a otro canal del mismo guild llama `join(guildId, nuevoChannelId, flags)` y actualiza `voice.channelId`.
- Moverme a un canal de otro guild actualiza `voice.guildId` al guild del canal nuevo.
- Si el move llega mientras `status === "joining"`, el `join` nuevo se encola y no pisa la entrada en curso.
- El reducer `voice/moved` acepta `guildId` (opcional) sin romper los casos actuales.

### REQ: log-rotation-and-dispatch-gate
El log por evento de gateway (`gateway.dispatch`) deja de escribirse por defecto; se habilita solo con env (p. ej. `ZORD_LOG_DISPATCH=1`). El logger rota por tamaño (sin perder redacción de tokens) y mantiene válidos los chequeos de leak.

Acceptance criteria:
- Sin la env var, un dispatch no escribe línea `gateway.dispatch`.
- Con la env var activa, sí se escribe.
- Al superar el límite de tamaño, el archivo rota (el archivo activo no crece sin cota) y las líneas nuevas siguen redactadas.
- `tests/log/logger.test.ts` y `tests/security/no-token-leak.test.ts` siguen pasando.

### REQ: small-cleanups-a
Tres arreglos chicos independientes: el volumen 0 por usuario se conserva al persistir/cargar; se elimina el log de diagnóstico `ready.shape`; el cache de imágenes mira `Content-Length` antes de leer el body completo.

Acceptance criteria:
- `parseVolumes({ "id": 0 })` conserva `id: 0` (mute por usuario sobrevive al restart).
- `runtime` no loguea `ready.shape` en ningún dispatch READY.
- Con `Content-Length > MAX_IMAGE_BYTES`, `createImageCache.get()` devuelve `null` sin llamar a `response.arrayBuffer()`.

### REQ: small-cleanups-b
Cuatro arreglos chicos independientes: `retry` no re-subte adjuntos ya subidos; el throttle de envío del gateway captura el socket al que le corresponde el payload; los grupos no se titulan "(DM)"; y las teclas `l`/`Esc` se comportan según el foco.

Acceptance criteria:
- `retry(nonce)` reutiliza los adjuntos ya subidos y no llama de nuevo a `upload`.
- Un payload throttled cuyo socket ya se cerró no se envía por un socket nuevo.
- `notificationTitle` para un group DM (tipo 3 con nombre) usa el nombre del grupo, no `(DM)`.
- `Esc` con foco en canales/servidores no fuerza `toBottom()`; con foco en mensajes conserva el comportamiento actual.
- `l`/`right` con foco en mensajes tiene una rama explícita (no cae en silencio): abre el primer link del mensaje seleccionado si existe, y si no, no hace nada visible sin error.

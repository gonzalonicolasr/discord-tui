## T001 (parallel wave 1)

# TDD evidence — T001

| task | test file | RED result | GREEN result | notes |
|------|-----------|-----------|--------------|-------|
| T001 | tests/store/ready.test.ts | 4 fail (3 new versioned/merged_members + 1 missing fixture) | 28 pass / 0 fail | added `entriesOf`, `merged_members` merge, versioned fixture |
| T001 | tests/fixtures/fixtures-contract.test.ts | 1 fail (fixture ENOENT) | pass | added `gateway/READY-versioned-1.json` to REQUIRED |

Evidence command: `bun test tests/store/ready.test.ts tests/fixtures/fixtures-contract.test.ts` → 28 pass, 0 fail.

## T002 (parallel wave 1)

# TDD Evidence — T002 (Timeout y rate-limit HTTP: B5, B2, B15)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T002 | tests/rest/http.test.ts | 6 fail (timeout colgado, global false por header/scope, retry_after NaN, queueCount undefined) | 24 pass / 0 fail | RED confirmó la ausencia de `signal`, del flag global por headers/scope, del default de 1s y de la limpieza de colas |
| T002 | tests/rest/client.test.ts | 6 fail (queueCount undefined) | 24 pass / 0 fail | TRIANGULATE: cola compartida por ruta, rutas distintas en paralelo y drenado a 0 por identidad |

Comandos:

- RED: `bun test tests/rest/http.test.ts tests/rest/client.test.ts` → 16 pass / 6 fail
- GREEN/REFACTOR: mismo comando → 24 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

## T003 (parallel wave 1)

# TDD Evidence — T003 (onUnauthorized en sesión guardada · B1)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T003 | tests/app/root.test.tsx | 0 pass / 1 fail (Cannot find module '../../src/app/root') | 2 pass / 0 fail | Extraje `Root` en `src/app/root.tsx`; registra `onUnauthorized` siempre (login y sesión guardada) y vuelve a `LoginScreen`. Triangulación: 2º caso con `initialRuntime=null` (login) verifica que arranca en login y `q` sale con runtime null. |

## T004 (batch 2/3)

# TDD Evidence — T004 (Flush de settings y guarda de notify · B10, B12)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T004 | tests/settings/settings.test.ts | 2 fail (detach no flushea el cambio pendiente) | 12 pass / 0 fail | `attachSettingsPersistence` devuelve `() => Promise<void>`: si el debounce sigue vivo guarda el último valor y lo espera; si ya está en vuelo lo espera. |
| T004 | tests/notify/notify.test.ts | 1 fail (spawn que tira se propaga) | 6 pass / 0 fail | `notify()` envuelve el spawn en try/catch, loguea `notify.failed` con `error_name` (allowlisted) y absorbe `child.exited` rechazado. |

Comandos:
- RED: `bun test tests/settings/settings.test.ts tests/notify/notify.test.ts` → 25 pass / 3 fail
- GREEN/REFACTOR: mismo comando → 28 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

## T005 (batch 2/3)

# TDD Evidence — T005 (Automatizaciones de read-state · B8)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T005 | tests/store/messages.test.ts | 3 fail (propio no marca leído, mención no suma, DM no suma) | 20 pass / 0 fail | Nuevo `applyMessageCreateReadState` en `read-state.ts`, cableado en MESSAGE_CREATE. Propio → `lastAckedId=id, mentionCount=0`; mención ajena o DM no silenciado → `mentionCount+1`. |

Comandos:
- RED: `bun test tests/store/messages.test.ts tests/store/unread.test.ts` → 17 pass / 3 fail
- GREEN/REFACTOR: mismo comando → 20 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

## T006 (batch 2/3)

# TDD Evidence — T006 (Ack token y last_viewed · B21)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T006 | tests/rest/routes.test.ts (new) | 1 fail / 1 error (`lastViewedDays` no exportado) | 3 pass / 0 fail | `postAck` acepta `{token, last_viewed}`, calcula `last_viewed` (días desde la época) y devuelve el `token` de la respuesta. |
| T006 | tests/actions/read.test.ts | 1 fail (scheduler no reusa token) | 5 pass / 0 fail | `createAckScheduler` guarda token por canal y lo manda en el siguiente ack. |
| T006 | tests/actions/typing-ack.test.ts | 3 fail de tipos (firma vieja de `postAck`) | 6 pass / 0 fail | Actualicé los fakes al nuevo retorno `{ token }`; no cambió el comportamiento debounced. |

Comandos:
- RED: `bun test tests/rest/routes.test.ts tests/actions/read.test.ts` → 2 pass / 2 fail / 1 error
- GREEN/REFACTOR: `bun test tests/rest/routes.test.ts tests/actions/read.test.ts tests/actions/typing-ack.test.ts` → 11 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

## T007 (batch 2/3)

# TDD Evidence — T007 (selectGuild sin GET de historial · B6)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T007 | tests/actions/read.test.ts | 1 fail (j/k entre guilds hacía 2 GETs) | 5 pass / 0 fail | `selectGuild` solo abre el primer canal en la selección inicial; con guild ya seleccionado despacha `ui/selectChannel` al primer canal openable sin pedir historial. |

Comandos:
- RED: `bun test tests/actions/read.test.ts` → 4 pass / 1 fail
- GREEN/REFACTOR: mismo comando → 5 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

## T008 (batch 3/3)

# TDD Evidence — T008 (voice/moved sigue a Discord · B4)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T008 | tests/actions/voice.test.ts | 16 pass / 1 fail (move no llamaba `session.join`) | 19 pass / 0 fail | `voice/moved` ahora lleva `guildId`+`channelId`; el subscriber detecta el move con `findSelfState` y encola `moveVoice` (stop media → leave → `voice/moved` → join con flags actuales). Triangulación: 2º caso con mute y 3º caso de reducer. |
| T008 | tests/voice/session-e2e.test.ts | regression (ya pasaba) | 10 pass / 0 fail | Agregué e2e "joining another channel tears down..." para cubrir el leave+join del move a nivel de sesión real. |

Comandos:
- RED: `bun test tests/actions/voice.test.ts` → 16 pass / 1 fail
- GREEN/REFACTOR: `bun test tests/actions/voice.test.ts tests/voice/session-e2e.test.ts` → 29 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio (ajusté 2 dispatches de `voice/moved` en tests/golive y tests/watch al nuevo `guildId`)

## T009 (batch 3/3)

# TDD Evidence — T009 (Rotación de log y gate de dispatch · B9)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T009 | tests/log/logger.test.ts | 2 pass / 1 fail (ENOENT `.1` no existe) | 4 pass / 0 fail | `createLogger` acepta `maxBytes` (default 10 MB) y rota a `${file}.1` antes de escribir; trackea `bytes` y usa `fstatSync` al abrir. Triangulación: archivo ya oversized rota en el primer write. |
| T009 | tests/gateway/connection.test.ts | 9 pass / 1 fail (`gateway.dispatch` logueado siempre) | 11 pass / 0 fail | `gateway.dispatch` solo se loguea con `DISCORD_TUI_DEBUG=1/true`; sin la env no hay writeSync por dispatch. |

Comandos:
- RED: `bun test tests/log/logger.test.ts tests/gateway/connection.test.ts` → 11 pass / 2 fail
- GREEN/REFACTOR: mismo comando → 14 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

## T010 (batch 3/3)

# TDD Evidence — T010 (Volumen 0, ready.shape y Content-Length · B11, B13, B17)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T010 | tests/settings/settings.test.ts | 25 pass / 1 fail (volumen 0 y negativo dropeados) | 28 pass / 0 fail | `parseVolumes` ya no descarta el 0; clampa negativos a 0 y los conserva. Triangulación: 0 sobrevive save/load. |
| T010 | tests/images/cdn.test.ts | 7 pass / 2 fail (ignora Content-Length y no streamea) | 9 pass / 0 fail | `createImageCache` mira `content-length` antes de leer y streamea con tope `maxImageBytes` (default 8 MB) cancelando al pasarse. |
| T010 | tests/app/runtime.test.ts | 6 pass / 1 fail (`ready.shape` siempre logueado) | 8 pass / 0 fail | `ready.shape` solo con `DISCORD_TUI_DEBUG=1/true`. |

Comandos:
- RED: `bun test tests/settings/settings.test.ts tests/images/cdn.test.ts tests/app/runtime.test.ts` → 26 pass / 4 fail
- GREEN/REFACTOR: mismo comando → 31 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

## T011 (batch 3/3)

# TDD Evidence — T011 (Retry, throttle, título de grupo y teclas vim · B14, B16, B19, B20)

| task | test file | RED result | GREEN result | notes |
|------|-----------|------------|--------------|-------|
| T011 | tests/actions/outbox.test.ts | 9 pass / 1 fail (retry subía 2 veces) | 11 pass / 0 fail | `createSendActions` cachea los slots subidos por nonce y los reusa en `retry`; borra el cache al enviar. Triangulación: envíos distintos suben cada uno lo suyo. |
| T011 | tests/gateway/connection.test.ts | 13 pass / 1 fail (payload throttleado salía por socket nuevo) | 14 pass / 0 fail | `send` captura el socket y el timer del throttle descarta el payload si el socket cambió. |
| T011 | tests/notify/notify.test.ts | 7 pass / 1 fail (grupo titulado "(DM)") | 8 pass / 0 fail | `notificationTitle` usa `channel.name` para grupos (type 3) y mantiene "(DM)" para type 1. |
| T011 | tests/ui/app.test.tsx | 8 pass / 1 fail (`l` en mensajes no hacía nada) | 9 pass / 0 fail | En foco mensajes, `l`/`right` entra al composer; `Esc` solo salta al fondo en mensajes (en guilds/canales solo limpia el hint). |

Comandos:
- RED: `bun test tests/actions/outbox.test.ts tests/gateway/connection.test.ts tests/notify/notify.test.ts tests/ui/app.test.tsx` → 35 pass / 4 fail
- GREEN/REFACTOR: mismo comando → 40 pass / 0 fail
- Typecheck: `bun run typecheck` → limpio

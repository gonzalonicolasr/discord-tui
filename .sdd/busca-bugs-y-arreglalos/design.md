# Design — busca bugs y arreglalos

## Code roots
- `/home/gonza/projects/discord-tui/src` — app source (Bun + TypeScript + Solid/OpenTUI)
- `/home/gonza/projects/discord-tui/tests` — Bun test suite (124 files, 782 tests)
- `/home/gonza/projects/discord-tui/fixtures` — redacted synthetic gateway/browser payloads
- `/home/gonza/projects/discord-tui/docs` — includes the prior bug audit `docs/AUDITORIA-2026-11-08.md`

## Enfoque

Los fixes van en `src/`, con tests primero en `tests/` y fixtures redactados en `fixtures/`. El store sigue siendo un reducer puro (`src/store/reduce.ts` → `src/store/reducers/*.ts`); los efectos viven en `src/actions/*.ts` y en `src/app/runtime.ts`. Se mantiene la inyección de deps para poder testear con fakes (`tests/fakes/*`).

Orden de implementación (cada paso = tests + `bun run typecheck` + commit + push):

1. **Protocolo** (`ready.ts`): `entriesOf()` genérico que desenvuelve `{entries}` y cae a `asList`; se usa en `read_state`, `user_guild_settings` y `channel_overrides`. `merged_members` se mezcla en `applyReady`. Fixture nuevo `fixtures/gateway/READY-versioned-1.json` y entrada en `tests/fixtures/fixtures-contract.test.ts`.
2. **HTTP** (`rest/http.ts`, `rest/client.ts`): `signal: AbortSignal.timeout(30_000)`, mapeo de `TimeoutError`/`AbortError` a `NetworkError`, `global` desde body/header/scope, y delete de colas por identidad.
3. **Auth** (`main.tsx`): extraer un componente de sesión (p. ej. `src/app/root.tsx`) que siempre registra `onUnauthorized` y vuelve a `LoginScreen`; `main()` lo usa en `main`/`offline` y el camino de login sigue igual.
4. **Ciclo de vida** (`settings/persist.ts`, `app/runtime.ts`, `notify/notify.ts`, `log/logger.ts`): `flush()` en persistencia, await en `stop()`, try/catch en `notify`, campos allowlisted nuevos.
5. **Leído** (`store/reduce.ts`, `store/reducers/read-state.ts`): automatización en MESSAGE_CREATE.
6. **Ack** (`rest/routes.ts`, `actions/ack.ts`, `actions/index.ts`): token por canal + `last_viewed` por época.
7. **Navegación** (`actions/index.ts`): `selectGuild` solo abre historial en la selección inicial.
8. **Voz** (`actions/voice.ts`, `store/reducers/voice.ts`): `voice/moved` con `guildId` y `session.join` serializado.
9. **Log** (`log/logger.ts`, `gateway/connection.ts`): gate de dispatch por env + rotación por tamaño.
10. **Limpieza A** (`settings/settings.ts`, `app/runtime.ts`, `images/cache.ts`).
11. **Limpieza B** (`actions/send.ts`, `gateway/connection.ts`, `notify/notify.ts`, `ui/App.tsx`).

## Archivos a tocar

### Producción
- `/home/gonza/projects/discord-tui/src/store/reducers/ready.ts`
- `/home/gonza/projects/discord-tui/src/rest/http.ts`
- `/home/gonza/projects/discord-tui/src/rest/client.ts`
- `/home/gonza/projects/discord-tui/src/main.tsx`
- `/home/gonza/projects/discord-tui/src/app/root.tsx` (new)
- `/home/gonza/projects/discord-tui/src/settings/persist.ts`
- `/home/gonza/projects/discord-tui/src/app/runtime.ts`
- `/home/gonza/projects/discord-tui/src/notify/notify.ts`
- `/home/gonza/projects/discord-tui/src/log/logger.ts`
- `/home/gonza/projects/discord-tui/src/store/reduce.ts`
- `/home/gonza/projects/discord-tui/src/store/reducers/read-state.ts`
- `/home/gonza/projects/discord-tui/src/rest/routes.ts`
- `/home/gonza/projects/discord-tui/src/actions/ack.ts`
- `/home/gonza/projects/discord-tui/src/actions/index.ts`
- `/home/gonza/projects/discord-tui/src/actions/voice.ts`
- `/home/gonza/projects/discord-tui/src/store/reducers/voice.ts`
- `/home/gonza/projects/discord-tui/src/gateway/connection.ts`
- `/home/gonza/projects/discord-tui/src/settings/settings.ts`
- `/home/gonza/projects/discord-tui/src/images/cache.ts`
- `/home/gonza/projects/discord-tui/src/actions/send.ts`
- `/home/gonza/projects/discord-tui/src/ui/App.tsx`

### Tests
- `/home/gonza/projects/discord-tui/tests/store/ready.test.ts`
- `/home/gonza/projects/discord-tui/tests/fixtures/fixtures-contract.test.ts`
- `/home/gonza/projects/discord-tui/tests/rest/http.test.ts`
- `/home/gonza/projects/discord-tui/tests/rest/client.test.ts`
- `/home/gonza/projects/discord-tui/tests/app/root.test.tsx` (new)
- `/home/gonza/projects/discord-tui/tests/app/boot.test.ts`
- `/home/gonza/projects/discord-tui/tests/settings/settings.test.ts`
- `/home/gonza/projects/discord-tui/tests/notify/notify.test.ts`
- `/home/gonza/projects/discord-tui/tests/store/messages.test.ts`
- `/home/gonza/projects/discord-tui/tests/store/unread.test.ts`
- `/home/gonza/projects/discord-tui/tests/rest/routes.test.ts` (new)
- `/home/gonza/projects/discord-tui/tests/actions/read.test.ts`
- `/home/gonza/projects/discord-tui/tests/actions/voice.test.ts`
- `/home/gonza/projects/discord-tui/tests/voice/session-e2e.test.ts`
- `/home/gonza/projects/discord-tui/tests/log/logger.test.ts`
- `/home/gonza/projects/discord-tui/tests/gateway/connection.test.ts`
- `/home/gonza/projects/discord-tui/tests/images/cdn.test.ts`
- `/home/gonza/projects/discord-tui/tests/app/runtime.test.ts`
- `/home/gonza/projects/discord-tui/tests/actions/outbox.test.ts`
- `/home/gonza/projects/discord-tui/tests/ui/app.test.tsx`

### Fixtures
- `/home/gonza/projects/discord-tui/fixtures/gateway/READY-versioned-1.json` (new)

## Comandos

- Por tarea: el `evidence` exacto de `tasks.md`.
- Suite completa al final de cada tarea: `bun test`.
- Tipos: `bun run typecheck`.

## Decisiones y riesgos

- **B22**: el fixture array-shaped actual no reproduce el bug a propósito; se agrega un segundo fixture versionado para cubrir las dos formas, sin "arreglar" el array.
- **B5**: 30 s es el compromiso entre colgarse y matar uploads/historias lentas; los uploads usan otro path (`src/uploads/upload.ts`) y no cambian.
- **B21**: el token y la época se implementan acá; validar contra la cuenta real queda como 🧍 Paso de Gon.
- **B9**: la rotación debe mantener `tests/scripts/leak-check.test.ts` y `tests/security/no-token-leak.test.ts` verdes.
- **B1**: se prefiere un componente raíz único antes que duplicar el handler en `main()`.

# Tasks — busca bugs y arreglalos

- [x] T001 — Protocolo versionado READY (B22, B3) [P]
  - files: `/home/gonza/projects/discord-tui/src/store/reducers/ready.ts`, `/home/gonza/projects/discord-tui/tests/store/ready.test.ts`, `/home/gonza/projects/discord-tui/fixtures/gateway/READY-versioned-1.json` (new), `/home/gonza/projects/discord-tui/tests/fixtures/fixtures-contract.test.ts`
  - depends: []
  - evidence: `bun test tests/store/ready.test.ts tests/fixtures/fixtures-contract.test.ts` passes
  - review: ~200 changed lines

- [x] T002 — Timeout y rate-limit HTTP (B5, B2, B15) [P]
  - files: `/home/gonza/projects/discord-tui/src/rest/http.ts`, `/home/gonza/projects/discord-tui/src/rest/client.ts`, `/home/gonza/projects/discord-tui/tests/rest/http.test.ts`, `/home/gonza/projects/discord-tui/tests/rest/client.test.ts`
  - depends: []
  - evidence: `bun test tests/rest/http.test.ts tests/rest/client.test.ts` passes
  - review: ~170 changed lines

- [x] T003 — onUnauthorized en sesión guardada (B1) [P]
  - files: `/home/gonza/projects/discord-tui/src/main.tsx`, `/home/gonza/projects/discord-tui/src/app/root.tsx` (new), `/home/gonza/projects/discord-tui/tests/app/root.test.tsx` (new), `/home/gonza/projects/discord-tui/tests/app/boot.test.ts`
  - depends: []
  - evidence: `bun test tests/app/root.test.tsx tests/app/boot.test.ts` passes
  - review: ~150 changed lines

- [x] T004 — Flush de settings y guarda de notify (B10, B12)
  - files: `/home/gonza/projects/discord-tui/src/settings/persist.ts`, `/home/gonza/projects/discord-tui/src/app/runtime.ts`, `/home/gonza/projects/discord-tui/src/notify/notify.ts`, `/home/gonza/projects/discord-tui/src/log/logger.ts`, `/home/gonza/projects/discord-tui/tests/settings/settings.test.ts`, `/home/gonza/projects/discord-tui/tests/notify/notify.test.ts`
  - depends: []
  - evidence: `bun test tests/settings/settings.test.ts tests/notify/notify.test.ts` passes
  - review: ~130 changed lines

- [x] T005 — Automatizaciones de read-state (B8)
  - files: `/home/gonza/projects/discord-tui/src/store/reduce.ts`, `/home/gonza/projects/discord-tui/src/store/reducers/read-state.ts`, `/home/gonza/projects/discord-tui/tests/store/messages.test.ts`, `/home/gonza/projects/discord-tui/tests/store/unread.test.ts`
  - depends: []
  - evidence: `bun test tests/store/messages.test.ts tests/store/unread.test.ts` passes
  - review: ~120 changed lines

- [x] T006 — Ack token y last_viewed (B21)
  - files: `/home/gonza/projects/discord-tui/src/rest/routes.ts`, `/home/gonza/projects/discord-tui/src/actions/ack.ts`, `/home/gonza/projects/discord-tui/src/actions/index.ts`, `/home/gonza/projects/discord-tui/tests/rest/routes.test.ts` (new), `/home/gonza/projects/discord-tui/tests/actions/read.test.ts`
  - depends: []
  - evidence: `bun test tests/rest/routes.test.ts tests/actions/read.test.ts` passes
  - review: ~150 changed lines

- [x] T007 — selectGuild sin GET de historial (B6)
  - files: `/home/gonza/projects/discord-tui/src/actions/index.ts`, `/home/gonza/projects/discord-tui/tests/actions/read.test.ts`
  - depends: [T006]
  - evidence: `bun test tests/actions/read.test.ts` passes
  - review: ~90 changed lines

- [x] T008 — voice/moved sigue a Discord (B4)
  - files: `/home/gonza/projects/discord-tui/src/actions/voice.ts`, `/home/gonza/projects/discord-tui/src/store/reducers/voice.ts`, `/home/gonza/projects/discord-tui/tests/actions/voice.test.ts`, `/home/gonza/projects/discord-tui/tests/voice/session-e2e.test.ts`
  - depends: []
  - evidence: `bun test tests/actions/voice.test.ts tests/voice/session-e2e.test.ts` passes
  - review: ~170 changed lines

- [x] T009 — Rotación de log y gate de dispatch (B9)
  - files: `/home/gonza/projects/discord-tui/src/log/logger.ts`, `/home/gonza/projects/discord-tui/src/gateway/connection.ts`, `/home/gonza/projects/discord-tui/tests/log/logger.test.ts`, `/home/gonza/projects/discord-tui/tests/gateway/connection.test.ts`
  - depends: [T004]
  - evidence: `bun test tests/log/logger.test.ts tests/gateway/connection.test.ts` passes
  - review: ~150 changed lines

- [x] T010 — Volumen 0, ready.shape y Content-Length (B11, B13, B17)
  - files: `/home/gonza/projects/discord-tui/src/settings/settings.ts`, `/home/gonza/projects/discord-tui/src/app/runtime.ts`, `/home/gonza/projects/discord-tui/src/images/cache.ts`, `/home/gonza/projects/discord-tui/tests/settings/settings.test.ts`, `/home/gonza/projects/discord-tui/tests/images/cdn.test.ts`, `/home/gonza/projects/discord-tui/tests/app/runtime.test.ts`
  - depends: [T004]
  - evidence: `bun test tests/settings/settings.test.ts tests/images/cdn.test.ts tests/app/runtime.test.ts` passes
  - review: ~120 changed lines

- [x] T011 — Retry, throttle, título de grupo y teclas vim (B14, B16, B19, B20)
  - files: `/home/gonza/projects/discord-tui/src/actions/send.ts`, `/home/gonza/projects/discord-tui/src/gateway/connection.ts`, `/home/gonza/projects/discord-tui/src/notify/notify.ts`, `/home/gonza/projects/discord-tui/src/ui/App.tsx`, `/home/gonza/projects/discord-tui/tests/actions/outbox.test.ts`, `/home/gonza/projects/discord-tui/tests/gateway/connection.test.ts`, `/home/gonza/projects/discord-tui/tests/notify/notify.test.ts`, `/home/gonza/projects/discord-tui/tests/ui/app.test.tsx`
  - depends: [T004, T009]
  - evidence: `bun test tests/actions/outbox.test.ts tests/gateway/connection.test.ts tests/notify/notify.test.ts tests/ui/app.test.tsx` passes
  - review: ~210 changed lines

## Review Workload
- T001: ~200 changed lines
- T002: ~170 changed lines
- T003: ~150 changed lines
- T004: ~130 changed lines
- T005: ~120 changed lines
- T006: ~150 changed lines
- T007: ~90 changed lines
- T008: ~170 changed lines
- T009: ~150 changed lines
- T010: ~120 changed lines
- T011: ~210 changed lines
- **Total: ~1660 changed lines**

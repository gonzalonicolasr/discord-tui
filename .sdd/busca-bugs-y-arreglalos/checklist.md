## Analyzed artifacts
- `/home/gonza/projects/discord-tui/.sdd/busca-bugs-y-arreglalos/request.md`
- `/home/gonza/projects/discord-tui/.sdd/busca-bugs-y-arreglalos/clarifications.md`
- `/home/gonza/projects/discord-tui/.sdd/busca-bugs-y-arreglalos/proposal.md`
- `/home/gonza/projects/discord-tui/.sdd/busca-bugs-y-arreglalos/spec.md`
- `/home/gonza/projects/discord-tui/.sdd/busca-bugs-y-arreglalos/design.md`
- `/home/gonza/projects/discord-tui/.sdd/busca-bugs-y-arreglalos/tasks.md`
- `/home/gonza/projects/discord-tui/.sdd/busca-bugs-y-arreglalos/findings.md` (explore report, for cross-checking)
- Spot-checked against code: `docs/AUDITORIA-2026-11-08.md`, `src/rest/http.ts`, `src/rest/client.ts`, `src/main.tsx`, `src/settings/settings.ts`, `src/actions/index.ts`, `src/store/types.ts`, `src/store/reduce.ts`, `src/store/reducers/voice.ts`

## Checklist
- **Unresolved ambiguity / clarify assumptions hold** — PASS. Clarifications assumed a general bug hunt via tests + static analysis; explore found a green baseline (782 tests, clean typecheck) and a prior verified audit with 20 open bugs (B7/B18 confirmed fixed at `main` @ `ac13a61` and explicitly excluded). The plan adopted that audit as the de-facto spec without contradicting any clarification. Real-account verification is deferred as 🧍 Paso de Gon (B21, B22), consistent with AGENTS.md rules recorded in findings. Spot checks confirm the bugs are real: no `signal` anywhere in `src/rest/http.ts`, `onUnauthorized` registered only at `src/main.tsx:47` (login path), `volume === MIN_VOLUME` dropped at `settings.ts:100`, `selectGuild` always calls `openChannel` → history GET.
- **Acceptance criteria** — PASS. Every REQ has concrete, testable criteria (exact values like `last_viewed = (Date.now() - 1420070400000) / 86400000`, `queues.size`, `parseVolumes({"id": 0})`, fixture contract, env-var gate for `gateway.dispatch`). Two soft spots, non-blocking: B1 offers an either/or outcome (`LoginScreen` o `quit` controlado) — both are testable; B20's `l` opens the first link, feasible via existing `src/proc/open-url.ts` / `actions.openUrl` (verified present).
- **Task graph quality** — PASS with one note. Dependencies are real file-collision edges I verified: T006→T007 (`src/actions/index.ts`, `tests/actions/read.test.ts`), T004→T009 (`src/log/logger.ts`), T004→T010 (`src/app/runtime.ts`, `tests/settings/settings.test.ts`), T004+T009→T011 (`notify.ts`, `connection.ts`, `tests/notify`, `tests/gateway/connection.test.ts`). No invented prerequisites; `[P]` markers only on T001–T003 while T005/T006/T008 are also dependency-free (cosmetic). Note: T008's spec acceptance ("`voice/moved` acepta `guildId` opcional") requires editing `src/store/types.ts:289` (the action union), which is missing from both T008's `files` and design's production file list — typecheck will surface it immediately; minor.
- **Focused evidence** — PASS. All 11 `evidence:` entries are runnable `bun test <paths>` commands, no prose. I executed every baseline evidence batch: all existing files pass (ready+fixtures 22, http+client 16, boot 6, settings+notify 24, messages+unread+read 19, settings+cdn+runtime 23, outbox+connection+notify+ui 30, voice 16, log+gateway 10, voice e2e 9, leak tests 5, fixtures-contract 15) and `bun run typecheck` is clean. The two commands naming not-yet-created files (`tests/app/root.test.tsx`, `tests/rest/routes.test.ts`) resolve as paths once the tasks create them; TDD order makes that natural. Full `bun test` + typecheck per step is mandated in design, so the omission from `evidence:` is cosmetic.
- **TDD suitability** — PASS. Each task maps to a failing-test-first cycle: versioned READY fixture + `entriesOf()` tests, fake `fetch` for timeout/429-header, `root.test.tsx` for the unauthorized handler, `flush()`/spawn-throw tests, MESSAGE_CREATE dispatch assertions, ack token round-trip, `selectGuild` GET counting, voice-move join spies, env-gated dispatch log, and four independent cleanup assertions. One friction risk noted (not blocking): B2's criterion "con timer stub" — `bun:test` exposes `useFakeTimers`/`advanceTimersByTime` (verified present in Bun 1.4.3) but it may not drive `AbortSignal.timeout`; the task may need a small injectable timeout/signal dep in `HttpDeps`, which is within T002's ~170-line budget.
- **Scope boundaries** — PASS. Only the 20 open audit bugs; B7/B18 excluded; no dependency/version changes; no real-account verification; no new features. ~1660 changed lines total across 11 tasks.
- **Review workload** — PASS. Per-task estimates 90–210 changed lines, all under ~400; grouping is by file/responsibility so shared-file collisions are handled by the dependency edges above.

## Blockers
None.

## Decision
Decision: continue

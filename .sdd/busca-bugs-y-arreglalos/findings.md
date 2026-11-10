All verification done. Here is the findings report.

## Code roots
- `/home/gonza/projects/discord-tui/src` — app source (Bun + TypeScript + Solid/OpenTUI)
- `/home/gonza/projects/discord-tui/tests` — Bun test suite (124 files, 782 tests)
- `/home/gonza/projects/discord-tui/fixtures` — redacted synthetic gateway/browser payloads
- `/home/gonza/projects/discord-tui/docs` — includes the prior bug audit `docs/AUDITORIA-2026-11-08.md`

## Baseline (measured this run)
- `bun run typecheck` → **clean** (no output).
- `bun test` → **782 pass / 0 fail**, 4884 expect() calls, ~49 s. Tests print noisy unhandled `ErrorEvent: WebSocket connection to 'wss://127.0.0.1:<port>/?v=8' failed` from gateway/voice e2e tests (stderr pollution, not a failure).
- No TODO/FIXME/BUG markers in `src/`.
- **Conclusion: nothing is "red". The bug hunt is the audit re-verification below.** A prior agent run already produced `docs/AUDITORIA-2026-11-08.md` with 22 bugs (B1–B22); some were fixed afterwards, most are still present in `main` @ `ac13a61`. This is the de-facto spec for "busca bugs y arreglalos".

### Confirmed FIXED since the audit (do not re-fix)
- **B7** `applyPage` prunes `byId` — `src/store/reducers/messages.ts:135-136` (commit `7562555`).
- **B18** `op 3` gated on ready — `src/app/runtime.ts:98` now passes `ready: () => gateway.status === "ready"`.

## Bugs still present (verified against current code)

| # | Sev | Where | Status |
|---|-----|-------|--------|
| B22 | Alta | `src/store/reducers/ready.ts:5-15` (`asList`), `:171` (`read_state`), `:180-186` (`user_guild_settings`); `src/gateway/identify.ts:4` | **Reproduced** with a throwaway script: with `GATEWAY_CAPABILITIES = 1734653` bits 2 (`VERSIONED_READ_STATES`) and 3 (`VERSIONED_USER_GUILD_SETTINGS`) are on, so the server sends `{entries,partial,version}`. `asList` iterates the object's keys → `readState` = `{partial:{…},version:{…},entries:{…}}`, every real entry lost. Effect: `isChannelUnread` (`src/store/selectors.ts:56` `if (!read?.lastAckedId) return true`) marks **every** channel unread; `guildSettings.mutedGuilds/mutedChannels` stay empty → notifications from muted guilds. Proposed fix in audit: an `entriesOf()` helper that unwraps `value.entries` when present, falling back to `asList`. |
| B5 | Alta | `src/rest/http.ts:49-55` (fetch without `signal`) | No HTTP timeout anywhere except `src/client-props/build-number.ts:21`. A hung request permanently blocks that route's queue (`src/rest/client.ts:78-89` chains on `previous`). |
| B1 | Alta | `src/main.tsx:149-171` | `runtime.onUnauthorized(...)` is registered **only** inside `LoginRoot.finish` (line 47). On the saved-session boot path (`kind === "main"/"offline"`) it is never registered → a 401 silently kills REST, no return to login, no notice. |
| B4 | Alta | `src/actions/voice.ts:312`; `src/store/reducers/voice.ts:147-148` | `voice/moved` only patches UI `channelId`; no `session.join(guildId, newChannelId, flags)` and no `guildId` update on cross-guild moves. |
| B2 | Alta | `src/rest/http.ts:82-86` | `global` still comes only from `parsed?.global`; `x-ratelimit-global` header never read. (The `NaN` sleep the audit mentioned is partly mitigated: `Number(headers.get("retry-after") ?? "1")`.) |
| B11 | Media | `src/settings/settings.ts:90-99`, `MIN_VOLUME = 0` (line 72) | `if (volume === MIN_VOLUME && raw <= MIN_VOLUME) continue;` drops a persisted 0 % volume → per-user mute never survives restart. |
| B10 | Media | `src/settings/persist.ts:27-31` | Detach does `clearTimeout(timer)` with no flush; `runtime.stop()` (`src/app/runtime.ts:230`) drops the last <500 ms change. |
| B12 | Media | `src/notify/notify.ts:31-34`; called at `src/app/runtime.ts:167` | `spawnClean` can throw synchronously; the `try` at `runtime.ts:155-157` wraps only `store.dispatch`, so a missing `notify-send` escapes into the WebSocket callback. |
| B21 | Media | `src/rest/routes.ts:35-37` | `postAck` still hardcodes `{ token: null, last_viewed: 0 }`; no ack token stored, `last_viewed: 0` overwrites other devices' state. |
| B9 | Media | `src/gateway/connection.ts:150`; `src/log/logger.ts:71` | `log.info("gateway.dispatch", …)` on **every** gateway event + `writeSync` per line; no rotation/size cap in `logger.ts`. |
| B6 | Media | `src/actions/index.ts:246-252` | `selectGuild` always calls `openChannel(first.id)` → a history `GET` per `j`/`k`. |
| B8 | Media | `src/store/reduce.ts:47-60`; `src/store/reducers/read-state.ts` | No client-side read-state automations (mentions → `mentionCount+1`; own message → `lastAckedId=id, mentionCount=0`). Your own message leaves the channel unread. |
| B17 | Baja | `src/images/cache.ts:47-49` | `await response.arrayBuffer()` before the `MAX_IMAGE_BYTES` check. |
| B16 | Baja | `src/gateway/connection.ts:84-97` | Throttle `setTimer` callback calls `rawSend` on the *current* socket; stale payload can leak into a new session. |
| B15 | Baja | `src/rest/client.ts:36,78-89` | `queues` Map never deletes entries. |
| B14 | Baja | `src/actions/send.ts:26-33` | `deliver()` re-runs `deps.upload(...)` on `retry(nonce)` — re-uploads attachments. |
| B13 | Baja | `src/app/runtime.ts:143` | Diagnostic `ready.shape` log left in production. |
| B3 | Baja | `src/store/reducers/ready.ts:132` | `merged_members` never read (grep: zero hits in `ready.ts`) — own member/roles only arrive with `READY_SUPPLEMENTAL`. |
| B19 | Baja | `src/notify/notify.ts:11-12` (`channel?.guildId === null` → `"${author} (DM)"`), `:6-15` | Group-DM notifications titled "(DM)"; DM mutes rely on `user_guild_settings` (which B22 currently loses anyway). |
| B20 | Baja | `src/ui/App.tsx:1093-1096` (`case "l"` handles only `channels`/`guilds`), `:1059-1063` (`escape` → `toBottom()` regardless of focus) | Minor vim-keyboard inconsistencies. |

**Highest user-visible impact: B22** (it *is* the "todos los canales con puntito" symptom, and it also breaks mutes), then **B5**, **B1**, **B2**, **B4**.

## Relevant files and patterns
- Store is a plain reducer: `src/store/reduce.ts` dispatches on `{type:"gw", t, d}`; each event has an `applyX` in `src/store/reducers/*.ts`. Immutable, no framework. Reducers are unit-tested against `emptyState()` from `src/store/store.ts` plus `fixtures/gateway/*.json`.
- Side effects live in `src/actions/*.ts` (store-subscriber driven, e.g. `src/actions/voice.ts:295-313`) and in `src/app/runtime.ts` (single wiring point, deps injectable: `WebSocketImpl`, `setTimer`, `notify`, `voiceSession`, …). Tests use `tests/fakes/{fake-gateway,fake-http,fake-voice-server,fake-stream-server,fake-remote-auth}.ts`.
- Errors are typed in `src/rest/errors.ts` (`HttpError`, `RateLimitedError`, `UnauthorizedError`, `NetworkError`, `InvalidResponseError`, `CaptchaRequiredError`); `RateLimitedError` already carries a `global` field and a `scope` — a fix for B2 is a one-expression change.
- Logging is allowlisted + token-redacting (`src/log/logger.ts`, `src/security/*`); there is a dedicated `tests/security/no-token-leak.test.ts` — any new log field must be added to `ALLOWED_FIELDS` or it prints `[dropped]`.
- Settings shape/persistence: `src/settings/settings.ts` (parse + clamp helpers) → `src/settings/persist.ts` (debounced store subscriber).

## Test runner and commands
- `bun test` (all), `bun test tests/store/ready.test.ts` (one file), `bun test -t "read state"` (by name). Preloads from `bunfig.toml`: `@opentui/solid/preload` + `./tests/setup-env.ts` (which isolates `XDG_STATE_HOME` into a tmp dir — keep it that way).
- `bun run typecheck` (`tsc --noEmit`) must stay clean after fixes.
- `bun run dev` / `bun run demo` are manual; **any check against the real account is a 🧍 Paso de Gon** — do not do it.

## Constraints and project rules (`AGENTS.md` — overrides everything else)
1. Never read/print/copy the Discord token or `~/.config/discord-tui/session.json`; never run `bun scripts/leak-check.ts` or any command touching that folder.
2. Never look at raw authenticated payloads — work only with `fixtures/`.
3. Real-account verification = 🧍 Paso de Gon: stop and wait for his result.
4. After each task: `bun test`, `bun run typecheck`, commit, `git push origin main`.
5. Exact dependency versions (`bun add --exact`); no dependency upgrades.
6. In tests, fake tokens come from `tests/helpers/fake-token.ts` (`fakeToken()`), never a token-shaped literal.
7. AGENTS.md rule 4 pushes to `main`; git status is clean except untracked `.sdd/`.
- Repo language: comments/docs/user-facing strings are in **Rioplatense Spanish**; match it.
- Naming: package is `zcord` (v0.2.0, private), Bun >= 1.3.14, ESM (`"type": "module"`), TSX via OpenTUI Solid.

## Risks and unknowns
- **Fixing B22 changes user-visible behaviour in one shot** (unread badges + mutes). The real payload shape must be confirmed against `docs/protocol-notes.md` / discord.food; `fixtures/gateway/READY-1.json` is **synthetic and array-shaped** (`read_state` is a list, `merged_members: []`), so it will not reproduce the bug and must not be "fixed" to look versioned-only — better to add a *second* versioned fixture/test so both shapes are covered.
- B5 timeout: a too-short timeout kills slow uploads/older-history pages; uploads use a different `fetch` path (`src/uploads/upload.ts`). Choose ~30 s and map `TimeoutError`/`AbortError` → `NetworkError` so the route queue continues.
- B1 requires deciding where the runtime is created: extracting a single root component that always registers `onUnauthorized` is cleaner than duplicating the handler in `main()`'s session path.
- B4 needs a serialized `session.join` (the file already has a `queue = next.catch(...)` serial helper at `src/actions/voice.ts:341`) plus a decision for the `status === "joining"` race.
- B21 (ack tokens / `last_viewed`) touches protocol we can only validate against the real account → risky; propose the token plumbing + the epoch math (`Date.now() - 1420070400000` / 86400000) but flag the verification as a Gon step.
- B9: dropping per-dispatch logs may break any test or script that greps the log (`tests/scripts/leak-check.test.ts`, `scripts/leak-check.ts` scans the whole file); rotation must keep `leak-check` valid.
- The `docs/AUDITORIA` list was produced statically and never run against the account; severity rankings are informed guesses.
- Unexplained test stderr (WebSocket ErrorEvents from `wss://127.0.0.1:<random>`): looks like a missing/late `ws.onerror` in `src/voice/session.ts:97` / gateway e2e fakes. Cosmetic but hides real signal — worth a small follow-up, not a product bug.

## Concrete next seams for the plan phase
Recommended batching, cheapest-highest-impact first (each batch = tests + typecheck + commit):

1. **Batch A — protocol correctness (B22 + B3)**: add `entriesOf()` in `src/store/reducers/ready.ts` (handles `{entries,partial,version}` arrays and legacy arrays/maps); use it for `read_state`, `user_guild_settings`, `channel_overrides`, and apply `d.merged_members` alongside `rawGuild.members`; new test in `tests/store/ready.test.ts` with a versioned READY (array `read_state` test stays green via the fallback); plus a `versioned: true` fixture variant under `fixtures/gateway/` if the contract test in `tests/fixtures/fixtures-contract.test.ts` allows.
2. **Batch B — HTTP resilience (B5 + B2 + B15)**: `signal: AbortSignal.timeout(30_000)` in `src/rest/http.ts` + `TimeoutError → NetworkError`; `global = parsed?.global === true || headers.get("x-ratelimit-global") === "true" || scope === "global"`; delete finished queue entries in `src/rest/client.ts` by identity check. Tests: `tests/rest/http.test.ts`, `tests/rest/client.test.ts` (fake `fetch` returning a header-only 429; fake fetch that never resolves with a stubbed timer).
3. **Batch C — auth + lifecycle (B1 + B10 + B12)**: hoist runtime creation so `onUnauthorized` is registered on both boot paths in `src/main.tsx`; add `flush()` to `attachSettingsPersistence` and await it in `runtime.stop()`; wrap the `notify-send` spawn in try/catch + `log.warn` (add `notify.failed` fields to `ALLOWED_FIELDS`). Tests: `tests/app/boot.test.ts`, `tests/settings/settings.test.ts`, `tests/notify/notify.test.ts`.
4. **Batch D — read-state semantics (B8 + B21 + B6)**: MESSAGE_CREATE automations in `src/store/reduce.ts`/`read-state.ts`; `postAck` returns and stores the ack token and computes `last_viewed`; stop fetching history in `selectGuild`. Tests: `tests/store/messages.test.ts`, `tests/actions/read.test.ts`, `tests/ui/unread-ui.test.tsx`.
5. **Batch E — voice move (B4)**: serialize a `session.join(guildId, mine.channelId, currentFlags)` in the `src/actions/voice.ts` subscriber, queue when `status === "joining"`, update `guildId` on cross-guild moves. Tests: `tests/actions/voice.test.ts`, `tests/voice/session-e2e.test.ts` with `tests/fakes/fake-voice-server.ts` (4014 path).
6. **Batch F — small/cleanup (B9, B11, B13, B14, B16, B17, B19, B20)**: gate the per-dispatch log behind an env var and add size-based rotation in `logger.ts`; let `parseVolumes` keep 0; delete the `ready.shape` log; cache uploaded attachment slots on `OutboxItem`; capture `const ws = socket` in the throttle timer (or flush pending on close); check `Content-Length` before `arrayBuffer()`; group-DM notification title; `l` in messages focus and `Esc` scoped to messages.

Unknowns to settle before planning: the real versioned READY shape (ask Gon / `docs/protocol-notes.md`), whether `notification_settings` / `guild_join_requests` also arrive versioned, and the intended ack-token lifetime (per channel vs per account).

---
**Phase outcome:** explore complete — read-only; no files modified. Findings above are for `findings.md` (baseline green; 20 of 22 audited bugs still open, B7/B18 already fixed; B22 reproduced live). No `.sdd/busca-bugs-y-arreglalos/` artifacts written besides this report.

import { expect, test } from "bun:test";

import { autoReloadBlockers, createAutoReloader, AUTO_RELOAD_QUIET_MS } from "../../src/app/auto-reload";
import { emptyState } from "../../src/store/store";
import type { AppState } from "../../src/store/types";

const NOW = 1_000_000;
const idle = { losses: [], editing: false, lastInputAt: NOW - AUTO_RELOAD_QUIET_MS - 1, now: NOW };

function withState(patch: (state: AppState) => AppState): AppState {
  return patch(emptyState());
}

test("it is safe to reload alone only with nothing to lose, nothing in flight, no call and no recent input", () => {
  expect(autoReloadBlockers({ ...idle, state: emptyState() })).toEqual([]);
  expect(autoReloadBlockers({ ...idle, state: emptyState(), losses: ["el borrador", "1 adjunto"] })).toEqual(["el borrador", "1 adjunto"]);
  expect(autoReloadBlockers({ ...idle, state: emptyState(), editing: true })).toEqual(["la edición"]);
  const sending = withState((s) => ({ ...s, outbox: { n1: { nonce: "n1", channelId: "1", content: "hola", state: "pending" } as never } }));
  expect(autoReloadBlockers({ ...idle, state: sending })).toEqual(["un envío en curso"]);
  const sentOnly = withState((s) => ({ ...s, outbox: { n1: { nonce: "n1", channelId: "1", content: "hola", state: "sent" } as never } }));
  expect(autoReloadBlockers({ ...idle, state: sentOnly })).toEqual([]);
  const inCall = withState((s) => ({ ...s, voice: { ...s.voice, channelId: "3", status: "connected" } }));
  expect(autoReloadBlockers({ ...idle, state: inCall })).toEqual(["la llamada"]);
  const joining = withState((s) => ({ ...s, voice: { ...s.voice, status: "joining" } }));
  expect(autoReloadBlockers({ ...idle, state: joining })).toEqual(["la llamada"]);
  const watching = withState((s) => ({ ...s, voice: { ...s.voice, watch: { status: "watching", userId: "9", error: null } } }));
  expect(autoReloadBlockers({ ...idle, state: watching })).toEqual(["la transmisión que mirás"]);
  expect(autoReloadBlockers({ ...idle, state: emptyState(), lastInputAt: NOW - 3_000 })).toEqual(["lo que estás tocando"]);
});

function fakeClock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let next = 1;
  return {
    setTimer: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id as never;
    },
    clearTimer: (id: unknown) => void (timers = timers.filter((t) => t.id !== id)),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = until;
    },
    pending: () => timers.length,
  };
}

test("a burst of changes (a git pull touching many files) gives a single reload, after the burst", () => {
  const clock = fakeClock();
  let reloads = 0;
  const reloader = createAutoReloader({ blockers: () => [], reload: () => void (reloads += 1), waiting: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer, debounceMs: 2_000 });
  for (let i = 0; i < 30; i++) {
    reloader.changed();
    clock.advance(100);
  }
  expect(reloads).toBe(0);
  clock.advance(2_000);
  expect(reloads).toBe(1);
  reloader.changed(); // ya se está recargando: no hay una segunda
  clock.advance(60_000);
  expect(reloads).toBe(1);
  expect(clock.pending()).toBe(0);
});

test("when it is not safe it says why, retries every few seconds and reloads once it becomes safe", () => {
  const clock = fakeClock();
  let reloads = 0;
  let blockers = ["el borrador"];
  const waits: string[][] = [];
  const reloader = createAutoReloader({ blockers: () => blockers, reload: () => void (reloads += 1), waiting: (r) => waits.push(r), setTimer: clock.setTimer, clearTimer: clock.clearTimer, debounceMs: 2_000, retryMs: 5_000 });
  reloader.changed();
  clock.advance(2_000);
  expect(reloads).toBe(0);
  expect(waits).toEqual([["el borrador"]]);
  clock.advance(5_000);
  expect(waits).toHaveLength(2);
  blockers = ["la llamada"];
  clock.advance(5_000);
  expect(waits.at(-1)).toEqual(["la llamada"]);
  blockers = [];
  clock.advance(5_000);
  expect(reloads).toBe(1);
  expect(clock.pending()).toBe(0);
});

test("stop cancels a pending reload", () => {
  const clock = fakeClock();
  let reloads = 0;
  const reloader = createAutoReloader({ blockers: () => [], reload: () => void (reloads += 1), waiting: () => {}, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  reloader.changed();
  reloader.stop();
  clock.advance(60_000);
  expect(reloads).toBe(0);
});

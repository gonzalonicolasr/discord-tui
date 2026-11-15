import { expect, test } from "bun:test";

import { createAutoMute } from "../../src/actions/auto-mute";
import type { SystemIdleEvents, SystemIdleSource } from "../../src/desktop/wayland-idle";
import { createStore, emptyState } from "../../src/store/store";

const GUILD = "100000000000000001";
const VOICE = "100000000000000003";
const MIN = 60_000;

/**
 * Fuente falsa con reloj falso: hace lo que hace el compositor con ext-idle-notify (avisa una vez cuando pasan
 * `idleAfterMs` sin teclado/mouse en todo el sistema; la actividad reinicia la cuenta) y el bloqueo de pantalla.
 */
function fakeSource() {
  let now = 0;
  let lastInput = 0;
  let current: { ms: number; events: SystemIdleEvents; fired: boolean } | null = null;
  const starts: number[] = [];
  let stops = 0;
  const source: SystemIdleSource = (ms, events) => {
    const watch = { ms, events, fired: false };
    current = watch;
    lastInput = now;
    starts.push(ms);
    return () => {
      stops += 1;
      if (current === watch) current = null;
    };
  };
  return {
    source,
    starts,
    stops: () => stops,
    running: () => current !== null,
    advance(ms: number) {
      now += ms;
      if (current && !current.fired && now - lastInput >= current.ms) {
        current.fired = true;
        current.events.idle();
      }
    },
    /** Teclado o mouse en cualquier ventana. */
    input() {
      lastInput = now;
      if (current) current.fired = false;
    },
    lock: (locked: boolean) => current?.events.lock(locked),
  };
}

function setup(patch: Record<string, unknown> = {}) {
  const store = createStore(emptyState());
  if (Object.keys(patch).length > 0) store.dispatch({ type: "settings/set", patch: patch as never });
  const fake = fakeSource();
  const notified: Array<[string, string]> = [];
  let toggles = 0;
  const voice = {
    toggleMute() {
      toggles += 1;
      const v = store.getState().voice;
      store.dispatch({ type: "voice/flags", selfMute: !v.selfMute, selfDeaf: false, muteBeforeDeaf: v.muteBeforeDeaf });
    },
  };
  const auto = createAutoMute({ store, voice, source: fake.source, notify: (title, body) => void notified.push([title, body]) });
  const join = (opts: { muted?: boolean } = {}) => {
    store.dispatch({ type: "voice/flags", selfMute: opts.muted ?? false, selfDeaf: false, muteBeforeDeaf: false });
    store.dispatch({ type: "voice/joining", guildId: GUILD, channelId: VOICE });
    store.dispatch({ type: "voice/status", status: "connected" });
  };
  const notices = () => Object.values(store.getState().notices).map((n) => n.text);
  return { store, fake, notified, toggles: () => toggles, voice, auto, join, notices };
}

test("defaults: on, after 10 minutes without using the PC; not before", () => {
  const { store, fake, join, toggles } = setup();
  expect(store.getState().settings.autoMuteAfterMinutes).toBe(10);
  join();
  expect(fake.starts).toEqual([10 * MIN]);
  fake.advance(10 * MIN - 1);
  expect(toggles()).toBe(0);
  fake.advance(1);
  expect(toggles()).toBe(1);
  expect(store.getState().voice.selfMute).toBe(true);
});

test("idle with the mic open in a call: mutes through toggleMute, a desktop notification and a notice that stays", () => {
  const { fake, join, toggles, notified, notices, store } = setup();
  join();
  fake.advance(10 * MIN);
  expect(toggles()).toBe(1);
  expect(notified).toHaveLength(1);
  expect(notified[0]![0]).toContain("micrófono silenciado por inactividad");
  expect(notices().some((t) => t.includes("micrófono silenciado por inactividad"))).toBe(true);
  const notice = Object.values(store.getState().notices).find((n) => n.key === "voice-auto-mute");
  expect(notice?.level).toBe("error"); // las de nivel error no se borran solas: sigue ahí cuando volvés
});

test("activity anywhere keeps the mic open: only a whole idle period mutes", () => {
  const { fake, join, toggles } = setup();
  join();
  for (let i = 0; i < 30; i += 1) {
    fake.advance(9 * MIN);
    fake.input();
  }
  expect(toggles()).toBe(0);
});

test("locking the screen with the mic open mutes right away", () => {
  const { fake, join, toggles, notified, store } = setup();
  join();
  fake.lock(true);
  expect(toggles()).toBe(1);
  expect(store.getState().voice.selfMute).toBe(true);
  expect(notified[0]![0]).toContain("micrófono silenciado por inactividad");
  expect(notified[0]![1]).toContain("bloqueaste la pantalla");
});

test("it never opens the mic again: not on unlock, not on activity, not on a later idle", () => {
  const { fake, join, toggles, store } = setup();
  join();
  fake.lock(true);
  fake.lock(false);
  fake.input();
  fake.advance(20 * MIN);
  fake.lock(true);
  expect(toggles()).toBe(1);
  expect(store.getState().voice.selfMute).toBe(true);
});

test("with the mic already closed (muted or deafened) idle and lock do nothing", () => {
  const { fake, join, toggles, store, notified } = setup();
  join({ muted: true });
  fake.advance(10 * MIN);
  fake.lock(true);
  store.dispatch({ type: "voice/flags", selfMute: true, selfDeaf: true, muteBeforeDeaf: false });
  fake.lock(true);
  expect(toggles()).toBe(0);
  expect(notified).toEqual([]);
});

test("after Gon opens the mic again, a new idle period mutes again", () => {
  const { fake, join, toggles, voice } = setup();
  join();
  fake.advance(10 * MIN);
  fake.input();
  voice.toggleMute(); // Gon lo abre
  fake.advance(10 * MIN);
  expect(toggles()).toBe(3);
});

test("outside a call nothing is watched; leaving the call stops watching", () => {
  const { fake, join, store, toggles } = setup();
  expect(fake.running()).toBe(false);
  fake.advance(60 * MIN);
  join();
  expect(fake.running()).toBe(true);
  store.dispatch({ type: "voice/left" });
  expect(fake.running()).toBe(false);
  expect(toggles()).toBe(0);
});

test("moving to another channel keeps the same watch (no restart)", () => {
  const { fake, join, store } = setup();
  join();
  store.dispatch({ type: "voice/moved", guildId: GUILD, channelId: "100000000000000004" });
  expect(fake.starts).toHaveLength(1);
  expect(fake.stops()).toBe(0);
});

test("setting off (null) = today's behavior: never watches, idle or lock never mute", () => {
  const { fake, join, toggles } = setup({ autoMuteAfterMinutes: null });
  join();
  expect(fake.starts).toEqual([]);
  fake.advance(60 * MIN);
  fake.lock(true);
  expect(toggles()).toBe(0);
});

test("turning it off or changing the minutes during a call stops or restarts the watch", () => {
  const { fake, join, store } = setup();
  join();
  store.dispatch({ type: "settings/set", patch: { autoMuteAfterMinutes: 30 } });
  expect(fake.starts).toEqual([10 * MIN, 30 * MIN]);
  expect(fake.stops()).toBe(1);
  store.dispatch({ type: "settings/set", patch: { autoMuteAfterMinutes: null } });
  expect(fake.running()).toBe(false);
});

test("push-to-talk does not need it: nothing is watched while the input mode is push_to_talk", () => {
  const { fake, join, store, toggles } = setup({ inputMode: "push_to_talk" });
  join();
  expect(fake.running()).toBe(false);
  store.dispatch({ type: "settings/set", patch: { inputMode: "voice_activity" } });
  expect(fake.running()).toBe(true);
  store.dispatch({ type: "settings/set", patch: { inputMode: "push_to_talk" } });
  expect(fake.running()).toBe(false);
  expect(toggles()).toBe(0);
});

test("stop() stops the watch and ignores the store from then on", () => {
  const { fake, join, auto, store } = setup();
  join();
  auto.stop();
  expect(fake.running()).toBe(false);
  store.dispatch({ type: "voice/left" });
  join();
  expect(fake.starts).toHaveLength(1);
});

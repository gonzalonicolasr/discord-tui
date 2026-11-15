import { afterEach, expect, test } from "bun:test";

import { watchWaylandIdle, type SystemIdleEvents } from "../../src/desktop/wayland-idle";
import type { LogFields } from "../../src/log/logger";
import { startFakeWayland, type FakeWayland } from "../fakes/fake-wayland";

const HYPRLAND = [
  { iface: "wl_compositor", version: 6 },
  { iface: "wl_seat", version: 9 },
  { iface: "ext_idle_notifier_v1", version: 2 },
  { iface: "hyprland_lock_notifier_v1", version: 1 },
];

let fake: FakeWayland | null = null;
afterEach(() => {
  fake?.stop();
  fake = null;
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timeout");
    await Bun.sleep(2);
  }
}

function recorder() {
  const events: string[] = [];
  const logs: string[] = [];
  const on: SystemIdleEvents = { idle: () => void events.push("idle"), lock: (locked) => void events.push(locked ? "locked" : "unlocked") };
  const logger = {
    info: (event: string, fields?: LogFields) => void logs.push(`info ${event} ${JSON.stringify(fields ?? {})}`),
    warn: (event: string, fields?: LogFields) => void logs.push(`warn ${event} ${JSON.stringify(fields ?? {})}`),
  };
  return { events, logs, on, logger };
}

test("on Hyprland it asks for input-only idle (v2, ignores idle inhibitors) with the timeout, and for lock notifications", async () => {
  fake = startFakeWayland({ globals: HYPRLAND });
  const r = recorder();
  const stop = watchWaylandIdle(600_000, r.on, { env: { WAYLAND_DISPLAY: fake.path }, log: r.logger });
  await waitFor(() => fake!.requests.includes("get_lock_notification"));
  expect(fake.requests).toEqual([
    "get_registry",
    "sync",
    "bind wl_seat v1",
    "bind ext_idle_notifier_v1 v2",
    "get_input_idle_notification 600000",
    "bind hyprland_lock_notifier_v1 v1",
    "get_lock_notification",
  ]);
  expect(r.logs.some((l) => l.startsWith("info voice.auto-mute") && l.includes("watching"))).toBe(true);

  fake.idled();
  fake.resumed();
  fake.locked();
  fake.unlocked();
  await waitFor(() => r.events.length === 3);
  expect(r.events).toEqual(["idle", "locked", "unlocked"]);
  stop();
});

test("already locked when it connects: the lock arrives right away", async () => {
  fake = startFakeWayland({ globals: HYPRLAND, lockedAtStart: true });
  const r = recorder();
  const stop = watchWaylandIdle(60_000, r.on, { env: { WAYLAND_DISPLAY: fake.path }, log: r.logger });
  await waitFor(() => r.events.length === 1);
  expect(r.events).toEqual(["locked"]);
  stop();
});

test("a compositor with only the v1 idle notifier gets get_idle_notification, and no lock part", async () => {
  fake = startFakeWayland({ globals: [{ iface: "wl_seat", version: 5 }, { iface: "ext_idle_notifier_v1", version: 1 }] });
  const r = recorder();
  const stop = watchWaylandIdle(300_000, r.on, { env: { WAYLAND_DISPLAY: fake.path }, log: r.logger });
  await waitFor(() => fake!.requests.some((q) => q.startsWith("get_idle_notification")));
  await Bun.sleep(10);
  expect(fake.requests).toEqual(["get_registry", "sync", "bind wl_seat v1", "bind ext_idle_notifier_v1 v1", "get_idle_notification 300000"]);
  expect(r.logs.some((l) => l.startsWith("warn voice.auto-mute") && l.includes("no-lock"))).toBe(true);
  stop();
});

test("a compositor without idle or lock notifications: nothing is watched and the log says so", async () => {
  fake = startFakeWayland({ globals: [{ iface: "wl_seat", version: 9 }] });
  const r = recorder();
  watchWaylandIdle(600_000, r.on, { env: { WAYLAND_DISPLAY: fake.path }, log: r.logger });
  await waitFor(() => r.logs.some((l) => l.includes("unavailable")));
  await waitFor(() => fake!.clients() === 0);
  expect(fake.requests).toEqual(["get_registry", "sync"]);
  expect(r.events).toEqual([]);
});

test("without Wayland (no WAYLAND_DISPLAY) or with a dead socket it stays off with a warning, never throws", async () => {
  const r = recorder();
  const stop = watchWaylandIdle(600_000, r.on, { env: {}, log: r.logger });
  expect(r.logs).toEqual([`warn voice.auto-mute {"state":"unavailable","msg":"sin WAYLAND_DISPLAY"}`]);
  stop();

  const dead = recorder();
  watchWaylandIdle(600_000, dead.on, { env: { WAYLAND_DISPLAY: "/nonexistent/zcord/wayland-9" }, log: dead.logger });
  await waitFor(() => dead.logs.length > 0);
  expect(dead.logs[0]).toContain("unavailable");
  expect(dead.events).toEqual([]);
});

test("a relative WAYLAND_DISPLAY is looked up in XDG_RUNTIME_DIR", async () => {
  fake = startFakeWayland({ globals: HYPRLAND });
  const r = recorder();
  const dir = fake.path.slice(0, fake.path.lastIndexOf("/"));
  const stop = watchWaylandIdle(1_000, r.on, { env: { WAYLAND_DISPLAY: "wayland-0", XDG_RUNTIME_DIR: dir }, log: r.logger });
  await waitFor(() => fake!.requests.includes("get_input_idle_notification 1000"));
  stop();
});

test("stop() closes the connection (nothing is left behind), even before it finished connecting", async () => {
  fake = startFakeWayland({ globals: HYPRLAND });
  const r = recorder();
  const stop = watchWaylandIdle(600_000, r.on, { env: { WAYLAND_DISPLAY: fake.path }, log: r.logger });
  await waitFor(() => fake!.requests.includes("get_lock_notification"));
  expect(fake.clients()).toBe(1);
  stop();
  await waitFor(() => fake!.clients() === 0);
  fake.idled();
  await Bun.sleep(10);
  expect(r.events).toEqual([]);

  const early = watchWaylandIdle(600_000, r.on, { env: { WAYLAND_DISPLAY: fake.path }, log: r.logger });
  early();
  await Bun.sleep(30);
  expect(fake.clients()).toBe(0);
});

test("if the compositor goes away the log says so (and nothing else happens)", async () => {
  fake = startFakeWayland({ globals: HYPRLAND });
  const r = recorder();
  watchWaylandIdle(600_000, r.on, { env: { WAYLAND_DISPLAY: fake.path }, log: r.logger });
  await waitFor(() => fake!.requests.includes("get_lock_notification"));
  fake.drop();
  await waitFor(() => r.logs.some((l) => l.includes("lost")));
  expect(r.events).toEqual([]);
});

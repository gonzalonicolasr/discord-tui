import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_SETTINGS, loadSettings, normalizeSettings, saveSettings } from "../../src/settings/settings";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "discord-tui-settings-"));
  return fn(dir);
}

describe("settings", () => {
  test("missing file gives defaults", async () => {
    await withTempDir(async (dir) => {
      expect(await loadSettings({ path: join(dir, "settings.json") })).toEqual(DEFAULT_SETTINGS);
    });
  });

  test("invalid fields fall back one by one", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      await writeFile(
        path,
        JSON.stringify({ inputMode: "loud", theme: "light", userVolumes: { "1": 900, "2": 50 } }),
      );
      const settings = await loadSettings({ path });
      expect(settings).toMatchObject({
        inputMode: "voice_activity",
        theme: "light",
        userVolumes: { "2": 50 },
      });
    });
  });

  test("userVolumes keeps a 0 (muted) volume and clamps negatives to 0", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      await writeFile(path, JSON.stringify({ userVolumes: { "1": 0, "2": 50, "3": -5 } }));
      const settings = await loadSettings({ path });
      expect(settings.userVolumes).toEqual({ "1": 0, "2": 50, "3": 0 });
    });
  });

  test("a 0 user volume survives save/load", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const settings = { ...DEFAULT_SETTINGS, userVolumes: { "1": 0, "2": 100 } };
      await saveSettings(settings, { path });
      expect((await loadSettings({ path })).userVolumes).toEqual({ "1": 0, "2": 100 });
    });
  });

  test("Go Live settings: defaults to ask + 720p30, keeps valid values, drops invalid ones", () => {
    expect(normalizeSettings({})).toMatchObject({ streamMonitor: null, streamQuality: "720p30" });
    expect(normalizeSettings({}).animateImages).toBe(true);
    expect(normalizeSettings({ animateImages: false }).animateImages).toBe(false);
    expect(normalizeSettings({ animateImages: "no" }).animateImages).toBe(true);
    expect(normalizeSettings({ streamMonitor: "DP-1", streamQuality: "1080p30" })).toMatchObject({ streamMonitor: "DP-1", streamQuality: "1080p30" });
    expect(normalizeSettings({ streamMonitor: 3, streamQuality: "4k60" })).toMatchObject({ streamMonitor: null, streamQuality: "720p30" });
  });

  test("broken JSON gives defaults", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      await writeFile(path, "{no es json");
      expect(await loadSettings({ path })).toEqual(DEFAULT_SETTINGS);
    });
  });

  test("vadSensitivity is clamped to [-60, -20]", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      await writeFile(path, JSON.stringify({ vadSensitivity: -90 }));
      expect((await loadSettings({ path })).vadSensitivity).toBe(-60);
      await writeFile(path, JSON.stringify({ vadSensitivity: 10 }));
      expect((await loadSettings({ path })).vadSensitivity).toBe(-20);
    });
  });

  test("saved with mode 0600 and never contains a token-like string", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      await saveSettings(DEFAULT_SETTINGS, { path });
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
      const body = await readFile(path, "utf8");
      expect(body).not.toMatch(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{25,}/);
    });
  });

  test("save then load round-trips the values", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const settings = { ...DEFAULT_SETTINGS, theme: "light" as const, inputMode: "push_to_talk" as const };
      await saveSettings(settings, { path });
      expect(await loadSettings({ path })).toEqual(settings);
    });
  });
});

describe("settings persistence in the store", () => {
  test("settings/set updates the store immediately", async () => {
    const { createStore, emptyState } = await import("../../src/store/store");
    const store = createStore(emptyState());
    store.dispatch({ type: "settings/set", patch: { theme: "light" } });
    expect(store.getState().settings.theme).toBe("light");
  });

  test("settings/set persists after the debounce", async () => {
    const { createStore, emptyState } = await import("../../src/store/store");
    const { attachSettingsPersistence } = await import("../../src/settings/persist");
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const store = createStore(emptyState());
      attachSettingsPersistence(store, { path, debounceMs: 20 });
      store.dispatch({ type: "settings/set", patch: { theme: "light" } });
      store.dispatch({ type: "settings/set", patch: { idleAfterMinutes: null } });
      await Bun.sleep(80);
      const saved = await loadSettings({ path });
      expect(saved.theme).toBe("light");
      expect(saved.idleAfterMinutes).toBeNull();
    });
  });

  test("detaching flushes a pending save before the debounce fires", async () => {
    const { createStore, emptyState } = await import("../../src/store/store");
    const { attachSettingsPersistence } = await import("../../src/settings/persist");
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const store = createStore(emptyState());
      const detach = attachSettingsPersistence(store, { path, debounceMs: 1000 });
      store.dispatch({ type: "settings/set", patch: { theme: "light" } });
      await detach();
      const saved = await loadSettings({ path });
      expect(saved.theme).toBe("light");
    });
  });

  test("detach flush saves the latest of several rapid changes", async () => {
    const { createStore, emptyState } = await import("../../src/store/store");
    const { attachSettingsPersistence } = await import("../../src/settings/persist");
    await withTempDir(async (dir) => {
      const path = join(dir, "settings.json");
      const store = createStore(emptyState());
      const detach = attachSettingsPersistence(store, { path, debounceMs: 1000 });
      store.dispatch({ type: "settings/set", patch: { theme: "light" } });
      store.dispatch({ type: "settings/set", patch: { idleAfterMinutes: null } });
      await detach();
      const saved = await loadSettings({ path });
      expect(saved.theme).toBe("light");
      expect(saved.idleAfterMinutes).toBeNull();
    });
  });

  test("an invalid patch is normalized before it reaches the store", async () => {
    const { createStore, emptyState } = await import("../../src/store/store");
    const store = createStore(emptyState());
    store.dispatch({ type: "settings/set", patch: { vadSensitivity: -200 } });
    expect(store.getState().settings.vadSensitivity).toBe(-60);
  });

  test("status defaults to online, keeps the four valid values and drops anything else", () => {
    expect(DEFAULT_SETTINGS.status).toBe("online");
    for (const status of ["online", "idle", "dnd", "invisible"] as const) {
      expect(normalizeSettings({ status }).status).toBe(status);
    }
    for (const status of ["offline", "unknown", "DND", 3, null]) {
      expect(normalizeSettings({ status, theme: "light" })).toMatchObject({ status: "online", theme: "light" });
    }
  });
});

describe("sound settings", () => {
  test("defaults: on, volume 60, every cue on", () => {
    const s = normalizeSettings({});
    expect(s.sounds.enabled).toBe(true);
    expect(s.sounds.volume).toBe(60);
    expect(Object.values(s.sounds.events).every((v) => v === true)).toBe(true);
    expect(Object.keys(s.sounds.events)).toContain("userJoin");
  });

  test("keeps valid values, clamps volume, drops unknown cues and bad types", () => {
    const s = normalizeSettings({ sounds: { enabled: false, volume: 140.4, events: { message: false, join: "no", bogus: false } } });
    expect(s.sounds.enabled).toBe(false);
    expect(s.sounds.volume).toBe(100);
    expect(s.sounds.events.message).toBe(false);
    expect(s.sounds.events.join).toBe(true);
    expect("bogus" in s.sounds.events).toBe(false);
    expect(normalizeSettings({ sounds: { volume: -5 } }).sounds.volume).toBe(0);
    expect(normalizeSettings({ sounds: "loud" }).sounds).toEqual(DEFAULT_SETTINGS.sounds);
  });

  test("a sounds patch through the store round-trips", async () => {
    const { createStore, emptyState } = await import("../../src/store/store");
    const store = createStore(emptyState());
    const sounds = { ...DEFAULT_SETTINGS.sounds, volume: 30, events: { ...DEFAULT_SETTINGS.sounds.events, message: false } };
    store.dispatch({ type: "settings/set", patch: { sounds } });
    expect(store.getState().settings.sounds).toEqual(sounds);
  });
});

describe("mic safety settings", () => {
  test("join muted: on by default, keeps a boolean and drops anything else", () => {
    expect(DEFAULT_SETTINGS.joinMuted).toBe(true);
    expect(normalizeSettings({}).joinMuted).toBe(true);
    expect(normalizeSettings({ joinMuted: false }).joinMuted).toBe(false);
    expect(normalizeSettings({ joinMuted: "no", theme: "light" })).toMatchObject({ joinMuted: true, theme: "light" });
  });

  test("auto mute: 10 minutes by default, null turns it off, bad values fall back to 10", () => {
    expect(DEFAULT_SETTINGS.autoMuteAfterMinutes).toBe(10);
    expect(normalizeSettings({}).autoMuteAfterMinutes).toBe(10);
    expect(normalizeSettings({ autoMuteAfterMinutes: null }).autoMuteAfterMinutes).toBeNull();
    expect(normalizeSettings({ autoMuteAfterMinutes: 30 }).autoMuteAfterMinutes).toBe(30);
    expect(normalizeSettings({ autoMuteAfterMinutes: 4.6 }).autoMuteAfterMinutes).toBe(5);
    // menos de un minuto redondeaba a 0: silenciaba casi al instante
    expect(normalizeSettings({ autoMuteAfterMinutes: 0.4 }).autoMuteAfterMinutes).toBe(1);
    expect(normalizeSettings({ autoMuteAfterMinutes: 0.01 }).autoMuteAfterMinutes).toBe(1);
    for (const bad of [0, -3, "10", Number.NaN, true]) {
      expect(normalizeSettings({ autoMuteAfterMinutes: bad, theme: "light" })).toMatchObject({ autoMuteAfterMinutes: 10, theme: "light" });
    }
  });
});

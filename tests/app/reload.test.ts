import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureReloadState, restoreAfterReload, saveReloadState, takeReloadState } from "../../src/app/reload";
import { createStore, emptyState } from "../../src/store/store";

const G = "100000000000000001";
const TEXT = "100000000000000002";
const VOICE = "100000000000000003";

test("the reload state is read once, and an old or broken one is ignored", () => {
  const path = join(mkdtempSync(join(tmpdir(), "zcord-reload-")), "reload.json");
  const flags = { selfMute: false, selfDeaf: false, muteBeforeDeaf: false };
  saveReloadState({ guildId: G, channelId: TEXT, voiceChannelId: VOICE, voiceFlags: flags, at: 1_000 }, path);
  expect(takeReloadState(path, 2_000)).toEqual({ guildId: G, channelId: TEXT, voiceChannelId: VOICE, voiceFlags: flags, at: 1_000 });
  expect(takeReloadState(path, 2_000)).toBeNull(); // se borra al leerlo
  saveReloadState({ guildId: G, channelId: TEXT, voiceChannelId: null, voiceFlags: null, at: 1_000 }, path);
  expect(takeReloadState(path, 1_000 + 3 * 60_000)).toBeNull(); // viejo
  writeFileSync(path, "{roto");
  expect(takeReloadState(path)).toBeNull();
  writeFileSync(path, JSON.stringify({ guildId: "../../x", channelId: 5, voiceChannelId: null, at: Date.now() }));
  expect(takeReloadState(path)).toMatchObject({ guildId: null, channelId: null, voiceFlags: null });
  writeFileSync(path, JSON.stringify({ guildId: G, channelId: TEXT, voiceChannelId: VOICE, voiceFlags: { selfMute: "no", selfDeaf: false, muteBeforeDeaf: false }, at: Date.now() }));
  expect(takeReloadState(path)?.voiceFlags).toBeNull(); // flags rotos: como un archivo viejo, sin flags
});

test("after reloading it goes back to the channel and rejoins the call, only once the gateway is ready", async () => {
  const store = createStore(emptyState());
  store.dispatch({ type: "gw", t: "CHANNEL_CREATE", d: { id: TEXT, guild_id: G, type: 0, name: "general" } });
  store.dispatch({ type: "gw", t: "CHANNEL_CREATE", d: { id: VOICE, guild_id: G, type: 2, name: "Sala 1" } });
  const calls: string[] = [];
  const actions = {
    selectGuild: (id: string) => void calls.push(`guild:${id}`),
    openChannel: async (id: string) => void calls.push(`open:${id}`),
    voice: { toggleVoice: async (id: string) => void calls.push(`voice:${id}`) },
  };
  restoreAfterReload(store, actions, { guildId: null, channelId: TEXT, voiceChannelId: VOICE, voiceFlags: null, at: Date.now() });
  expect(calls).toEqual([]); // todavía no hay conexión
  store.dispatch({ type: "connection", status: "ready" } as never);
  expect(calls).toEqual([`open:${TEXT}`, `voice:${VOICE}`]);
  store.dispatch({ type: "connection", status: "ready" } as never);
  expect(calls).toHaveLength(2); // una sola vez
});

test("captureReloadState takes the selected guild, channel and voice channel", () => {
  const store = createStore(emptyState());
  store.dispatch({ type: "ui/selectGuild", id: "@dms" });
  store.dispatch({ type: "voice/joining", guildId: G, channelId: VOICE });
  expect(captureReloadState(store, 5)).toEqual({
    guildId: "@dms",
    channelId: null,
    voiceChannelId: VOICE,
    voiceFlags: { selfMute: false, selfDeaf: false, muteBeforeDeaf: false },
    at: 5,
  });
  store.dispatch({ type: "voice/left" });
  expect(captureReloadState(store, 5).voiceFlags).toBeNull();
});

test("the rejoin after a reload keeps the mic as it was: the saved flags go to toggleVoice", () => {
  const store = createStore(emptyState());
  store.dispatch({ type: "gw", t: "CHANNEL_CREATE", d: { id: VOICE, guild_id: G, type: 2, name: "Sala 1" } });
  const joins: unknown[] = [];
  const actions = {
    selectGuild: () => {},
    openChannel: async () => {},
    voice: { toggleVoice: async (id: string, opts?: unknown) => void joins.push([id, opts]) },
  };
  const voiceFlags = { selfMute: false, selfDeaf: false, muteBeforeDeaf: false };
  restoreAfterReload(store, actions, { guildId: null, channelId: null, voiceChannelId: VOICE, voiceFlags, at: Date.now() });
  store.dispatch({ type: "connection", status: "ready" } as never);
  expect(joins).toEqual([[VOICE, { flags: voiceFlags }]]);
});

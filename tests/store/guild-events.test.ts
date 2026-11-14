import { expect, test } from "bun:test";

import { isChannelMuted } from "../../src/store/selectors";
import { createStore, emptyState } from "../../src/store/store";
import readyVersioned from "../../fixtures/gateway/READY-versioned-1.json";

const ME = "100000000000000010";
const G = "100000000000000001";
const CH = "100000000000000002";

function ready() {
  const store = createStore(emptyState());
  store.dispatch({ type: "gw", t: "READY", d: structuredClone(readyVersioned.d) });
  return store;
}

const newGuild = (id: string) => ({
  id,
  name: "nuevo",
  icon: null,
  owner_id: "9",
  roles: [{ id, name: "@everyone", color: 0, position: 0, permissions: "1024" }],
  emojis: [],
  channels: [{ id: "600000000000000002", type: 0, name: "general", position: 0, parent_id: null, permission_overwrites: [] }],
  members: [{ user: { id: ME, username: "user1" }, roles: [], nick: null }],
  presences: [],
  threads: [],
});

test("GUILD_CREATE adds a guild you just joined, with its channels and roles", () => {
  const store = ready();
  store.dispatch({ type: "gw", t: "GUILD_CREATE", d: newGuild("600000000000000001") });
  const s = store.getState();
  expect(s.guilds["600000000000000001"]?.name).toBe("nuevo");
  expect(s.guilds["600000000000000001"]?.roles.map((r) => r.permissions)).toEqual(["1024"]);
  expect(s.guildOrder).toEqual([G, "600000000000000001"]);
  expect(s.channels["600000000000000002"]?.guildId).toBe("600000000000000001");
  expect(s.members["600000000000000001"]?.[ME]?.userId).toBe(ME);
  expect(s.guilds[G]?.name).toBe("guild1");
});

test("GUILD_CREATE for a guild already known keeps a single entry in the order", () => {
  const store = ready();
  store.dispatch({ type: "gw", t: "GUILD_CREATE", d: { ...newGuild(G), name: "otra vez" } });
  expect(store.getState().guildOrder).toEqual([G]);
  expect(store.getState().guilds[G]?.name).toBe("otra vez");
});

test("GUILD_UPDATE renames the guild and replaces its roles", () => {
  const store = ready();
  store.dispatch({
    type: "gw",
    t: "GUILD_UPDATE",
    d: { id: G, name: "renombrado", icon: "abc", owner_id: ME, roles: [{ id: G, name: "@everyone", color: 0, position: 0, permissions: "0" }] },
  });
  const guild = store.getState().guilds[G]!;
  expect(guild.name).toBe("renombrado");
  expect(guild.icon).toBe("abc");
  expect(guild.roles.map((r) => r.permissions)).toEqual(["0"]);
  expect(guild.emojis.map((e) => e.name)).toEqual(["partyparrot"]);
});

test("GUILD_DELETE removes the guild, its channels and messages, and leaves it if it was open", () => {
  const store = ready();
  store.dispatch({ type: "ui/selectGuild", id: G });
  store.dispatch({ type: "ui/selectChannel", id: CH });
  store.dispatch({ type: "messages/page", channelId: CH, messages: [{ id: "100000000000000020", channel_id: CH, content: "x", author: { id: ME, username: "user1" } } as any], mode: "latest" });
  store.dispatch({ type: "gw", t: "GUILD_DELETE", d: { id: G } });
  const s = store.getState();
  expect(s.guilds[G]).toBeUndefined();
  expect(s.guildOrder).toEqual([]);
  expect(s.channels[CH]).toBeUndefined();
  expect(s.channels["100000000000000004"]).toBeDefined();
  expect(s.messages[CH]).toBeUndefined();
  expect(s.members[G]).toBeUndefined();
  expect(s.ui.selectedGuildId).toBe("@dms");
  expect(s.ui.selectedChannelId).toBeNull();
});

test("GUILD_DELETE with unavailable: true (an outage) does not remove the guild", () => {
  const store = ready();
  store.dispatch({ type: "gw", t: "GUILD_DELETE", d: { id: G, unavailable: true } });
  expect(store.getState().guilds[G]).toBeDefined();
  expect(store.getState().guildOrder).toEqual([G]);
});

test("GUILD_MEMBER_REMOVE of yourself (you were kicked) removes the guild", () => {
  const store = ready();
  store.dispatch({ type: "gw", t: "GUILD_MEMBER_REMOVE", d: { guild_id: G, user: { id: ME, username: "user1" } } });
  expect(store.getState().guilds[G]).toBeUndefined();
  expect(store.getState().channels[CH]).toBeUndefined();
});

test("GUILD_MEMBER_REMOVE of someone else keeps the guild", () => {
  const store = ready();
  store.dispatch({ type: "gw", t: "GUILD_MEMBER_REMOVE", d: { guild_id: G, user: { id: "100000000000000011", username: "user2" } } });
  expect(store.getState().guilds[G]).toBeDefined();
});

test("GUILD_ROLE_CREATE / UPDATE / DELETE keep the guild roles in sync", () => {
  const store = ready();
  const role = { id: "700", name: "mods", color: 5, position: 1, permissions: "8" };
  store.dispatch({ type: "gw", t: "GUILD_ROLE_CREATE", d: { guild_id: G, role } });
  expect(store.getState().guilds[G]!.roles.map((r) => r.id)).toEqual([G, "700"]);
  store.dispatch({ type: "gw", t: "GUILD_ROLE_UPDATE", d: { guild_id: G, role: { ...role, permissions: "0" } } });
  expect(store.getState().guilds[G]!.roles.find((r) => r.id === "700")?.permissions).toBe("0");
  store.dispatch({ type: "gw", t: "GUILD_ROLE_DELETE", d: { guild_id: G, role_id: "700" } });
  expect(store.getState().guilds[G]!.roles.map((r) => r.id)).toEqual([G]);
});

test("USER_GUILD_SETTINGS_UPDATE unmutes and mutes the guild and its channels", () => {
  const store = ready();
  expect(isChannelMuted(store.getState(), G, CH)).toBe(true);
  store.dispatch({ type: "gw", t: "USER_GUILD_SETTINGS_UPDATE", d: { guild_id: G, muted: false, channel_overrides: [] } });
  expect(store.getState().guildSettings).toEqual({ mutedGuilds: [], mutedChannels: [] });
  store.dispatch({ type: "gw", t: "USER_GUILD_SETTINGS_UPDATE", d: { guild_id: G, muted: true, channel_overrides: [{ channel_id: CH, muted: true }] } });
  expect(store.getState().guildSettings).toEqual({ mutedGuilds: [G], mutedChannels: [CH] });
});

test("USER_GUILD_SETTINGS_UPDATE of one guild does not touch the mutes of another", () => {
  const store = ready();
  store.dispatch({ type: "gw", t: "USER_GUILD_SETTINGS_UPDATE", d: { guild_id: "999", muted: false, channel_overrides: [] } });
  expect(store.getState().guildSettings).toEqual({ mutedGuilds: [G], mutedChannels: [CH] });
});

test("a new READY replaces the mutes instead of adding to the old ones", () => {
  const store = ready();
  const d = structuredClone(readyVersioned.d) as any;
  d.user_guild_settings.entries[0].muted = false;
  d.user_guild_settings.entries[0].channel_overrides.entries = [];
  store.dispatch({ type: "gw", t: "READY", d });
  expect(store.getState().guildSettings).toEqual({ mutedGuilds: [], mutedChannels: [] });
});

test("GUILD_CREATE of a guild already known (back from an outage) merges members and presences instead of wiping them", () => {
  const store = ready();
  expect(store.getState().members[G]?.[ME]?.nick).toBe("yo");
  store.dispatch({
    type: "gw",
    t: "GUILD_CREATE",
    d: {
      ...newGuild(G),
      members: [{ user: { id: "100000000000000011", username: "user2" }, roles: [], nick: "dos" }],
      presences: [{ user: { id: "100000000000000011" }, user_id: "100000000000000011", status: "online", activities: [] }],
    },
  });
  store.dispatch({ type: "gw", t: "GUILD_CREATE", d: { ...newGuild(G), members: [], presences: [] } });
  const s = store.getState();
  expect(s.members[G]?.[ME]?.nick).toBe("yo");
  expect(s.members[G]?.["100000000000000011"]?.nick).toBe("dos");
  expect(s.presences["100000000000000011"]?.status).toBe("online");
});

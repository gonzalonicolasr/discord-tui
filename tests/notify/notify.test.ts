import { expect, test } from "bun:test";

import { cleanEnv } from "../../src/proc/spawn";
import { notify, notificationTitle, shouldNotify } from "../../src/notify/notify";
import { reduce } from "../../src/store/reduce";
import { emptyState } from "../../src/store/store";
import type { Message } from "../../src/store/types";
import { fakeToken } from "../helpers/fake-token";

test("cleanEnv keeps only the allowlist", () => {
  expect(cleanEnv({ PATH: "/bin", DISCORD_TOKEN: fakeToken(), FOO: "1", WAYLAND_DISPLAY: "w" } as never)).toEqual({
    PATH: "/bin",
    WAYLAND_DISPLAY: "w",
  });
});

function base() {
  let state = emptyState();
  state = reduce(state, { type: "connection", status: "ready" });
  return { ...state, me: { id: "me", username: "user1" } };
}

function message(state: ReturnType<typeof base>, partial: Partial<Message>): Message {
  return {
    id: partial.id ?? "m",
    channelId: partial.channelId ?? "ch",
    authorId: partial.authorId ?? "other",
    content: "hola",
    timestamp: "2026-11-06T12:00:00.000000+00:00",
    editedTimestamp: null,
    attachments: [],
    embeds: [],
    mentionIds: [],
    mentionsMe: partial.mentionsMe ?? false,
    referenced: null,
    reactions: [],
    nonce: null,
  };
}

test.each([
  ["mention in another channel", true],
  ["DM", true],
  ["reply to me", true],
  ["own message", false],
  ["muted guild", false],
  ["muted channel", false],
  ["viewing that channel", false],
  ["plain message, no mention", false],
])("shouldNotify: %s → %p", (_label, expected) => {
  const state = base();
  const viewing = _label === "viewing that channel" ? "ch" : "other-ch";
  const mutedGuild = _label === "muted guild";
  const mutedChannel = _label === "muted channel";
  const own = _label === "own message";
  const isDm = _label === "DM";
  const mention = _label === "mention in another channel" || _label === "reply to me";

  const full = {
    ...state,
    channels: {
      ch: { id: "ch", guildId: mutedGuild ? "guild" : isDm ? null : "guild", name: "canal", type: 0, position: 0, parentId: null, permissionOverwrites: [], lastMessageId: null },
    },
    guilds: { guild: { id: "guild", name: "g", icon: null, ownerId: "x", roles: [], emojis: [] } },
    guildSettings: {
      mutedGuilds: mutedGuild ? ["guild"] : [],
      mutedChannels: mutedChannel ? ["ch"] : [],
    },
  };

  expect(shouldNotify(full, message(state, { authorId: own ? "me" : "other", channelId: "ch", mentionsMe: mention }), viewing)).toBe(expected);
});

test("notificationTitle names group DMs by their group name", () => {
  const state = base();
  const full = {
    ...state,
    channels: {
      ch: { id: "ch", guildId: null, name: "los pibes", type: 3, position: 0, parentId: null, permissionOverwrites: [], lastMessageId: null },
    },
    users: { other: { id: "other", username: "pepe", globalName: null, avatar: null, bot: false } },
  };
  const msg = message(state, { channelId: "ch", authorId: "other" });
  expect(notificationTitle(full, msg)).toBe("pepe (los pibes)");
});

test("notificationTitle keeps regular DMs as (DM)", () => {
  const state = base();
  const full = {
    ...state,
    channels: {
      ch: { id: "ch", guildId: null, name: "pepe", type: 1, position: 0, parentId: null, permissionOverwrites: [], lastMessageId: null },
    },
    users: { other: { id: "other", username: "pepe", globalName: null, avatar: null, bot: false } },
  };
  const msg = message(state, { channelId: "ch", authorId: "other" });
  expect(notificationTitle(full, msg)).toBe("pepe (DM)");
});

test("notify spawns notify-send with an args array and clean env", () => {
  const calls: Array<{ cmd: string[]; opts: any }> = [];
  const spawn = ((cmd: string[], opts?: any) => {
    calls.push({ cmd, opts });
    return { stdout: null, exited: Promise.resolve(0) } as never;
  }) as never;

  notify("gon (DM)", "hola", { spawn: spawn as never });
  expect(calls[0]!.cmd).toEqual(["notify-send", "-a", "zcord", "--", "gon (DM)", "hola"]);
});

test("a title or body starting with '-' is never read as a notify-send option", () => {
  const calls: string[][] = [];
  const spawn = ((cmd: string[]) => {
    calls.push(cmd);
    return { stdout: null, exited: Promise.resolve(0) } as never;
  }) as never;

  notify("-gon (DM)", "--urgency=critical -5 grados", { spawn: spawn as never });
  const cmd = calls[0]!;
  const end = cmd.indexOf("--");
  expect(end).toBeGreaterThan(0);
  expect(cmd.slice(end + 1)).toEqual(["-gon (DM)", "--urgency=critical -5 grados"]);
});

test("notify does not throw when the spawner throws synchronously", () => {
  const spawn = (() => {
    throw new Error("notify-send missing");
  }) as never;

  expect(() => notify("gon (DM)", "hola", { spawn: spawn as never })).not.toThrow();
});

test("notify ignores a rejected child exit", () => {
  const spawn = (() => ({ stdout: null, exited: Promise.reject(new Error("boom")) })) as never;

  expect(() => notify("gon (DM)", "hola", { spawn: spawn as never })).not.toThrow();
});

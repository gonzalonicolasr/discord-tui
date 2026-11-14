import { expect, test } from "bun:test";

import { reduce } from "../../src/store/reduce";
import { emptyState } from "../../src/store/store";

const CH = "100000000000000002";

function state() {
  let s = emptyState();
  s = reduce(s, { type: "connection", status: "ready" });
  s = { ...s, me: { id: "100000000000000010", username: "user1" } };
  s = reduce(s, {
    type: "gw",
    t: "MESSAGE_CREATE",
    d: { id: "100000000000000100", channel_id: CH, author: { id: "1" }, content: "x", reactions: [] },
  });
  return s;
}

test("reaction add/remove update count and me", () => {
  let s = state();
  s = reduce(s, {
    type: "gw",
    t: "MESSAGE_REACTION_ADD",
    d: { user_id: "100000000000000010", channel_id: CH, message_id: "100000000000000100", emoji: { id: null, name: "👍" } },
  });
  expect(s.messages[CH]!.byId["100000000000000100"]!.reactions).toMatchObject([
    { emoji: { id: null, name: "👍" }, count: 1, me: true },
  ]);

  s = reduce(s, {
    type: "gw",
    t: "MESSAGE_REACTION_REMOVE",
    d: { user_id: "100000000000000010", channel_id: CH, message_id: "100000000000000100", emoji: { id: null, name: "👍" } },
  });
  expect(s.messages[CH]!.byId["100000000000000100"]!.reactions).toEqual([]);

  s = reduce(s, {
    type: "gw",
    t: "MESSAGE_REACTION_REMOVE_ALL",
    d: { channel_id: CH, message_id: "100000000000000100" },
  });
  expect(s.messages[CH]!.byId["100000000000000100"]!.reactions).toMatchObject([]);
});

test("removing the last reaction of an emoji drops its chip; removing one of two keeps it", () => {
  let s = state();
  const ev = (t: string, userId: string) => ({
    type: "gw" as const,
    t,
    d: { user_id: userId, channel_id: CH, message_id: "100000000000000100", emoji: { id: null, name: "👍" } },
  });
  s = reduce(s, ev("MESSAGE_REACTION_ADD", "7"));
  s = reduce(s, ev("MESSAGE_REACTION_ADD", "8"));
  s = reduce(s, ev("MESSAGE_REACTION_REMOVE", "7"));
  expect(s.messages[CH]!.byId["100000000000000100"]!.reactions).toMatchObject([{ emoji: { name: "👍" }, count: 1 }]);
  s = reduce(s, ev("MESSAGE_REACTION_REMOVE", "8"));
  expect(s.messages[CH]!.byId["100000000000000100"]!.reactions).toEqual([]);
});

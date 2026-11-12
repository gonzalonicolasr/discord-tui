import { expect, test } from "bun:test";

import { createActions } from "../../src/actions";
import { buildDemoStore, DEMO } from "../../scripts/demo-state";

const MSG = "930000000000099999"; // no está cargado en la demo

test("mentionsInbox maps Discord's mentions to 'Server › #channel', author and text; jumpToMessage loads around it", async () => {
  const paths: string[] = [];
  const message = { id: MSG, channel_id: DEMO.general, guild_id: DEMO.guild, author: { id: "7", username: "ramiro", global_name: "Ramiro" }, content: "che mirá", timestamp: "2026-11-12T10:00:00.000Z" };
  const rest = {
    closed: false,
    request: async <T,>(method: string, path: string): Promise<T> => {
      paths.push(`${method} ${path}`);
      if (path.startsWith("/users/@me/mentions")) return [message] as T;
      if (path.includes("around=")) return [message] as T;
      return [] as T;
    },
  };
  const store = buildDemoStore();
  const actions = createActions({ store, rest: rest as never, gateway: { send() {} } as never });
  const items = await actions.mentionsInbox!();
  expect(items).toEqual([expect.objectContaining({ messageId: MSG, channelId: DEMO.general, where: "Los Andes › #💬-general", author: "Ramiro" })]);
  expect(paths[0]).toBe("GET /users/@me/mentions?limit=25&roles=true&everyone=true");
  await actions.jumpToMessage!(DEMO.general, MSG);
  expect(store.getState().ui.selectedChannelId).toBe(DEMO.general);
  expect(store.getState().messages[DEMO.general]?.byId[MSG]).toBeDefined();
  expect(paths.some((p) => p.startsWith(`GET /channels/${DEMO.general}/messages?`) && p.includes(`around=${MSG}`))).toBe(true);
});

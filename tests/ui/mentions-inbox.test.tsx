import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";

async function setup() {
  const store = buildDemoStore();
  store.dispatch({ type: "ui/selectGuild", id: "@dms" });
  const h = await testRender(() => <App store={store} actions={demoActions(store)} onQuit={() => {}} />, { width: 160, height: 45 });
  await h.renderOnce();
  return { store, h };
}

test("@ opens the mentions inbox: who, where and the text; Enter goes to that message", async () => {
  const { store, h } = await setup();
  h.mockInput.pressKey("@");
  await Bun.sleep(10);
  await h.renderOnce();
  const frame = h.captureCharFrame();
  expect(frame).toContain("🔔 Menciones");
  expect(frame).toContain("Ramiro · Los Andes › #💬-general");
  expect(frame).toContain("¿estás trabajando en ese juego de ajedrez");
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  await h.renderOnce();
  expect(h.captureCharFrame()).not.toContain("🔔 Menciones");
  expect(store.getState().ui.selectedChannelId).toBe(DEMO.general);
  expect(store.getState().ui.focus).toBe("messages");
});

test("the status bar shows 🔔 with the unread mention count and opens the inbox; Esc closes it", async () => {
  const { store, h } = await setup();
  store.dispatch({ type: "gw", t: "MESSAGE_ACK", d: { channel_id: DEMO.general, message_id: "930000000000001000", mention_count: 3 } } as never);
  await h.renderOnce();
  const lines = h.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => /🔔 \d+|🔔 @/.test(l));
  expect(y).toBeGreaterThan(-1);
  const x = Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf("🔔"))) + 1;
  await h.mockMouse.click(x, y);
  await Bun.sleep(10);
  await h.renderOnce();
  expect(h.captureCharFrame()).toContain("🔔 Menciones");
  h.mockInput.pressEscape();
  await Bun.sleep(80);
  await h.renderOnce();
  expect(h.captureCharFrame()).not.toContain("🔔 Menciones");
});

import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";

const MSG = "930000000000009200";
const MEMES = "920000000000000005";

async function setup() {
  const store = buildDemoStore();
  store.dispatch({
    type: "gw",
    t: "MESSAGE_CREATE",
    d: {
      id: MSG,
      channel_id: DEMO.general,
      author: { id: DEMO.me, username: "gon" },
      content: "mirá",
      timestamp: new Date().toISOString(),
      attachments: [{ id: "940000000000002001", filename: "uno.png", size: 2048, url: "https://cdn.discordapp.com/attachments/1/1/uno.png", content_type: "image/png" }],
    },
  });
  const edits: string[] = [];
  const sends: Array<{ channel: string; content: string }> = [];
  const base = demoActions(store);
  const actions = {
    ...base,
    edit: async (_c: string, _id: string, content: string) => void edits.push(content),
    send: async (channel: string, content: string) => void sends.push({ channel, content }),
  };
  const h = await testRender(() => <App store={store} actions={actions} onQuit={() => {}} />, { width: 160, height: 45 });
  await h.renderOnce();
  return { store, h, edits, sends };
}

function find(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (let y = 0; y < lines.length; y++) {
    const i = lines[y]!.indexOf(text);
    if (i !== -1) return { x: Bun.stringWidth(lines[y]!.slice(0, i)) + 1, y };
  }
  throw new Error(`no encontré "${text}"`);
}

test("switching channel while editing cancels the edit and keeps the other channel's draft", async () => {
  const { store, h, edits, sends } = await setup();
  // Borrador en #memes.
  store.dispatch({ type: "ui/selectChannel", id: MEMES });
  await h.renderOnce();
  h.mockInput.pressKey("i");
  await h.mockInput.typeText("borrador de memes");
  h.mockInput.pressEscape();
  await Bun.sleep(30);
  // Vuelvo a #general y edito mi mensaje (con un adjunto).
  store.dispatch({ type: "ui/selectChannel", id: DEMO.general });
  await h.renderOnce();
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await h.renderOnce();
  expect(h.captureCharFrame()).toContain("╭─ editando");
  // Sin salir del modo escritura, click en #memes.
  const at = find(h.captureCharFrame(), "memes");
  await h.mockMouse.click(at.x, at.y);
  await h.renderOnce();
  expect(store.getState().ui.selectedChannelId).toBe(MEMES);
  const frame = h.captureCharFrame();
  expect(frame).not.toContain("╭─ editando");
  expect(frame).not.toContain("📎 uno.png");
  expect(frame).toContain("borrador de memes");
  // Sigue en modo escritura: Enter en #memes manda un mensaje nuevo, no un PATCH al de #general.
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  expect(edits).toEqual([]);
  expect(sends).toEqual([{ channel: MEMES, content: "borrador de memes" }]);
  // Al volver a #general el texto de la edición no quedó como borrador.
  store.dispatch({ type: "ui/selectChannel", id: DEMO.general });
  await h.renderOnce();
  expect(h.captureCharFrame()).not.toContain("╭─ editando");
});

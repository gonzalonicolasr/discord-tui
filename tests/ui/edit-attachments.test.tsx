import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";

const MSG = "930000000000009100";

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
      attachments: [
        { id: "940000000000001001", filename: "uno.png", size: 2048, url: "https://cdn.discordapp.com/attachments/1/1/uno.png", content_type: "image/png" },
        { id: "940000000000001002", filename: "dos.png", size: 4096, url: "https://cdn.discordapp.com/attachments/1/2/dos.png", content_type: "image/png" },
      ],
    },
  });
  const edits: Array<{ content: string; keep?: string[] }> = [];
  const actions = { ...demoActions(store), edit: async (_c: string, _id: string, content: string, keep?: string[]) => void edits.push({ content, keep }) };
  const h = await testRender(() => <App store={store} actions={actions} onQuit={() => {}} deps={{ readClipboardFiles: async () => [], readClipboardImage: async () => ({ bytes: new Uint8Array(3), mime: "image/png", filename: "x.png" }), readClipboardText: async () => null } as never} />, { width: 160, height: 45 });
  await h.renderOnce();
  return { store, h, edits };
}

function find(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n");
  for (let y = lines.length - 1; y >= 0; y--) {
    const i = lines[y]!.indexOf(text);
    if (i !== -1) return { x: Bun.stringWidth(lines[y]!.slice(0, i)) + 1, y };
  }
  throw new Error(`no encontré "${text}"`);
}

test("editing a message with two images: they show with ✕, removing one keeps only the other", async () => {
  const { h, edits } = await setup();
  h.mockInput.pressKey("k"); // el último mensaje: el propio con las dos imágenes
  h.mockInput.pressKey("e");
  await h.renderOnce();
  const frame = h.captureCharFrame();
  expect(frame).toContain("📎 uno.png (2 KB)");
  expect(frame).toContain("📎 dos.png (4 KB)");
  // ✕ de la fila de dos.png (la que está más abajo, en el cuadro de edición)
  const row = find(frame, "📎 dos.png (4 KB)");
  const x = Bun.stringWidth(frame.split("\n")[row.y]!.slice(0, frame.split("\n")[row.y]!.indexOf("✕")));
  await h.mockMouse.click(x, row.y);
  await h.renderOnce();
  const composer = h.captureCharFrame().split("╭─ editando")[1]!;
  expect(composer).toContain("📎 uno.png (2 KB)");
  expect(composer).not.toContain("📎 dos.png (4 KB)");
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  expect(edits).toEqual([{ content: "mirá", keep: ["940000000000001001"] }]);
});

test("editing without touching the attachments sends no attachment list; pasting while editing is refused", async () => {
  const { h, edits } = await setup();
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await h.mockInput.typeText("!");
  h.mockInput.pressKey("v", { ctrl: true });
  await Bun.sleep(10);
  await h.renderOnce();
  expect(h.captureCharFrame()).toContain("al editar solo podés sacar adjuntos");
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  expect(edits).toEqual([{ content: "mirá!", keep: undefined }]);
});

import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";

const MSG = "930000000000009300";

/** edit() queda pendiente hasta que el test lo resuelve o lo rechaza. */
async function setup() {
  const store = buildDemoStore();
  store.dispatch({
    type: "gw",
    t: "MESSAGE_CREATE",
    d: { id: MSG, channel_id: DEMO.general, author: { id: DEMO.me, username: "gon" }, content: "mirá", timestamp: new Date().toISOString() },
  });
  const edits: string[] = [];
  const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const copied: string[] = [];
  const actions = {
    ...demoActions(store),
    edit: (_c: string, _id: string, content: string) =>
      new Promise<void>((resolve, reject) => {
        edits.push(content);
        pending.push({ resolve, reject });
      }),
  };
  const deps = {
    readClipboardFiles: async () => [],
    readClipboardImage: async () => null,
    readClipboardText: async () => null,
    writeClipboardText: async (text: string) => (copied.push(text), true),
  };
  const h = await testRender(() => <App store={store} actions={actions} onQuit={() => {}} deps={deps as never} />, { width: 160, height: 45 });
  await h.renderOnce();
  return { store, h, edits, pending, copied };
}

function composer(frame: string): string {
  return frame.split("\n").slice(-4).join("\n");
}

test("typing while the edit PATCH is in flight is kept, and the composer leaves edit mode right away", async () => {
  const { h, edits, pending } = await setup();
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await h.mockInput.typeText("!");
  h.mockInput.pressEnter();
  await h.renderOnce();
  expect(h.captureCharFrame()).not.toContain("╭─ editando");
  await h.mockInput.typeText("otro mensaje");
  pending[0]!.resolve();
  await Bun.sleep(10);
  await h.renderOnce();
  expect(edits).toEqual(["mirá!"]);
  expect(composer(h.captureCharFrame())).toContain("otro mensaje");
});

test("a second edit can't be sent while one is in flight", async () => {
  const { h, edits, pending } = await setup();
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await h.mockInput.typeText("!");
  h.mockInput.pressEnter();
  h.mockInput.pressEscape();
  await Bun.sleep(30);
  h.mockInput.pressKey("e"); // el mensaje sigue seleccionado
  await h.mockInput.typeText("?");
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  await h.renderOnce();
  expect(edits).toEqual(["mirá!"]);
  expect(h.captureCharFrame()).toContain("todavía se está guardando la edición");
  pending[0]!.resolve();
});

test("if the PATCH fails the edit comes back with its text and a warning", async () => {
  const { h, edits, pending } = await setup();
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await h.mockInput.typeText("!");
  h.mockInput.pressEnter();
  pending[0]!.reject(new Error("500"));
  await Bun.sleep(10);
  await h.renderOnce();
  const frame = h.captureCharFrame();
  expect(edits).toEqual(["mirá!"]);
  expect(frame).toContain("no se pudo editar");
  expect(frame).toContain("╭─ editando");
  expect(composer(frame)).toContain("mirá!");
});

test("if the PATCH fails after typing something else, that text stays and the edit text goes to the clipboard", async () => {
  const { h, pending, copied } = await setup();
  h.mockInput.pressKey("k");
  h.mockInput.pressKey("e");
  await h.mockInput.typeText("!");
  h.mockInput.pressEnter();
  await h.mockInput.typeText("otro");
  pending[0]!.reject(new Error("500"));
  await Bun.sleep(10);
  await h.renderOnce();
  const frame = h.captureCharFrame();
  expect(frame).toContain("no se pudo editar");
  expect(frame).not.toContain("╭─ editando");
  expect(composer(frame)).toContain("otro");
  expect(copied).toEqual(["mirá!"]);
});

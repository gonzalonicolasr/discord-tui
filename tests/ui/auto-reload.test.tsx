import { afterEach, expect, jest, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions } from "../../scripts/demo-state";

// Cambios de código con zcord abierto: si es seguro se recarga solo (mismo camino que Ctrl+R); si no, avisa y espera.
async function setup() {
  const store = buildDemoStore();
  const actions = demoActions(store);
  let reloads = 0;
  let codeChanged: () => void = () => {};
  const deps = {
    readClipboardFiles: async () => [],
    readClipboardImage: async () => null,
    readClipboardText: async () => null,
  };
  const h = await testRender(
    () => (
      <App
        store={store}
        actions={actions}
        onQuit={() => {}}
        onReload={() => void (reloads += 1)}
        onCodeChange={(listener) => {
          codeChanged = listener;
          return () => {};
        }}
        deps={deps as never}
      />
    ),
    { width: 160, height: 45 },
  );
  await h.renderOnce();
  return { store, h, reloads: () => reloads, codeChanged: () => codeChanged() };
}

afterEach(() => jest.useRealTimers());

test("a code change with nothing pending and nobody typing reloads alone, once", async () => {
  const { h, reloads, codeChanged } = await setup();
  jest.useFakeTimers();
  jest.advanceTimersByTime(11_000); // nadie tocó nada en los últimos 10 s
  codeChanged();
  codeChanged();
  jest.advanceTimersByTime(1_000);
  expect(reloads()).toBe(0); // todavía puede venir otro archivo
  jest.advanceTimersByTime(2_000);
  expect(reloads()).toBe(1);
  jest.advanceTimersByTime(30_000);
  expect(reloads()).toBe(1);
  h.renderer.destroy();
});

test("with a draft it does not reload alone: it says so and Ctrl+R still works", async () => {
  const { h, reloads, codeChanged } = await setup();
  h.mockInput.pressKey("i");
  await h.mockInput.typeText("todavía escribiendo");
  jest.useFakeTimers();
  jest.advanceTimersByTime(11_000);
  codeChanged();
  jest.advanceTimersByTime(60_000);
  expect(reloads()).toBe(0);
  await h.renderOnce();
  const frame = h.captureCharFrame();
  expect(frame).toContain("se recarga solo");
  expect(frame).toContain("el borrador");
  h.mockInput.pressKey("r", { ctrl: true });
  h.mockInput.pressKey("r", { ctrl: true });
  expect(reloads()).toBe(1);
  h.renderer.destroy();
});

test("a recent click or key holds the reload until zcord has been left alone ~10 s", async () => {
  const { h, reloads, codeChanged } = await setup();
  await h.mockMouse.click(80, 20);
  jest.useFakeTimers();
  codeChanged();
  jest.advanceTimersByTime(5_000);
  expect(reloads()).toBe(0);
  h.mockInput.pressKey("j");
  jest.advanceTimersByTime(9_000);
  expect(reloads()).toBe(0);
  jest.advanceTimersByTime(6_000);
  expect(reloads()).toBe(1);
  h.renderer.destroy();
});

test("in a voice call it waits until you leave", async () => {
  const { store, h, reloads, codeChanged } = await setup();
  store.dispatch({ type: "voice/joining", guildId: "100000000000000001", channelId: "100000000000000003" });
  jest.useFakeTimers();
  jest.advanceTimersByTime(11_000);
  codeChanged();
  jest.advanceTimersByTime(30_000);
  expect(reloads()).toBe(0);
  store.dispatch({ type: "voice/left" });
  jest.advanceTimersByTime(6_000);
  expect(reloads()).toBe(1);
  h.renderer.destroy();
});

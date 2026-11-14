import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions } from "../../scripts/demo-state";

async function setup() {
  const store = buildDemoStore();
  const actions = demoActions(store);
  let reloads = 0;
  const deps = {
    readClipboardFiles: async () => [],
    readClipboardImage: async () => ({ bytes: new Uint8Array(3), mime: "image/png", filename: "x.png" }),
    readClipboardText: async () => null,
  };
  const h = await testRender(
    () => <App store={store} actions={actions} onQuit={() => {}} onReload={() => void (reloads += 1)} deps={deps as never} />,
    { width: 160, height: 45 },
  );
  await h.renderOnce();
  return { store, actions, h, reloads: () => reloads };
}

test("Ctrl+R with nothing to lose reloads right away", async () => {
  const { h, reloads } = await setup();
  h.mockInput.pressKey("r", { ctrl: true });
  expect(reloads()).toBe(1);
});

test("Ctrl+R with a draft warns first and reloads only on a second Ctrl+R", async () => {
  const { h, reloads } = await setup();
  h.mockInput.pressKey("i");
  await h.mockInput.typeText("mensaje largo sin mandar");
  h.mockInput.pressKey("r", { ctrl: true });
  await h.renderOnce();
  expect(reloads()).toBe(0);
  expect(h.captureCharFrame()).toContain("Ctrl+R otra vez");
  expect(h.captureCharFrame()).toContain("borrador");
  h.mockInput.pressKey("r", { ctrl: true });
  expect(reloads()).toBe(1);
});

test("Ctrl+R with a pending attachment warns first", async () => {
  const { h, reloads } = await setup();
  h.mockInput.pressKey("v", { ctrl: true });
  await Bun.sleep(10);
  h.mockInput.pressKey("escape");
  h.mockInput.pressKey("r", { ctrl: true });
  await h.renderOnce();
  expect(reloads()).toBe(0);
  expect(h.captureCharFrame()).toContain("adjunto");
});

test("Ctrl+R while streaming warns first; after 2 s a lone Ctrl+R warns again", async () => {
  const { store, h, reloads } = await setup();
  store.dispatch({ type: "voice/stream", patch: { status: "live" } });
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    h.mockInput.pressKey("r", { ctrl: true });
    await h.renderOnce();
    expect(reloads()).toBe(0);
    expect(h.captureCharFrame()).toContain("transmisión");
    now += 2_500;
    h.mockInput.pressKey("r", { ctrl: true });
    expect(reloads()).toBe(0);
    now += 500;
    h.mockInput.pressKey("r", { ctrl: true });
    expect(reloads()).toBe(1);
  } finally {
    Date.now = realNow;
  }
});

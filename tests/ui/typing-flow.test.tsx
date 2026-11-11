import { buildKittyKeyboardFlags } from "@opentui/core";
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { KITTY_KEYBOARD } from "../../src/ui/kitty";
import { buildDemoStore, demoActions } from "../../scripts/demo-state";

async function setup() {
  const store = buildDemoStore();
  const sent: string[] = [];
  const actions = { ...demoActions(store), send: async (_c: string, content: string) => void sent.push(content) };
  const h = await testRender(() => <App store={store} actions={actions} onQuit={() => {}} />, { width: 160, height: 45, kittyKeyboard: true });
  await h.renderOnce();
  return { h, sent };
}

test("like Discord: after Enter you keep typing (no click to get back into the box)", async () => {
  const { h, sent } = await setup();
  h.mockInput.pressKey("i");
  await h.mockInput.typeText("hola");
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  await h.mockInput.typeText("chau");
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  await h.renderOnce();
  expect(sent).toEqual(["hola", "chau"]);
  expect(h.captureCharFrame()).toContain(" INSERT ");
});

test("zcord asks the terminal for each key's text (kitty 'report associated text')", () => {
  expect(buildKittyKeyboardFlags(KITTY_KEYBOARD) & 0b10000).toBe(0b10000);
});

test("ñ and accents arrive with their text even if the key is the US ';' (Latin American layout)", async () => {
  const { h, sent } = await setup();
  h.mockInput.pressKey("i");
  // la tecla de al lado de la L: código de la tecla física (;) + texto ñ / Ñ; después una á de tecla muerta
  h.mockInput.pressKeys(["\u001b[59;1;241u", "\u001b[59;2;209u", "\u001b[97;1;225u"]);
  await h.renderOnce();
  h.mockInput.pressEnter();
  await Bun.sleep(10);
  expect(sent).toEqual(["ñÑá"]);
});

test("Ctrl+R reloads zcord from any mode (and says so)", async () => {
  const store = buildDemoStore();
  let reloads = 0;
  const h = await testRender(() => <App store={store} actions={demoActions(store)} onQuit={() => {}} onReload={() => reloads++} />, { width: 160, height: 45, kittyKeyboard: true });
  await h.renderOnce();
  h.mockInput.pressKey("r", { ctrl: true });
  await h.renderOnce();
  expect(reloads).toBe(1);
  expect(h.captureCharFrame()).toContain("recargando zcord…");
  h.mockInput.pressKey("i");
  h.mockInput.pressKey("r", { ctrl: true });
  expect(reloads).toBe(2);
});

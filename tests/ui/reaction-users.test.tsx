import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions } from "../../scripts/demo-state";

test("hovering a reaction shows who put it (like Discord's tooltip)", async () => {
  const store = buildDemoStore();
  const h = await testRender(() => <App store={store} actions={demoActions(store)} onQuit={() => {}} />, { width: 160, height: 45 });
  await h.renderOnce();
  const lines = h.captureCharFrame().split("\n");
  const y = lines.findIndex((l) => l.includes("😂 3"));
  const x = Bun.stringWidth(lines[y]!.slice(0, lines[y]!.indexOf("😂 3"))) + 1;
  await h.mockMouse.moveTo(x, y);
  await Bun.sleep(10);
  await h.renderOnce();
  expect(h.captureCharFrame()).toContain("😂 Gon, Ramiro, Celes");
});

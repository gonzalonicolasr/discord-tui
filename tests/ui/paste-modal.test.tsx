import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { App } from "../../src/ui/App";
import { buildDemoStore, demoActions } from "../../scripts/demo-state";

async function setup() {
  const store = buildDemoStore();
  const reads: string[] = [];
  const deps = {
    readClipboardFiles: async () => [],
    readClipboardImage: async () => null,
    readClipboardText: async () => null,
    readAttachmentFromPath: async (path: string) => (reads.push(path), { filename: "foto.png", mime: "image/png", bytes: new Uint8Array(3) }),
  };
  const h = await testRender(() => <App store={store} actions={demoActions(store)} onQuit={() => {}} deps={deps as never} />, { width: 160, height: 45 });
  await h.renderOnce();
  return { h, reads };
}

function composer(frame: string): string {
  return frame.split("\n").slice(-4).join("\n");
}

for (const [name, open, marker] of [
  ["the mentions inbox", "@", "🔔 Menciones"],
  ["the help", "?", "ayuda"],
] as const) {
  test(`pasting with ${name} open does nothing (no hidden text or attachment in the composer)`, async () => {
    const { h, reads } = await setup();
    h.mockInput.pressKey(open);
    await Bun.sleep(10);
    await h.renderOnce();
    expect(h.captureCharFrame()).toContain(marker);
    await h.mockInput.pasteBracketedText("texto pegado");
    await h.mockInput.pasteBracketedText("/tmp/foto.png");
    await Bun.sleep(10);
    h.mockInput.pressEscape();
    await Bun.sleep(80);
    await h.renderOnce();
    const frame = h.captureCharFrame();
    expect(composer(frame)).not.toContain("texto pegado");
    expect(composer(frame)).not.toContain("INSERT");
    expect(reads).toEqual([]);
  });
}

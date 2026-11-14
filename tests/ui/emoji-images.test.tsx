import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { ImageRenderable, type Renderable } from "@opentui/core";
import { testRender } from "@opentui/solid";
import { join } from "node:path";

import { DEMO_EMOJI } from "../../scripts/demo/emoji";
import { buildDemoStore, DEMO } from "../../scripts/demo-state";
import { createImageCache, imageCache } from "../../src/images/cache";
import { selectMessages } from "../../src/store/selectors";
import { MessageItem } from "../../src/ui/components/MessageItem";
import { THEMES } from "../../src/ui/theme";

// El cache de imágenes usa globalThis.fetch: acá devuelve un PNG local y anota cada pedido, sin red.
const PNG = new Uint8Array(await Bun.file(join(import.meta.dir, "..", "fixtures", "images", "sample.png")).arrayBuffer());
const requests: { url: string; headers: unknown }[] = [];
const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(input), headers: init?.headers });
    return new Response(PNG, { status: 200 });
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

function images(node: Renderable): ImageRenderable[] {
  const own = node instanceof ImageRenderable ? [node] : [];
  return [...own, ...node.getChildren().flatMap((child) => images(child as Renderable))];
}

async function renderMessage(id: string, withImages: boolean, onReact?: (emoji: { id: string | null; name: string }) => void) {
  const state = buildDemoStore().getState();
  const message = selectMessages(state, DEMO.general).find((m) => m.id === id)!;
  const r = await testRender(
    () => <MessageItem message={message} state={state} theme={THEMES.dark} guildId={DEMO.guild} grouped={false} images={withImages} onReact={onReact} />,
    { width: 80, height: 12 },
  );
  await r.renderOnce();
  await Bun.sleep(20);
  await r.renderOnce();
  return r;
}

test("jumbo emoji with images off keep today's :name: text", async () => {
  const r = await renderMessage(DEMO_EMOJI.jumboMsg, false);
  expect(r.captureCharFrame()).toContain(":kek: :baile: 🎉");
  expect(images(r.renderer.root)).toHaveLength(0);
  r.renderer.destroy();
});

test("jumbo emoji with images on: one 4x2 image per custom emoji, unicode stays text, animated as GIF", async () => {
  // imageCache es uno por proceso: otros tests de la suite ya pueden haber bajado estos emojis. Durante este test
  // lo atiende un cache nuevo (el mismo código) cuyo fetch anota cada pedido, así no depende del orden de la suite.
  const seen: { url: string; headers: unknown }[] = [];
  const fresh = createImageCache({
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), headers: init?.headers });
      return new Response(PNG, { status: 200 });
    }) as typeof fetch,
  });
  const spy = spyOn(imageCache, "get").mockImplementation((url) => fresh.get(url));
  const r = await renderMessage(DEMO_EMOJI.jumboMsg, true).finally(() => spy.mockRestore());
  const found = images(r.renderer.root);
  expect(found).toHaveLength(2);
  expect(found.map((img) => [img.width, img.height])).toEqual([
    [4, 2],
    [4, 2],
  ]);
  const frame = r.captureCharFrame();
  expect(frame).toContain("🎉");
  expect(frame).not.toContain(":kek:");
  const urls = seen.map((req) => req.url);
  expect(urls).toContain(`https://cdn.discordapp.com/emojis/${DEMO_EMOJI.kek}.webp?size=48&quality=lossless`);
  expect(urls).toContain(`https://cdn.discordapp.com/emojis/${DEMO_EMOJI.baile}.gif?size=48`);
  expect(seen.every((req) => req.headers === undefined)).toBe(true); // sin token ni nada que salga al CDN
  expect(requests.every((req) => req.headers === undefined)).toBe(true);
  r.renderer.destroy();
});

test("text mixed with a custom emoji keeps :name: even with images on", async () => {
  const r = await renderMessage(DEMO_EMOJI.mixedMsg, true);
  expect(r.captureCharFrame()).toContain("nooo :kek: qué crack");
  expect(images(r.renderer.root)).toHaveLength(0);
  r.renderer.destroy();
});

test("custom-emoji reactions: :name: chips with images off, 2x1 image + count with images on, click toggles", async () => {
  const off = await renderMessage(DEMO_EMOJI.reactedMsg, false);
  expect(off.captureCharFrame()).toContain(" :kek: 2 ");
  expect(off.captureCharFrame()).toContain(" :baile: 1 ");
  expect(images(off.renderer.root)).toHaveLength(0);
  off.renderer.destroy();

  const reacted: { id: string | null; name: string }[] = [];
  const on = await renderMessage(DEMO_EMOJI.reactedMsg, true, (emoji) => reacted.push(emoji));
  const found = images(on.renderer.root);
  expect(found.map((img) => [img.width, img.height])).toEqual([
    [2, 1],
    [2, 1],
  ]);
  const frame = on.captureCharFrame();
  expect(frame).not.toContain(":kek:");
  expect(frame).toContain("🔥 4");
  const kek = found[0]!;
  await on.mockMouse.click(kek.x, kek.y);
  await on.renderOnce();
  expect(reacted).toEqual([{ id: DEMO_EMOJI.kek, name: "kek" }]);
  on.renderer.destroy();
});

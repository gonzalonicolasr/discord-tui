/**
 * Debajo del video las celdas tienen que quedar con el fondo por defecto de la terminal, como las deja el `<image>`
 * de OpenTUI: después de colocar la imagen reescribe sus celdas con `ESC[0m` y espacios. La app Herdr (a través de
 * herdr-core) dibuja las imágenes debajo del texto (`z<0`) por debajo de los fondos de celda pintados: con el fondo
 * del tema encima, el recuadro del video mostraba solo el fondo aunque los cuadros llegaran y se colocaran.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";

import { buildDemoStore } from "../../scripts/demo-state";
import { syntheticFrame } from "../../scripts/demo/watch";
import { StreamViewer } from "../../src/ui/components/StreamViewer";
import { KITTY_IMAGE_TRANSPORT } from "../../src/ui/kitty";
import { THEMES } from "../../src/ui/theme";
import type { DecodedFrame } from "../../src/watch/decode";
import { cellBackgrounds, fakeKittyTerminal, placedCells } from "./kitty-term";

const COLS = 120;
const ROWS = 40;

/** Mira 4 cuadros con un fondo de tema detrás (como la App) y cuenta los fondos de las celdas bajo la imagen. */
async function backgroundsUnderVideo(fileOk: boolean, env: Record<string, string> = {}) {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const term = fakeKittyTerminal({ cols: COLS, rows: ROWS, fileOk });
    let push: ((f: DecodedFrame) => void) | null = null;
    const voice = { watchFrames: (_w: number, _h: number, fn: (f: DecodedFrame) => void) => ((push = fn), { resize() {}, unsubscribe() {} }) };
    const h = await testRender(
      () => (
        <box width="100%" height="100%" backgroundColor={THEMES.dark.bg}>
          <StreamViewer store={buildDemoStore()} theme={THEMES.dark} voice={voice as never} />
        </box>
      ),
      { width: COLS, height: ROWS, stdin: term.stdin as never, stdout: term.stdout as never, bufferedOutput: "stdout", remote: false, kittyImageTransport: KITTY_IMAGE_TRANSPORT },
    );
    await h.renderer.setupTerminal();
    for (let i = 0; i < 80 && (!h.renderer.capabilities?.kitty_graphics || h.renderer.kittyImageTransportStatus.fileState === "probing"); i++) await Bun.sleep(5);
    expect(h.renderer.kittyImageTransportStatus.fileState).toBe(fileOk ? "ready" : "unsupported");
    await h.renderOnce();
    const out = new Uint8Array(480 * 270 * 4);
    for (let t = 0; t < 4; t++) {
      push!(syntheticFrame(480, 270, t, out));
      for (let i = 0; i < 3; i++) {
        await h.renderOnce();
        await h.renderer.idle();
        await Bun.sleep(5);
      }
    }
    const stream = term.writes.join("");
    await h.dispose();
    const cells = placedCells(stream).cells;
    const bgs = cellBackgrounds(stream);
    const count: Record<string, number> = {};
    for (const c of cells) count[bgs.get(c) ?? "unset"] = (count[bgs.get(c) ?? "unset"] ?? 0) + 1;
    return { cells: cells.size, count, stream };
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("without the file transport the cells under the stream video get the default background, like OpenTUI's own image", async () => {
  const native = await backgroundsUnderVideo(true);
  expect(native.cells).toBeGreaterThan(1000);
  expect(native.count).toEqual({ default: native.cells }); // lo que hace el nativo, y se veía en la app Herdr

  const own = await backgroundsUnderVideo(false);
  expect(own.cells).toBe(native.cells);
  expect(own.count).toEqual({ default: own.cells });
});

test("ZCORD_KITTY_HOLE=0 leaves the theme background under the stream video (to test in the Herdr app)", async () => {
  const own = await backgroundsUnderVideo(false, { ZCORD_KITTY_HOLE: "0" });
  expect(own.cells).toBeGreaterThan(1000);
  expect(own.count.default ?? 0).toBe(0);
});

test("ZCORD_KITTY_ZLIB=0 sends the stream frames uncompressed even when the terminal says it understands zlib", async () => {
  const on = await backgroundsUnderVideo(false);
  expect(on.stream).toMatch(/\x1b_Ga=t,f=24,o=z,/);
  const off = await backgroundsUnderVideo(false, { ZCORD_KITTY_ZLIB: "0" });
  expect(off.cells).toBeGreaterThan(1000);
  expect(off.stream).toMatch(/\x1b_Ga=t,f=24,s=/);
  expect(off.stream).not.toMatch(/o=z/);
});

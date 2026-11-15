/**
 * El video propio (sin transporte por archivo) tiene que ocupar en pantalla exactamente las mismas celdas que el
 * `<image>` de OpenTUI en la misma escena: el nativo recorta la imagen alrededor de lo que se dibuja encima con fondo
 * (ayuda, settings, Ctrl+K, avisos) y la mueve con la caja. Cada escena se corre dos veces, con una terminal que lee
 * archivos (camino de OpenTUI) y con una que no (camino propio), y se comparan las celdas cubiertas en cada momento.
 */
import { expect, test } from "bun:test";
import { testRender } from "@opentui/solid";
import { createSignal, Show } from "solid-js";

import type { Actions } from "../../src/actions";
import { App } from "../../src/ui/App";
import { StreamViewer } from "../../src/ui/components/StreamViewer";
import { KITTY_IMAGE_TRANSPORT } from "../../src/ui/kitty";
import { THEMES } from "../../src/ui/theme";
import type { DecodedFrame } from "../../src/watch/decode";
import { buildDemoStore, demoActions, DEMO } from "../../scripts/demo-state";
import { syntheticFrame } from "../../scripts/demo/watch";
import { fakeKittyTerminal, placedCells } from "./kitty-term";

const COLS = 120;
const ROWS = 40;
const RAGNAR = "900000000000000101";

type Harness = Awaited<ReturnType<typeof testRender>>;

async function start(term: ReturnType<typeof fakeKittyTerminal>, node: () => any): Promise<Harness> {
  const h = await testRender(node, {
    width: COLS,
    height: ROWS,
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    bufferedOutput: "stdout",
    remote: false,
    kittyImageTransport: KITTY_IMAGE_TRANSPORT,
    kittyKeyboard: true, // como zcord: Esc llega como secuencia propia, sin esperar a ver si sigue otra tecla
  });
  await h.renderer.setupTerminal();
  for (let i = 0; i < 80 && (!h.renderer.capabilities?.kitty_graphics || h.renderer.kittyImageTransportStatus.fileState === "probing"); i++) await Bun.sleep(5);
  await h.renderOnce();
  return h;
}

async function settle(h: Harness): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await h.renderOnce();
    await h.renderer.idle();
    await Bun.sleep(5);
  }
}

/** Corre la escena y devuelve, en cada punto de control, las celdas cubiertas por imágenes y los huecos. */
async function scene(fileOk: boolean, layout: (viewer: () => any) => any, steps: (h: Harness, frame: () => Promise<void>, mark: () => void) => Promise<void>) {
  const term = fakeKittyTerminal({ cols: COLS, rows: ROWS, fileOk });
  let push: ((f: DecodedFrame) => void) | null = null;
  const voice = { watchFrames: (_w: number, _h: number, fn: (f: DecodedFrame) => void) => ((push = fn), { resize() {}, unsubscribe() {} }) };
  const viewer = () => <StreamViewer store={buildDemoStore()} theme={THEMES.dark} voice={voice as never} />;
  const h = await start(term, () => layout(viewer));
  expect(h.renderer.kittyImageTransportStatus.fileState).toBe(fileOk ? "ready" : "unsupported");
  const out = new Uint8Array(480 * 270 * 4);
  let t = 0;
  const frame = async (): Promise<void> => {
    push!(syntheticFrame(480, 270, t++, out));
    await settle(h);
  };
  const marks: string[][] = [];
  const mark = (): void => void marks.push([...placedCells(term.writes.join("")).cells].sort());
  await steps(h, frame, mark);
  const { gaps } = placedCells(term.writes.join(""));
  const own = term.writes.join("").includes("\x1b7\x1b[");
  await h.dispose();
  return { marks, gaps, own };
}

/** Celdas de más y de menos del video propio contra el nativo (las primeras 5 de cada una, para leer el fallo). */
function diff(mark: number, mine: string[], native: string[]) {
  const a = new Set(mine);
  const b = new Set(native);
  return { mark, extra: mine.filter((c) => !b.has(c)).slice(0, 5), missing: native.filter((c) => !a.has(c)).slice(0, 5) };
}

async function same(layout: Parameters<typeof scene>[1], steps: Parameters<typeof scene>[2]) {
  const native = await scene(true, layout, steps);
  const mine = await scene(false, layout, steps);
  expect(native.own).toBe(false);
  expect(mine.own).toBe(true);
  expect(mine.marks.length).toBe(native.marks.length);
  for (let i = 0; i < native.marks.length; i++) expect(diff(i, mine.marks[i]!, native.marks[i]!)).toEqual({ mark: i, extra: [], missing: [] });
  expect(mine.gaps).toBe(0);
  return native.marks;
}

test("a box with a background opened over the stream is cut out of the video, and the video comes back whole", async () => {
  const [open, setOpen] = createSignal(false);
  const marks = await same(
    (viewer) => (
      <box width="100%" height="100%">
        {viewer()}
        <Show when={open()}>
          <box position="absolute" left={20} top={8} width={60} height={20} backgroundColor="#222244" border>
            <text>MODAL</text>
          </box>
        </Show>
      </box>
    ),
    async (h, frame, mark) => {
      setOpen(false);
      for (let i = 0; i < 3; i++) await frame();
      mark();
      setOpen(true);
      await settle(h);
      mark();
      await frame();
      await frame();
      mark();
      setOpen(false);
      await settle(h);
      mark();
      await frame();
      mark();
    },
  );
  const whole = new Set(marks[0]);
  expect(whole.size).toBeGreaterThan(1000);
  expect(marks[1]!.length).toBeLessThan(whole.size); // abierto: falta el hueco de la caja
  expect(marks[1]!.length).toBeGreaterThan(0);
  expect(marks[1]!.includes("40,15")).toBe(false);
  expect(marks[3]).toEqual(marks[0]!); // cerrado: entera otra vez
});

test("the stream follows its box when the terminal is resized and when the panel next to it changes width", async () => {
  const [side, setSide] = createSignal(30);
  await same(
    (viewer) => (
      <box flexDirection="row" width="100%" height="100%">
        <box width={side()} flexShrink={0}>
          <text>canales</text>
        </box>
        {viewer()}
      </box>
    ),
    async (h, frame, mark) => {
      setSide(30);
      for (let i = 0; i < 3; i++) await frame();
      mark();
      setSide(50); // se mueve y se achica sin cuadro nuevo
      await settle(h);
      mark();
      h.resize(90, 30);
      await settle(h);
      mark();
      await frame();
      mark();
      h.resize(COLS, ROWS);
      await settle(h);
      await frame();
      mark();
    },
  );
});

/** La App de verdad mirando la transmisión de la demo, con los overlays reales (ayuda con ?, Ctrl+K). */
async function appScene(fileOk: boolean) {
  const term = fakeKittyTerminal({ cols: COLS, rows: ROWS, fileOk });
  const store = buildDemoStore();
  const actions = demoActions(store) as Actions;
  const h = await start(term, () => <App store={store} actions={actions} onQuit={() => {}} />);
  await actions.voice!.toggleVoice(DEMO.voice);
  await actions.voice!.watchStream!(RAGNAR);
  for (let i = 0; i < 200 && placedCells(term.writes.join("")).cells.size < 500; i++) await settle(h);
  const marks: string[][] = [];
  /** Espera a que la pantalla muestre lo que se pidió y anota las celdas cubiertas. */
  const mark = async (shown: (screen: string) => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !shown(h.captureCharFrame()); i++) await settle(h);
    expect(shown(h.captureCharFrame())).toBe(true);
    // Los avisos aparecen y vencen solos: en las dos corridas tienen que estar igual (ninguno).
    for (const id of Object.keys(store.getState().notices)) store.dispatch({ type: "notice/dismiss", id });
    await settle(h);
    marks.push([...placedCells(term.writes.join("")).cells].sort());
  };
  const help = (screen: string): boolean => screen.includes("Ayuda · ? o Esc cierra");
  const jump = (screen: string): boolean => screen.includes("Saltar a…");
  await mark((screen) => screen.includes("en vivo")); // 0: viendo (la App arranca en modo NORMAL: ? y Ctrl+K son atajos)
  h.mockInput.pressKey("?");
  await mark(help);
  h.mockInput.pressEscape();
  await mark((screen) => !help(screen));
  h.mockInput.pressKey("k", { ctrl: true });
  await mark(jump);
  h.mockInput.pressEscape();
  await mark((screen) => !jump(screen));
  const { gaps } = placedCells(term.writes.join(""));
  await actions.voice!.stopWatching!();
  await actions.voice!.leaveVoice();
  await h.dispose();
  return { marks, gaps };
}

test("the help overlay and the quick switcher cover the stream the same way as OpenTUI's own image", async () => {
  const native = await appScene(true);
  const mine = await appScene(false);
  expect(native.marks[0]!.length).toBeGreaterThan(500);
  expect(native.marks[1]!.length).toBeLessThan(native.marks[0]!.length); // la ayuda tapa parte del video
  expect(native.marks[3]!.length).toBeLessThan(native.marks[0]!.length); // Ctrl+K también
  expect(native.marks[4]).toEqual(native.marks[0]!);
  for (let i = 0; i < native.marks.length; i++) expect(diff(i, mine.marks[i]!, native.marks[i]!)).toEqual({ mark: i, extra: [], missing: [] });
  expect(mine.gaps).toBe(0);
});

test("while the file probe is still running the stream goes through OpenTUI's image, exactly as before", async () => {
  const term = fakeKittyTerminal({ cols: COLS, rows: ROWS, fileOk: true, fileDelayMs: 300 });
  let push: ((f: DecodedFrame) => void) | null = null;
  const voice = { watchFrames: (_w: number, _h: number, fn: (f: DecodedFrame) => void) => ((push = fn), { resize() {}, unsubscribe() {} }) };
  const h = await testRender(() => <StreamViewer store={buildDemoStore()} theme={THEMES.dark} voice={voice as never} />, {
    width: COLS,
    height: ROWS,
    stdin: term.stdin as never,
    stdout: term.stdout as never,
    bufferedOutput: "stdout",
    remote: false,
    kittyImageTransport: KITTY_IMAGE_TRANSPORT,
  });
  await h.renderer.setupTerminal();
  for (let i = 0; i < 40 && !h.renderer.capabilities?.kitty_graphics; i++) await Bun.sleep(5);
  expect(h.renderer.kittyImageTransportStatus.fileState).toBe("probing");
  const out = new Uint8Array(480 * 270 * 4);
  for (let t = 0; t < 4; t++) {
    push!(syntheticFrame(480, 270, t, out));
    await settle(h);
  }
  for (let i = 0; i < 80 && h.renderer.kittyImageTransportStatus.fileState === "probing"; i++) await Bun.sleep(10);
  expect(h.renderer.kittyImageTransportStatus.fileState).toBe("ready");
  for (let t = 4; t < 7; t++) {
    push!(syntheticFrame(480, 270, t, out));
    await settle(h);
  }
  const all = term.writes.join("");
  await h.dispose();
  expect(all.includes("\x1b7\x1b[")).toBe(false); // ninguna colocación propia
  expect(all.includes("o=z")).toBe(false); // ni el sondeo de zlib
  expect(placedCells(all).cells.size).toBeGreaterThan(1000); // el video sí se vio, por el <image>
});

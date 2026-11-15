/**
 * Lo que le llega a la terminal por cada cuadro de la transmisión que mirás. Cada cuadro nuevo borra la imagen
 * anterior (`a=d`) y coloca la nueva (`a=p`); entre las dos no hay ninguna imagen en pantalla. Con el transporte
 * "raw" ese tramo son los píxeles en base64 (~2,7 MB por cuadro de 960×540, en decenas de escrituras), y un
 * multiplexor que redibuja a mitad de camino (herdr con kitty_graphics) muestra el recuadro vacío: el parpadeo
 * negro. Con el transporte por archivo el borrado y la colocación van juntos, en una sola escritura chica.
 */
import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import { testRender } from "@opentui/solid";

import { buildDemoStore } from "../../scripts/demo-state";
import { syntheticFrame } from "../../scripts/demo/watch";
import type { VoiceActions } from "../../src/actions/voice";
import { StreamViewer } from "../../src/ui/components/StreamViewer";
import { KITTY_IMAGE_TRANSPORT } from "../../src/ui/kitty";
import { THEMES } from "../../src/ui/theme";
import type { DecodedFrame } from "../../src/watch/decode";

const COLS = 120;
const ROWS = 40;

/** Terminal falsa: graba cada escritura y contesta como Ghostty a las consultas de gráficos (`a=q`, `q=0`) y al DA1. */
function fakeTerminal() {
  const stdin = new Readable({ read() {} });
  const writes: string[] = [];
  const reply = (text: string): void => void setTimeout(() => stdin.emit("data", Buffer.from(text)), 0);
  const stdout = new (class extends Writable {
    isTTY = true;
    columns = COLS;
    rows = ROWS;
    getColorDepth(): number {
      return 24;
    }
    override _write(chunk: Buffer, _enc: string, done: () => void): void {
      const text = chunk.toString("latin1");
      writes.push(text);
      for (const m of text.matchAll(/\x1b_G([^;\x1b]*)/g)) {
        const id = /(?:^|,)i=(\d+)/.exec(m[1]!)?.[1];
        if (id && /(?:^|,)(?:q=0|a=q)(?:,|$)/.test(m[1]!)) reply(`\x1b_Gi=${id};OK\x1b\\`);
      }
      if (text.includes("\x1b[c")) reply("\x1b[?62;22c");
      done();
    }
  })();
  return { stdin, stdout, writes };
}

test("each new stream frame swaps the image in one small write, never leaving the box empty mid-stream", async () => {
  const term = fakeTerminal();
  let push: ((frame: DecodedFrame) => void) | null = null;
  const voice = { watchFrames: (_w: number, _h: number, fn: (f: DecodedFrame) => void) => ((push = fn), { resize() {}, unsubscribe() {} }) };
  const h = await testRender(
    () => <StreamViewer store={buildDemoStore()} theme={THEMES.dark} voice={voice as unknown as VoiceActions} />,
    {
      width: COLS,
      height: ROWS,
      stdin: term.stdin as never,
      stdout: term.stdout as never,
      bufferedOutput: "stdout",
      remote: false,
      kittyImageTransport: KITTY_IMAGE_TRANSPORT,
    },
  );
  await h.renderer.setupTerminal(); // consultas de capacidades y prueba del transporte, como en la app real
  for (let i = 0; i < 40 && (!h.renderer.capabilities?.kitty_graphics || h.renderer.kittyImageTransportStatus.fileState === "probing"); i++) await Bun.sleep(5);
  expect(h.renderer.capabilities?.kitty_graphics).toBe(true);
  await h.renderOnce();
  expect(push).not.toBeNull();

  const out = new Uint8Array(480 * 270 * 4);
  const frames: string[][] = [];
  for (let t = 0; t < 4; t++) {
    term.writes.length = 0;
    push!(syntheticFrame(480, 270, t, out));
    await Promise.resolve();
    await h.renderOnce();
    await Bun.sleep(5);
    frames.push([...term.writes]);
  }
  await h.dispose();

  // Del segundo cuadro en adelante: lo que hay entre el borrado de la imagen vieja y la colocación de la nueva.
  for (const writes of frames.slice(1)) {
    const all = writes.join("");
    const del = all.search(/\x1b_Ga=d,/);
    const place = all.indexOf("\x1b_Ga=p,", del);
    expect(del).toBeGreaterThanOrEqual(0);
    expect(place).toBeGreaterThan(del);
    expect(place - del).toBeLessThan(1024);
    expect(writes.filter((w) => w.includes("\x1b_G"))).toHaveLength(1);
  }
});

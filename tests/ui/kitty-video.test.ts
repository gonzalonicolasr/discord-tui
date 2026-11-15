import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";

import { KittyVideo, probeZlib, visibleParts, type VideoView } from "../../src/ui/kitty-video";

const BOX = { col: 1, row: 3, cols: 40, rows: 12 };
const whole = (box = BOX): VideoView => ({ box, parts: [{ x: 0, y: 0, w: box.cols, h: box.rows }] });
const VIEW = whole();
const px = (w: number, h: number): Uint8Array => new Uint8Array(w * h * 4).fill(200);

function output(accept: () => boolean = () => true) {
  const writes: string[] = [];
  let release: (() => void) | null = null;
  return {
    writes,
    flushIdle: () => release?.(),
    out: {
      write: (b: Uint8Array) => (accept() ? (writes.push(Buffer.from(b).toString("latin1")), true) : false),
      idle: () => new Promise<void>((r) => (release = r)),
    },
  };
}
const ids = (s: string, cmd: RegExp): string[] => [...s.matchAll(cmd)].map((m) => m[1]!);

test("each frame is placed with the other id before the previous one is deleted", async () => {
  const o = output();
  const v = new KittyVideo(o.out);
  for (let i = 0; i < 3; i++) {
    v.show(px(8, 4), 8, 4, VIEW);
    o.flushIdle();
    await Bun.sleep(0);
  }
  expect(o.writes).toHaveLength(3);
  const [a, b] = [ids(o.writes[0]!, /a=p,i=(\d+)/g)[0]!, ids(o.writes[1]!, /a=p,i=(\d+)/g)[0]!];
  expect(a).not.toBe(b);
  for (const [w, placed, deleted] of [[o.writes[1]!, b, a], [o.writes[2]!, a, b]] as const) {
    expect(w.indexOf(`a=p,i=${placed}`)).toBeLessThan(w.indexOf(`a=d,d=I,i=${deleted}`));
    expect(w.startsWith("\x1b[?2026h")).toBe(true);
    expect(w).toContain(`\x1b7\x1b[4;2H`); // fila/columna 1-based de la caja, sin mover el cursor (DECSC/DECRC)
  }
});

test("a frame that finds the output full is skipped and the shown image stays placed", async () => {
  let full = false;
  const o = output(() => !full);
  const v = new KittyVideo(o.out);
  v.show(px(8, 4), 8, 4, VIEW);
  o.flushIdle();
  await Bun.sleep(0);
  full = true;
  v.show(px(8, 4), 8, 4, VIEW);
  full = false;
  v.show(px(8, 4), 8, 4, VIEW);
  expect(o.writes).toHaveLength(2);
  const first = ids(o.writes[0]!, /a=p,i=(\d+)/g)[0]!;
  expect(o.writes[1]).toContain(`a=d,d=I,i=${first}`); // borra la que de verdad estaba colocada
});

test("only the latest frame waits while one is being written, moves re-place, clear deletes both ids", async () => {
  const o = output();
  const v = new KittyVideo(o.out);
  v.show(px(8, 4), 8, 4, VIEW);
  v.show(px(8, 4), 8, 4, VIEW);
  v.show(px(8, 4), 8, 4, VIEW);
  expect(o.writes).toHaveLength(1);
  o.flushIdle();
  await Bun.sleep(0);
  expect(o.writes).toHaveLength(2);
  expect(v.written).toBe(2);

  v.move(whole({ ...BOX, row: 5 }));
  expect(o.writes.at(-1)).toMatch(/^\x1b\[\?2026h\x1b7\x1b\[6;2H\x1b_Ga=p,i=\d+,p=1,x=0,y=0,w=8,h=4,c=40,r=12,C=1/);
  v.move(whole({ ...BOX, row: 5 }));
  expect(o.writes).toHaveLength(3); // misma caja: no vuelve a escribir

  v.dispose();
  expect(ids(o.writes.at(-1)!, /a=d,d=I,i=(\d+)/g)).toHaveLength(2);
  v.show(px(8, 4), 8, 4, VIEW);
  expect(o.writes).toHaveLength(4);
});

/** Terminal falsa para el sondeo: contesta `reply` (o nada) a la consulta `a=q,o=z`. */
function zlibTerminal(reply: ((id: string) => string) | null) {
  const handlers: ((seq: string) => boolean)[] = [];
  const writes: string[] = [];
  const out = {
    write(b: Uint8Array) {
      const text = Buffer.from(b).toString("latin1");
      writes.push(text);
      const q = /\x1b_Ga=q,[^;]*o=z[^;]*i=(\d+)|\x1b_Ga=q,[^;]*i=(\d+)[^;]*o=z/.exec(text);
      const id = q?.[1] ?? q?.[2];
      if (id && reply) setTimeout(() => handlers.slice().forEach((h) => h(reply(id))), 1);
      return true;
    },
    idle: () => Promise.resolve(),
  };
  const input = {
    prependInputHandler: (h: (seq: string) => boolean) => void handlers.push(h),
    removeInputHandler: (h: (seq: string) => boolean) => void handlers.splice(handlers.indexOf(h), 1),
  };
  return { out, input, handlers, writes };
}

test("zlib is used only when the terminal answers OK to a compressed query", async () => {
  const ok = zlibTerminal((id) => `\x1b_Gi=${id};OK\x1b\\`);
  expect(await probeZlib(ok.out, ok.input, 200)).toBe(true);
  expect(ok.writes.join("")).toContain("o=z");
  expect(ok.handlers).toHaveLength(0);

  const err = zlibTerminal((id) => `\x1b_Gi=${id};EINVAL:unsupported compression\x1b\\`);
  expect(await probeZlib(err.out, err.input, 200)).toBe(false);
  const silent = zlibTerminal(null); // herdr-core sin cliente no contesta las consultas de gráficos
  expect(await probeZlib(silent.out, silent.input, 20)).toBe(false);
  expect(silent.handlers).toHaveLength(0);

  const other = zlibTerminal(() => "\x1b_Gi=7;OK\x1b\\"); // la respuesta de otra imagen no cuenta
  expect(await probeZlib(other.out, other.input, 20)).toBe(false);
});

test("with zlib on, the frame goes compressed (o=z) and inflates back to the RGB pixels", () => {
  const o = output();
  const v = new KittyVideo(o.out);
  v.zlib = true;
  const rgba = new Uint8Array(32 * 16 * 4).map((_, i) => (i >> 7) * 9); // filas lisas: comprime bien
  v.show(rgba, 32, 16, VIEW);
  const w = o.writes[0]!;
  expect(w).toMatch(/\x1b_Ga=t,f=24,o=z,s=32,v=16,/);
  const b64 = [...w.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map((m) => m[1]).join("");
  const rgb = inflateSync(Buffer.from(b64, "base64"));
  expect([...rgb.subarray(0, 6)]).toEqual([0, 1, 2, 4, 5, 6].map((i) => rgba[i]!));
  expect(rgb.length).toBe(32 * 16 * 3);
});

test("frames that barely compress go raw, and zlib is tried again only after a while", async () => {
  const o = output();
  const v = new KittyVideo(o.out);
  v.zlib = true;
  const smooth = new Uint8Array(64 * 32 * 4).fill(90);
  const grain = new Uint8Array(64 * 32 * 4).map(() => Math.floor(Math.random() * 256));
  const send = async (rgba: Uint8Array): Promise<string> => {
    v.show(rgba, 64, 32, VIEW);
    const w = o.writes.at(-1)!;
    o.flushIdle();
    await Bun.sleep(0);
    return w;
  };
  expect(await send(smooth)).toContain(",o=z,");
  expect(await send(grain)).not.toContain(",o=z,"); // casi no baja: va crudo
  expect(await send(smooth)).not.toContain(",o=z,"); // y no se vuelve a comprimir enseguida
  let again = -1;
  for (let i = 0; i < 120 && again < 0; i++) if ((await send(smooth)).includes(",o=z,")) again = i;
  expect(again).toBeGreaterThan(30);
});

test("visible parts: a box over the middle leaves four rectangles, all covered leaves none", () => {
  const hole = (x: number, y: number): boolean => x >= 3 && x < 7 && y >= 2 && y < 4;
  expect(visibleParts(10, 6, hole)).toEqual([
    { x: 0, y: 0, w: 10, h: 2 },
    { x: 0, y: 2, w: 3, h: 2 },
    { x: 7, y: 2, w: 3, h: 2 },
    { x: 0, y: 4, w: 10, h: 2 },
  ]);
  expect(visibleParts(10, 6, () => false)).toEqual([{ x: 0, y: 0, w: 10, h: 6 }]);
  expect(visibleParts(10, 6, () => true)).toEqual([]);
  expect(visibleParts(40, 40, (x, y) => (x + y) % 2 === 0)).toEqual([]); // demasiado recortado: no se muestra
});

test("each visible part is placed with its pixel crop; parts that go away are removed without deleting the image", async () => {
  const o = output();
  const v = new KittyVideo(o.out);
  const box = { col: 0, row: 0, cols: 10, rows: 6 };
  const split: VideoView = { box, parts: [{ x: 0, y: 0, w: 10, h: 2 }, { x: 7, y: 2, w: 3, h: 4 }] };
  v.show(px(100, 60), 100, 60, split);
  const w = o.writes[0]!;
  expect(w).toContain("\x1b[1;1H\x1b_Ga=p,i=");
  expect(w).toMatch(/p=1,x=0,y=0,w=100,h=20,c=10,r=2,/);
  expect(w).toContain("\x1b[3;8H");
  expect(w).toMatch(/p=2,x=70,y=20,w=30,h=40,c=3,r=4,/);
  const id = ids(w, /a=p,i=(\d+)/g)[0]!;
  o.flushIdle();
  await Bun.sleep(0);

  v.move(whole(box)); // se cerró lo que tapaba
  const back = o.writes.at(-1)!;
  expect(back).toMatch(new RegExp(`a=p,i=${id},p=1,x=0,y=0,w=100,h=60,c=10,r=6,`));
  expect(back).toContain(`a=d,d=i,i=${id},p=2,`);
  expect(back.includes("d=I")).toBe(false); // la imagen sigue guardada
  expect(back.indexOf("a=p")).toBeLessThan(back.indexOf("a=d")); // primero la colocación entera, después se saca la parte

  v.move({ box, parts: [] }); // todo tapado: se sacan las colocaciones y no se manda ningún cuadro
  expect(o.writes.at(-1)).toContain(`a=d,d=i,i=${id},p=1,`);
  const before = o.writes.length;
  v.show(px(100, 60), 100, 60, { box, parts: [] });
  expect(o.writes).toHaveLength(before);
  v.move(whole(box)); // se destapa: vuelve el último cuadro
  expect(o.writes.at(-1)).toMatch(new RegExp(`a=p,i=${id},p=1,`));
});

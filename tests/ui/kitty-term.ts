/**
 * Terminal falsa con gráficos kitty para los tests del video, y un lector de lo que se colocó en pantalla.
 */
import { Readable, Writable } from "node:stream";

export interface FakeTerminalOptions {
  cols: number;
  rows: number;
  /** false: contesta que no lee archivos (`t=f`), como la app Herdr a través de herdr-core. */
  fileOk?: boolean;
  /** Demora de la respuesta al sondeo del archivo, en ms. */
  fileDelayMs?: number;
}

/** Graba cada escritura y contesta como Ghostty a las consultas de gráficos (`a=q`, `q=0`) y al DA1. */
export function fakeKittyTerminal(o: FakeTerminalOptions) {
  const stdin = new Readable({ read() {} });
  const writes: string[] = [];
  const reply = (text: string, ms = 0): void => void setTimeout(() => stdin.emit("data", Buffer.from(text)), ms);
  const stdout = new (class extends Writable {
    isTTY = true;
    columns = o.cols;
    rows = o.rows;
    getColorDepth(): number {
      return 24;
    }
    override _write(chunk: Buffer, _enc: string, done: () => void): void {
      const text = chunk.toString("latin1");
      writes.push(text);
      for (const m of text.matchAll(/\x1b_G([^;\x1b]*)/g)) {
        const id = /(?:^|,)i=(\d+)/.exec(m[1]!)?.[1];
        if (!id || !/(?:^|,)(?:q=0|a=q)(?:,|$)/.test(m[1]!)) continue;
        const file = /(?:^|,)t=f(?:,|$)/.test(m[1]!);
        reply(file && o.fileOk === false ? `\x1b_Gi=${id};ENOTSUPPORTED:no file\x1b\\` : `\x1b_Gi=${id};OK\x1b\\`, file ? (o.fileDelayMs ?? 0) : 0);
      }
      if (text.includes("\x1b[c")) reply("\x1b[?62;22c");
      done();
    }
  })();
  return { stdin, stdout, writes };
}

/**
 * Repasa los comandos kitty en orden y devuelve las celdas que cubren las imágenes colocadas al final (`x,y`), y
 * cuántas veces, desde la primera colocación, no quedó ninguna colocada (`gaps`).
 */
export function placedCells(stream: string): { cells: Set<string>; gaps: number } {
  const placed = new Map<string, { col: number; row: number; c: number; r: number }>();
  let row = 0;
  let col = 0;
  let seen = false;
  let gaps = 0;
  for (const m of stream.matchAll(/\x1b\[(\d+);(\d+)H|\x1b_G([^;\x1b]*)/g)) {
    if (m[1]) {
      row = Number(m[1]) - 1;
      col = Number(m[2]) - 1;
      continue;
    }
    const k = Object.fromEntries(m[3]!.split(",").map((kv) => kv.split("=") as [string, string]));
    if (k.a === "p") {
      placed.set(`${k.i}:${k.p ?? "0"}`, { col, row, c: Number(k.c), r: Number(k.r) });
      seen = true;
    } else if (k.a === "d") {
      for (const key of [...placed.keys()]) {
        const [i, p] = key.split(":");
        const all = k.d === "a" || k.d === "A" || k.d === undefined;
        if (all || (i === k.i && (k.p === undefined || k.p === p))) placed.delete(key);
      }
    } else continue;
    if (seen && placed.size === 0) gaps++;
  }
  const cells = new Set<string>();
  for (const p of placed.values()) for (let y = p.row; y < p.row + p.r; y++) for (let x = p.col; x < p.col + p.c; x++) cells.add(`${x},${y}`);
  return { cells, gaps };
}

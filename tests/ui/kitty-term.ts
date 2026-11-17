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

/**
 * El fondo con que quedó cada celda (`x,y` → `"default"` o `"r,g,b"`), leyendo lo escrito en orden: posiciones de
 * cursor (`CSI f;c H`, `ESC 7`/`ESC 8`), el fondo de SGR (`0`, `49`, `48;2;r;g;b`, `48;5;n`) y los caracteres que
 * se imprimen. Se saltean los APC, OSC y las otras secuencias.
 */
export function cellBackgrounds(stream: string): Map<string, string> {
  const text = Buffer.from(stream, "latin1").toString("utf8");
  const bgs = new Map<string, string>();
  let row = 0;
  let col = 0;
  let bg = "default";
  let saved = { row: 0, col: 0 };
  const re = /\x1b_[^\x1b]*\x1b\\|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-9;:?<=>]*)([ -\/]*)([@-~])|\x1b([78])|\x1b[ -\/]*[0-~]|([\r\n])|([^\x00-\x1f\x7f\x1b])/gu;
  for (const m of text.matchAll(re)) {
    if (m[3] !== undefined) {
      const params = m[1] ?? "";
      if (m[3] === "H" && !m[2] && !params.startsWith("?")) {
        const [r, c] = params.split(";");
        row = Math.max(0, Number(r || 1) - 1);
        col = Math.max(0, Number(c || 1) - 1);
      } else if (m[3] === "m" && !m[2] && !/[?<=>]/.test(params)) {
        const p = params === "" ? [0] : params.split(";").map(Number);
        for (let i = 0; i < p.length; i++) {
          if (p[i] === 0 || p[i] === 49) bg = "default";
          else if (p[i] === 48 && p[i + 1] === 2) (bg = `${p[i + 2]},${p[i + 3]},${p[i + 4]}`), (i += 4);
          else if (p[i] === 48 && p[i + 1] === 5) (bg = `i${p[i + 2]}`), (i += 2);
          else if (p[i] === 38 && p[i + 1] === 2) i += 4;
          else if (p[i] === 38 && p[i + 1] === 5) i += 2;
        }
      }
    } else if (m[4] === "7") saved = { row, col };
    else if (m[4] === "8") ({ row, col } = saved);
    else if (m[5] === "\r") col = 0;
    else if (m[5] === "\n") row++;
    else if (m[6] !== undefined) {
      const w = Math.max(1, Bun.stringWidth(m[6]));
      for (let k = 0; k < w; k++) bgs.set(`${col + k},${row}`, bg);
      col += w;
    }
  }
  return bgs;
}

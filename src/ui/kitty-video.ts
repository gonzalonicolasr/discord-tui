/**
 * El video de una transmisión en gráficos kitty sin borrar antes de colocar. Para cuando la imagen no puede viajar
 * por archivo (la app Herdr a través de herdr-core contesta que no lee archivos): el `<image>` de OpenTUI manda cada
 * cuadro como `borrar · ~2 MB de píxeles · colocar` con el mismo id, y herdr-core, cuando el cliente lee lento,
 * corta el bloque de salida sincronizada después del borrado: la app dibuja el recuadro vacío (parpadeo negro).
 * Acá cada cuadro va con el otro de dos ids: se transmite y se coloca encima del anterior, y recién después se
 * borra el anterior. Corte donde se corte, siempre hay una imagen colocada.
 *
 * Las secuencias van por la misma cola ordenada que los cuadros de OpenTUI (`NativeSession.write`). Un cuadro por
 * vez: mientras uno se está escribiendo, solo se guarda el último que llegó y se saltean los del medio.
 *
 * Como el `<image>` nativo, la imagen se recorta alrededor de lo que se dibuja encima con fondo (ayuda, Ctrl+K,
 * settings): se coloca en varias partes (`visibleParts`), cada una con su recorte de píxeles (`x,y,w,h`).
 *
 * Si la terminal contesta que entiende píxeles comprimidos (`probeZlib`), los cuadros van con zlib (`o=z`): una
 * pantalla compartida con texto pesa varias veces menos y llegan más cuadros por segundo. Sin respuesta, sin zlib.
 */
import { deflateSync } from "node:zlib";

/** Lo que usa de la `NativeSession` del renderer (`renderer.nativeScene.driver`). */
export interface KittyOutput {
  write(bytes: Uint8Array): boolean;
  idle(): Promise<void>;
}

/** Para leer la respuesta de la terminal (el renderer: le llegan las respuestas kitty que no son suyas). */
export interface KittyInput {
  prependInputHandler(handler: (sequence: string) => boolean): void;
  removeInputHandler(handler: (sequence: string) => boolean): void;
}

/**
 * Pregunta a la terminal si acepta una imagen comprimida con zlib (`a=q` con `o=z`, que no guarda nada). `true` solo
 * con un `OK` para esa consulta; un error o el silencio (herdr-core sin cliente no contesta) dan `false`.
 */
export function probeZlib(out: KittyOutput, input: KittyInput, timeoutMs = 3000): Promise<boolean> {
  const id = 0x40000000 + Math.floor(Math.random() * 0x3ffffff0);
  const pixel = deflateSync(Buffer.from([0, 0, 0])).toString("base64");
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearTimeout(timer);
      input.removeInputHandler(handler);
      resolve(ok);
    };
    const handler = (seq: string): boolean => {
      const m = new RegExp(`^\x1b_Gi=${id}(?:,[^;]*)?;([^\x1b]*)\x1b\\\\`).exec(seq);
      if (!m) return false;
      finish(m[1] === "OK");
      return true;
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    input.prependInputHandler(handler);
    let sent = false;
    try {
      sent = out.write(Buffer.from(`\x1b_Ga=q,i=${id},f=24,s=1,v=1,o=z;${pixel}\x1b\\`, "latin1"));
    } catch {
      // renderer cerrándose
    }
    if (!sent) finish(false);
  });
}

/** Dónde va la imagen entera, en celdas (0 = primera columna/fila). */
export interface CellBox {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/** Un rectángulo de celdas dentro de la caja (0,0 = esquina de la caja). */
export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** La caja y las partes de ella que se ven (lo demás lo tapa algo con fondo). */
export interface VideoView {
  box: CellBox;
  parts: CellRect[];
}

/** Más partes que esto (algo muy recortado encima) y no se muestra: nunca queda video encima de un fondo. */
const MAX_PARTS = 32;

/**
 * Las celdas visibles de una caja de `cols`×`rows` en rectángulos: tramos por fila, y los tramos iguales de filas
 * seguidas se juntan. Una caja tapada por un recuadro da 4 partes (arriba, izquierda, derecha, abajo).
 */
export function visibleParts(cols: number, rows: number, covered: (x: number, y: number) => boolean): CellRect[] {
  const parts: CellRect[] = [];
  let open = new Map<string, CellRect>();
  for (let y = 0; y < rows; y++) {
    const next = new Map<string, CellRect>();
    for (let x = 0; x < cols; ) {
      if (covered(x, y)) {
        x++;
        continue;
      }
      const from = x;
      while (x < cols && !covered(x, y)) x++;
      const key = `${from}:${x - from}`;
      const same = open.get(key);
      if (same) (same.h++, next.set(key, same));
      else {
        const part = { x: from, y, w: x - from, h: 1 };
        parts.push(part);
        next.set(key, part);
      }
    }
    open = next;
    if (parts.length > MAX_PARTS) return [];
  }
  return parts;
}

/** Como el nativo de OpenTUI: debajo del texto y encima de los fondos de las celdas. */
const Z = -1073741823;
const CHUNK = 4096;

export class KittyVideo {
  private readonly ids: [number, number];
  private shown = -1; // índice en `ids` de la imagen colocada, -1 = ninguna
  private size = { width: 0, height: 0 }; // píxeles de la imagen colocada
  private view: VideoView | null = null;
  private placed = 0; // colocaciones (p=1..placed) de la imagen actual
  private pending: { rgba: Uint8Array; width: number; height: number } | null = null;
  private busy = false;
  private closed = false;
  private rgb = new Uint8Array(0);
  /** Cuadros que llegaron a la salida (los salteados no cuentan), para los fps del encabezado. */
  written = 0;
  /** La terminal entiende `o=z` (ver `probeZlib`). */
  zlib = false;

  constructor(private readonly out: KittyOutput) {
    const base = 0x40000000 + Math.floor(Math.random() * 0x3ffffff0);
    this.ids = [base, base + 1];
  }

  /** Muestra un cuadro RGBA en `view`. Copia los píxeles al escribir. Con todo tapado no transmite nada. */
  show(rgba: Uint8Array, width: number, height: number, view: VideoView): void {
    if (this.closed || view.box.cols <= 0 || view.box.rows <= 0) return;
    this.move(view);
    if (view.parts.length === 0) return;
    this.pending = { rgba, width, height };
    this.flush();
  }

  /** Cambió la caja o lo que la tapa, sin cuadro nuevo: vuelve a colocar la imagen actual. */
  move(view: VideoView): void {
    if (this.closed || sameView(view, this.view)) return;
    if (this.shown < 0) return void (this.view = view);
    const id = this.ids[this.shown]!;
    const text = placeAll(id, view, this.size) + dropPlacements(id, view.parts.length, this.placed);
    if (this.send(sync(text))) (this.view = view), (this.placed = view.parts.length);
  }

  /** Borra las imágenes (al dejar de ver). */
  clear(): void {
    this.pending = null;
    this.shown = -1;
    this.placed = 0;
    this.view = null;
    this.send(sync(this.ids.map(del).join("")));
  }

  dispose(): void {
    this.clear();
    this.closed = true;
  }

  private flush(): void {
    if (this.busy || !this.pending || !this.view || this.view.parts.length === 0) return;
    const { rgba, width, height } = this.pending;
    const view = this.view;
    this.pending = null;
    const next = this.shown === 0 ? 1 : 0;
    const old = this.shown < 0 ? "" : del(this.ids[this.shown]!);
    const size = { width, height };
    const bytes = sync(this.transmit(this.ids[next]!, rgba, width, height) + placeAll(this.ids[next]!, view, size) + old);
    if (!this.send(bytes)) return; // salida llena: se saltea el cuadro, queda el anterior
    this.shown = next;
    this.size = size;
    this.placed = view.parts.length;
    this.written++;
    this.busy = true;
    const done = (): void => {
      this.busy = false;
      this.flush();
    };
    this.out.idle().then(done, () => (this.busy = false));
  }

  private transmit(id: number, rgba: Uint8Array, width: number, height: number): string {
    const px = width * height;
    if (this.rgb.length !== px * 3) this.rgb = new Uint8Array(px * 3);
    const rgb = this.rgb;
    for (let i = 0, j = 0; i < px * 4; i += 4, j += 3) {
      rgb[j] = rgba[i]!;
      rgb[j + 1] = rgba[i + 1]!;
      rgb[j + 2] = rgba[i + 2]!;
    }
    const pixels = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length);
    const zlib = this.zlib;
    const data = (zlib ? deflateSync(pixels, { level: 1 }) : pixels).toString("base64");
    const parts: string[] = [];
    for (let at = 0; at < data.length; at += CHUNK) {
      const more = at + CHUNK < data.length ? 1 : 0;
      const head = at === 0 ? `a=t,f=24${zlib ? ",o=z" : ""},s=${width},v=${height},i=${id},m=${more},q=2` : `m=${more},q=2`;
      parts.push(`\x1b_G${head};${data.slice(at, at + CHUNK)}\x1b\\`);
    }
    return parts.join("");
  }

  private send(text: string): boolean {
    if (!text) return true;
    try {
      return this.out.write(Buffer.from(text, "latin1"));
    } catch {
      return false; // renderer cerrándose o cuadro más grande que la cola
    }
  }
}

/**
 * Coloca cada parte visible (p=1..n) con su recorte de píxeles, sin mover el cursor (DECSC/DECRC alrededor y C=1).
 * Volver a colocar con el mismo `p` reemplaza esa colocación, sin hueco.
 */
function placeAll(id: number, { box, parts }: VideoView, size: { width: number; height: number }): string {
  const sx = (c: number): number => Math.round((c * size.width) / box.cols);
  const sy = (r: number): number => Math.round((r * size.height) / box.rows);
  return parts
    .map((p, k) => {
      const x = sx(p.x);
      const y = sy(p.y);
      const w = Math.max(1, sx(p.x + p.w) - x);
      const h = Math.max(1, sy(p.y + p.h) - y);
      return (
        `\x1b7\x1b[${box.row + p.y + 1};${box.col + p.x + 1}H` +
        `\x1b_Ga=p,i=${id},p=${k + 1},x=${x},y=${y},w=${w},h=${h},c=${p.w},r=${p.h},C=1,z=${Z},q=2\x1b\\\x1b8`
      );
    })
    .join("");
}

/** Saca las colocaciones que sobran (p=from+1..to), dejando los píxeles guardados. */
function dropPlacements(id: number, from: number, to: number): string {
  let text = "";
  for (let p = from + 1; p <= to; p++) text += `\x1b_Ga=d,d=i,i=${id},p=${p},q=2\x1b\\`;
  return text;
}

function del(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

function sync(body: string): string {
  return body ? `\x1b[?2026h${body}\x1b[?2026l` : "";
}

function sameView(a: VideoView, b: VideoView | null): boolean {
  if (!b) return false;
  const x = a.box;
  const y = b.box;
  if (x.col !== y.col || x.row !== y.row || x.cols !== y.cols || x.rows !== y.rows || a.parts.length !== b.parts.length) return false;
  return a.parts.every((p, i) => {
    const q = b.parts[i]!;
    return p.x === q.x && p.y === q.y && p.w === q.w && p.h === q.h;
  });
}

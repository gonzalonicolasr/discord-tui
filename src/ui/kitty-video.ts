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
 */

/** Lo que usa de la `NativeSession` del renderer (`renderer.nativeScene.driver`). */
export interface KittyOutput {
  write(bytes: Uint8Array): boolean;
  idle(): Promise<void>;
}

/** Dónde va la imagen, en celdas (0 = primera columna/fila). */
export interface CellBox {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

/** Como el nativo de OpenTUI: debajo del texto y encima de los fondos de las celdas. */
const Z = -1073741823;
const CHUNK = 4096;

export class KittyVideo {
  private readonly ids: [number, number];
  private shown = -1; // índice en `ids` de la imagen colocada, -1 = ninguna
  private box: CellBox | null = null;
  private pending: { rgba: Uint8Array; width: number; height: number; box: CellBox } | null = null;
  private busy = false;
  private closed = false;
  private rgb = new Uint8Array(0);
  /** Cuadros que llegaron a la salida (los salteados no cuentan), para los fps del encabezado. */
  written = 0;

  constructor(private readonly out: KittyOutput) {
    const base = 0x40000000 + Math.floor(Math.random() * 0x3ffffff0);
    this.ids = [base, base + 1];
  }

  /** Muestra un cuadro RGBA. Copia los píxeles al escribir, así que el buffer se puede reusar después. */
  show(rgba: Uint8Array, width: number, height: number, box: CellBox): void {
    if (this.closed || box.cols <= 0 || box.rows <= 0) return;
    this.pending = { rgba, width, height, box };
    this.flush();
  }

  /** La caja se movió o cambió de tamaño sin cuadro nuevo: vuelve a colocar la imagen actual. */
  move(box: CellBox): void {
    if (this.closed || this.shown < 0 || sameBox(box, this.box)) return;
    if (this.send(sync(place(this.ids[this.shown]!, box)))) this.box = box;
  }

  /** Borra las imágenes (al dejar de ver o al pasar al `<image>` de OpenTUI). */
  clear(): void {
    this.pending = null;
    this.shown = -1;
    this.box = null;
    this.send(sync(this.ids.map(del).join("")));
  }

  dispose(): void {
    this.clear();
    this.closed = true;
  }

  private flush(): void {
    if (this.busy || !this.pending) return;
    const { rgba, width, height, box } = this.pending;
    this.pending = null;
    const next = this.shown === 0 ? 1 : 0;
    const old = this.shown < 0 ? "" : del(this.ids[this.shown]!);
    const bytes = sync(this.transmit(this.ids[next]!, rgba, width, height) + place(this.ids[next]!, box) + old);
    if (!this.send(bytes)) return; // salida llena: se saltea el cuadro, queda el anterior
    this.shown = next;
    this.box = box;
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
    const data = Buffer.from(rgb.buffer, rgb.byteOffset, rgb.length).toString("base64");
    const parts: string[] = [];
    for (let at = 0; at < data.length; at += CHUNK) {
      const more = at + CHUNK < data.length ? 1 : 0;
      const head = at === 0 ? `a=t,f=24,s=${width},v=${height},i=${id},m=${more},q=2` : `m=${more},q=2`;
      parts.push(`\x1b_G${head};${data.slice(at, at + CHUNK)}\x1b\\`);
    }
    return parts.join("");
  }

  private send(text: string): boolean {
    try {
      return this.out.write(Buffer.from(text, "latin1"));
    } catch {
      return false; // renderer cerrándose o cuadro más grande que la cola
    }
  }
}

/** Coloca sin mover el cursor (DECSC/DECRC alrededor y C=1), en la misma colocación p=1 de siempre. */
function place(id: number, b: CellBox): string {
  return `\x1b7\x1b[${b.row + 1};${b.col + 1}H\x1b_Ga=p,i=${id},p=1,c=${b.cols},r=${b.rows},C=1,z=${Z},q=2\x1b\\\x1b8`;
}

function del(id: number): string {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

function sync(body: string): string {
  return `\x1b[?2026h${body}\x1b[?2026l`;
}

function sameBox(a: CellBox, b: CellBox | null): boolean {
  return !!b && a.col === b.col && a.row === b.row && a.cols === b.cols && a.rows === b.rows;
}
